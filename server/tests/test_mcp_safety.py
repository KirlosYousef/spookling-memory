"""MCP write tools: sharing needs the user's yes (elicitation), and archives stay inside ~/.spookling/exports/."""
import asyncio
import json
import os
import subprocess
import sys

import pytest

from spookling_memory import mcp as M


class Res:
    def __init__(self, action, confirm=None):
        self.action = action
        self.data = None if confirm is None else type("D", (), {"confirm": confirm})()


class Ctx:
    def __init__(self, answer=None, boom=False):
        self.answer, self.boom, self.asked = answer, boom, []

    async def elicit(self, message, schema):
        self.asked.append(message)
        if self.boom:
            raise RuntimeError("client does not support elicitation")
        return self.answer


@pytest.fixture
def team(monkeypatch):
    calls = []

    def fake(name, args):
        calls.append((name, args))
        if name == "share-target":
            if args["kind"] == "project":
                return {"orgId": "o1", "orgName": "Acme", "count": 7}
            return {"orgId": "o1", "orgName": "Acme", "title": "Fix the login bug", "project": "shop"}
        return {"ok": True, "name": name}

    monkeypatch.setattr(M, "_team", fake)
    return calls


def run(coro):
    return asyncio.run(coro)


def acted(calls):
    return [c for c in calls if c[0] in ("share", "autoshare")]


def test_tools_are_still_listed_without_a_ctx_argument():
    tools = {t.name: t for t in run(M.server.list_tools())}
    assert {"memory_share", "memory_autoshare"} <= set(tools)
    assert "ctx" not in tools["memory_share"].input_schema.get("properties", {})
    assert "colleague" in tools["memory_share"].description and "colleague" in tools["memory_autoshare"].description


def test_share_asks_naming_the_session_and_the_org_then_acts_on_yes(team):
    ctx = Ctx(Res("accept", True))
    out = run(M.memory_share("sid1", True, "acme", ctx))
    assert out == {"ok": True, "name": "share"}
    assert "Fix the login bug" in ctx.asked[0] and "Acme" in ctx.asked[0]
    assert acted(team) == [("share", {"sessionId": "sid1", "share": True, "org": "o1"})]  # the org it asked about, by id


@pytest.mark.parametrize("answer", [Res("decline"), Res("cancel"), Res("accept", False), Res("accept")])
def test_share_does_nothing_without_a_clear_yes(team, answer):
    out = run(M.memory_share("sid1", True, "acme", Ctx(answer)))
    assert out["ok"] is False and acted(team) == []


def test_share_without_elicitation_returns_the_cli_command(team):
    for ctx in (Ctx(boom=True), None):
        out = run(M.memory_share("sid1", True, "acme", ctx))
        assert out["ok"] is False and "spookling share sid1 --org Acme" in out["message"]
    assert acted(team) == []


def test_unshare_needs_no_confirmation(team):
    ctx = Ctx(boom=True)
    run(M.memory_share("sid1", False, "", ctx))
    assert ctx.asked == [] and acted(team) == [("share", {"sessionId": "sid1", "share": False, "org": ""})]


def test_autoshare_backfill_names_project_org_and_count(team):
    ctx = Ctx(Res("accept", True))
    run(M.memory_autoshare("shop", True, "acme", True, ctx))
    msg = ctx.asked[0]
    assert "'shop'" in msg and "Acme" in msg and "7 session" in msg
    assert acted(team) == [("autoshare", {"project": "shop", "enabled": True, "org": "o1", "backfill": True})]


def test_autoshare_without_backfill_does_not_mention_a_count(team):
    ctx = Ctx(Res("accept", True))
    run(M.memory_autoshare("shop", True, "acme", False, ctx))
    assert "7 session" not in ctx.asked[0]
    assert acted(team)[0][1]["backfill"] is False


def test_backfill_is_never_accepted_without_confirmation(team):
    for ctx in (Ctx(Res("decline")), Ctx(boom=True), None):
        out = run(M.memory_autoshare("shop", True, "acme", True, ctx))
        assert out["ok"] is False
        assert "spookling autoshare shop on --org Acme --backfill" in out["message"] or "did not confirm" in out["message"]
    assert acted(team) == []


def test_autoshare_off_needs_no_confirmation_and_never_backfills(team):
    ctx = Ctx(boom=True)
    run(M.memory_autoshare("shop", False, "", True, ctx))
    assert ctx.asked == []
    assert acted(team) == [("autoshare", {"project": "shop", "enabled": False, "org": "", "backfill": False})]


def test_a_target_error_is_returned_and_nothing_is_asked(team, monkeypatch):
    monkeypatch.setattr(M, "_team", lambda n, a: {"error": "Which org? A, B."})
    ctx = Ctx(Res("accept", True))
    assert run(M.memory_share("sid1", True, "", ctx)) == {"error": "Which org? A, B."}
    assert ctx.asked == []


SERVER = """
from spookling_memory import mcp as M
M._team = lambda n, a: {"orgId": "o1", "orgName": "Acme", "count": 7} if n == "share-target" else {"ok": True, "did": n}
M.server.run("stdio")
"""


def stdio_call(caps, reply):
    """A real stdio session in protocol 2025-06-18, as Claude Code and Codex speak it. Returns (asked, tool result text)."""
    p = subprocess.Popen([sys.executable, "-c", SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

    def send(o):
        p.stdin.write(json.dumps(o) + "\n")
        p.stdin.flush()

    def recv():
        return json.loads(p.stdout.readline())

    try:
        send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": caps, "clientInfo": {"name": "t", "version": "0"}}})
        recv()
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
            "name": "memory_autoshare", "arguments": {"project": "shop", "org": "acme", "backfill": True}}})
        asked = []
        while True:
            m = recv()
            if m.get("method") == "elicitation/create":
                asked.append(m["params"]["message"])
                send({"jsonrpc": "2.0", "id": m["id"], **reply})
            elif m.get("id") == 2:
                return asked, m["result"]["content"][0]["text"]
    finally:
        p.kill()


def test_elicitation_over_stdio_accept():
    asked, text = stdio_call({"elicitation": {}}, {"result": {"action": "accept", "content": {"confirm": True}}})
    assert "'shop'" in asked[0] and "Acme" in asked[0] and "7 session" in asked[0]
    assert '"did": "autoshare"' in text


def test_elicitation_over_stdio_decline_and_unticked():
    for result in ({"action": "decline"}, {"action": "cancel"}, {"action": "accept", "content": {"confirm": False}}):
        asked, text = stdio_call({"elicitation": {}}, {"result": result})
        assert asked and '"did"' not in text and "did not confirm" in text


def test_a_client_that_cannot_elicit_is_never_asked_and_gets_the_command():
    asked, text = stdio_call({}, {"result": {"action": "accept", "content": {"confirm": True}}})
    assert asked == [] and "spookling autoshare shop on --org Acme --backfill" in text and '"did"' not in text


def test_a_client_that_errors_on_the_request_gets_the_command():
    asked, text = stdio_call({"elicitation": {}}, {"error": {"code": -32601, "message": "Method not found"}})
    assert asked and "spookling autoshare shop on --org Acme --backfill" in text and '"did"' not in text


# --- export and import ---

@pytest.fixture
def exports(tmp_path, monkeypatch):
    d = tmp_path / "exports"
    monkeypatch.setattr(M, "EXPORTS", d)
    monkeypatch.setattr(M, "call", lambda path, body=None, raw=None: b"ARCHIVE" if path == "/v1/export" else {"raw": raw})
    return d


def test_export_goes_inside_the_exports_folder_0700_and_0600(exports):
    p = M.memory_export("a.spookling")
    assert p == str(exports / "a.spookling")
    assert (exports / "a.spookling").read_bytes() == b"ARCHIVE"
    if os.name != "nt":  # Windows has no POSIX mode bits
        assert exports.stat().st_mode & 0o777 == 0o700
        assert (exports / "a.spookling").stat().st_mode & 0o777 == 0o600


def test_export_refuses_to_overwrite_unless_asked(exports):
    M.memory_export("a.spookling")
    with pytest.raises(ValueError, match="overwrite"):
        M.memory_export("a.spookling")
    (exports / "a.spookling").write_bytes(b"old")
    M.memory_export("a.spookling", overwrite=True)
    assert (exports / "a.spookling").read_bytes() == b"ARCHIVE"


@pytest.mark.parametrize("bad", ["../x", "sub/../../x", "/etc/cron.d/x", "~/.ssh/authorized_keys", "/tmp/x"])
def test_export_and_import_refuse_paths_outside(exports, bad, tmp_path):
    with pytest.raises(ValueError):
        M.memory_export(bad)
    with pytest.raises(ValueError):
        M.memory_import(bad)
    assert not (tmp_path / "x").exists()


def test_a_symlink_cannot_lead_out(exports, tmp_path):
    exports.mkdir()
    (exports / "link").symlink_to(tmp_path)
    with pytest.raises(ValueError):
        M.memory_export("link/x")


def test_import_reads_from_the_folder_by_name_or_full_path(exports):
    exports.mkdir()
    (exports / "a.spookling").write_bytes(b"DATA")
    assert M.memory_import("a.spookling") == {"raw": b"DATA"}
    assert M.memory_import(str(exports / "a.spookling")) == {"raw": b"DATA"}


def deleted(calls):
    return [c for c in calls if c[0] in ("delete", "delete-all")]


def test_delete_is_listed_and_says_cloud_only():
    tools = {t.name: t for t in run(M.server.list_tools())}
    assert "ctx" not in tools["memory_delete"].input_schema.get("properties", {})
    d = tools["memory_delete"].description
    assert "NOT deleted" in d and "cloud" in d and "colleague" in d


def test_delete_one_asks_then_acts_on_yes(team):
    ctx = Ctx(Res("accept", True))
    assert run(M.memory_delete("sid1", False, ctx)) == {"ok": True, "name": "delete"}
    assert "'sid1'" in ctx.asked[0] and "not deleted" in ctx.asked[0]
    assert deleted(team) == [("delete", {"sessionId": "sid1"})]


def test_delete_all_asks_then_acts_on_yes(team):
    ctx = Ctx(Res("accept", True))
    assert run(M.memory_delete(None, True, ctx)) == {"ok": True, "name": "delete-all"}
    assert "ALL" in ctx.asked[0]
    assert deleted(team) == [("delete-all", {})]


@pytest.mark.parametrize("answer", [Res("decline"), Res("cancel"), Res("accept", False), Res("accept")])
@pytest.mark.parametrize("all_", [False, True])
def test_delete_does_nothing_without_a_clear_yes(team, answer, all_):
    out = run(M.memory_delete(None if all_ else "sid1", all_, Ctx(answer)))
    assert out["ok"] is False and "did not confirm" in out["message"]
    assert deleted(team) == []


def test_delete_without_elicitation_returns_the_cli_command(team):
    for ctx, args, cmd in ((None, ("sid 1", False), "spookling delete 'sid 1'"), (Ctx(boom=True), (None, True), "spookling delete --all")):
        out = run(M.memory_delete(*args, ctx))
        assert out["ok"] is False and cmd in out["message"] and "deleting" in out["message"]
    assert deleted(team) == []


def test_delete_needs_exactly_one_target(team):
    ctx = Ctx(Res("accept", True))
    assert "error" in run(M.memory_delete(None, False, ctx))
    assert "error" in run(M.memory_delete("sid1", True, ctx))
    assert ctx.asked == [] and deleted(team) == []


def _pending_team(monkeypatch):
    calls = []

    def fake(name, args):
        calls.append((name, args))
        if name == "share-target":
            return {"orgId": "o1", "orgName": "Acme", "title": "New chat", "project": "", "sessionId": "cur1", "pending": True}
        return {"ok": True, "pending": True, "message": "Will be shared with Acme after this session's next save."}

    monkeypatch.setattr(M, "_team", fake)
    return calls


def test_a_pending_session_still_triggers_the_dialog_then_queues_on_yes(monkeypatch):
    calls = _pending_team(monkeypatch)
    ctx = Ctx(Res("accept", True))
    out = run(M.memory_share("", True, "acme", ctx))
    assert out["pending"] is True
    assert "next save" in ctx.asked[0] and "Acme" in ctx.asked[0]
    assert acted(calls) == [("share", {"sessionId": "cur1", "share": True, "org": "o1"})]  # the resolved current session


@pytest.mark.parametrize("answer", [Res("decline"), Res("cancel"), Res("accept", False)])
def test_declining_a_pending_share_queues_nothing(monkeypatch, answer):
    calls = _pending_team(monkeypatch)
    out = run(M.memory_share("", True, "acme", Ctx(answer)))
    assert out["ok"] is False and acted(calls) == []


def test_session_id_defaults_to_empty_for_the_current_session():
    import inspect
    assert inspect.signature(M.memory_share).parameters["session_id"].default == ""

def test_instructions_send_a_blocked_share_to_the_cli():
    text = M.server.instructions
    assert "memory_retrieve" in text
    assert "spookling share" in text and "/spookling-share" in text
    assert "do not retry" in text and "do not change any settings" in text
