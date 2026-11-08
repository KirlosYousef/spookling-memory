"""The Codex subscription tagger, offline: a fake `codex` on PATH records each run and answers like the CLI."""
import json
import os
import sys
import time

import pytest
from conftest import turns
from fastapi.testclient import TestClient

from spookling_memory import subscription as S
from spookling_memory.api import create_app
from spookling_memory.core import models
from spookling_memory.core.triage import SYSTEM, WRITER
from spookling_memory.store import Store

FAKE = r'''
import json, os, re, subprocess, sys, time
text = sys.stdin.read()
with open(os.environ["FAKE_CODEX_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "files": os.listdir("."), "prompt": text,
                        "env": {k: os.environ.get(k) for k in ("SPOOKLING_TAGGING", "OPENAI_API_KEY", "CODEX_API_KEY")}}) + "\n")
mode = os.environ.get("FAKE_CODEX_MODE", "ok")
if mode == "fail":
    sys.stderr.write("2026-10-22T21:16:12Z ERROR codex_login: Failed to refresh token\n"
                     "ERROR: Your access token could not be refreshed. Please log out and sign in again.\n")
    sys.exit(1)
if mode == "slow":  # a child that keeps stdout open, as the real binary under npm's node shim would
    subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    time.sleep(30)
sys.stderr.write("OpenAI Codex (fake)\nuser\n" + text + "\n")
if "settle one flagged memory update" in text:
    print(json.dumps({"op": "assert", "value": "Toyota Corolla", "old": None, "when": None, "disputed": False,
                      "confidence": 0.9, "why": "stated"}))
else:
    msgs = re.findall(r"^\[(\d+)\] (.*)$", text, re.M)
    items = lambda t: [{"label": "fact", "key": "car", "value": "Toyota Corolla", "old": None, "when": None,
                        "confidence": 0.95, "cues": []}] if "Toyota Corolla" in t else []
    print(json.dumps({"turns": [{"turn": int(n), "items": items(t)} for n, t in msgs]}))
'''


@pytest.fixture
def fake(tmp_path, monkeypatch):
    """A fake codex first on PATH; returns the list of recorded runs."""
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    (bin_ / "fake_codex.py").write_text(FAKE)
    if os.name == "nt":
        (bin_ / "codex.bat").write_text(f'@"{sys.executable}" "%~dp0fake_codex.py" %*\n')
    else:
        (bin_ / "codex").write_text(f"#!{sys.executable}\n" + FAKE)
        (bin_ / "codex").chmod(0o755)
    log = tmp_path / "runs.jsonl"
    monkeypatch.setenv("PATH", f"{bin_}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("FAKE_CODEX_LOG", str(log))
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("CODEX_API_KEY", "sk-test")
    return lambda: [json.loads(x) for x in log.read_text(encoding="utf-8").splitlines()] if log.exists() else []


@pytest.fixture
def codex_store(tmp_path):
    made = []

    def make():
        s = Store(tmp_path / "m", **S.adapter("codex"))
        made.append(s)
        return s

    yield make
    for s in made:
        s.close()


def test_codex_tags_a_chat_through_the_store(fake, codex_store, tmp_path):
    s = codex_store()
    s.ingest("s1", turns(["I drive a Toyota Corolla, nothing fancy.", "How do I roast peppers?"]), "2024-05-22T10:00:00Z")
    assert "Toyota Corolla" in s.retrieve("What car do I drive?", "2025-03-01T10:00:00Z")["context"]
    runs = fake()
    assert runs and all(r["argv"] == S.CODEX for r in runs)
    assert "-m" in S.CODEX and S.CODEX[-1] == "-"  # the prompt goes in on stdin
    for r in runs:
        assert r["files"] == [] and not os.path.exists(r["cwd"])  # an empty temp folder, removed after
        assert r["env"] == {"SPOOKLING_TAGGING": "1", "OPENAI_API_KEY": None, "CODEX_API_KEY": None}
    assert runs[0]["prompt"].startswith(SYSTEM) and "[user]\nSession date:" in runs[0]["prompt"]
    assert s.stats()["tagger"] == {"model": "codex", "via": "codex", "decider": None}  # what `status` shows
    judged = [d for d in s.mem.log.decisions if d["step"] == "triage"]
    assert judged and all(d["version"].startswith("codex|") and d["writer"].startswith("codex/") for d in judged)
    s.close()
    n = len(runs)
    codex_store()  # reopening replays the records: no call
    assert len(fake()) == n


def test_a_failed_codex_call_is_a_503_and_nothing_is_written(fake, codex_store, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "fail")
    c = TestClient(create_app(codex_store()), base_url="http://127.0.0.1:7447")
    r = c.post("/v1/ingest", json={"id": "s1", "ts": "2024-05-22T10:00:00Z", "turns": turns(["I drive a Toyota Corolla."])})
    assert r.status_code == 503
    assert r.json()["detail"] == "codex exited 1: ERROR: Your access token could not be refreshed. Please log out and sign in again."
    assert not (tmp_path / "m" / "log.jsonl").exists()


def test_codex_missing_is_a_clear_error(monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", str(tmp_path))
    with pytest.raises(RuntimeError, match="codex CLI is not on the server's PATH"):
        S.codex([{"role": "user", "content": "hi"}])


def test_a_hung_codex_is_killed_with_its_children(fake, monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "slow")
    monkeypatch.setattr(S, "TIMEOUT", 1)
    t = time.monotonic()
    with pytest.raises(RuntimeError, match="codex gave no reply in 1 s"):
        S.codex([{"role": "user", "content": "hi"}])
    assert time.monotonic() - t < 10  # a child left holding stdout would keep communicate() waiting 30 s


def test_the_model_id_picks_the_backend(monkeypatch):
    monkeypatch.setattr(models, "BACKEND", "openrouter")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert S.backend("codex") == "codex"
    assert S.backend("typesafe/jev-router") == "openrouter"
    a = S.adapter("codex")
    assert a["model"] == "codex" and isinstance(a["triage"], S.Subscription) and a["triage"].ask is S.codex
    assert S.adapter("typesafe/jev-router") == {"model": "typesafe/jev-router"}
    assert S.adapter(None) == {"model": WRITER} and models.route(WRITER) == "openrouter"  # no Anthropic key
    monkeypatch.setenv("ANTHROPIC_API_KEY", "\u0073k-ant-test")
    assert S.backend(WRITER) == "anthropic" and S.backend("typesafe/jev-router") == "openrouter"
    assert S.adapter(WRITER) == {"model": WRITER} and models.route(WRITER) == "anthropic"  # the wizard's choice 2
    assert models.route("typesafe/jev-router") == "openrouter"


def test_one_prompt_from_chat_messages():
    msgs = [{"role": "system", "content": "Tag."}, {"role": "user", "content": "[1] hi"},
            {"role": "assistant", "content": "{}"}, {"role": "user", "content": "JSON only."}]
    assert S.prompt(msgs) == "Tag.\n\n[user]\n[1] hi\n\n[assistant]\n{}\n\n[user]\nJSON only."
