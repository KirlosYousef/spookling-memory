"""The memory folder: the two records on disk, line for line the adapter's own; reopening rebuilds every view."""
import json

import pytest
from conftest import HISTORY, NOW, QUESTIONS, TAGS, Stub, fill, snapshot, turns

from spookling_memory.store import Store


def test_reopen_rebuilds_the_same_views_and_calls_no_model(open_store, tmp_path):
    s = open_store()
    fill(s)
    s.compact("s2")
    s.compact("s3")
    before, snap = [s.retrieve(q, NOW) for q in QUESTIONS], snapshot(s)
    assert snap["events"] and snap["staging"] and snap["rules"]  # the round trip covers every store
    s.close()
    t = open_store()
    assert t.mem.triage.judged == []  # nothing was tagged again
    assert snapshot(t) == snap
    assert [t.retrieve(q, NOW) for q in QUESTIONS] == before
    log, dec = t.mem.log.lines()
    assert (tmp_path / "m" / "log.jsonl").read_text().splitlines() == log
    assert (tmp_path / "m" / "judgements.jsonl").read_text().splitlines() == dec
    assert [json.loads(x)["step"] for x in dec].count("compact") == 2


def test_one_process_per_folder(open_store, tmp_path):
    open_store()
    with pytest.raises(RuntimeError, match="open in another process"):
        Store(tmp_path / "m", triage=Stub(TAGS))


def test_an_altered_log_line_is_refused(open_store, tmp_path):
    s = open_store()
    fill(s, HISTORY[:1])
    s.close()
    path = tmp_path / "m" / "log.jsonl"
    path.write_text(path.read_text().replace("Toyota Corolla", "Tesla Model 3"))
    with pytest.raises(ValueError, match="altered"):
        Store(tmp_path / "m", triage=Stub(TAGS))
    path.write_text(path.read_text().replace("Tesla Model 3", "Toyota Corolla"))
    assert len(open_store().mem.log.events) == 4  # the refused open left the folder unlocked


def test_tail_ingest_logs_only_new_turns(open_store):
    s = open_store()
    conv = turns(["I drive a Toyota Corolla, nothing fancy."])
    assert s.ingest("cc", conv, tail=True) == 2
    assert s.ingest("cc", conv, tail=True) == 0  # a retried hook adds nothing
    conv += turns(["We decided to use Postgres 16 for the shop."])
    assert s.ingest("cc", conv, tail=True) == 2
    assert [e.session_id for e in s.mem.log.events] == ["cc#0", "cc#0", "cc#2", "cc#2"]
    out = s.compact("cc")  # the session id covers its tail parts
    assert out["kept"] == 1 and "We decided to use Postgres 16" in out["block"]
    assert s.compact("cc")["kept"] == 0


def test_a_failed_tagging_call_still_logs_the_turns(open_store, tmp_path):
    class Down(Stub):
        def judge(self, turns, date, known):
            raise ConnectionError("model down")

    s = open_store()
    s.mem.triage = Down(TAGS)
    fill(s, HISTORY[:1])  # no exception: the turns are the truth and the model may fail
    assert len((tmp_path / "m" / "log.jsonl").read_text().splitlines()) == 4
    assert (tmp_path / "m" / "pending.json").exists()  # and they are marked as waiting for the model
    s.mem.triage = Stub(TAGS)
    s._retry_at = 0
    fill(s, HISTORY[1:2])  # the next good call judges both sessions
    assert len((tmp_path / "m" / "log.jsonl").read_text().splitlines()) == 8
    assert not (tmp_path / "m" / "pending.json").exists()
    assert any(d["source"] == s.mem.log.events[0].hash for d in s.mem.log.decisions)
    s.close()
    assert len(open_store().mem.log.events) == 8


def test_a_bad_timestamp_is_refused_before_it_reaches_the_log(open_store):
    s = open_store()
    with pytest.raises(ValueError):
        s.ingest("s1", turns(["I drive a Toyota Corolla, nothing fancy."]), "last tuesday")
    assert s.mem.log.events == []
    fill(s, HISTORY[:1])
    assert len(s.mem.log.events) == 4


def test_a_line_separator_inside_a_turn_survives_a_reopen_and_an_archive(open_store, tmp_path):
    from spookling_memory.portability import read_archive

    text = "Line one line two\u0085three, café \u2014 \U0001F47B"  # JSON keeps U+2028 and U+0085 raw
    s = open_store()
    s.ingest("s1", turns([text]), "2024-05-22T10:00:00Z")
    s.export(tmp_path / "a.spookling")
    s.close()
    assert b"\r\n" not in (tmp_path / "m" / "log.jsonl").read_bytes()  # \n line ends on every OS
    assert open_store().mem.log.events[0].text == text
    assert read_archive(tmp_path / "a.spookling")[0][0]["text"] == text


def test_the_windows_lock_refuses_a_second_open_and_frees_on_close(monkeypatch, tmp_path):
    """msvcrt exists only on Windows: a stand-in with its contract runs the Windows branch here."""
    import os
    import sys
    import types

    from spookling_memory import store as store_mod

    held = {}

    def locking(fd, mode, n):
        key = os.fstat(fd).st_ino
        if mode == 0:
            assert held.pop(key) == fd, "unlocked by a handle that did not lock"
        elif held.setdefault(key, fd) != fd:
            raise PermissionError(13, "Permission denied")

    monkeypatch.setitem(sys.modules, "msvcrt", types.SimpleNamespace(LK_UNLCK=0, LK_NBLCK=2, locking=locking))
    monkeypatch.setattr(store_mod, "WINDOWS", True)
    a = Store(tmp_path / "w", triage=Stub(TAGS))
    with pytest.raises(RuntimeError, match="open in another process"):
        Store(tmp_path / "w", triage=Stub(TAGS))
    a.close()
    a.close()  # idempotent
    assert held == {}  # unlocked before the handle closed
    Store(tmp_path / "w", triage=Stub(TAGS)).close()  # free at once


def test_a_background_open_answers_busy_until_it_is_open(open_store, tmp_path, monkeypatch):
    """Until the open is done a call gets Busy (a 503); so does a rebuild holding the lock past `wait`."""
    import threading

    from spookling_memory import store as store_mod
    from spookling_memory.core import models, vectors

    s = open_store()
    fill(s, HISTORY[:1])
    s.close()
    go = threading.Event()
    real = store_mod.load
    monkeypatch.setattr(store_mod, "load", lambda *a: (go.wait(10), real(*a)))
    b = Store(tmp_path / "m", background=True, wait=0.05, triage=Stub(TAGS))
    with pytest.raises(store_mod.Busy, match="still opening"):
        b.stats()
    go.set()
    assert b.ready.wait(10) and b.stats()["n_events"] == 4
    assert vectors.CACHE == tmp_path / "m" / "vectors.sqlite"
    assert models.CACHE_PATH == tmp_path / "m" / "cache.sqlite"
    got = []
    with b.lock:  # a rebuild in progress on another thread
        t = threading.Thread(target=lambda: got.append(pytest.raises(store_mod.Busy, b.retrieve, "What car?", NOW)))
        t.start()
        t.join(5)
    assert got and "rebuild" in str(got[0].value)
    b.close()


def test_a_failed_background_open_says_why_and_frees_the_folder(open_store, tmp_path):
    s = open_store()
    fill(s, HISTORY[:1])
    s.close()
    (tmp_path / "m" / "log.jsonl").write_text("not json\n")
    b = Store(tmp_path / "m", background=True, wait=1, triage=Stub(TAGS))
    assert b.ready.wait(10)
    with pytest.raises(RuntimeError, match="could not be opened.*not JSON"):
        b.stats()
    b.close()  # nothing to close
    Store(tmp_path / "m2", triage=Stub(TAGS)).close()


def test_a_reopen_with_the_decider_asks_jev_nothing_already_judged(tmp_path, monkeypatch):
    """The decider's same-event answers are judgements on disk: a second open reads them, it does not ask again."""
    from spookling_memory.core import decisions

    asked = []

    def ask(model, state, questions):
        asked.append(len(questions))
        return {q: {"noul": 0.9} if v["type"] == "noul" else
                {"choice": next(iter(v["criteria"])), "confidence": 0.9, "probabilities": {next(iter(v["criteria"])): 0.95}}
                for q, v in questions.items()}

    monkeypatch.setattr(decisions, "ask", ask)
    concert = "I went to a Billie Eilish concert at the Wells Fargo Center"
    a = Store(tmp_path / "j", triage=Stub({}), decider="typesafe/jev-1.14")
    a.ingest("s1", turns([concert + " last Saturday."]), "2025-05-10T10:00:00Z")
    a.ingest("s2", turns([concert + " with my sister."]), "2025-05-20T10:00:00Z")
    a.retrieve("When did I see Billie Eilish?", "2025-06-01T10:00:00Z")  # settles: the same-event question is asked
    assert asked and any(d["step"] == "same_event" for d in a.mem.log.decisions)
    assert a.stats()["tagger"]["decider"] == "typesafe/jev-1.14"  # a string: the Decider object made /v1/stats a 409
    a.close()
    n = len(asked)
    b = Store(tmp_path / "j", triage=Stub({}), decider="typesafe/jev-1.14")
    assert len(asked) == n and b.mem.events_store.rows()  # reopened and rebuilt, nothing asked
    b.close()
