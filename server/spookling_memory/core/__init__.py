"""The memory algorithm: LOG and DECISIONS are the truth; FACTS, EVENTS, INDEX and SEARCH are views of them."""
from __future__ import annotations

import copy
import json
import re
import threading
from pathlib import Path

from . import compact as keep
from .base import Memory
from .facts import Facts
from .index_page import MIN_STRONG
from .log import Log
from .recall import Search, Values, check, reader_tokens, recall, rung, words
from .sleep import full, light, rebuild
from .triage import WRITER, ModelTriage, Spent, Triage, Vocab

VERSION = "6.1"  # names memory-bench's result files, with a config fingerprint


INVARIANT_CAP = 40  # item lines in <invariant>
RESERVE = 1000  # per reader call: its prompt, the question and the date


def is_idk(response: str) -> bool:
    """The reader's exact abstention string, as memory-bench's judge.is_idk tests it."""
    return re.sub(r"[^a-z' ]", "", response.lower().replace("\u2019", "'")).strip() == "i don't know"


class SpooklingMemory(Memory):
    """Knobs: the keyword arguments below; memory-bench's docs/spookling-adapter.md describes them."""

    name = "spookling"

    def __init__(self, model: str = WRITER, triage: Triage | None = None, k: int = 60, budget: int = 1500,
                 neighbours: int = 2, session_cap: int = 16, aggregate: bool = True, agg_k: float = 2.0,
                 agg_budget: int = 9000, agg_trim: int = 300, guide: bool = False, per_key: int = 3, tau: float = 0.8,
                 sleep_every: str | int = "session", full_every: int = 10, index: str = "undated", index_cap: int = 200,
                 vectors: bool | str = "auto", embed_model: str = "BAAI/bge-small-en-v1.5", rerank: bool | str = "auto",
                 rerank_model: str = "BAAI/bge-reranker-base", rerank_pool: int = 60, rerank_k: int = 8,
                 rerank_mode: str = "order",
                 mapreduce: bool = False, mr_sessions: int = 12, ladder: bool = False, ladder_max: int = 1, selfcheck: bool = False,
                 event_dates: bool = True, entities: bool = True, prefs_on_demand: bool = True, rewrite: str = "off",
                 date_fixes: bool = True, agg_nodiv: bool = True, trim_all: bool = True, stale_label: bool = True,
                 token_cap: int = 10000, compact_keep: bool = True, pin_rules: bool = True, anchor_now: bool = True,
                 events: bool = True, event_tagger="rule", activation: bool = True, activation_cap: int = 10,
                 event_cap: int = 40, timeline: bool = True, stem: bool = True, since_range: bool = True,
                 invariant: bool = True, time: bool = True, decider: str | None = None, decide_threshold: float = 0.8,
                 class_threshold: float = 0.6, class_confidence: float = 0.5):
        index = {True: "always", False: "never"}.get(index, index) if isinstance(index, bool) else index  # the CLI coerces on/off to bool
        if index not in ("undated", "always", "never"):
            raise ValueError(f"index must be undated, always or never, not {index!r}")
        self.model, self.k, self.budget, self.per_key, self.tau = model, k, budget, per_key, tau
        self.neighbours, self.session_cap = neighbours, session_cap
        self.aggregate, self.agg_k, self.agg_budget, self.agg_trim, self.guide = aggregate, agg_k, agg_budget, agg_trim, guide
        self.sleep_every = "session" if str(sleep_every).strip() == "session" else int(str(sleep_every).split()[0])
        self.full_every, self.index_mode, self.index_cap = full_every, index, index_cap
        self.triage = triage if triage is not None else ModelTriage(model)
        from .jev import Decider

        self.decider = Decider(decider, decide_threshold, class_threshold, class_confidence) \
            if decider and str(decider).lower() not in ("off", "none", "false") else None
        from . import vectors as local

        why = local.available()
        self.local_models = why or "on"
        self.vectors = (why is None) if vectors == "auto" else bool(vectors)
        self.rerank = (why is None) if rerank == "auto" else bool(rerank)
        self.embed_model, self.rerank_model, self.rerank_pool, self.rerank_k = embed_model, rerank_model, rerank_pool, rerank_k
        if rerank_mode not in ("order", "top"):
            raise ValueError(f"rerank_mode must be order or top, not {rerank_mode!r}")
        self.rerank_mode = rerank_mode
        self.mapreduce, self.mr_sessions, self.ladder, self.selfcheck = mapreduce, mr_sessions, ladder, selfcheck
        self.ladder_max, self.token_cap, self.compact_keep, self.pin_rules = ladder_max, token_cap, compact_keep, pin_rules
        self.anchor_now = anchor_now
        self.event_dates, self.entities, self.prefs_on_demand = event_dates, entities, prefs_on_demand
        rewrite = {True: "all", False: "off"}.get(rewrite, rewrite) if isinstance(rewrite, bool) else rewrite  # the CLI coerces on/off to bool
        if rewrite not in ("off", "complex", "all"):
            raise ValueError(f"rewrite must be off, complex or all, not {rewrite!r}")
        self.rewrite = rewrite
        self.date_fixes, self.agg_nodiv, self.trim_all, self.stale_label = date_fixes, agg_nodiv, trim_all, stale_label
        self.events_on, self.activation, self.activation_cap, self.event_cap = events, activation, activation_cap, event_cap
        self.timeline, self.stem, self.since_range, self.invariant, self.time = timeline, stem, since_range, invariant, time
        if event_tagger == "rule":
            from .extract import RuleEvents

            self.event_tagger = RuleEvents()
        elif event_tagger == "model":
            self.event_tagger = self.triage
        else:
            self.event_tagger = event_tagger
        self.event_tagger_name = event_tagger if isinstance(event_tagger, str) else getattr(event_tagger, "name", "custom")
        self._lock = threading.Lock()
        self.reset()

    def config(self) -> dict:
        return {"version": VERSION, "model": self.model, "triage": self.triage.name, "triage_version": self.triage.version, "k": self.k,
                "budget": self.budget, "neighbours": self.neighbours, "session_cap": self.session_cap,
                "aggregate": self.aggregate, "agg_k": self.agg_k, "agg_budget": self.agg_budget, "agg_trim": self.agg_trim,
                "guide": self.guide, "vectors": self.vectors and self.embed_model, "rerank": self.rerank and self.rerank_model,
                "rerank_pool": self.rerank_pool, "rerank_k": self.rerank_k, "rerank_mode": self.rerank_mode, "mapreduce": self.mapreduce,
                "mr_sessions": self.mr_sessions, "ladder": self.ladder, "ladder_max": self.ladder_max, "selfcheck": self.selfcheck,
                "token_cap": self.token_cap, "compact_keep": self.compact_keep, "pin_rules": self.pin_rules, "anchor_now": self.anchor_now,
                "event_dates": self.event_dates, "entities": self.entities, "prefs_on_demand": self.prefs_on_demand,
                "rewrite": self.rewrite, "local_models": self.local_models, "date_fixes": self.date_fixes,
                "agg_nodiv": self.agg_nodiv, "trim_all": self.trim_all, "stale_label": self.stale_label,
                "per_key": self.per_key, "tau": self.tau, "sleep_every": self.sleep_every,
                "full_every": self.full_every, "index": self.index_mode, "index_cap": self.index_cap,
                "events": self.events_on, "event_tagger": self.event_tagger_name,
                "event_tagger_version": getattr(self.event_tagger, "event_version", getattr(self.event_tagger, "version", "")),
                "activation": self.activation, "activation_cap": self.activation_cap, "event_cap": self.event_cap,
                "timeline": self.timeline, "stem": self.stem, "since_range": self.since_range, "invariant": self.invariant,
                "time": self.time} | ({"decider": self.decider.model, "decider_version": self.decider.version,
                                       "decide_threshold": self.decider.threshold, "class_threshold": self.decider.class_threshold,
                                       "class_confidence": self.decider.class_confidence} if self.decider else {})

    def reset(self) -> None:
        if getattr(self, "log", None) is not None:  # a reset releases the stores it replaces
            self.log.close()
            self.facts.close()
            if self.events_store is not None and self._owns_events:
                self.events_store.close()
        self.log, self.facts, self.vocab = Log(), Facts(), Vocab()
        from .events import ClassVocab

        self.classes = ClassVocab()  # grown only by the slow path
        self.events_store, self.graph, self._owns_events = None, None, True
        self.values: Values = Values(self.facts)
        self.search: Search | None = None
        self.index = ""
        self.index_strong = 0  # under MIN_STRONG the page is noise and stays out
        self._last = None  # for followup()
        self.staging: list = []  # compact()'s verbatim keepers
        self.usage: dict[tuple[str, str], tuple[int, str]] = {}  # (attribute, item) -> (n_used, last_used)
        self.decision_by_id: dict[str, dict] = {}
        self.tag_cursor = self.full_seq = 0
        self.turns_since_light = self.sessions_since_full = 0
        self.n_light = self.n_full = self.write_calls = self.write_tokens = self.n_write_failures = 0

    def record(self, d: dict) -> dict:
        self.decision_by_id[d["id"]] = d
        return self.log.decide(d)

    def spend(self, s: Spent) -> None:
        self.write_calls += s.calls
        self.write_tokens += s.tokens
        self.n_write_failures += s.failures

    def log_time(self) -> str:
        return self.log.events[-1].ts if self.log.events else ""

    def ingest(self, session) -> None:
        for i, t in enumerate(session.turns):
            if self.log.append(session.agent, session.id, i, t.role, session.ts, t.content) is None:
                continue  # the same turn again: the LOG keeps one
            self.turns_since_light += 1
            if self.sleep_every != "session" and self.turns_since_light >= self.sleep_every:
                light(self)
                self.turns_since_light = 0
        if self.sleep_every == "session":
            light(self)
            self.turns_since_light = 0
        self.sessions_since_full += 1
        if self.full_every and self.sessions_since_full >= self.full_every:
            full(self)
            self.sessions_since_full = 0

    def append(self, session) -> int:
        """The raw turns into the LOG, no model call: how many were new. sleep() judges them, now or later."""
        n = 0
        for i, t in enumerate(session.turns):
            if self.log.append(session.agent, session.id, i, t.role, session.ts, t.content) is not None:
                n += 1
                self.turns_since_light += 1
        return n

    def sleep(self) -> None:
        """The model half of ingest(): judge every turn past tag_cursor. A failure leaves tag_cursor where it got to."""
        light(self)
        self.turns_since_light = 0
        self.sessions_since_full += 1
        if self.full_every and self.sessions_since_full >= self.full_every:
            full(self)
            self.sessions_since_full = 0

    def untagged(self) -> int:
        return sum(e.seq > self.tag_cursor for e in self.log.events)

    def owed(self) -> int:
        """Model work waiting: turns not yet judged, and slow-path items not yet ruled on."""
        triaged = [d for d in self.log.decisions if d["step"] == "triage"]
        ruled = {(d["seq"], d["idx"]) for d in self.log.decisions if d["step"] == "resolve"}
        return self.untagged() + sum(d["route"] == "slow" and (d["seq"], d["idx"]) not in ruled for d in triaged)

    def rebuild(self) -> None:
        """The views without a model call (see sleep.rebuild)."""
        with self._lock:
            rebuild(self)

    def compact(self, session_id: str) -> None:
        """Keep the session's rules, decisions, values, dates, paths and names verbatim, pointing into the LOG."""
        if not self.compact_keep:
            return
        have = {k.text for k in self.staging}
        self.staging += [k for k in keep.extract(e for e in self.log.events if e.session_id == session_id) if k.text not in have]

    def settle(self) -> None:
        """The pass that runs once before questions: a full sleep if anything arrived since the last one."""
        with self._lock:
            if self.log.last_seq > self.full_seq:
                full(self)
                self.sessions_since_full = 0

    def rules(self) -> list[str]:
        """Standing rules, oldest first: kept verbatim at compaction, plus tagged ones no kept rule already holds."""
        kept = [(k.day, k.text) for k in self.staging if k.kind == "rule"]
        tagged = [(r["said"], s) for r in self.facts.rules  # a tagged fragment ("Quokka", "Dr. Rao") is not pinned
                  if (s := self.said_rule(r)) and (keep.is_rule(s) or self._jev_rule(r))
                  and not any(s.lower() in t.lower() for _, t in kept)]
        return [f"- {t} (said {d})" for d, t in sorted(kept + tagged)]

    def _jev_rule(self, r: dict) -> bool:
        """Jev's standing-instruction Noul, beside is_rule(): it catches rules the regex misses ("Call me Dr. Rao")."""
        return self.decider is not None and r.get("p_rule") is not None and r["p_rule"] >= self.decider.threshold

    def said_rule(self, r: dict) -> str:
        """The user's own sentence holding a tagged rule ('' if none), so a rule scoped to one task stays out."""
        ev, frag = self.log.by_hash.get(r["source"]), (r["text"] or "").lower()
        return next((s for s in keep.sentences(ev.text) if frag in s.lower()), "") if ev and frag else ""

    def invariant_block(self) -> str:
        """Rules first, in their own <rules> tag (the runner keys on it), then the newest other keepers."""
        rules = self.rules() if self.pin_rules else []
        room = max(INVARIANT_CAP - len(rules), 0)
        rules = rules[:INVARIANT_CAP]
        rest = [k for k in self.staging if k.kind in ("decision", "failed", "open")]
        rest = sorted(rest, key=lambda k: k.seq)[-room:] if room else []
        parts = []
        if rules:
            parts.append("<rules>\nStanding instructions the user gave, still in force:\n" + "\n".join(rules) + "\n</rules>")
        for kind, title in (("decision", "Decisions:"), ("failed", "Failed attempts:"), ("open", "Open items:")):
            items = [f"- [{k.day}] {k.text}" for k in rest if k.kind == kind]
            if items:
                parts.append(title + "\n" + "\n".join(items))
        return "<invariant>\n" + "\n".join(parts) + "\n</invariant>" if parts else ""

    def kept_lines(self, question: str, limit: int = 12) -> list[str]:
        """Non-rule keepers sharing a content word with the question, most shared first."""
        q = set(words(question))
        skip = {"rule", "decision", "failed", "open"} if self.invariant else {"rule"}
        scored = [(len(q & set(words(k.text))), i, k) for i, k in enumerate(self.staging) if k.kind not in skip]
        best = sorted((x for x in scored if x[0]), key=lambda x: (-x[0], x[1]))[:limit]
        return [f"- [{k.day}, {k.kind}, u{k.seq}] {k.text}" for _, _, k in sorted(best, key=lambda x: x[2].seq)]

    def retrieve(self, question: str, asked_by: str, ts: str) -> dict:
        """{context, digest, strong}; strong: a fact record or an on-subject hit was found (the runner's re-ask)."""
        ctx = self.context(question, asked_by, ts)
        last = self._last or {}
        return {"context": ctx, "digest": last.get("digest", ""), "strong": bool(last.get("strong"))}

    def context(self, question: str, asked_by: str, ts: str) -> str:
        self.settle()
        if self.invariant:
            head = self.invariant_block()
        else:
            rules = self.rules() if self.pin_rules else []
            head = ("<rules>\nStanding instructions the user gave, still in force:\n" + "\n".join(rules) + "\n</rules>") if rules else ""
        kept = self.kept_lines(question) if self.staging else []
        kept_block = ("<kept-before-compaction>\n" + "\n".join(kept) + "\n</kept-before-compaction>") if kept else ""
        page_tokens = reader_tokens(self.index) if self.index else 0
        self._room = self.token_cap - RESERVE - reader_tokens(head + kept_block) - page_tokens  # the recalled block's ceiling
        body, shown, when = recall(self, question, ts)
        for r in shown:  # use counts rank the INDEX; outside FACTS, a refold keeps them
            n, _ = self.usage.get((r.attribute, r.item), (0, ""))
            self.usage[(r.attribute, r.item)] = (n + 1, ts[:10])
        page = self.index_strong >= MIN_STRONG and (self.index_mode == "always" or (self.index_mode == "undated" and when.how == "now"))
        index = f"<memory-index>\n{self.index}\n</memory-index>" if page and self.index else ""
        out = "\n\n".join(x for x in (head, index, kept_block, body) if x)
        if self._last is not None:
            self._last["spent"] = self._last.get("writer_tokens", 0) + reader_tokens(out) + RESERVE
        return out

    def followup(self, question: str, asked_by: str, ts: str, reply: str, step: int) -> tuple[str, str] | None:
        """(context, label) to ask again with, or None: "I don't know" climbs the ladder; a sum gets a self-check."""
        if self._last is None:
            return None
        if is_idk(reply):
            for n in range(1, self.ladder_max + 1) if self.ladder else ():
                if n in self._last["done"]:
                    continue
                self._last["done"].add(n)
                ctx = rung(self, n, question, ts)
                if ctx is None:
                    return None
                if ctx and self._fits(ctx):
                    return ctx, f"rung{n}"
            return None
        ctx = check(self, question, reply, ts) if self.selfcheck else None
        return (ctx, "selfcheck") if ctx and self._fits(ctx) else None

    def _fits(self, ctx: str) -> bool:
        """The per-question cap: a follow-up context is sent only if it fits what is left, and is then counted."""
        cost = reader_tokens(ctx) + RESERVE
        if self._last.get("spent", 0) + cost > self.token_cap:
            self._last["capped"] = self._last.get("capped", 0) + 1
            return False
        self._last["spent"] = self._last.get("spent", 0) + cost
        return True

    def fork(self) -> "SpooklingMemory":
        with self._lock:
            if self.log.last_seq > self.full_seq:
                full(self)
                self.sessions_since_full = 0
            new = copy.copy(self)
            new._lock = threading.Lock()
            new.log, new.facts = Log(self.log), Facts(self.facts)  # SQLite snapshots
            new.vocab, new.triage = copy.deepcopy(self.vocab), copy.deepcopy(self.triage)
            new.event_tagger = new.triage if self.event_tagger is self.triage else copy.deepcopy(self.event_tagger)
            new.classes, new._owns_events = copy.deepcopy(self.classes), False  # EVENTS and the graph: shared, read-only
            new.usage, new.decision_by_id, new.staging = dict(self.usage), dict(self.decision_by_id), list(self.staging)
            return new  # values, search and index are rebuilt, never mutated: shared

    def close(self) -> None:
        """Idempotent; a fork's close() leaves its parent intact."""
        with self._lock:
            if self.log is not None:
                self.log.close()
                self.facts.close()
                if self.events_store is not None and self._owns_events:
                    self.events_store.close()
            self.log = self.facts = self.search = self.values = self._last = None
            self.events_store = self.graph = None
            self.decision_by_id, self.usage, self.staging, self.index = {}, {}, [], ""

    def stats(self) -> dict:
        log_lines, dec_lines = self.log.lines()
        size = lambda xs: sum(len(x.encode()) + 1 for x in xs)
        believed = self.facts.view_lines()
        rows = [json.dumps(r, ensure_ascii=False) for r in self.facts.all_rows()]
        counters = [json.dumps(list(r), ensure_ascii=False) for r in self.facts.db.execute("SELECT * FROM fact_stats")]
        cues = self.search.cue_bytes if self.search else 0
        index = len(self.index.encode()) + len("\n".join(self.rules()).encode()) + sum(len(k.text.encode()) for k in self.staging)
        triaged = [d for d in self.log.decisions if d["step"] == "triage"]
        resolved = [d for d in self.log.decisions if d["step"] == "resolve"]
        return {
            "store_bytes": size(log_lines) + size(dec_lines) + size(rows) + size(counters) + index + cues,
            "view_bytes": size(believed) + index,
            "log_bytes": self.log.text_bytes(),
            "n_events": len(self.log.events), "n_facts": len({(r["attribute"], r["item"]) for r in self.facts.all_rows()
                                                             if r["superseded_at"] == "9999-12-31"}),
            "n_rows": len(rows), "n_decisions": len(self.log.decisions),
            "n_fast": sum(d["route"] == "fast" for d in triaged), "n_slow": sum(d["route"] == "slow" for d in triaged),
            "n_skip": sum(d["route"] == "skip" for d in triaged), "n_rejected": sum(d["route"] == "rejected" for d in triaged),
            "n_disputed": sum(d["status"] == "disputed" for d in resolved),
            "pending_slow": sum(d["route"] == "slow" for d in triaged) - len(resolved),
            "n_rules": len(self.facts.rules), "index_lines": self.index.count("\n") + bool(self.index),
            "n_light": self.n_light, "n_full": self.n_full, "write_calls": self.write_calls,
            "write_tokens": self.write_tokens, "n_write_failures": self.n_write_failures,
        }

    def dump(self, dir: str | Path) -> None:
        out = Path(dir)
        out.mkdir(parents=True, exist_ok=True)
        self.log.dump(out)
        (out / "facts.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in self.facts.all_rows()))
        (out / "INDEX.md").write_text(self.index + "\n")
        (out / "vocab.json").write_text(json.dumps(self.vocab.words, indent=1, ensure_ascii=False) + "\n")
        if self.events_store is not None:
            (out / "events.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in self.events_store.rows()))


__all__ = ["SpooklingMemory", "Triage", "ModelTriage"]
