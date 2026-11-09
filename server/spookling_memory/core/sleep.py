"""SLEEP, the one writer: light() applies the fast judgements; full() resolves the slow ones and rebuilds every view."""
from __future__ import annotations

import hashlib
import re
from datetime import date, datetime, timedelta, timezone

from . import dates
from .dates import fmt
from .facts import MULTI_VALUED, Facts, norm, same, toks
from .index_page import render, strong
from .recall import Search, Values
from .triage import CHANGE, LABELS, Item, Ruling, fired, mention_of, sentence_of, verbatim

BATCH_CHARS = 6000  # a session's user turns go to the tagger together while their text stays under this
OP = {"fact": "assert", "preference": "assert", "retraction": "retract", "correction": "correct", "rule": "rule"}
NEEDS_VALUE = ("fact", "preference", "correction", "rule")


def tx_of(ts: str, seq: int, item: int) -> str:
    """Transaction time of a decision: its LOG turn's time, made unique and ordered by (seq, item)."""
    t = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(timezone.utc)
    return f"{t:%Y-%m-%dT%H:%M:%S}.{seq:09d}{item:03d}Z"


def _id(*parts) -> str:
    return hashlib.sha256("\x00".join(map(str, parts)).encode()).hexdigest()


def known(mem, day: str) -> list[tuple[str, list[str], str | None]]:
    """What the tagger is shown (logged as the decision's base): each key, its words, the value in force."""
    now: dict[str, list[str]] = {}
    for r in mem.facts.in_force(day):
        now.setdefault(r.attribute, []).append(r.value if r.value is not None else "none any more")
    return [(k, ws, ", ".join(now[k]) if k in now else None) for k, ws in mem.vocab.words.items()]


def route(mem, label: str, key: str, value: str | None, sentence: str, vf: date, day: date, confidence: float,
          jev: dict | None = None) -> tuple[str, list[str]]:
    """fast, slow or skip, and why slow; with the decider on, Jev's Nouls replace the confidence and CHANGE tests."""
    if label in ("none", "hypothetical"):
        return "skip", []
    bare = sentence.replace(value, " ") if value else sentence
    flags = fired(bare)
    span = dates.parse(bare, day, "nearest")
    if span and span.kind == "absolute":
        flags.append("explicit_date")
    if vf < day - timedelta(days=30):
        flags.append("retroactive")
    if vf > day:
        flags.append("postactive")
    if label in ("correction", "rule"):
        flags.append(f"label:{label}")
    if flags:
        return "slow", flags
    if not (mem.decider.yes(jev["durable"], "durable") if jev else confidence >= mem.tau):
        return "slow", ["low_confidence"]
    if key in MULTI_VALUED:
        return "fast", []
    rows = mem.facts.believed(key, "")
    cur = next((r for r in rows if r.valid_from <= vf.isoformat() < r.valid_to), rows[-1] if rows else None)
    if label != "retraction":
        if cur is not None and cur.value is not None and same(value, cur.value) and changed(sentence, value, cur.value):
            return "slow", ["changed"]  # part of the stored value, beside another time or number: maybe an update
        if cur is None or (cur.value is not None and same(value, cur.value)):
            return "fast", []  # a first value, or seen again
        if any(r.value and same(value, r.value) for r in rows):
            return "slow", ["revert"]
    elif cur is not None and cur.value is None:
        return "fast", []  # already none: seen again
    change = mem.decider.yes(jev["replaces"], "replaces") if jev else CHANGE.search(sentence)
    return ("fast", []) if change else ("slow", ["surprise"])


NUMBER = re.compile(r"\b\d{1,2}(?::\d{2})?\s?[ap]\.?m\b\.?|\b\d+(?:[.,:]\d+)*\b", re.I)


def changed(sentence: str, value: str, stored: str) -> bool:
    """Some of the stored value's words, beside a time or number that differs from the one the value holds."""
    if set(toks(value)) == set(toks(stored)):
        return False
    key = lambda s: {re.sub(r"[\s.]", "", x.lower()) for x in NUMBER.findall(s)}
    old = key(stored)
    return bool(old) and bool(key(sentence) - old)


def stored_keys(mem, value: str) -> set[str]:
    """Keys holding a value this one names or completes, applied or waiting for the slow path."""
    v = set(toks(value))
    if not v:
        return set()
    known = [(a, x) for (a, _, nv), said in mem.facts.surfaces.items() for x in (nv, *said)]
    known += [(d["key"], d["value"]) for d in mem.log.decisions if d["step"] == "triage" and d.get("route") in ("fast", "slow")
              and d.get("value") and d.get("key")]
    return {a for a, x in known if toks(x) and (v <= set(toks(x)) or set(toks(x)) <= v)}


def triage_decision(mem, e, idx: int, it: Item, jev: dict | None = None) -> dict:
    """jev: the decider's Noul answers for this tag (durable, replaces, rule), recorded on the decision."""
    turn, day = e.text, dates.day_of(e.ts)
    d = {"id": _id(e.hash, "triage", idx, mem.triage.version), "step": "triage", "seq": e.seq, "idx": idx,
         "source": e.hash, "version": mem.triage.version, "label": it.label, "raw": {"key": it.key, "value": it.value,
         "old": it.old, "when": it.when}, "confidence": it.confidence, "cues": list(it.cues), "created": mem.log_time(),
         "tx": tx_of(e.ts, e.seq, idx), "status": "ok", "kind": it.label if it.label in ("fact", "preference") else "fact"}
    if jev:  # the fact's confidence is Jev's durable-fact probability; the tagger's own is kept beside it
        d.update(jev=jev, confidence=jev["durable"], tagger_confidence=it.confidence)
    value, old, when = verbatim(turn, it.value), verbatim(turn, it.old), verbatim(turn, it.when)
    flags: list[str] = []
    stored = stored_keys(mem, it.value) if it.value else set()
    if it.value and value is None and stored:  # a mention the tagger completed to a stored value
        value = mention_of(turn, it.value)
        if value:
            flags.append("mention")
    label = it.label
    if label not in LABELS and it.key.strip() and value:  # a key word put in the label field ("hobby")
        label = "fact"
        flags.append("label_guess")
    key, source = mem.vocab.canonical(it.key) if it.key.strip() else ("", "none")
    owners = stored_keys(mem, value) if value else set()
    if len(owners) == 1 and key not in owners and not mem.facts.believed(key):
        key, source = next(iter(owners)), "value"  # an empty key yields to the one key holding this value
    d["label"] = label
    reject = ("label" if label not in LABELS else "value not verbatim" if it.value and value is None
              else "no value" if label in NEEDS_VALUE and not value
              else "no key" if label in OP and label != "rule" and not key else None)
    vf, precision = dates.resolve_when(when, day)
    d.update(key=key, key_source=source, value=value, old=old, when=when, vf=vf.isoformat(), precision=precision,
             item=norm(value) if key in MULTI_VALUED and value else "", op=OP.get(label, "none"))
    if reject:
        d.update(route="rejected", flags=[reject])
    else:
        d["route"], d["flags"] = route(mem, label, key, value, sentence_of(turn, value or old), vf, day, it.confidence, jev)
        if "label_guess" in flags and d["route"] == "fast":
            d["route"] = "slow"  # a guessed label is never applied unchecked
        d["flags"] = flags + d["flags"]
    d["writer"] = f"{mem.triage.name}/{d['route']}"
    d["base"] = [f"{r.value or 'none'} [{r.valid_from}, {r.valid_to})" for r in mem.facts.believed(key)] if key else []
    return d


def resolve_decision(mem, d: dict, e, ruling: Ruling | None) -> dict:
    """The slow path's answer as a decision. No answer: the tagger's reading stands, marked disputed."""
    turn, day = e.text, dates.day_of(e.ts)
    if ruling is None:
        op, value, old, when, status, conf, why = d["op"], d["value"], d["old"], d["when"], "disputed", d["confidence"], "unresolved"
    else:
        op, status, conf, why = ruling.op, "disputed" if ruling.disputed else "ok", ruling.confidence, ruling.why
        value = verbatim(turn, ruling.value) or (d["value"] if op in ("assert", "correct", "rule") else None)
        old, when = verbatim(turn, ruling.old) or d["old"], verbatim(turn, ruling.when) or d["when"]
        if op in ("assert", "correct", "rule") and not value:
            op = "none"
    vf, precision = dates.resolve_when(when, day)
    return {**d, "id": _id(e.hash, "resolve", d["idx"], mem.triage.version), "step": "resolve", "op": op, "value": value,
            "old": old, "when": when, "vf": vf.isoformat(), "precision": precision, "status": status, "confidence": conf,
            "why": why, "failed": ruling is None, "item": norm(value) if d["key"] in MULTI_VALUED and value else d["item"],
            "created": mem.log_time(), "writer": f"{mem.triage.name}/slow"}


def light(mem) -> bool:
    pending = [e for e in mem.log.events if e.seq > mem.tag_cursor]
    if not pending:
        return False
    groups: list[list] = []
    for e in pending:
        if groups and groups[-1][0].session_id == e.session_id:
            groups[-1].append(e)
        else:
            groups.append([e])
    for g in groups:
        batches: list[list] = []
        for e in (e for e in g if e.role == "user"):  # each user turn is in exactly one call
            if not batches or sum(len(x.text) for x in batches[-1]) + len(e.text) > BATCH_CHARS:
                batches.append([])
            batches[-1].append(e)
        for users in batches:
            items, spent = mem.triage.judge([e.text for e in users], g[0].ts[:10], known(mem, g[0].ts[:10]))
            mem.spend(spent)
            evs = propose_events(mem, users, g) if mem.events_on else None
            jev = [mem.decider.message(e.text, e.ts[:10], its, evs[n] if evs else [], mem.classes) if mem.decider else {}
                   for n, (e, its) in enumerate(zip(users, items, strict=True))]  # one Decisions request per message
            for e, its, ja in zip(users, items, jev, strict=True):  # a Triage returns one list per turn
                for idx, it in enumerate(its):
                    d = mem.record(triage_decision(mem, e, idx, it, ja.get(("f", idx))))  # logged before it changes anything
                    if d["route"] == "fast":
                        mem.facts.apply(d)
                    if d["key_source"] == "model" and d["route"] in ("fast", "slow"):
                        mem.vocab.add(d["key"], d["cues"])
            if evs:
                tag_events(mem, users, evs, jev)
        mem.tag_cursor = g[-1].seq
    mem.n_light += 1
    return True


def propose_events(mem, users: list, group: list) -> list[list] | None:
    """Candidate clauses by code, spans by the event tagger; None when no turn has a candidate clause."""
    from .extract import clauses

    replies = {a.hash: b.text for a, b in zip(group, group[1:]) if a.role == "user" and b.role == "assistant"}
    cands = [clauses(e.text, mem.classes) for e in users]
    if not any(cands):
        return None
    items, spent = mem.event_tagger.events([e.text for e in users], [replies.get(e.hash, "") for e in users],
                                           group[0].ts[:10], cands, mem.classes)
    mem.spend(spent)
    return items


def tag_events(mem, users: list, items: list[list], jev: list[dict] | None = None) -> None:
    """Spans checked verbatim, polarity and dates by code (or Jev above its gate); decisions logged before use."""
    from .extract import date_turn, event_decision

    tagger = mem.event_tagger
    version = getattr(tagger, "event_version", tagger.version)
    for n, (e, its) in enumerate(zip(users, items, strict=True)):
        notes = {}
        if mem.decider and jev and jev[n]:
            its, notes = mem.decider.events(its, jev[n])
        dated = date_turn(e.hash, e.text, e.ts, its)  # the time module dates them, in dependency order
        local: dict[str, str] = {}
        decs = []
        for idx, (it, (anc, ref)) in enumerate(zip(its, dated, strict=True)):
            d = event_decision(e.hash, e.text, e.ts, idx, it, mem.classes, f"{tagger.name}/events", version, mem.log_time(), anc)
            local[f"c{idx + 1}"] = d["id"]
            decs.append((d, ref))
        for idx, (d, ref) in enumerate(decs):
            d["anchor_event"] = local.get(ref) if ref else None
            if idx in notes:  # what Jev answered; a class it was unsure of (or found none for) sends the clause slow
                d.update(notes[idx])
                if notes[idx]["jev_slow"] and d["route"] == "fast":
                    d["route"] = "slow"
                d["flags"] = d["flags"] + [f"jev_{k}" for k in notes[idx]["jev_slow"]]
            d = mem.record(d)
            if d["route"] == "fast" and d["object"] and d["object_class"] \
                    and d["object_class"] not in mem.classes.classes_in(d["object"], "object"):
                head = re.findall(r"[A-Za-z][\w'-]*", d["object"])
                if head:  # the tagger filed a new word under a listed class: applied once seen twice
                    mem.classes.propose_word(head[-1], d["object_class"])


def resolve_events(mem) -> None:
    """The slow path for a class off the list; unsettled, an object class is dropped, an action class its event."""
    from .jev import NEW

    done = {d["of"] for d in mem.log.decisions if d.get("step") == "event_resolve"}
    for d in [d for d in mem.log.decisions if d.get("step") == "event" and d["route"] == "slow" and d["id"] not in done]:
        out = dict(d)
        for field, kind in (("action_class", "action"), ("object_class", "object")):
            cls = d.get(field)
            if cls and (not mem.classes.closed(cls) or kind in d.get("jev_slow", ())):
                word = d["action"] if kind == "action" else (d.get("object") or "")
                if mem.decider:
                    got, out[f"jev_{kind}_resolve"] = mem.decider.resolve_class(d["clause"], word, cls, kind, mem.classes)
                    spent = None
                    if got == NEW:  # Jev says no listed class fits: the writer model names the new one
                        got, spent = mem.triage.resolve_class(d["clause"], word, cls, kind, mem.classes)
                    elif got is None and mem.classes.closed(cls):
                        got, out["status"] = cls, "disputed"
                elif mem.classes.closed(cls):  # a listed class Jev doubted, opened without Jev: the tagger's class stands
                    got, spent, out["status"] = cls, None, "disputed"
                else:
                    got, spent = mem.event_tagger.resolve_class(d["clause"], word, cls, kind, mem.classes)
                if spent:
                    mem.spend(spent)
                if got and not mem.classes.closed(got):
                    mem.classes.add_class(got, kind, [word] if word else [])
                out[field] = got
        ok = mem.classes.closed(out["action_class"]) and (out.get("object_class") is None or mem.classes.closed(out["object_class"]))
        mem.record(out | {"id": d["id"] + ":resolve", "step": "event_resolve", "of": d["id"], "route": "fast" if ok else "rejected",
                          "created": mem.log_time()})


def same_event(mem):
    """Jev's check of the identity rule's candidates: each pair asked once and recorded; replays read the record."""
    def same(d: dict, cands: list[dict]) -> list[bool]:
        ids = [f"same:{d['id']}~{s['id']}" for s in cands]
        todo = [(i, s) for i, s in zip(ids, cands, strict=True) if i not in mem.decision_by_id]
        if todo:
            for (i, s), p in zip(todo, mem.decider.same_event(d, [s for _, s in todo]), strict=True):
                mem.decider.yes(p, "same_event")
                mem.record({"id": i, "step": "same_event", "source": d["source"], "a": d["id"], "b": s["id"], "noul": p,
                            "version": mem.decider.version, "created": mem.log_time()})
        return [mem.decision_by_id[i]["noul"] >= mem.decider.threshold for i in ids]
    return same


def fold(decisions: list[dict]) -> Facts:
    """FACTS from zero: the final decision per item, applied in LOG order; pure code, so rebuilds are deterministic."""
    final = {}
    for d in decisions:
        if d["step"] not in ("triage", "resolve"):
            continue  # event decisions build EVENTS, not FACTS
        if d["step"] == "resolve" or d["route"] == "fast":
            final[(d["seq"], d["idx"])] = d
    facts = Facts()
    for k in sorted(final):
        facts.apply(final[k])
    return facts


def full(mem) -> None:
    light(mem)
    done = {(d["seq"], d["idx"]) for d in mem.log.decisions if d["step"] == "resolve"}
    slow = [d for d in mem.log.decisions if d["step"] == "triage" and d["route"] == "slow" and (d["seq"], d["idx"]) not in done]
    hist = lambda key: [f"- {r.value or 'none'}: true from {fmt(date.fromisoformat(r.valid_from))} to {fmt(date.fromisoformat(r.valid_to))}"
                        for r in mem.facts.believed(key)]
    if mem.decider:  # Jev rules: one request per message for its slow items
        by_source: dict[str, list[dict]] = {}
        for d in slow:
            by_source.setdefault(d["source"], []).append(d)
        for src, ds in by_source.items():
            e = mem.log.by_hash[src]
            answers = mem.decider.resolve(e.text, e.ts[:10], ds, {d["key"]: hist(d["key"]) for d in ds})
            for d in ds:
                a = answers.get(d["id"])
                mem.record(resolve_decision(mem, d, e, mem.decider.ruling(d, a)) | {"jev_ruling": a, "writer": "jev/slow"})
        slow = []
    for d in slow:
        e = mem.log.by_hash[d["source"]]
        ruling, spent = mem.triage.resolve(e.text, e.ts[:10], d, hist(d["key"]), d["flags"])
        mem.spend(spent)
        mem.record(resolve_decision(mem, d, e, ruling))
    rebuild(mem)


def rebuild(mem) -> None:
    """The views from the LOG and the judgements so far: pure code, no model call. full() ends here; so does a settle
    while the model is unavailable (turns still waiting for a judgement are searchable, just not tagged)."""
    facts = fold(mem.log.decisions)
    facts.check()  # raises IntegrityError
    old, mem.facts = mem.facts, facts
    if old is not None and old is not facts:
        old.close()
    mem.values = Values(facts)
    now = max((e.ts[:10] for e in mem.log.events), default="0000-00-00")
    mem.index = render(facts, mem.usage, now, mem.index_cap)
    mem.index_strong = strong(facts, now)
    store = None
    if mem.events_on:  # EVENTS after the slow path settles new classes
        from .extract import build

        resolve_events(mem)
        store = build(mem.log.events, mem.log.decisions, mem.classes, mem.log_time(), same_event(mem) if mem.decider else None)
        if mem.events_store is not None and mem._owns_events:
            mem.events_store.close()
        mem.events_store, mem._owns_events = store, True
    mem.search = Search(mem.log.events, mem.values, mem.vocab, event_dates=mem.event_dates, entities=mem.entities,
                        embed_model=mem.embed_model if mem.vectors else None, store=store, stem=mem.stem)
    if mem.events_on and mem.activation:
        from .activation import Graph

        mem.graph = Graph(mem.search, store)
    mem.full_seq = mem.log.last_seq
    mem.n_full += 1
