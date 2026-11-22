"""MCP write tools: sharing needs the user's yes (elicitation), project rules are only checked here (the user types them), and archives stay inside ~/.spookling/exports/."""
import asyncio
import json
import os
import subprocess
import sys
import threading
from types import SimpleNamespace as NS

import pytest

from spookling_memory import mcp as M


class Res:
    def __init__(self, action, confirm=None):
        self.action = action
        self.data = None if confirm is None else type("D", (), {"confirm": confirm})()


class Ctx:
    """An old-protocol (2025-06-18) request context whose client can show forms. The tools run through the real server,
    so the resolvers see the same attributes the SDK gives them."""
    protocol_version = "2025-06-18"
    input_responses = None
    request_state = None
    client_capabilities = NS(elicitation=NS(form=None, url=None))

    def __init__(self, answer=None, boom=False):
        self.answer, self.boom, self.asked = answer, boom, []

    async def elicit(self, message, schema):
        self.asked.append(message)
        if self.boom:
            raise RuntimeError("client does not support elicitation")
        return self.answer


class _Tools:
    """The three tools called through the server (resolvers and all). ctx None is a call with no request to ask through."""

    @staticmethod
    async def _go(name, args, ctx):
        res = await M.server.call_tool(name, args, ctx)
        assert not res.is_error, res.content
        return json.loads(res.content[0].text)

    async def memory_share(self, session_id="", share=True, org="", ctx=None):
        return await self._go("memory_share", {"session_id": session_id, "share": share, "org": org}, ctx)

    async def memory_autoshare(self, project, enabled=True, org="", backfill=False, ctx=None):
        return await self._go("memory_autoshare", {"project": project, "enabled": enabled, "org": org, "backfill": backfill}, ctx)

    async def memory_delete(self, session_id=None, all=False, ctx=None):
        return await self._go("memory_delete", {"session_id": session_id, "all": all}, ctx)

    async def project_rule_set(self, text, replaces_rule_id="", org="", ctx=None):
        return await self._go("project_rule_set", {"text": text, "replaces_rule_id": replaces_rule_id, "org": org}, ctx)

    async def project_rule_remove(self, rule_id, org="", ctx=None):
        return await self._go("project_rule_remove", {"rule_id": rule_id, "org": org}, ctx)


T = _Tools()


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
    out = run(T.memory_share("sid1", True, "acme", ctx))
    assert out == {"ok": True, "name": "share"}
    assert "Fix the login bug" in ctx.asked[0] and "Acme" in ctx.asked[0]
    assert acted(team) == [("share", {"sessionId": "sid1", "share": True, "org": "o1"})]  # the org it asked about, by id


@pytest.mark.parametrize("answer", [Res("decline"), Res("cancel"), Res("accept", False), Res("accept")])
def test_share_does_nothing_without_a_clear_yes(team, answer):
    out = run(T.memory_share("sid1", True, "acme", Ctx(answer)))
    assert out["ok"] is False and acted(team) == []


def test_share_without_elicitation_returns_the_cli_command(team):
    for ctx in (Ctx(boom=True), None):
        out = run(T.memory_share("sid1", True, "acme", ctx))
        assert out["ok"] is False and "spookling share sid1 --org Acme" in out["message"]
    assert acted(team) == []


def test_unshare_needs_no_confirmation(team):
    ctx = Ctx(boom=True)
    run(T.memory_share("sid1", False, "", ctx))
    assert ctx.asked == [] and acted(team) == [("share", {"sessionId": "sid1", "share": False, "org": ""})]


def test_autoshare_backfill_names_project_org_and_count(team):
    ctx = Ctx(Res("accept", True))
    run(T.memory_autoshare("shop", True, "acme", True, ctx))
    msg = ctx.asked[0]
    assert "'shop'" in msg and "Acme" in msg and "7 session" in msg
    assert acted(team) == [("autoshare", {"project": "shop", "enabled": True, "org": "o1", "backfill": True})]


def test_autoshare_without_backfill_does_not_mention_a_count(team):
    ctx = Ctx(Res("accept", True))
    run(T.memory_autoshare("shop", True, "acme", False, ctx))
    assert "7 session" not in ctx.asked[0]
    assert acted(team)[0][1]["backfill"] is False


def test_backfill_is_never_accepted_without_confirmation(team):
    for ctx in (Ctx(Res("decline")), Ctx(boom=True), None):
        out = run(T.memory_autoshare("shop", True, "acme", True, ctx))
        assert out["ok"] is False
        assert "spookling autoshare shop on --org Acme --backfill" in out["message"] or "did not confirm" in out["message"]
    assert acted(team) == []


def test_autoshare_off_needs_no_confirmation_and_never_backfills(team):
    ctx = Ctx(boom=True)
    run(T.memory_autoshare("shop", False, "", True, ctx))
    assert ctx.asked == []
    assert acted(team) == [("autoshare", {"project": "shop", "enabled": False, "org": "", "backfill": False})]


def test_a_target_error_is_returned_and_nothing_is_asked(team, monkeypatch):
    monkeypatch.setattr(M, "_team", lambda n, a: {"error": "Which org? A, B."})
    ctx = Ctx(Res("accept", True))
    out = run(T.memory_share("sid1", True, "", ctx))
    assert out["ok"] is False and out["error"] == "Which org? A, B." and out["message"].startswith("Nothing was changed.")
    assert ctx.asked == []


SERVER = """
import os
from spookling_memory import mcp as M

def team(n, a):
    if n == "share-target":
        if os.environ.get("SEVERAL") and not a.get("org"):
            return {"error": "several orgs", "needOrg": True, "sessionId": a.get("sessionId") or "cur1",
                    "orgs": [{"id": "o1", "name": "Acme"}, {"id": "o2", "name": "Beta"}]}
        o = ("o2", "Beta") if a.get("org") in ("o2", "beta", "Beta") else ("o1", "Acme")
        t = {"orgId": o[0], "orgName": o[1]}
        return {**t, "count": 7} if a["kind"] == "project" else {**t, "title": "Fix the login bug", "project": "shop", "sessionId": a.get("sessionId") or "cur1"}
    if n == "rules-get":
        if os.environ.get("SEVERAL") and not a.get("org"):
            return {"error": "several orgs", "needOrg": True, "orgs": [{"id": "o1", "name": "Acme"}, {"id": "o2", "name": "Beta"}]}
        o = ("o2", "Beta") if a.get("org") in ("o2", "beta", "Beta") else ("o1", "Acme")
        return {"orgId": o[0], "orgName": o[1], "project": "shop", "projectKey": "dir:shop", "removed": [],
                "rules": [{"id": "r_1", "text": "Use MVVM.", "version": 3, "status": "active"}]}
    return {"ok": True, "did": n, "args": a}

M._team = team
M.server.run("stdio")
"""

PROTOCOLS = ["2025-06-18", "2026-07-28"]
FORM = {"elicitation": {"form": {}, "url": {}}}
ACCEPT = {"action": "accept", "content": {"confirm": True}}

# tool -> (arguments naming the org, arguments naming none, the key in "did", the terminal command, a word the dialog must hold)
TOOLS = {
    "memory_share": ({"session_id": "sid1", "org": "acme"}, {"session_id": "sid1"}, "share", "spookling share sid1 --org Acme", "Fix the login bug"),
    "memory_autoshare": ({"project": "shop", "org": "acme", "backfill": True}, {"project": "shop", "backfill": True}, "autoshare",
                         "spookling autoshare shop on --org Acme --backfill", "7 session"),
    "memory_delete": ({"session_id": "sid1"}, {"session_id": "sid1"}, "delete", "spookling delete sid1", "'sid1'"),
}
SEVERAL_TOOLS = ["memory_share", "memory_autoshare"]
ORG_KEY = {}  # the key the write carries; others use "org"
NO_ORG_CMD = {"memory_share": "spookling share sid1", "memory_autoshare": "spookling autoshare shop on --org <org>"}


def stdio_call(protocol, caps, answer, tool, args, several=False):
    """A real stdio session against the server in the given protocol, played the way Claude Code plays it.

    2025-06-18: initialize, then the server sends `elicitation/create` mid-call and the client replies.
    2026-07-28: `server/discover`, then every request carries its version and capabilities in `_meta`; the server answers a
    tool call with an `input_required` result holding its questions, and the client retries the call with `inputResponses`
    and the echoed `requestState`.
    `answer(message, schema)` returns the reply: {"result": {...}} or {"error": {...}} (old), or an elicit result dict (2026).
    Returns (asked messages, asked schemas, tool result text or None, is_error, server stderr)."""
    env = {**os.environ, **({"SEVERAL": "1"} if several else {})}
    p = subprocess.Popen([sys.executable, "-c", SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, bufsize=1, env=env)
    timer = threading.Timer(60, p.kill)  # a hung exchange fails the test instead of hanging the run
    timer.start()
    nid = [0]

    def send(o):
        p.stdin.write(json.dumps(o) + "\n")
        p.stdin.flush()

    def recv():
        line = p.stdout.readline()
        assert line, "the server closed the stream: " + p.stderr.read()
        return json.loads(line)

    def request(method, params):
        nid[0] += 1
        send({"jsonrpc": "2.0", "id": nid[0], "method": method, "params": params})
        return nid[0]

    asked, schemas = [], []
    try:
        if protocol == "2025-06-18":
            i = request("initialize", {"protocolVersion": protocol, "capabilities": caps, "clientInfo": {"name": "t", "version": "0"}})
            recv()
            send({"jsonrpc": "2.0", "method": "notifications/initialized"})
            i = request("tools/call", {"name": tool, "arguments": args})
            while True:
                m = recv()
                if m.get("method") == "elicitation/create":
                    asked.append(m["params"]["message"])
                    schemas.append(m["params"]["requestedSchema"])
                    send({"jsonrpc": "2.0", "id": m["id"], **answer(asked[-1], schemas[-1])})
                elif m.get("id") == i:
                    break
            res = m["result"]
        else:
            meta = {"io.modelcontextprotocol/protocolVersion": protocol, "io.modelcontextprotocol/clientInfo": {"name": "t", "version": "0"},
                    "io.modelcontextprotocol/clientCapabilities": caps}
            request("server/discover", {"_meta": meta})
            assert recv()["result"]
            extra = {}
            for _ in range(6):
                i = request("tools/call", {"_meta": meta, "name": tool, "arguments": args, **extra})
                m = recv()
                assert m.get("id") == i and "result" in m, m
                res = m["result"]
                if res.get("resultType") != "input_required":
                    break
                responses = {}
                for key, req in res["inputRequests"].items():
                    assert req["method"] == "elicitation/create"
                    asked.append(req["params"]["message"])
                    schemas.append(req["params"]["requestedSchema"])
                    reply = answer(asked[-1], schemas[-1])
                    responses[key] = reply["result"] if "result" in reply else {"action": "accept"}
                extra = {"inputResponses": responses, "requestState": res["requestState"]}
            else:
                pytest.fail("the call never completed")
        text = res["content"][0]["text"] if res.get("content") else None
        return asked, schemas, text, bool(res.get("isError")), ""
    finally:
        p.kill()
        timer.cancel()
        err = p.stderr.read()
        p.stdout.close()
        p.stderr.close()
        stdio_call.stderr = err


def reply(result):
    return lambda message, schema: {"result": result}


@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("tool", TOOLS)
def test_dialog_accept_acts_and_names_what_it_is_about(protocol, tool):
    args, _, did, _, word = TOOLS[tool]
    asked, schemas, text, err, _ = stdio_call(protocol, FORM, reply(ACCEPT), tool, args)
    assert len(asked) == 1 and word in asked[0]
    assert schemas[0]["properties"]["confirm"]["type"] == "boolean"
    assert not err and f'"did": "{did}"' in text


@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("tool", TOOLS)
@pytest.mark.parametrize("result", [{"action": "decline"}, {"action": "cancel"}, {"action": "accept", "content": {"confirm": False}}],
                         ids=["decline", "cancel", "unticked"])
def test_dialog_decline_cancel_or_unticked_does_nothing(protocol, tool, result):
    args, _, did, _, _ = TOOLS[tool]
    asked, _, text, err, _ = stdio_call(protocol, FORM, reply(result), tool, args)
    assert len(asked) == 1 and not err and '"did"' not in text and "did not confirm" in text and "Nothing was changed" in text


@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("tool", TOOLS)
@pytest.mark.parametrize("caps", [{}, {"sampling": {}}, {"elicitation": {"url": {}}}], ids=["none", "other", "url-only"])
def test_a_client_without_form_elicitation_is_never_asked_and_gets_the_command(protocol, tool, caps):
    args, _, _, cmd, _ = TOOLS[tool]
    asked, _, text, err, _ = stdio_call(protocol, caps, reply(ACCEPT), tool, args)
    assert asked == [] and not err and cmd in text and '"did"' not in text
    assert "cannot show a confirmation dialog" in text and "no capability" not in text


def test_a_client_that_errors_on_the_request_gets_the_command_and_a_log_line():
    """Old protocols: the standalone request fails. The user still gets the command, and the server log says why."""
    for tool, (args, _, _, cmd, _) in TOOLS.items():
        asked, _, text, err, _ = stdio_call("2025-06-18", FORM, lambda m, s: {"error": {"code": -32601, "message": "Method not found"}}, tool, args)
        log = stdio_call.stderr
        assert asked and not err and cmd in text and '"did"' not in text, tool
        assert "confirmation dialog failed" in log and "MCPError" in log and "Method not found" in log, log
        assert "Fix the login bug" not in log and "shop" not in log and "sid1" not in log  # never what the user was asked


def test_a_2026_client_that_answers_with_nothing_usable_changes_nothing():
    """2026-07-28: an accepted answer with no content is a broken client. The call fails safe, and nothing is done."""
    for tool, (args, _, _, _, _) in TOOLS.items():
        asked, _, text, err, _ = stdio_call("2026-07-28", FORM, lambda m, s: {"result": {"action": "accept"}}, tool, args)
        assert asked and err and '"did"' not in text, tool


def _pick_then_confirm(choice):
    def answer(message, schema):
        if "confirm" in schema["properties"]:
            return {"result": ACCEPT}
        return {"result": {"action": "accept", "content": {"org": choice}}}
    return answer


@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("tool", SEVERAL_TOOLS)
def test_several_orgs_ask_which_one_then_confirm_for_that_org(protocol, tool):
    _, args, did, _, _ = TOOLS[tool]
    asked, schemas, text, err, _ = stdio_call(protocol, FORM, _pick_then_confirm("Beta"), tool, args, several=True)
    assert len(asked) == 2 and "Which one" in asked[0] and "org" in schemas[0]["properties"]
    assert set(schemas[0]["properties"]["org"].get("enum", [])) == {"Acme", "Beta"}
    assert "'Beta'" in asked[1] and "Acme" not in asked[1] and "confirm" in schemas[1]["properties"]
    assert not err and f'"did": "{did}"' in text and ORG_KEY.get(tool, '"org": "o2"') in text


@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("tool", SEVERAL_TOOLS)
def test_several_orgs_picked_but_not_confirmed_does_nothing(protocol, tool):
    _, args, _, _, _ = TOOLS[tool]

    def answer(message, schema):
        return {"result": {"action": "decline"}} if "confirm" in schema["properties"] else {"result": {"action": "accept", "content": {"org": "Beta"}}}

    asked, _, text, err, _ = stdio_call(protocol, FORM, answer, tool, args, several=True)
    assert len(asked) == 2 and not err and '"did"' not in text and "did not confirm" in text


@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("tool", SEVERAL_TOOLS)
@pytest.mark.parametrize("result", [{"action": "cancel"}, {"action": "decline"}], ids=["cancel", "decline"])
def test_several_orgs_cancelled_pick_never_guesses_and_asks_nothing_more(protocol, tool, result):
    _, args, _, _, _ = TOOLS[tool]
    asked, _, text, err, _ = stdio_call(protocol, FORM, reply(result), tool, args, several=True)
    assert len(asked) == 1 and not err and '"did"' not in text and "Acme" in text and "Beta" in text


@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("tool", SEVERAL_TOOLS)
def test_several_orgs_and_no_dialog_hand_over_a_command_that_asks_which_org(protocol, tool):
    _, args, _, _, _ = TOOLS[tool]
    asked, _, text, err, _ = stdio_call(protocol, {}, reply(ACCEPT), tool, args, several=True)
    cmd = NO_ORG_CMD[tool]
    assert asked == [] and not err and cmd in text and '"did"' not in text and "--org Acme" not in text


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_unshare_and_autoshare_off_need_no_dialog(protocol):
    asked, _, text, err, _ = stdio_call(protocol, FORM, reply(ACCEPT), "memory_share", {"session_id": "sid1", "share": False})
    assert asked == [] and not err and '"did": "share"' in text
    asked, _, text, err, _ = stdio_call(protocol, FORM, reply(ACCEPT), "memory_autoshare", {"project": "shop", "enabled": False})
    assert asked == [] and not err and '"did": "autoshare"' in text


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_delete_all_asks_in_both_protocols(protocol):
    asked, _, text, err, _ = stdio_call(protocol, FORM, reply(ACCEPT), "memory_delete", {"all": True})
    assert len(asked) == 1 and "ALL" in asked[0] and '"did": "delete-all"' in text
    asked, _, text, err, _ = stdio_call(protocol, FORM, reply({"action": "decline"}), "memory_delete", {"all": True})
    assert len(asked) == 1 and '"did"' not in text


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
    assert run(T.memory_delete("sid1", False, ctx)) == {"ok": True, "name": "delete"}
    assert "'sid1'" in ctx.asked[0] and "not deleted" in ctx.asked[0]
    assert deleted(team) == [("delete", {"sessionId": "sid1"})]


def test_delete_all_asks_then_acts_on_yes(team):
    ctx = Ctx(Res("accept", True))
    assert run(T.memory_delete(None, True, ctx)) == {"ok": True, "name": "delete-all"}
    assert "ALL" in ctx.asked[0]
    assert deleted(team) == [("delete-all", {})]


@pytest.mark.parametrize("answer", [Res("decline"), Res("cancel"), Res("accept", False), Res("accept")])
@pytest.mark.parametrize("all_", [False, True])
def test_delete_does_nothing_without_a_clear_yes(team, answer, all_):
    out = run(T.memory_delete(None if all_ else "sid1", all_, Ctx(answer)))
    assert out["ok"] is False and "did not confirm" in out["message"]
    assert deleted(team) == []


def test_delete_without_elicitation_returns_the_cli_command(team):
    for ctx, args, cmd in ((None, ("sid 1", False), "spookling delete 'sid 1'"), (Ctx(boom=True), (None, True), "spookling delete --all")):
        out = run(T.memory_delete(*args, ctx))
        assert out["ok"] is False and cmd in out["message"] and "deleting" in out["message"]
    assert deleted(team) == []


def test_delete_needs_exactly_one_target(team):
    ctx = Ctx(Res("accept", True))
    assert "error" in run(T.memory_delete(None, False, ctx))
    assert "error" in run(T.memory_delete("sid1", True, ctx))
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
    out = run(T.memory_share("", True, "acme", ctx))
    assert out["pending"] is True
    assert "next save" in ctx.asked[0] and "Acme" in ctx.asked[0]
    assert acted(calls) == [("share", {"sessionId": "cur1", "share": True, "org": "o1"})]  # the resolved current session


@pytest.mark.parametrize("answer", [Res("decline"), Res("cancel"), Res("accept", False)])
def test_declining_a_pending_share_queues_nothing(monkeypatch, answer):
    calls = _pending_team(monkeypatch)
    out = run(T.memory_share("", True, "acme", Ctx(answer)))
    assert out["ok"] is False and acted(calls) == []


def test_session_id_defaults_to_empty_for_the_current_session():
    import inspect
    assert inspect.signature(M.memory_share).parameters["session_id"].default == ""

def test_instructions_send_a_blocked_share_to_the_cli():
    text = M.server.instructions
    assert "memory_retrieve" in text
    assert "spookling share" in text and "/spookling-share" in text
    assert "do not retry" in text and "do not change any settings" in text


# ---- clients with no dialog get a ready-to-run hand-off; orgs are resolved live ----

@pytest.fixture
def live_team(monkeypatch):
    """share-target answers like the CLI: one org by default, or `needOrg` with the choices when SEVERAL is set."""
    state = {"several": False, "note": None}
    calls = []

    def fake(name, args):
        calls.append((name, args))
        if name == "share-target":
            if state["several"] and not args.get("org"):
                return {"error": "You are in several orgs: 'One', 'Two'. Run again with --org '<name>'.", "needOrg": True,
                        "sessionId": args.get("sessionId") or "cur1", "orgs": [{"id": "o1", "name": "One"}, {"id": "o2", "name": "Two"}]}
            org = {"o1": "One", "o2": "Two"}.get(args.get("org"), "Org test")
            if args["kind"] == "project":
                return {"orgId": "o9", "orgName": "Org test", "count": 3}
            t = {"orgId": args.get("org") if args.get("org") in ("o1", "o2") else "o9", "orgName": org, "title": "Fix it", "project": "shop", "sessionId": args.get("sessionId") or "cur1"}
            if state["note"]:
                t["note"] = state["note"]
            return t
        return {"ok": True, "name": name}

    monkeypatch.setattr(M, "_team", fake)
    return state, calls


def test_no_dialog_returns_title_project_org_and_the_exact_command(live_team):
    _, calls = live_team
    for ctx in (Ctx(boom=True), None):
        out = run(T.memory_share("sid1", True, "", ctx))
        assert out["ok"] is False and out["needsUserConfirmation"] is True
        assert (out["title"], out["project"], out["org"], out["sessionId"]) == ("Fix it", "shop", "Org test", "sid1")
        assert out["command"] == "spookling share sid1 --org 'Org test'"
        assert "--yes" not in out["command"] and "--yes" not in out["message"]
        assert "word for word" not in out["message"] and "exactly as written" in out["message"]
        assert "do not guess or change the org" in out["message"].lower()
        assert "Nothing was shared" in out["message"]
        assert "slashCommand" not in out  # an explicit id may not be the current session: /spookling-share shares the current one
    assert acted(calls) == []


def test_no_dialog_for_the_current_session_also_offers_the_slash_command(live_team):
    out = run(T.memory_share("", True, "", None))
    assert out["sessionId"] == "cur1"
    assert out["command"] == "spookling share cur1 --org 'Org test'"
    assert out["slashCommand"] == "/spookling-share Org test" and "/spookling-share" in out["message"]


def test_a_dialog_still_asks_and_the_org_is_the_live_one(live_team):
    state, calls = live_team
    state["note"] = "Your saved default org 'Spookling' is no longer one of your orgs, so it was ignored. Using 'Org test', your only org."
    ctx = Ctx(Res("accept", True))
    out = run(T.memory_share("sid1", True, "Spookling", ctx))  # the model guessed an org: the live target decides
    assert "Org test" in ctx.asked[0] and "no longer one of your orgs" in ctx.asked[0]
    assert out["note"] == state["note"]
    assert acted(calls) == [("share", {"sessionId": "sid1", "share": True, "org": "o9"})]


def test_several_orgs_and_no_org_ask_in_a_dialog_and_share_only_with_the_pick(live_team):
    state, calls = live_team
    state["several"] = True

    class Both(Ctx):
        def __init__(self):
            super().__init__()
            self.answers = [Res("accept"), Res("accept", True)]

        async def elicit(self, message, schema):
            self.asked.append(message)
            if len(self.asked) == 1:
                return type("R", (), {"action": "accept", "data": type("D", (), {"org": "Two"})()})()
            return self.answers[1]

    ctx = Both()
    out = run(T.memory_share("sid1", True, "", ctx))
    assert out == {"ok": True, "name": "share"}
    assert "Which one" in ctx.asked[0] and "Two" in ctx.asked[1]
    assert acted(calls) == [("share", {"sessionId": "sid1", "share": True, "org": "o2"})]


def test_several_orgs_without_a_dialog_hands_over_a_command_that_asks_which_org(live_team):
    state, calls = live_team
    state["several"] = True
    out = run(T.memory_share("sid1", True, "", None))
    assert out["ok"] is False and out["command"] == "spookling share sid1" and out["orgs"] == ["One", "Two"]
    assert "'One', 'Two'" in out["message"] and "asks which org" in out["message"]
    assert acted(calls) == []


def test_a_cancelled_org_pick_shares_nothing(live_team):
    state, calls = live_team
    state["several"] = True
    out = run(T.memory_share("sid1", True, "", Ctx(Res("cancel"))))
    assert out["ok"] is False and acted(calls) == []


def test_a_wrong_org_name_is_refused_with_the_live_orgs_and_nothing_shared(monkeypatch):
    err = "No org matches \"Spookling\". Your orgs: 'Org test'. Name one of those orgs."
    monkeypatch.setattr(M, "_team", lambda n, a: {"error": err})
    out = run(T.memory_share("sid1", True, "Spookling", Ctx(Res("accept", True))))
    assert out["ok"] is False and err in out["message"] and "do not guess" in out["message"]


def test_autoshare_without_a_dialog_hands_over_the_command(live_team):
    out = run(T.memory_autoshare("shop", True, "", True, None))
    assert out["needsUserConfirmation"] is True and out["org"] == "Org test"
    assert out["command"] == "spookling autoshare shop on --org 'Org test' --backfill"


def test_instructions_require_a_live_org_check_and_relaying_the_command():
    text = M.server.instructions
    assert "team_orgs" in text and "never state which orgs" in text.lower()
    assert "word for word" in text and "do not guess or change the org" in text


def test_team_orgs_asks_the_live_listing(monkeypatch):
    seen = []
    monkeypatch.setattr(M, "_team", lambda n, a: seen.append((n, a)) or {"orgs": [{"name": "Org test"}]})
    assert M.team_orgs() == {"orgs": [{"name": "Org test"}]} and seen == [("orgs", {})]
    assert "team_orgs" in {t.name for t in run(M.server.list_tools())}


# ---- cloud-first memory_retrieve: the token stays in node; the local server is the fallback

def test_memory_retrieve_goes_cloud_first(monkeypatch):
    seen = []
    monkeypatch.setattr(M, "_cloud_retrieve", lambda q: seen.append(q) or {"context": "We chose Postgres.", "tier": "strong", "status": "ok", "items": [{"id": "m1"}]})
    monkeypatch.setattr(M, "call", lambda *a, **k: pytest.fail("the local server must not be asked while the cloud answers"))
    out = M.memory_retrieve("which database?")
    assert seen == ["which database?"]
    assert out["context"] == "We chose Postgres." and out["source"] == "cloud" and out["items"] == [{"id": "m1"}]


def test_memory_retrieve_falls_back_to_the_local_server(monkeypatch):
    monkeypatch.setattr(M, "_cloud_retrieve", lambda q: None)
    monkeypatch.setattr(M, "call", lambda path, body=None, raw=None: {"context": "local", "path": path, "body": body})
    assert M.memory_retrieve("q") == {"context": "local", "path": "/v1/retrieve", "body": {"question": "q"}}


def test_cloud_retrieve_shells_out_to_node_and_never_raises(monkeypatch, tmp_path):
    script = tmp_path / "cloud-retrieve-invoke.js"
    script.write_text("")
    monkeypatch.setattr(M, "_node_script", lambda name: script)
    monkeypatch.setattr(M.shutil, "which", lambda n: "/usr/bin/node")
    ran = []

    def fake(cmd, **kw):
        ran.append(cmd)
        return type("P", (), {"returncode": 0, "stdout": json.dumps({"context": "c", "status": "ok"})})()

    monkeypatch.setattr(M.subprocess, "run", fake)
    assert M._cloud_retrieve("q") == {"context": "c", "status": "ok"}
    assert ran[0][:2] == ["/usr/bin/node", str(script)] and json.loads(ran[0][2])["question"] == "q"
    for bad in ('null', 'not json', '[]', '{"status":"ok"}'):
        monkeypatch.setattr(M.subprocess, "run", lambda cmd, bad=bad, **kw: type("P", (), {"returncode": 0, "stdout": bad})())
        assert M._cloud_retrieve("q") is None
    monkeypatch.setattr(M.subprocess, "run", lambda cmd, **kw: (_ for _ in ()).throw(subprocess.TimeoutExpired(cmd, 8)))
    assert M._cloud_retrieve("q") is None
    monkeypatch.setattr(M, "_node_script", lambda name: None)
    assert M._cloud_retrieve("q") is None


def test_cloud_retrieve_end_to_end_with_the_real_node_script(monkeypatch, tmp_path):
    """The real cloud-retrieve-invoke.js, logged out: it answers null (so the local server is used), and no token is read here."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.delenv("SPOOKLING_TOKEN", raising=False)
    if M._node_script("cloud-retrieve-invoke.js") and M.shutil.which("node"):
        assert M._cloud_retrieve("which database did we pick?") is None


# ---- project rules: the MCP tools only read and check. Nothing is written from here: the user types /spookling-rules or runs the CLI.

RULE = {"id": "r_1", "text": "Use MVVM for all UI code.", "version": 2, "status": "active", "createdBy": "Ada",
        "createdAt": "2026-11-18T09:00:00.000Z", "updatedBy": "Lin", "updatedAt": "2026-11-18T10:00:00.000Z"}


@pytest.fixture
def rules_team(monkeypatch):
    """rules-get answers like the CLI: one org, or `needOrg` when state["several"] and no org was passed. Any other team call is recorded
    as a write and fails the test: the MCP process has no write path."""
    state = {"several": False, "error": None}
    calls = []

    def fake(name, args):
        calls.append((name, args))
        if name != "rules-get":
            return {"error": f"unexpected team call {name}"}
        if state["error"]:
            return {"error": state["error"]}
        if state["several"] and not args.get("org"):
            return {"error": "You are in several orgs: 'One', 'Two'. Run again with --org '<name>'.", "needOrg": True,
                    "orgs": [{"id": "o1", "name": "One"}, {"id": "o2", "name": "Two"}]}
        org = {"o1": "One", "o2": "Two"}.get(args.get("org"), "Acme")
        return {"orgId": args.get("org") if args.get("org") in ("o1", "o2") else "o9", "orgName": org, "project": "shop",
                "projectKey": "git:github.com/acme/shop", "rules": [dict(RULE)], "removed": []}

    monkeypatch.setattr(M, "_team", fake)
    return state, calls


def only_reads(calls):
    return all(c[0] == "rules-get" for c in calls)


def test_rule_tools_are_listed_and_say_they_write_nothing():
    tools = {t.name: t for t in run(M.server.list_tools())}
    assert {"project_rules", "project_rule_set", "project_rule_remove"} <= set(tools)
    for n in ("project_rule_set", "project_rule_remove"):
        assert "ctx" not in tools[n].input_schema.get("properties", {})
        desc = " ".join(tools[n].description.split()).lower()
        assert "writes nothing" in desc and "never say the user agreed" in desc
    assert "Read-only" in tools["project_rules"].description


def test_instructions_say_the_user_types_the_line_and_the_model_never_changes_rules():
    text = " ".join(M.server.instructions.split())
    assert "project_rule_set" in text and "project_rule_remove" in text and "/spookling-rules" in text
    assert "never changed by you" in text and "never say the user agreed" in text and "before writing any code" in text


def test_project_rules_lists_the_rules_read_only(rules_team):
    _, calls = rules_team
    out = run(M.project_rules())
    assert out["org"] == "Acme" and out["project"] == "shop"
    assert out["rules"][0]["n"] == 1 and out["rules"][0]["id"] == "r_1" and out["rules"][0]["setBy"] == "Ada"
    assert only_reads(calls) and calls[0][1]["cwd"] == os.getcwd()


def test_rule_set_returns_the_chat_line_and_the_terminal_command_and_writes_nothing(rules_team):
    _, calls = rules_team
    ctx = Ctx(Res("accept", True))  # even a yes in a dialog is not asked for: there is no dialog here
    out = run(T.project_rule_set("Write  tests\nfor every bug fix.", "", "", ctx))
    assert ctx.asked == []
    assert out["ok"] is False and out["needsUserConfirmation"] is True
    assert out["slashCommand"] == "/spookling-rules Write tests for every bug fix."
    assert out["command"] == "spookling rules set 'Write tests for every bug fix.' --org Acme"
    assert (out["org"], out["project"]) == ("Acme", "shop") and "Nothing was set" in out["message"]
    assert "never saves a project rule from the chat" in out["message"] and "Do not run either yourself" in out["message"]
    assert only_reads(calls)


def test_rule_set_with_an_org_named_carries_it_into_the_chat_line(rules_team):
    out = run(T.project_rule_set("Use tabs.", "", "acme", Ctx(boom=True)))
    assert out["slashCommand"] == "/spookling-rules --org Acme Use tabs."
    assert out["command"] == "spookling rules set 'Use tabs.' --org Acme"


def test_rule_replace_returns_the_replace_line_with_the_id(rules_team):
    _, calls = rules_team
    out = run(T.project_rule_set("Use MVI for all UI code.", "r_1", "acme", None))
    assert out["slashCommand"] == "/spookling-rules --org Acme replace r_1 Use MVI for all UI code."
    assert out["command"] == "spookling rules set 'Use MVI for all UI code.' --replace r_1 --org Acme"
    assert out["message"].startswith("Nothing was changed.")
    assert only_reads(calls)


def test_rule_remove_returns_the_remove_line_and_writes_nothing(rules_team):
    _, calls = rules_team
    out = run(T.project_rule_remove("r_1", "", Ctx(Res("accept", True))))
    assert out["slashCommand"] == "/spookling-rules remove r_1" and out["command"] == "spookling rules remove r_1 --org Acme"
    assert "Nothing was removed" in out["message"] and only_reads(calls)


def test_the_chat_line_names_the_org_by_id_when_the_name_has_spaces():
    assert M._slash_org({"orgName": "Acme Labs", "orgId": "o9"}) == "o9"
    assert M._slash_org({"orgName": "Acme", "orgId": "o9"}) == "Acme"


def test_several_orgs_with_no_picker_is_a_plain_refusal_that_lists_them(rules_team):
    state, calls = rules_team
    state["several"] = True
    out = run(T.project_rule_set("Use tabs.", "", "", None))
    assert out["ok"] is False and out["orgs"] == ["One", "Two"] and "command" not in out and "slashCommand" not in out
    assert "'One', 'Two'" in out["error"] and "Do not guess the org" in out["message"]
    assert only_reads(calls)


def test_several_orgs_pick_in_a_dialog_then_the_line_is_for_that_org(rules_team):
    state, calls = rules_team
    state["several"] = True

    class Pick(Ctx):
        async def elicit(self, message, schema):
            self.asked.append(message)
            return type("R", (), {"action": "accept", "data": type("D", (), {"org": "Two"})()})()

    ctx = Pick()
    out = run(T.project_rule_set("Use tabs.", "", "", ctx))
    assert len(ctx.asked) == 1 and "Which one" in ctx.asked[0]
    assert out["slashCommand"] == "/spookling-rules --org Two Use tabs." and out["org"] == "Two"
    assert only_reads(calls)


def test_server_errors_from_the_lookup_are_passed_on_in_plain_words(rules_team):
    state, calls = rules_team
    state["error"] = "Not logged in. Run `spookling login`, then try again."
    out = run(T.project_rule_set("Use tabs.", "", "", None))
    assert out["ok"] is False and out["error"] == state["error"] and "Nothing was changed" in out["message"]
    assert "command" not in out and only_reads(calls)


def test_unknown_rule_ids_and_bad_text_are_refused(rules_team):
    _, calls = rules_team
    ctx = Ctx(Res("accept", True))
    assert "No rule" in run(T.project_rule_set("x", "r_nope", "", ctx))["error"]
    assert "No active rule" in run(T.project_rule_remove("r_nope", "", ctx))["error"]
    assert "1 to 300" in run(T.project_rule_set("x" * 301, "", "", ctx))["error"]
    assert "1 to 300" in run(T.project_rule_set("   ", "", "", ctx))["error"]
    assert ctx.asked == [] and only_reads(calls)


def test_team_invoke_has_no_rule_write_entry():
    """The MCP process has no write path: the node bridge refuses the old write names as unknown tools."""
    node, script = M.shutil.which("node"), M._team_invoke_script()
    if not node or script is None:
        pytest.skip("node or the team bridge is not available")
    import tempfile
    with tempfile.TemporaryDirectory() as home:
        for name in ("rules-set", "rules-remove"):
            p = subprocess.run([node, str(script), name, "{}"], capture_output=True, text=True, timeout=60,
                               env={**os.environ, "HOME": home, "USERPROFILE": home})
            assert p.returncode == 1 and "Unknown team tool" in p.stdout, (name, p.stdout, p.stderr)
        assert not os.path.exists(os.path.join(home, ".spookling"))


# ---- project rules over the real stdio harness, both protocols: no dialog, the chat line comes back, nothing is written

@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_rule_set_over_stdio_asks_nothing_and_returns_the_chat_line(protocol):
    asked, _, text, err, _ = stdio_call(protocol, FORM, reply(ACCEPT), "project_rule_set", {"text": "Use MVI.", "replaces_rule_id": "r_1", "org": "acme"})
    assert asked == [] and not err and '"did"' not in text
    out = json.loads(text)
    assert out["slashCommand"] == "/spookling-rules --org Acme replace r_1 Use MVI."
    assert out["command"] == "spookling rules set 'Use MVI.' --replace r_1 --org Acme" and out["needsUserConfirmation"] is True


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_rule_remove_over_stdio_asks_nothing_and_returns_the_chat_line(protocol):
    asked, _, text, err, _ = stdio_call(protocol, FORM, reply(ACCEPT), "project_rule_remove", {"rule_id": "r_1", "org": "acme"})
    assert asked == [] and not err and '"did"' not in text
    assert json.loads(text)["slashCommand"] == "/spookling-rules --org Acme remove r_1"


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_several_orgs_over_stdio_ask_for_the_org_only_and_never_confirm(protocol):
    asked, _, text, err, _ = stdio_call(protocol, FORM, _pick_then_confirm("Beta"), "project_rule_set", {"text": "Use tabs."}, several=True)
    assert len(asked) == 1 and "Which one" in asked[0] and not err and '"did"' not in text
    assert json.loads(text)["slashCommand"] == "/spookling-rules --org Beta Use tabs."
