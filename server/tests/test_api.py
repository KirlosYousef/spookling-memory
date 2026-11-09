"""The HTTP API through FastAPI's TestClient, and the hooks' server side on a fake Claude Code transcript."""
import json
import os

import pytest
from conftest import HISTORY, NOW, TAGS, Stub, turns
from fastapi.testclient import TestClient

from spookling_memory import hooks
from spookling_memory.api import create_app
from spookling_memory.core.recall import ABSTAIN


def client(store):
    return TestClient(create_app(store), base_url="http://127.0.0.1:7447")


def test_every_endpoint(open_store):
    store = open_store("a")
    c = client(store)
    for sid, ts, users in HISTORY:
        assert c.post("/v1/ingest", json={"id": sid, "ts": ts, "turns": turns(users)}).json() == {"logged": 2 * len(users)}
    kept = c.post("/v1/compact", json={"session_id": "s3"}).json()
    assert kept["kept"] == 1 and "always answer in metric units" in kept["block"]
    archive = c.get("/v1/export")
    assert archive.status_code == 200 and archive.headers["content-type"] == "application/gzip"
    q = {"question": "What car do I drive?", "ts": NOW}
    got = c.post("/v1/retrieve", json=q).json()
    assert set(got) == {"context", "digest", "strong"} and "Toyota Corolla" in got["context"] and got["strong"]
    stats = c.get("/v1/stats").json()
    assert stats["n_events"] == 12 and stats["reset"] is None and stats["before_reset"] == 0

    other = client(open_store("b"))
    restored = other.post("/v1/import", content=archive.content, headers={"content-type": "application/octet-stream"})
    assert restored.json() == {"events": 12, "judgements": stats["n_decisions"]}
    assert other.post("/v1/retrieve", json=q).json() == got
    again = other.post("/v1/import", content=archive.content, headers={"content-type": "application/octet-stream"})
    assert again.status_code == 409 and "not empty" in again.json()["detail"]

    r = c.post("/v1/reset", json={"note": "fresh start"}).json()  # at now: after every turn above
    assert r["step"] == "reset" and r["note"] == "fresh start"
    assert c.post("/v1/retrieve", json={"question": "What car do I drive?"}).json()["context"] == ABSTAIN
    assert c.get("/v1/stats").json()["reset"]["id"] == r["id"]
    assert c.post("/v1/reset/undo", json={}).json()["of"] == r["id"]
    assert "Toyota Corolla" in c.post("/v1/retrieve", json={"question": "What car do I drive?"}).json()["context"]
    assert c.post("/v1/reset/undo", json={}).status_code == 409


def test_guards(open_store):
    store = open_store()
    assert TestClient(create_app(store), base_url="http://memory.attacker.example").get("/v1/stats").status_code == 400
    c = client(store)
    assert c.post("/v1/reset", content='{"note": ""}', headers={"content-type": "text/plain"}).status_code == 415
    assert c.post("/v1/reset/undo").status_code == 415  # no content type: a page could send that without a preflight
    assert c.post("/v1/import", content=b"junk", headers={"content-type": "application/octet-stream"}).status_code == 409
    assert c.post("/v1/hook/session-start", json={}).status_code == 404
    bad = {"id": "x", "turns": [{"role": "system", "content": "hi"}]}
    assert c.post("/v1/ingest", json=bad).status_code == 422
    assert c.get("/v1/stats").json()["n_events"] == 0


def write_transcript(path, entries):
    path.write_text("".join(json.dumps(e) + "\n" for e in entries))


TRANSCRIPT = [
    {"type": "summary", "summary": "Car chat"},
    {"type": "user", "isMeta": True, "message": {"role": "user", "content": "<local-command-caveat>ignore</local-command-caveat>"}},
    {"type": "user", "message": {"role": "user", "content": "<command-name>/clear</command-name>"}},
    {"type": "user", "message": {"role": "user", "content": "I drive a Toyota Corolla, nothing fancy."}},
    {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "thinking", "thinking": "..."}, {"type": "text", "text": "Noted."},
        {"type": "tool_use", "id": "t1", "name": "Read", "input": {}}]}},
    {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "x"}]}},
    {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Anything else?"}]}},
    {"type": "user", "isSidechain": True, "message": {"role": "user", "content": "a subagent's prompt"}},
    {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text":
        '<recalled-data now="x">\nuser: I drive a Toyota Corolla\n</recalled-data>\nFrom now on, always answer in metric units.'}]}},
]


def test_hooks_log_the_transcript_and_recall_for_the_prompt(open_store, tmp_path):
    store = open_store()
    c = client(store)
    path = tmp_path / "abc.jsonl"
    write_transcript(path, TRANSCRIPT)
    assert hooks.turns(path) == [
        {"role": "user", "content": "I drive a Toyota Corolla, nothing fancy."},
        {"role": "assistant", "content": "Noted."},  # each reply is its own entry: the text before a tool call is kept too
        {"role": "assistant", "content": "Anything else?"},
        {"role": "user", "content": "From now on, always answer in metric units."}]  # our own recalled block stripped
    base = {"session_id": "abc", "transcript_path": str(path), "cwd": str(tmp_path)}
    prompt = {**base, "hook_event_name": "UserPromptSubmit", "prompt": "What car do I drive?"}
    empty = c.post("/v1/hook/user-prompt-submit", json=prompt)
    assert empty.json() == {} and hooks.PULSE not in empty.headers  # nothing recalled, nothing to count

    stop = {**base, "hook_event_name": "Stop", "stop_hook_active": False}
    r = c.post("/v1/hook/stop", json=stop)
    assert r.json() == {} and hooks.PULSE not in r.headers
    assert [(e.session_id, e.role) for e in store.mem.log.events] == [("abc#e0-4", "user"), ("abc#e0-4", "assistant"),
                                                                  ("abc#e0-4", "assistant"), ("abc#e0-4", "user")]
    c.post("/v1/hook/stop", json=stop)
    assert len(store.mem.log.events) == 4

    r = c.post("/v1/hook/user-prompt-submit", json=prompt)
    out = r.json()["hookSpecificOutput"]
    assert out["hookEventName"] == "UserPromptSubmit" and "Toyota Corolla" in out["additionalContext"]
    assert len(out["additionalContext"]) <= hooks.CAP
    assert json.loads(r.headers[hooks.PULSE]) == hooks.counts(out["additionalContext"])  # the status line's numbers
    assert hooks.counts(out["additionalContext"])["chats"] >= 1

    write_transcript(path, TRANSCRIPT + [
        {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Metric it is."}]}},
        {"type": "user", "message": {"role": "user", "content": "We decided to use Postgres 16 for the shop."}}])
    pre = {**base, "hook_event_name": "PreCompact", "trigger": "auto", "custom_instructions": ""}
    r = c.post("/v1/hook/pre-compact", json=pre)
    assert r.json() == {}
    assert [e.session_id for e in store.mem.log.events][4:] == ["abc#e4-6", "abc#e4-6"]
    assert {k.kind for k in store.mem.staging} == {"rule", "decision"}
    assert json.loads(r.headers[hooks.PULSE]) == {"kept": 2, "rules": 1, "lines": 2}

    gone = {**stop, "transcript_path": str(tmp_path / "missing.jsonl")}
    assert c.post("/v1/hook/stop", json=gone).json() == {}


def test_counts_reads_each_kind_of_line_in_a_recall_block():
    ctx = ("<rules>\nStanding instructions the user gave, still in force:\n- Always answer in metric units. (said 2024-05-22)\n"
           "- Call me Dr. Rao. (said 2024-05-23)\n</rules>\n\n"
           '<recalled-data now="in force now (24 Oct 2026)">\n<timeline>\nE1 once [buy; car] "bought a Corolla" (said 2 May 2024)\n'
           "</timeline>\n[22 May 2024] user: I drive a Toyota Corolla\n[...]\nassistant: Noted.\n[3 Jun 2024] (latest mention) user: still the Corolla\n"
           '[u12, chat of 3 Jun 2024] car: "Corolla"\n'
           'car: Toyota Corolla (true from 22 May 2024 to now; in force now (24 Oct 2026); said 22 May 2024: "I drive a Toyota Corolla")\n'
           "</recalled-data>")
    assert hooks.counts(ctx) == {"facts": 1, "rules": 2, "events": 1, "chats": 2, "chars": len(ctx), "cap": hooks.CAP}
    assert hooks.counts("")["facts"] == hooks.counts("Nothing on record about this.")["chats"] == 0


@pytest.mark.parametrize("prompt", ["", "   "])
def test_an_empty_prompt_injects_nothing(open_store, prompt):
    c = client(open_store())
    assert c.post("/v1/hook/user-prompt-submit", json={"session_id": "x", "prompt": prompt}).json() == {}


def test_a_missing_model_key_still_saves_the_turns_and_the_server_lives(open_store):
    class NoKey(Stub):
        def judge(self, turns, date, known):
            raise SystemExit("OPENROUTER_API_KEY is not set")  # what core.models does

    store = open_store()
    c = client(store)
    store.mem.triage = NoKey(TAGS)
    r = c.post("/v1/ingest", json={"id": "s1", "ts": "2024-05-22T10:00:00Z", "turns": turns(["I drive a Toyota Corolla, nothing fancy."])})
    assert r.status_code == 200 and r.json()["logged"] == 2 and "not answering" in r.json()["note"]  # saved, judged later
    assert "OPENROUTER_API_KEY" in c.get("/v1/stats").json()["model"]["error"]
    store.mem.triage = Stub(TAGS)
    store._retry_at = 0
    assert c.post("/v1/ingest", json={"id": "s2", "ts": "2024-05-23T10:00:00Z", "turns": turns(["How do I roast peppers?"])}).json() == {"logged": 2}
    assert c.get("/v1/stats").json()["n_events"] == 4


def test_injected_context_fits_claude_codes_cap():
    ghost = "\U0001F47B"  # two UTF-16 units, as Claude Code (JavaScript) counts it
    assert hooks.CAP == 10_000
    out = hooks.cap("a" + ghost * 6000)
    assert len(out.encode("utf-16-le")) // 2 <= hooks.CAP and out == "a" + ghost * 4999  # never half an emoji
    assert hooks.cap("short") == "short"


def test_stop_adds_the_final_reply_the_transcript_has_not_caught_up_with(open_store, tmp_path):
    store = open_store()
    c = client(store)
    path = tmp_path / "lag.jsonl"
    write_transcript(path, [{"type": "user", "message": {"role": "user", "content": "I drive a Toyota Corolla, nothing fancy."}}])
    stop = {"session_id": "lag", "transcript_path": str(path), "hook_event_name": "Stop", "stop_hook_active": False,
            "last_assistant_message": "Noted, a Corolla."}
    c.post("/v1/hook/stop", json=stop)
    assert [(e.role, e.text) for e in store.mem.log.events] == [
        ("user", "I drive a Toyota Corolla, nothing fancy."), ("assistant", "Noted, a Corolla.")]
    write_transcript(path, [  # the file caught up, and the next turn came in
        {"type": "user", "message": {"role": "user", "content": "I drive a Toyota Corolla, nothing fancy."}},
        {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Noted, a Corolla."}]}},
        {"type": "user", "message": {"role": "user", "content": "How do I roast peppers?"}}])
    c.post("/v1/hook/stop", json={**stop, "last_assistant_message": "Under the grill."})
    assert [e.text for e in store.mem.log.events][2:] == ["How do I roast peppers?", "Under the grill."]  # no repeat


@pytest.mark.skipif(os.name == "nt", reason="the server in WSL reading a Windows client's path")
def test_a_windows_transcript_path_is_read_through_the_wsl_mount(monkeypatch, tmp_path):
    monkeypatch.setattr(hooks, "MNT", tmp_path)
    (tmp_path / "c" / "Users" / "Jane Doe" / ".claude").mkdir(parents=True)
    want = tmp_path / "c" / "Users" / "Jane Doe" / ".claude" / "s.jsonl"
    assert hooks.local_path("C:\\Users\\Jane Doe\\.claude\\s.jsonl") == want
    assert hooks.local_path("c:/Users/Jane Doe/.claude/s.jsonl") == want
    assert hooks.local_path("D:\\nope\\s.jsonl") == hooks.Path("D:\\nope\\s.jsonl")  # no such mount: as given
    assert hooks.local_path("/home/a/s.jsonl") == hooks.Path("/home/a/s.jsonl")


STOP = {"session_id": "s", "cwd": "/home/a", "hook_event_name": "Stop", "stop_hook_active": False,
        "background_tasks": [], "session_crons": []}


def post_stop(c, body: bytes):
    return c.post("/v1/hook/stop", content=body, headers={"content-type": "application/json"})


def test_hook_empty_body_is_200(open_store):
    c = client(open_store())
    assert (post_stop(c, b"").status_code, post_stop(c, b"").json()) == (200, {})  # was 422 "Field required"
    assert post_stop(c, b"\n").json() == {}  # was 422 "JSON decode error"


def test_hook_subagent_body_is_200_and_logs_no_sidechain(open_store, tmp_path):
    store = open_store()
    path = tmp_path / "agent-a1.jsonl"
    write_transcript(path, [{"type": "user", "isSidechain": True, "agentId": "a1", "message": {"role": "user", "content": "Do X."}},
                            {"type": "assistant", "isSidechain": True, "agentId": "a1",
                             "message": {"role": "assistant", "content": [{"type": "text", "text": "Done."}]}}])
    body = {**STOP, "agent_id": "a1", "agent_type": "general-purpose", "transcript_path": str(path),
            "last_assistant_message": "Done."}
    assert post_stop(client(store), json.dumps(body).encode()).json() == {}
    assert store.mem.log.events == []  # a subagent's work is not the user's conversation


def test_hook_non_jsonl_transcript_is_200(open_store, tmp_path):
    store = open_store()
    (tmp_path / "t.txt").write_text("I drive a Toyota Corolla.")
    assert post_stop(client(store), json.dumps({**STOP, "transcript_path": str(tmp_path / "t.txt")}).encode()).json() == {}
    assert store.mem.log.events == []


def test_hook_large_last_message_is_200_and_capped(open_store, tmp_path):
    store = open_store()
    path = tmp_path / "big.jsonl"
    write_transcript(path, [{"type": "user", "message": {"role": "user", "content": "Summarise the report."}}])
    big = {**STOP, "transcript_path": str(path), "last_assistant_message": "The report says a lot. " * 250_000}  # 5.7 MB
    r = post_stop(client(store), json.dumps(big).encode())
    assert (r.status_code, r.json()) == (200, {})
    reply = store.mem.log.events[-1]
    assert reply.role == "assistant" and len(reply.text) <= hooks.TURN_CAP + 2 and reply.text.endswith(" …")


def test_hook_raw_control_character_is_200(open_store):
    body = json.dumps({**STOP, "transcript_path": "/nope.jsonl"})[:-1] + ', "last_assistant_message": "a\tb"}'
    assert post_stop(client(open_store()), body.encode()).status_code == 200  # strict JSON refuses a raw tab


@pytest.mark.parametrize("body,why", [
    (b"hello", "not JSON"), (json.dumps({**STOP, "last_assistant_message": "x" * 9000}).encode()[:4096], "not JSON"),
    (b"[]", "JSON list, not an object"), (b"null", "JSON NoneType, not an object")])
def test_hook_garbage_is_400_with_the_reason_logged_once(open_store, caplog, body, why):
    c = client(open_store())
    for _ in range(2):
        r = post_stop(c, body)
        assert r.status_code == 400 and why in r.json()["detail"]
    assert sum("refused" in m for m in caplog.messages) == 1  # once per kind, not per request


def test_busy_is_a_503_with_retry_after(open_store):
    store = open_store()
    store.wait = 0.05
    with store.lock:  # a rebuild in progress elsewhere
        r = client(store).get("/v1/stats")
    assert r.status_code == 503 and r.headers["retry-after"] == "5" and "busy" in r.json()["detail"]


DEV = [  # a prompt with a paste, tool calls, narration, a task notification and a reminder
    {"type": "user", "message": {"role": "user", "content": "Why is the deploy failing? Here is the log:\n"
        "<pasted_content id=\"a1\">\nexport AWS_SECRET_ACCESS_KEY=\"abc\"\n</pasted_content id=\"a1\">\n"
        "2026-10-22T21:55:45Z ERROR deploy failed\n{\"status\": 500,\n  \"error\": \"boom\"\n}\n[Image #3] see this"}},
    {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "text", "text": "Let me read the workflow."}, {"type": "tool_use", "id": "t1", "name": "Read", "input": {}}]}},
    {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "yaml"}]}},
    {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text":
        "The deploy needs a new Haiku spend.\n```yaml\nruns-on: ubuntu\n```\nTraceback (most recent call last):\n"
        "I moved the job to the dev runner, key sk-or-v1-0123456789abcdef0123456789."}]}},
    {"type": "user", "message": {"role": "user", "content": "<task-notification>\n<task-id>b1</task-id>\n"
        "<result>Agent report: finishing needs new Haiku spend</result>\n</task-notification>"}},
    {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "The agent is done."}]}},
    {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text":
        "<system-reminder>Tool list changed.</system-reminder>\nGreat, ship it to dev."}]}},
]


def test_turns_keep_the_users_words_and_every_assistant_reply(tmp_path):
    path = tmp_path / "dev.jsonl"
    write_transcript(path, DEV)
    assert hooks.turns(path) == [
        {"role": "user", "content": "Why is the deploy failing? Here is the log:\n\nsee this"},
        {"role": "assistant", "content": "Let me read the workflow."},  # narration before a tool call is a reply too
        {"role": "assistant", "content": "The deploy needs a new Haiku spend.\n\n"
                                         "I moved the job to the dev runner, key [secret]."},
        {"role": "user", "content": ""},  # a task notification holds its place, empty
        {"role": "assistant", "content": "The agent is done."},
        {"role": "user", "content": "Great, ship it to dev."}]


def test_clean_drops_code_logs_json_and_caps():
    assert hooks.clean("ok\n```\nprint(1)\n") == "ok"  # an unclosed fence runs to the end
    assert hooks.clean("$ uv run pytest\n>>> 1 + 1\n@@ -1,2 +1,2 @@\nINFO:     started\nreal words") == "real words"
    assert hooks.clean("Sep 24 │ Layla │ cancelled\ne26bd2f7787b3e769676d1ad8c1c11eb1da6153954ae73\nwhy?") == "why?"
    assert hooks.clean("[a link](http://x) stays") == "[a link](http://x) stays"
    long = hooks.clean("word " * 5000)
    assert len(long) <= hooks.TURN_CAP + 2 and long.endswith("word …")


def test_empty_turns_hold_their_place_and_old_parts_still_line_up(open_store, tmp_path):
    store = open_store()
    c = client(store)
    path = tmp_path / "dev.jsonl"
    write_transcript(path, DEV)
    c.post("/v1/hook/stop", json={**STOP, "session_id": "dev", "transcript_path": str(path)})
    assert [e.session_id for e in store.mem.log.events] == ["dev#e0-6"] * 5  # 6 places, the empty one not logged
    write_transcript(path, DEV + [
        {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Shipped."}]}}])
    c.post("/v1/hook/stop", json={**STOP, "session_id": "dev", "transcript_path": str(path)})
    assert [(e.session_id, e.text) for e in store.mem.log.events][5:] == [("dev#e6-7", "Shipped.")]
    # a session logged before this change counted merged turns ("old#0" = 5 places, the notification's too), and a later reply
    # replaced the narration before it: only what comes after the last logged text is new
    store.ingest("old", [{"role": "user", "content": "Why is the deploy failing? Here is the log:\n\nsee this"},
                         {"role": "assistant", "content": "The deploy needs a new Haiku spend.\n\n"
                                                          "I moved the job to the dev runner, key [secret]."},
                         {"role": "user", "content": ""}, {"role": "assistant", "content": "The agent is done."},
                         {"role": "user", "content": "Great, ship it to dev."}], tail=True)
    write_transcript(path, DEV + [
        {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Shipped."}]}}])
    c.post("/v1/hook/stop", json={**STOP, "session_id": "old", "transcript_path": str(path)})
    assert [(e.session_id, e.text) for e in store.mem.log.events if e.session_id.startswith("old#")][4:] == [("old#e6-7", "Shipped.")]
