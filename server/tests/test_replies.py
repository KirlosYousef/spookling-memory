"""Every reply Claude showed is logged once, in order, even when it came after an earlier Stop of the same user turn."""
import json

from fastapi.testclient import TestClient

from spookling_memory import hooks
from spookling_memory.api import create_app


def line(kind, content, **more):
    return {"type": kind, "message": {"role": kind, "content": content}, **more}


def say(text):
    return line("assistant", [{"type": "text", "text": text}])


def tool_use(i):
    return line("assistant", [{"type": "tool_use", "id": i, "name": "Agent", "input": {}}])


def tool_result(i):
    return line("user", [{"type": "tool_result", "tool_use_id": i, "content": "ok"}])


def write(path, entries):
    path.write_text("\n".join(json.dumps(e) for e in entries) + "\n", encoding="utf-8")


def stop(c, sid, path, last=""):
    body = {"session_id": sid, "transcript_path": str(path), "hook_event_name": "Stop", "last_assistant_message": last}
    assert c.post("/v1/hook/stop", json=body).status_code == 200


FIRST = [line("user", "Plan the migration."), say("I've sent an explorer to look."), tool_use("t1")]
PLAN = "Here is the plan: " + "step. " * 800  # 4,800 characters
LATER = [tool_result("t1"),
         line("user", "<task-notification>agent done</task-notification>", isMeta=True),
         say(PLAN)]


def test_a_later_reply_after_a_tool_call_is_logged_not_dropped(open_store, tmp_path):
    s = open_store()
    c = TestClient(create_app(s), base_url="http://127.0.0.1:7447")
    path = tmp_path / "s.jsonl"
    write(path, FIRST)
    stop(c, "s", path, "I've sent an explorer to look.")
    assert [e.text for e in s.mem.log.events] == ["Plan the migration.", "I've sent an explorer to look."]
    write(path, FIRST + LATER)
    stop(c, "s", path, PLAN)
    assert [e.text for e in s.mem.log.events][2:] == [PLAN.strip()]  # the plan did not replace the first reply
    before = len(s.mem.log.events)
    stop(c, "s", path, PLAN)
    assert len(s.mem.log.events) == before  # a third Stop adds nothing


def test_the_final_message_the_file_lags_is_added_once(open_store, tmp_path):
    s = open_store()
    c = TestClient(create_app(s), base_url="http://127.0.0.1:7447")
    path = tmp_path / "s.jsonl"
    write(path, FIRST[:2])
    stop(c, "s", path, "I've sent an explorer to look.")
    write(path, FIRST + LATER[:1])  # the file has the tool result only; the Stop hook already knows the reply
    stop(c, "s", path, "Done: the plan is ready.")
    write(path, FIRST + LATER[:1] + [say("Done: the plan is ready.")])
    stop(c, "s", path, "Done: the plan is ready.")
    assert [e.text for e in s.mem.log.events] == ["Plan the migration.", "I've sent an explorer to look.", "Done: the plan is ready."]


def test_an_old_format_log_mid_session_continues_without_duplicates_or_gaps(open_store, tmp_path):
    s = open_store()
    c = TestClient(create_app(s), base_url="http://127.0.0.1:7447")
    path = tmp_path / "s.jsonl"
    # what the version before this one logged: merged turns, "#<from>" parts; the narration was replaced by the later text
    old = [line("user", "Plan the migration."), say("Let me look."), tool_use("t1"), tool_result("t1"), say("Found it."),
           line("user", "Go on."), say("Working."), tool_use("t2")]
    write(path, old)
    s.ingest("s", [{"role": "user", "content": "Plan the migration."}, {"role": "assistant", "content": "Found it."},
                   {"role": "user", "content": "Go on."}, {"role": "assistant", "content": "Working."}], tail=True)
    n = len(s.mem.log.events)
    stop(c, "s", path, "Working.")
    assert len(s.mem.log.events) == n  # nothing is logged twice, nothing is skipped
    write(path, old + [tool_result("t2"), say("The report."), line("user", "Thanks."), say("Welcome.")])
    stop(c, "s", path, "Welcome.")
    assert [e.text for e in s.mem.log.events][n:] == ["The report.", "Thanks.", "Welcome."]
    stop(c, "s", path, "Welcome.")
    assert len(s.mem.log.events) == n + 3


def test_an_old_log_that_lost_a_reply_in_the_last_turn_gets_it_at_the_next_stop(open_store, tmp_path):
    s = open_store()
    c = TestClient(create_app(s), base_url="http://127.0.0.1:7447")
    path = tmp_path / "s.jsonl"
    write(path, FIRST + LATER)
    s.ingest("s", [{"role": "user", "content": "Plan the migration."},
                   {"role": "assistant", "content": "I've sent an explorer to look."}], tail=True)  # the plan was lost
    stop(c, "s", path, PLAN)
    assert [e.text for e in s.mem.log.events][2:] == [PLAN.strip()]


def test_backfill_recovers_lost_replies_once(open_store, tmp_path):
    s = open_store()
    c = TestClient(create_app(s), base_url="http://127.0.0.1:7447")
    path = tmp_path / "s.jsonl"
    entries = FIRST + LATER + [line("user", "Thanks."), say("Welcome.")]
    write(path, entries)
    # the old log: the plan was lost, and the conversation went on after it
    s.ingest("s", [{"role": "user", "content": "Plan the migration."},
                   {"role": "assistant", "content": "I've sent an explorer to look."},
                   {"role": "user", "content": "Thanks."}, {"role": "assistant", "content": "Welcome."}], tail=True)
    n = len(s.mem.log.events)
    body = {"session_id": "s", "transcript_path": str(path)}
    assert c.post("/v1/backfill", json=body).json() == {"logged": 1}
    assert s.mem.log.events[-1].text == PLAN.strip() and len(s.mem.log.events) == n + 1
    assert c.post("/v1/backfill", json=body).json() == {"logged": 0}  # idempotent
    stop(c, "s", path, "Welcome.")
    assert len(s.mem.log.events) == n + 1  # and a Stop after it adds nothing


def test_codex_final_answers_each_stay(open_store, tmp_path):
    s = open_store()
    c = TestClient(create_app(s), base_url="http://127.0.0.1:7447")
    path = tmp_path / "rollout.jsonl"

    def item(role, text, phase=None):
        kind = "input_text" if role == "user" else "output_text"
        return {"type": "response_item", "payload": {"type": "message", "role": role, "phase": phase,
                                                      "content": [{"type": kind, "text": text}]}}

    write(path, [item("user", "Start."), item("assistant", "First answer.", "final_answer")])
    body = {"session_id": "cx", "transcript_path": str(path), "hook_event_name": "Stop", "harness": "codex"}
    c.post("/v1/hook/stop", json=body)
    write(path, [item("user", "Start."), item("assistant", "First answer.", "final_answer"),
                 item("assistant", "Second answer.", "final_answer")])
    c.post("/v1/hook/stop", json=body)
    c.post("/v1/hook/stop", json=body)
    assert [e.text for e in s.mem.log.events] == ["Start.", "First answer.", "Second answer."]


def test_the_cap_ends_a_cut_turn_with_an_ellipsis_and_keeps_a_long_one_whole():
    whole = "word " * 3000  # 15,000 characters: under the cap
    assert hooks.clean(whole) == whole.strip()
    cut = hooks.clean("word " * 5000)
    assert len(cut) <= hooks.TURN_CAP + 2 and cut.endswith("word …")
    assert hooks.TURN_CAP >= 16000
