"""A model key that stops working (OpenRouter's 403 "Key limit exceeded") never costs a turn: the LOG comes first."""
import json

import httpx
import openai
import pytest
from conftest import HISTORY, TAGS, Stub, turns
from fastapi.testclient import TestClient
from test_api import write_transcript

from spookling_memory.api import create_app
from spookling_memory.core import models
from spookling_memory.core import triage as triage_mod
from spookling_memory.core.triage import ModelTriage
from spookling_memory.store import Store

LIMIT = "Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys"


def status_error(code: int, message: str):
    req = httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions")
    cls = {401: openai.AuthenticationError, 403: openai.PermissionDeniedError}.get(code, openai.APIStatusError)
    return cls(f"Error code: {code} - {message}", response=httpx.Response(code, request=req), body={"error": {"message": message}})


@pytest.fixture
def limited(monkeypatch):
    """The real models.call path against a fake OpenRouter that answers 403 key-limit to every request; counts the requests."""
    sent = []

    def send(model, messages, params):
        sent.append(model)
        raise status_error(403, str({"error": {"message": LIMIT}}))

    monkeypatch.setattr(triage_mod, "call", models.call)  # conftest refuses model calls; this one is the point
    monkeypatch.setattr(models, "_send", send)
    monkeypatch.setattr(models, "STOPPED", None)
    monkeypatch.setattr(models, "STOP_INFO", None)
    return sent


def client(store):
    return TestClient(create_app(store), base_url="http://127.0.0.1:7447")


def test_key_limit_403_is_a_stop_and_latched(limited, tmp_path):
    assert models.is_credit_error(status_error(403, LIMIT))
    assert models.is_credit_error(status_error(401, "Invalid API key"))
    assert models.is_credit_error(status_error(402, "Insufficient credits"))
    assert not models.is_credit_error(status_error(403, "This model is not available in your region"))
    assert not models.is_credit_error(status_error(500, "Key limit exceeded"))
    models.CACHE_PATH = tmp_path / "cache.sqlite"
    with pytest.raises(models.CreditExhausted):
        models.complete("openai/some-model", [{"role": "user", "content": "hi"}])
    info = models.stop_info()
    assert info["kind"] == "limit" and info["provider"] == "openrouter" and info["since"].endswith("Z")
    assert models.STOPPED.startswith("key limit exceeded")
    with pytest.raises(models.CreditExhausted):  # latched: nothing more is sent
        models.complete("openai/some-model", [{"role": "user", "content": "another"}])
    assert len(limited) == 1


def test_anthropic_credit_errors_still_stop(monkeypatch):
    monkeypatch.setattr(models, "BACKEND", "anthropic")
    monkeypatch.setattr(models, "STOPPED", None)
    monkeypatch.setattr(models, "STOP_INFO", None)
    e = status_error(400, "Your credit balance is too low to access the Anthropic API")
    assert models.is_credit_error(e)
    models._stop(e, "anthropic/claude-haiku-4-5")
    assert models.stop_info()["provider"] == "anthropic" and models.stop_info()["kind"] == "credit"


def test_a_key_limit_leaves_the_turns_in_the_log_and_they_are_judged_later(limited, tmp_path):
    folder = tmp_path / "m"
    s = Store(folder, triage=ModelTriage("openai/some-model"))
    c = client(s)
    sid, ts, users = HISTORY[0]
    r = c.post("/v1/ingest", json={"id": sid, "ts": ts, "turns": turns(users)})
    assert r.status_code == 200 and r.json()["logged"] == 4 and "key over its limit" in r.json()["note"]
    lines = (folder / "log.jsonl").read_text(encoding="utf-8").splitlines()
    assert [json.loads(x)["text"] for x in lines][0] == users[0]  # every turn, verbatim, before and without a model
    assert len(lines) == 4 and (folder / "pending.json").exists()
    stats = c.get("/v1/stats").json()
    assert stats["model"]["stopped"]["kind"] == "limit" and stats["model"]["untagged"] == 4
    assert c.post("/v1/ingest", json={"id": "s2", "ts": HISTORY[1][1], "turns": turns(HISTORY[1][2])}).json()["logged"] == 4
    assert len(limited) == 1  # the second save did not ask the model again
    s.close()

    models.STOPPED = models.STOP_INFO = None  # the key was topped up and the server restarted
    s2 = Store(folder, triage=Stub(TAGS))  # server start judges what was waiting
    assert len(s2.mem.log.events) == 8 and s2.mem.untagged() == 0
    assert any(d["source"] == s2.mem.log.events[0].hash for d in s2.mem.log.decisions)
    assert not (folder / "pending.json").exists()
    s2.close()


def test_user_prompt_submit_is_200_when_the_model_fails(limited, tmp_path):
    s = Store(tmp_path / "m", triage=ModelTriage("openai/some-model"))
    c = client(s)
    for sid, ts, users in HISTORY[:2]:
        c.post("/v1/ingest", json={"id": sid, "ts": ts, "turns": turns(users)})
    r = c.post("/v1/hook/user-prompt-submit", json={"session_id": "x", "prompt": "What car do I drive?"})
    assert r.status_code == 200  # the views are rebuilt without the model; recall may be empty or local only
    assert c.post("/v1/retrieve", json={"question": "What car do I drive?"}).status_code == 200

    def boom(*a, **k):
        raise status_error(403, LIMIT)

    s.retrieve = boom  # anything the model path throws
    r = c.post("/v1/hook/user-prompt-submit", json={"session_id": "x", "prompt": "What car do I drive?"})
    assert r.status_code == 200 and r.json() == {}
    s.close()


def test_the_stop_hook_logs_the_turns_when_the_key_is_over_its_limit(limited, tmp_path):
    folder = tmp_path / "m"
    s = Store(folder, triage=ModelTriage("openai/some-model"))
    path = tmp_path / "t.jsonl"
    write_transcript(path, [{"type": "user", "message": {"role": "user", "content": "I drive a Toyota Corolla, nothing fancy."}},
                            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Noted."}]}}])
    body = {"session_id": "abc", "transcript_path": str(path), "hook_event_name": "Stop", "last_assistant_message": "Noted."}
    c = client(s)
    assert c.post("/v1/hook/stop", json=body).json() == {}  # the background task has run by the time the client returns
    assert c.post("/v1/hook/pre-compact", json=body).status_code == 200
    texts = [json.loads(x)["text"] for x in (folder / "log.jsonl").read_text(encoding="utf-8").splitlines()]
    assert texts == ["I drive a Toyota Corolla, nothing fancy.", "Noted."]
    s.close()


def test_backfill_is_idempotent(open_store, tmp_path):
    s = open_store()
    c = client(s)
    path = tmp_path / "gone.jsonl"
    entries = [{"type": "user", "message": {"role": "user", "content": "I drive a Toyota Corolla, nothing fancy."}},
               {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Noted."}]}}]
    write_transcript(path, entries)
    body = {"session_id": "lost", "transcript_path": str(path)}
    assert c.post("/v1/backfill", json=body).json() == {"logged": 2}
    assert c.post("/v1/backfill", json=body).json() == {"logged": 0}  # the same turns again add nothing
    write_transcript(path, entries + [{"type": "user", "message": {"role": "user", "content": "How do I roast peppers?"}}])
    assert c.post("/v1/backfill", json=body).json() == {"logged": 1}  # only the missing tail
    assert len(s.mem.log.events) == 3
    assert c.post("/v1/backfill", json={**body, "transcript_path": str(tmp_path / "nope.jsonl")}).json() == {"logged": 0}
