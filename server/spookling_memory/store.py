"""One memory folder: log.jsonl and judgements.jsonl are the only durable records; every view is rebuilt from them."""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from collections import Counter
from contextlib import contextmanager
from dataclasses import asdict
from pathlib import Path

from . import reset as R
from .reset import now
from .core import SpooklingMemory, models, vectors
from .core import compact as keep
from .core.base import Session, Turn
from .core.sleep import tx_of
from .subscription import backend

LOG, JUDGEMENTS, VECTORS, CACHE = "log.jsonl", "judgements.jsonl", "vectors.sqlite", "cache.sqlite"
PENDING = "pending.json"  # {"tagged_upto": seq} while turns in the LOG still wait for the model; gone when none do
RETRY = 60  # seconds before a model call that failed (not a latched key error) is tried again
WARN = logging.getLogger("uvicorn.error")  # uvicorn's, so it lands in .memory/server.log
WINDOWS = os.name == "nt"
PART = re.compile(r"#(\d+)(?:-(\d+))?")  # a tail part: "#<from>" or "#<from>-<to>"


PROVIDER = {"openrouter": "OpenRouter", "anthropic": "Anthropic"}
KIND = {"credit": "out of credit", "limit": "over its limit", "key": "refused (invalid or disabled)"}


class Busy(RuntimeError):
    """Opening, or a rebuild holds the lock: the API's 503 with Retry-After."""

    retry_after = 5  # seconds


def jsonl(text: str) -> list[str]:
    """Split on newline only: str.splitlines() also splits on U+2028 and U+0085, which JSON keeps raw in strings."""
    return [x.removesuffix("\r") for x in text.split("\n")]


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for n, line in enumerate(jsonl(path.read_text(encoding="utf-8")), 1):
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except ValueError as e:
            raise ValueError(f"{path} line {n} is not JSON ({e}); the file is left as it is") from None
    return out


def load(mem, events: list[dict], decisions: list[dict], tagged: int | None = None) -> None:
    """Replay the records into a fresh adapter, with the side state judging grows; settle() builds the views."""
    for e in events:
        ev = mem.log.append(e["agent"], e["session_id"], e["turn_index"], e["role"], e["ts"], e["text"])
        if ev is None or ev.hash != e["hash"]:
            raise ValueError(f"LOG line seq {e.get('seq')}: a repeated or altered turn")
    for d in decisions:
        mem.record(d)
        replay(mem, d)
    # every stored turn was tagged before it was stored, except those a pending.json says the model never got to
    mem.tag_cursor = mem.log.last_seq if tagged is None else min(tagged, mem.log.last_seq)


def replay(mem, d: dict) -> None:
    """What light() and resolve_events() grow beside a judgement (sleep.py), redone from the judgement alone."""
    step = d["step"]
    if step == "triage" and d.get("key_source") == "model" and d["route"] in ("fast", "slow"):
        mem.vocab.add(d["key"], d["cues"])
    elif step == "event" and d["route"] == "fast" and d.get("object") and d.get("object_class") \
            and d["object_class"] not in mem.classes.classes_in(d["object"], "object"):
        head = re.findall(r"[A-Za-z][\w'-]*", d["object"])
        if head:
            mem.classes.propose_word(head[-1], d["object_class"])
    elif step == "event_resolve" and (src := mem.decision_by_id.get(d["of"])):
        for field, kind in (("action_class", "action"), ("object_class", "object")):
            cls, got = src.get(field), d.get(field)
            if cls and not mem.classes.closed(cls) and got and not mem.classes.closed(got):
                word = src["action"] if kind == "action" else (src.get("object") or "")
                mem.classes.add_class(got, kind, [word] if word else [])
    elif step == "compact" and mem.compact_keep:
        mem.staging += [keep.Kept(**k) for k in d["kept"]]


def append(path: Path, new: list[str]) -> None:
    if new:
        with open(path, "a", encoding="utf-8", newline="\n") as f:
            f.write("".join(x + "\n" for x in new))
            f.flush()
            os.fsync(f.fileno())


def lock(f) -> None:
    """OSError if another open file holds it; the OS drops it when the process ends."""
    if WINDOWS:
        import msvcrt

        f.seek(0)
        msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)


def unlock(f) -> None:
    """Windows may free a closed handle's lock late, so unlock before close."""
    if f.closed:
        return
    if WINDOWS:
        import msvcrt

        f.seek(0)
        msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
    f.close()


class Store:
    """ponytail: one lock for every call; a per-view read lock if retrieval latency under load matters."""

    def __init__(self, folder: str | Path, background: bool = False, wait: float | None = None, **adapter):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self._lockfile = open(self.folder / "lock", "ab")  # never truncated: another process may hold its lock
        try:
            lock(self._lockfile)
        except OSError:
            self._lockfile.close()
            raise RuntimeError(f"{self.folder} is open in another process (one server per memory folder)") from None
        self.adapter, self.lock, self._post, self.mem = adapter, threading.RLock(), None, None
        self.wait, self.ready, self.failed = wait, threading.Event(), None
        self._retry_at, self.model_error = 0.0, None  # when the model may be asked again; its last failure, for status
        vectors.CACHE = self.folder / VECTORS  # ponytail: process-wide, fine for one folder per server process
        models.CACHE_PATH = self.folder / CACHE  # likewise
        if background:
            threading.Thread(target=self._open, name="spookling-open", daemon=True).start()
        else:
            self._open()
            if self.failed is not None:
                raise self.failed

    def _open(self) -> None:
        try:
            with self.lock:
                events, decisions = read_jsonl(self.folder / LOG), read_jsonl(self.folder / JUDGEMENTS)
                self.mem = SpooklingMemory(**self.adapter)
                load(self.mem, events, decisions, self._tagged_upto())
                self.written = (len(events), len(decisions))
                self._settle()  # judges what an earlier run left waiting, if the model answers now
                self._flush()  # a full sleep may judge pending items: those judgements are records too
                self._mark()
        except BaseException as e:
            if self.mem is not None:  # Windows cannot delete its open temp SQLite file
                self.mem.close()
            unlock(self._lockfile)
            self.failed = e
        finally:
            self.ready.set()

    @contextmanager
    def _busy(self, wait: float | None = None):
        """The lock within `wait` seconds, else Busy; core.models' sys.exit() (no key) becomes a RuntimeError."""
        if not self.ready.wait(wait):
            raise Busy(f"{self.folder} is still opening: replaying its records and rebuilding the views")
        if self.failed is not None:
            raise RuntimeError(f"{self.folder} could not be opened: {self.failed}")
        if not self.lock.acquire(timeout=-1 if wait is None else wait):
            raise Busy("the memory is busy: a tagging call or a rebuild of its views holds it")
        try:
            yield
        except SystemExit as e:
            raise RuntimeError(f"the writer model could not be called: {e}") from None
        finally:
            self.lock.release()

    def _flush(self) -> None:
        log, dec = self.mem.log.lines(self.written)
        append(self.folder / LOG, log)  # the LOG first: judgements point into it
        append(self.folder / JUDGEMENTS, dec)
        self.written = (len(self.mem.log.events), len(self.mem.log.decisions))

    def _tagged_upto(self) -> int | None:
        try:
            return int(json.loads((self.folder / PENDING).read_text(encoding="utf-8"))["tagged_upto"])
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def _mark(self) -> None:
        """pending.json says how far the model got while turns wait; it is written before the turns are, removed when none wait."""
        path = self.folder / PENDING
        if self.mem.tag_cursor >= self.mem.log.last_seq:
            path.unlink(missing_ok=True)
            return
        tmp = path.with_name(f"{PENDING}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps({"tagged_upto": self.mem.tag_cursor}) + "\n", encoding="utf-8")
        os.replace(tmp, path)

    def _model_ok(self) -> bool:
        """False once a key error latched (until a restart), and for RETRY seconds after any other model failure."""
        return not models.STOPPED and time.monotonic() >= self._retry_at

    def _model_failed(self, e: BaseException) -> None:
        self.model_error = f"{type(e).__name__}: {e}"[:300]
        if not models.STOPPED:
            self._retry_at = time.monotonic() + RETRY
        WARN.warning("the model could not be called, the turns are kept and judged later (%s)", self.model_error)

    def _settle(self) -> None:
        """Views up to date. Model work that is owed is tried when the model may be asked; if it fails, or may not be asked,
        the views are rebuilt from what is judged so far, so recall still answers (from the verbatim turns)."""
        m = self.mem
        if m.owed() and self._model_ok():
            m.full_seq = -1  # full() judges what is owed, then rebuilds
        elif m.owed():
            if m.log.last_seq > m.full_seq:
                m.rebuild()
            return
        try:
            m.settle()
            self.model_error = None
        except (Exception, SystemExit) as e:  # SystemExit: models._key() with no key
            self._model_failed(e)
            m.rebuild()

    def model_note(self) -> str | None:
        """One line for a caller that saved turns while the model is not working, else None."""
        info = models.stop_info()
        if info:
            return (f"{PROVIDER[info['provider']]} key {KIND[info['kind']]}: the turns are saved and will be judged once the key "
                    f"works; memory extraction is paused until then.")
        if self.mem is not None and self.mem.owed() and self.model_error:
            return "the memory model is not answering: the turns are saved and will be judged later."
        return None

    def records(self) -> tuple[list[dict], list[dict]]:
        return [asdict(e) for e in self.mem.log.events], list(self.mem.log.decisions)

    def _logged(self, session_id: str) -> int:
        """How many turns of the conversation the LOG is past, from its "<id>#<a>" and "<id>#<a>-<b>" parts."""
        parts = Counter(e.session_id for e in self.mem.log.events
                        if e.session_id == session_id or e.session_id.startswith(session_id + "#"))
        upto = 0
        for part, n in parts.items():
            m = PART.fullmatch(part[len(session_id):])
            upto = max(upto, int(m[2]) if m and m[2] else int(m[1]) + n if m else n)
        return upto

    def ingest(self, session_id: str, turns: list[dict], ts: str | None = None, agent: str = "user",
               tail: bool = False, patient: bool = False) -> int:
        """Returns how many turns were new. tail: turns is the whole conversation so far; patient: no wait limit."""
        with self._busy(None if patient else self.wait):
            m = self.mem
            if tail:
                have = self._logged(session_id)
                new = [t for t in turns[have:] if t["content"].strip()]
                if not new:
                    return 0
                part = f"{session_id}#{have}" if len(new) == len(turns) - have else f"{session_id}#{have}-{len(turns)}"
                turns, session_id, ts = new, part, None  # stamped now: the fold needs the LOG in arrival order
            ts = ts or now()
            tx_of(ts, 0, 0)  # a bad timestamp in the LOG would fail every later sleep
            if not R.admits(m.log.decisions, ts):
                raise ValueError(f"session {session_id} at {ts} predates the reset at {R.latest(m.log.decisions)['at']}")
            n = m.append(Session(session_id, agent, ts, [Turn(t["role"], t["content"]) for t in turns]))
            self._mark()  # before the turns, so a stop in between never calls them tagged
            self._flush()  # the turns are durable now; what the model derives from them may fail and is redone later
            if self._model_ok():
                try:
                    m.sleep()
                    self.model_error = None
                except (Exception, SystemExit) as e:
                    self._model_failed(e)
                self._flush()  # judgements made before a failure are records too
            self._mark()
            return n

    def retrieve(self, question: str, ts: str | None = None) -> dict:
        """After a reset, a question about now is answered from the after-reset view."""
        ts = ts or now()
        with self._busy(self.wait):
            self._settle()
            self._flush()
            self._mark()
            r = R.latest(self.mem.log.decisions)
            if r and not R.asks_before(self.mem, question, ts, r):
                return self._view(r).retrieve(question, "user", ts)
            with R.unpinned(self.mem, r):
                return self.mem.retrieve(question, "user", ts)

    def _view(self, r: dict) -> SpooklingMemory:
        """ponytail: rebuilt from zero on every change; grow it in place if the first question after one gets slow."""
        key = (r["id"], len(self.mem.log.events), len(self.mem.log.decisions))
        if self._post is None or self._post[0] != key:
            if self._post is not None:
                self._post[1].close()
            post = SpooklingMemory(**self.adapter)
            load(post, *R.after(*self.records(), r))
            post.settle()  # the main memory settled first, so no model is called here
            self._post = (key, post)
        return self._post[1]

    def compact(self, session_id: str) -> dict:
        """Keep the session's rules, decisions, values, dates, paths and names verbatim; returns <invariant>."""
        with self._busy(self.wait):
            m = self.mem
            evs = [e for e in m.log.events if e.session_id == session_id or e.session_id.startswith(session_id + "#")]
            have = {k.text for k in m.staging}
            new = [k for k in keep.extract(evs) if k.text not in have] if m.compact_keep else []
            if new:
                m.record({"id": R._id("compact", session_id, m.log.last_seq, len(m.log.decisions)), "step": "compact",
                          "session": session_id, "source": evs[-1].hash, "kept": [asdict(k) for k in new], "created": now()})
                m.staging += new
                self._flush()
            with R.unpinned(m, R.latest(m.log.decisions)):
                return {"block": m.invariant_block(), "kept": len(new)}

    def reset(self, note: str = "", at: str | None = None) -> dict:
        with self._busy(self.wait):
            out = R.reset(self.mem, at or now(), note)
            self._flush()
            return out

    def undo_reset(self) -> dict:
        with self._busy(self.wait):
            out = R.undo_reset(self.mem)
            self._flush()
            return out

    def restore(self, events: list[dict], decisions: list[dict]) -> dict:
        with self._busy(self.wait):
            if self.mem.log.events or self.mem.log.decisions:
                raise ValueError("this memory is not empty: import into an empty folder")
            load(self.mem, events, decisions)
            self.mem.settle()
            self._flush()
            return {"events": len(self.mem.log.events), "judgements": len(self.mem.log.decisions)}

    def export(self, path) -> dict:
        from .portability import export

        with self._busy(self.wait):
            return export(self.mem, path)

    def stats(self) -> dict:
        with self._busy(self.wait):
            r = R.latest(self.mem.log.decisions)
            return self.mem.stats() | {"folder": str(self.folder), "before_reset": len(R.before_reset(self.mem)),
                                       "reset": {k: r[k] for k in ("id", "at", "note", "upto")} if r else None,
                                       "model": {"stopped": models.stop_info(), "error": self.model_error,
                                                 "untagged": self.mem.untagged(), "owed": self.mem.owed()},
                                       "tagger": {"model": self.mem.model, "via": backend(self.mem.model),
                                                  "decider": self.mem.decider and self.mem.decider.model}}

    def close(self) -> None:
        """Idempotent; waits for an open or a call in progress."""
        self.ready.wait()
        if self.failed is not None:
            return
        with self._busy():
            if self._post is not None:
                self._post[1].close()
                self._post = None
            self.mem.close()
            unlock(self._lockfile)
