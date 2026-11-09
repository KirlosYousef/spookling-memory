"""Model client: OpenRouter, or the Anthropic API for anthropic/ ids when BACKEND is "anthropic", behind one cache."""
from __future__ import annotations

import difflib
import hashlib
import json
import os
import random
import re
import sqlite3
import sys
import threading
import time
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import openai

READER = "anthropic/claude-haiku-4.5"
JUDGES = ("anthropic/claude-sonnet-5", "openai/gpt-6-sol")  # judge 1 is the headline
BASE_URL = "https://openrouter.ai/api/v1"
KEY_FILE = Path.home() / "spookling-rig" / "openrouter.env"
ANTHROPIC_KEY_FILE = Path.home() / "spookling-rig" / "anthropic.env"
CACHE_PATH = Path.home() / ".cache" / "spookling-memory" / "cache.sqlite"  # the server and memory-bench each set their own
MAX_ATTEMPTS = 5
# Both reason by default (Sonnet 5 at "high") and ignore temperature: pin the effort.
MODEL_PARAMS: dict[str, dict] = {
    "anthropic/claude-sonnet-5": {"reasoning": {"effort": "low"}},
    "openai/gpt-6-sol": {"reasoning": {"effort": "low"}},
}
# our ids -> Anthropic API ids; anything else drops "anthropic/" and turns dots into dashes
ANTHROPIC_IDS = {"anthropic/claude-haiku-4.5": "claude-haiku-4-5", "anthropic/claude-sonnet-5": "claude-sonnet-5",
                 "anthropic/claude-opus-5.5": "claude-opus-5-5"}
# USD per million tokens: input, output, cache-read multiplier; a cache write is 1.25x input, a batch halves it all
ANTHROPIC_PRICES = {"claude-haiku-4-5": (1.0, 5.0, 0.1), "claude-sonnet-5": (2.0, 10.0, 0.1),
                    "claude-opus-5-5": (4.0, 20.0, 0.05)}
CACHE_WRITE = 1.25
DEFER_PHASES = ("reader", "judge")
MAX_BATCH_REQUESTS = 100_000  # API limit per batch
MAX_BATCH_BYTES = 200 * 2**20  # API limit is 256 MB; keep a margin

BACKEND = "openrouter"
PRICES: dict[str, tuple[float, float]] = {}  # model -> USD per (prompt, completion) token (OpenRouter)
PROVIDERS: dict[str, str] = {}  # model -> pinned provider tag
CONTEXT: dict[str, int] = {}  # model -> context window of the pinned endpoint (tokens)
NO_TEMPERATURE: set[str] = set()  # checked models whose endpoints do not take temperature
CACHE_ONLY = False  # bench verify / failures: a cache miss is an error, never a paid call
DEFER = False  # bench run --batch: reader/judge misses are parked in PENDING, not sent
SPEND_ONLY = False  # batch collect passes: record money spent, not the per-call list cost
PENDING: dict[str, dict] = {}  # cache key -> {"model", "request"} waiting for a batch
STOPPED: str | None = None  # set by the first credit/billing/key error: no new call is sent after it
STOP_INFO: dict | None = None  # the same, as data (stop_info)
USAGE: dict[str, dict] = {}  # model -> totals for this process
SLEEP = time.sleep  # tests replace it

_lock = threading.Lock()
_key_locks: dict[str, threading.Lock] = {}  # single flight: one lock per cache key
_tls = threading.local()
_client_obj: openai.OpenAI | None = None
_anthropic_client = None


class CacheMiss(RuntimeError):
    pass


class CreditExhausted(RuntimeError):
    """The key cannot be used (out of credit, over its limit, invalid or disabled): never retried; the first one stops
    every new call in this process."""


KEY_WORDS = ("key limit", "limit exceeded", "limit reached", "over its limit", "spend limit", "invalid api key", "invalid key",
             "invalid x-api-key", "incorrect api key", "key is disabled", "key disabled", "disabled", "revoked", "expired",
             "no auth credentials", "user not found", "insufficient credit")


def is_credit_error(e: Exception) -> bool:
    """Credit gone (402, Anthropic's 400) or a key the provider refuses: a 401/403 that says it is over its limit, invalid
    or disabled (OpenRouter's 403 "Key limit exceeded"). Other 401/403s (a model the key may not use) are not."""
    status, text = getattr(e, "status_code", None), str(e).lower()
    return ((status == 402 and "in_flight" not in text) or (status == 400 and "credit balance" in text)
            or (status in (401, 403) and any(w in text for w in KEY_WORDS)))


def stop_kind(e: Exception) -> str:
    """credit: out of money; limit: the key's own cap; key: refused as invalid or disabled."""
    text = str(e).lower()
    if "limit" in text and getattr(e, "status_code", None) in (401, 403):
        return "limit"
    return "credit" if getattr(e, "status_code", None) in (400, 402) or "credit" in text else "key"


def provider_of(model: str | None) -> str:
    return "anthropic" if model and route(model) == "anthropic" else "openrouter"


def _stop(e: Exception, model: str | None = None) -> CreditExhausted:
    global STOPPED, STOP_INFO
    with _lock:
        kind = stop_kind(e)
        label = {"credit": "credit exhausted", "limit": "key limit exceeded", "key": "key refused"}[kind]
        STOPPED = STOPPED or f"{label}: {str(e)[:300]}"
        if STOP_INFO is None:  # the first one is the one to show
            STOP_INFO = {"kind": kind, "provider": provider_of(model),
                         "since": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "reason": STOPPED}
    return CreditExhausted(STOPPED)


def stop_info() -> dict | None:
    """Why no model call is sent any more in this process, for status: {kind, provider, since, reason}, or None."""
    return STOP_INFO


class Deferred(RuntimeError):
    """A reader or judge call parked for a Message Batches job (bench run --batch)."""


class _Retry(RuntimeError):
    pass


@dataclass
class Reply:
    text: str
    prompt_tokens: int  # every input token, cached or not
    completion_tokens: int
    cache_hit: bool
    seconds: float
    provider: str | None
    finish_reason: str | None = None  # "length" means the reply was cut at max_tokens
    cache_write: int = 0  # Anthropic prompt caching: input tokens written to the cache
    cache_read: int = 0  # and read from it
    batch: bool = False  # answered by a Message Batches job (half price)
    usd: float | None = None  # OpenRouter's own usage.cost when the model has no list price (routers)


def route(model: str) -> str:
    return "anthropic" if BACKEND == "anthropic" and model.startswith("anthropic/") else "openrouter"


def anthropic_id(model: str) -> str:
    return ANTHROPIC_IDS.get(model) or model.removeprefix("anthropic/").replace(".", "-")


def _key(var: str, path: Path, file_first: bool = False) -> str:
    """The key from the env, else from a `[export ]VAR=...` line in path (file_first: the file wins)."""
    key = None if file_first else os.environ.get(var)
    if not key and path.exists():
        m = re.search(rf"^\s*(?:export\s+)?{var}\s*=\s*['\"]?([^'\"\s]+)", path.read_text(), re.M)
        key = m.group(1) if m else None
    if not key:
        sys.exit(f"{var} is not set and not found in {path}")
    return key


def api_key() -> str:
    return _key("OPENROUTER_API_KEY", KEY_FILE)


def _get(path: str) -> dict:
    req = urllib.request.Request(BASE_URL + path, headers={"Authorization": f"Bearer {api_key()}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def _closest_or_exit(missing: list[str], have: list[str], where: str) -> None:
    for i in missing:
        close = difflib.get_close_matches(i, have, n=6, cutoff=0.3)
        print(f"model id not on {where}: {i}\n  closest: {', '.join(close) or '(none)'}", file=sys.stderr)
    if missing:
        sys.exit(1)


def check_models(ids) -> None:
    """Every id must exist where it is routed (else exit 1); loads prices and context windows, pins providers."""
    ids = list(dict.fromkeys(ids))
    anth = [i for i in ids if route(i) == "anthropic"]
    if anth:
        _check_anthropic(anth)
    ids = [i for i in ids if route(i) == "openrouter"]
    if not ids:
        return
    try:
        have = {m["id"]: m for m in _get("/models")["data"]}
    except Exception as e:
        sys.exit(f"cannot list OpenRouter models: {e}")
    _closest_or_exit([i for i in ids if i not in have], list(have), "OpenRouter")
    for i, m in have.items():
        try:
            pin, pout = float(m["pricing"]["prompt"]), float(m["pricing"]["completion"])
            if pin >= 0 and pout >= 0:  # a router (typesafe/jev-router) lists -1: price comes back per call in usage.cost
                PRICES[i] = (pin, pout)
        except (KeyError, TypeError, ValueError):
            pass
    for i in ids:
        if "temperature" not in have[i].get("supported_parameters", []):
            NO_TEMPERATURE.add(i)
        try:
            endpoints = _get(f"/models/{i}/endpoints")["data"]["endpoints"]
            if endpoints:
                PROVIDERS[i] = endpoints[0]["tag"]
                CONTEXT[i] = int(endpoints[0].get("context_length") or have[i].get("context_length") or 0)
            else:  # a router has no endpoint of its own: no provider pin, context from the listing
                CONTEXT[i] = int(have[i].get("context_length") or 0)
        except Exception as e:
            sys.exit(f"cannot list providers for {i}: {e}")


def _check_anthropic(ids: list[str]) -> None:
    try:
        have = {m.id: m for m in _anthropic().models.list()}
    except Exception as e:
        sys.exit(f"cannot list Anthropic models: {e}")
    # the list may give dated snapshots (claude-haiku-4-5-20251001); the bare alias is accepted by the API
    find = lambda mid: have.get(mid) or next((m for k, m in sorted(have.items()) if k.startswith(mid + "-")), None)
    _closest_or_exit([anthropic_id(i) for i in ids if find(anthropic_id(i)) is None], list(have), "the Anthropic API")
    for i in ids:
        m = find(anthropic_id(i))
        CONTEXT[i] = int(getattr(m, "max_input_tokens", 0) or 0)
        PROVIDERS[i] = "anthropic-api"
        if not anthropic_id(i).startswith("claude-haiku"):
            NO_TEMPERATURE.add(i)
        if anthropic_id(i) not in ANTHROPIC_PRICES:
            print(f"warning: no price on file for {anthropic_id(i)}; its cost is recorded as $0", file=sys.stderr)


def _client() -> openai.OpenAI:
    global _client_obj
    if _client_obj is None:
        _client_obj = openai.OpenAI(base_url=BASE_URL, api_key=api_key(), max_retries=0, timeout=600)
    return _client_obj


def _anthropic():
    """The official SDK client; it retries 408, 409, 429 and 5xx itself, with backoff and jitter."""
    global _anthropic_client
    if _anthropic_client is None:
        import anthropic

        # ANTHROPIC_KEY_FILE picks another key file (two keys, two runs); when set, that file wins over the env var.
        override = os.environ.get("ANTHROPIC_KEY_FILE")
        key = _key("ANTHROPIC_API_KEY", Path(override).expanduser(), file_first=True) if override \
            else _key("ANTHROPIC_API_KEY", ANTHROPIC_KEY_FILE)
        workspace = os.environ.get("ANTHROPIC_WORKSPACE_ID")  # user keys must name their workspace
        _anthropic_client = anthropic.Anthropic(
            api_key=key, max_retries=MAX_ATTEMPTS - 1, timeout=600,
            **({"default_headers": {"anthropic-workspace-id": workspace}} if workspace else {}))
    return _anthropic_client


_COLUMNS = {"finish_reason": "text", "cache_write": "integer", "cache_read": "integer", "batch": "integer"}


def _db() -> sqlite3.Connection:
    dbs = _tls.__dict__.setdefault("dbs", {})
    if CACHE_PATH not in dbs:
        with _lock:  # threads opening a fresh cache at once would race on the WAL switch ("database is locked")
            CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
            c = sqlite3.connect(CACHE_PATH, timeout=60, isolation_level=None)
            c.execute("pragma journal_mode=wal")
            c.execute(
                "create table if not exists calls (key text primary key, model text not null, text text not null,"
                " prompt_tokens integer, completion_tokens integer, provider text, created text)"
            )
            have = {r[1] for r in c.execute("pragma table_info(calls)")}
            for col, kind in _COLUMNS.items():  # caches made before these were stored
                if col not in have:
                    c.execute(f"alter table calls add column {col} {kind}")
        dbs[CACHE_PATH] = c
    return dbs[CACHE_PATH]


def _blank() -> dict:
    return {"calls": 0, "hits": 0, "prompt_tokens": 0, "completion_tokens": 0, "cache_write_tokens": 0,
            "cache_read_tokens": 0, "cost_usd": 0.0, "spent_usd": 0.0}


@contextmanager
def meter():
    """Usage of this thread's calls inside the block, split by phase: {"reader": {...}, ...}."""
    m: dict[str, dict] = {}
    prev = getattr(_tls, "meter", None)
    _tls.meter = m
    try:
        yield m
    finally:
        _tls.meter = prev


@contextmanager
def phase(name: str):
    prev = getattr(_tls, "phase", "other")
    _tls.phase = name
    try:
        yield
    finally:
        _tls.phase = prev


def cost(model: str, r: Reply) -> float:
    """List price of one reply (Anthropic: cache writes 1.25x, reads at the cache-read price, batch half)."""
    if route(model) == "anthropic":
        pin, pout, read = ANTHROPIC_PRICES.get(anthropic_id(model), (0.0, 0.0, 0.1))
        fresh = r.prompt_tokens - r.cache_write - r.cache_read
        usd = (fresh * pin + r.cache_write * pin * CACHE_WRITE + r.cache_read * pin * read + r.completion_tokens * pout) / 1e6
        return usd * (0.5 if r.batch else 1.0)
    if model not in PRICES and r.usd is not None:
        return r.usd
    pin, pout = PRICES.get(model, (0.0, 0.0))
    return r.prompt_tokens * pin + r.completion_tokens * pout


def _record(model: str, r: Reply, spent_only: bool = False) -> None:
    usd = cost(model, r)
    spent = 0.0 if r.cache_hit else usd
    m = getattr(_tls, "meter", None)
    with _lock:
        if spent_only or SPEND_ONLY:  # batch bookkeeping: money spent, nothing else
            USAGE.setdefault(model, _blank())["spent_usd"] += spent
            return
        rows = [USAGE.setdefault(model, _blank())]
        if m is not None:
            rows.append(m.setdefault(getattr(_tls, "phase", "other"), _blank()))
        for u in rows:
            u["calls"] += 1
            u["hits"] += int(r.cache_hit)
            u["prompt_tokens"] += r.prompt_tokens
            u["completion_tokens"] += r.completion_tokens
            u["cache_write_tokens"] += r.cache_write
            u["cache_read_tokens"] += r.cache_read
            u["cost_usd"] += usd  # list price, hit or miss
            u["spent_usd"] += spent


def _cached(key: str) -> Reply | None:
    row = _db().execute(
        "select text, prompt_tokens, completion_tokens, provider, finish_reason, cache_write, cache_read, batch"
        " from calls where key = ?", (key,)
    ).fetchone()
    if not row:
        return None
    return Reply(row[0], row[1] or 0, row[2] or 0, True, 0.0, row[3], row[4], row[5] or 0, row[6] or 0, bool(row[7]))


def _store(key: str, model: str, text: str, pt: int, ct: int, provider, finish, cw: int = 0, cr: int = 0,
           batch: bool = False) -> None:
    _db().execute(  # first writer wins, also across processes
        "insert or ignore into calls (key, model, text, prompt_tokens, completion_tokens, provider, created,"
        " finish_reason, cache_write, cache_read, batch) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (key, model, text, pt, ct, provider, datetime.now(timezone.utc).isoformat(), finish, cw, cr, int(batch)),
    )


def cache_key(model: str, messages: list[dict], params: dict) -> str:
    parts = [model, messages, params] + (["anthropic-api"] if route(model) == "anthropic" else [])
    return hashlib.sha256(json.dumps(parts, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def call(model: str, messages: list[dict], **params) -> Reply:
    """One chat completion, cached; single flight: concurrent identical calls make one API call."""
    params = {**MODEL_PARAMS.get(model, {}), **params, "temperature": 0}
    key = cache_key(model, messages, params)
    reply = _cached(key)
    if reply is None:
        if STOPPED:  # out of credit: cache hits still serve, nothing new is sent
            raise CreditExhausted(STOPPED)
        if DEFER and route(model) == "anthropic" and getattr(_tls, "phase", "") in DEFER_PHASES:
            with _lock:
                PENDING[key] = {"model": model, "request": anthropic_request(model, messages, params)}
            raise Deferred(f"{model}: parked for a batch (key {key[:12]})")
        with _lock:
            # ponytail: one Lock per key, never freed; a few MB over a million calls
            key_lock = _key_locks.setdefault(key, threading.Lock())
        with key_lock:
            reply = _cached(key)  # another thread may have filled it while we waited
            if reply is None:
                if CACHE_ONLY:
                    raise CacheMiss(f"{model}: reply not in cache (key {key[:12]})")
                if STOPPED:
                    raise CreditExhausted(STOPPED)
                t0 = time.monotonic()
                try:
                    usd = None
                    if "questions" in params:  # a Decisions API request (decisions.py): typed answers, not chat
                        from .decisions import send

                        text, pt, ct, usd = send(model, messages[0]["content"], params["questions"])
                        _store(key, model, text, pt, ct, "decisions", None)
                    elif route(model) == "anthropic":
                        text, pt, ct, finish, cw, cr = _send_anthropic(model, messages, params)
                        _store(key, model, text, pt, ct, "anthropic-api", finish, cw, cr)
                    else:
                        out = _send(model, messages, params)
                        text, pt, ct, provider, finish = out[:5]
                        usd = out[5] if len(out) > 5 else None  # test stubs still return five values
                        _store(key, model, text, pt, ct, provider, finish)
                except Exception as e:
                    if is_credit_error(e):
                        raise _stop(e, model) from None
                    raise
                stored = _cached(key)
                stored.cache_hit, stored.seconds, stored.usd = False, time.monotonic() - t0, usd
                reply = stored
    _record(model, reply)
    return reply


def complete(model: str, messages: list[dict], **params) -> str:
    """Cached, temperature 0, returns the reply text."""
    return call(model, messages, **params).text


def _send(model: str, messages: list[dict], params: dict) -> tuple[str, int, int, str | None, str | None, float | None]:
    body = dict(params)
    if model in PROVIDERS:
        body["provider"] = {"order": [PROVIDERS[model]], "allow_fallbacks": False}
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            r = _client().chat.completions.create(model=model, messages=messages, extra_body=body)
            if not r.choices:
                raise _Retry(f"{model}: no choices in reply ({getattr(r, 'error', None)})")
            text = r.choices[0].message.content or ""
            if not text.strip():
                raise _Retry(f"{model}: empty reply (finish_reason={r.choices[0].finish_reason})")
            u = r.usage
            usd = None  # OpenRouter puts the charged price in usage.cost; routers have no list price, so keep it
            if u is not None:
                usd = getattr(u, "cost", None)
                if usd is None and getattr(u, "model_extra", None):
                    usd = u.model_extra.get("cost")
            return (text, (u.prompt_tokens if u else 0), (u.completion_tokens if u else 0), getattr(r, "provider", None),
                    r.choices[0].finish_reason, (float(usd) if usd is not None else None))
        except (openai.APIStatusError, openai.APIConnectionError, _Retry) as e:
            if attempt == MAX_ATTEMPTS or not _retryable(e):
                raise
            d = min(60.0, 2.0**attempt)
            if isinstance(e, openai.APIStatusError):  # honour Retry-After, capped
                try:
                    d = max(d, min(60.0, float(e.response.headers.get("retry-after") or 0)))
                except ValueError:
                    pass
            time.sleep(d / 2 + random.uniform(0, d / 2))  # exponential backoff with jitter
    raise AssertionError("unreachable")


def _retryable(e: Exception) -> bool:
    """429, 5xx, network errors, empty replies and the 402 "in-flight budget"; never a plain 402 or other 4xx."""
    if isinstance(e, openai.APIStatusError):
        return e.status_code == 429 or e.status_code >= 500 or (e.status_code == 402 and "in_flight" in str(e))
    return True


def anthropic_request(model: str, messages: list[dict], params: dict) -> dict:
    """Our messages and params as Messages API parameters; temperature only for Haiku (the others reject it)."""
    mid = anthropic_id(model)
    system, msgs = [], []
    for m in messages:
        c = m["content"]
        if m["role"] == "system":
            system += [{"type": "text", "text": c}] if isinstance(c, str) else list(c)
        else:
            msgs.append({"role": m["role"], "content": c})
    req = {"model": mid, "max_tokens": int(params.get("max_tokens") or 4096), "messages": msgs}
    if system:
        req["system"] = system
    if mid.startswith("claude-haiku") and "temperature" in params:
        req["temperature"] = params["temperature"]
    effort = (params.get("reasoning") or {}).get("effort")
    if effort and not mid.startswith("claude-haiku"):
        req["output_config"] = {"effort": effort}
    return req


def _parse_message(msg) -> tuple[str, int, int, str | None, int, int]:
    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    u = msg.usage
    cw, cr = int(getattr(u, "cache_creation_input_tokens", 0) or 0), int(getattr(u, "cache_read_input_tokens", 0) or 0)
    finish = {"max_tokens": "length", "end_turn": "stop", "stop_sequence": "stop"}.get(msg.stop_reason, msg.stop_reason)
    return text, int(u.input_tokens) + cw + cr, int(u.output_tokens), finish, cw, cr


def _send_anthropic(model: str, messages: list[dict], params: dict) -> tuple[str, int, int, str | None, int, int]:
    req = anthropic_request(model, messages, params)
    # SDK 1.x dropped temperature from create(); the API still honours it on Haiku 4.5, so it rides in extra_body
    extra = {"extra_body": {"temperature": req.pop("temperature")}} if "temperature" in req else {}
    msg = _anthropic().messages.create(**req, **extra)
    text, pt, ct, finish, cw, cr = _parse_message(msg)
    if not text.strip() and finish != "length":
        raise RuntimeError(f"{model}: empty reply (stop_reason={msg.stop_reason})")
    return text, pt, ct, finish, cw, cr


def _chunks(pending: dict[str, dict]):
    """Split requests at the Batches API limits (count and size)."""
    chunk, size = [], 0
    for key, item in pending.items():
        n = len(json.dumps(item["request"], ensure_ascii=False).encode())
        if chunk and (len(chunk) >= MAX_BATCH_REQUESTS or size + n > MAX_BATCH_BYTES):
            yield chunk
            chunk, size = [], 0
        chunk.append(key)
        size += n
    if chunk:
        yield chunk


def wait_for_batch(batch_id: str, cap: float = 60.0, max_wait: float = 26 * 3600):
    """Poll until the batch has ended: exponential backoff with jitter, capped at `cap` seconds."""
    delay, waited = 5.0, 0.0
    while True:
        b = _anthropic().messages.batches.retrieve(batch_id)
        if b.processing_status == "ended":
            return b
        if waited > max_wait:
            raise TimeoutError(f"batch {batch_id} still {b.processing_status} after {waited:.0f}s")
        pause = delay / 2 + random.uniform(0, delay / 2)
        SLEEP(pause)
        waited += pause
        delay = min(cap, delay * 2)


def _collect(state_file: Path) -> dict:
    """Wait for one recorded batch, write its results into the cache, mark it collected."""
    state = json.loads(state_file.read_text())
    wait_for_batch(state["id"])
    counts = {"succeeded": 0, "errored": 0, "canceled": 0, "expired": 0, "empty": 0}
    for res in _anthropic().messages.batches.results(state["id"]):
        model = state["models"].get(res.custom_id)
        kind = res.result.type
        if kind != "succeeded" or model is None:
            counts[kind if kind in counts else "errored"] += 1
            continue
        text, pt, ct, finish, cw, cr = _parse_message(res.result.message)
        if not text.strip() and finish != "length":
            counts["empty"] += 1
            continue
        _store(res.custom_id, model, text, pt, ct, "anthropic-batch", finish, cw, cr, batch=True)
        counts["succeeded"] += 1
        _record(model, Reply(text, pt, ct, False, 0.0, "anthropic-batch", finish, cw, cr, True), spent_only=True)
    state.update(collected=True, counts=counts, collected_at=datetime.now(timezone.utc).isoformat())
    state_file.write_text(json.dumps(state, indent=1) + "\n")
    missing = sum(v for k, v in counts.items() if k != "succeeded")
    print(f"batch {state['id']}: {counts['succeeded']} results cached"
          + (f", {missing} without a result ({counts}); re-run with --batch to resubmit them" if missing else ""), flush=True)
    return counts


def run_batches(pending: dict[str, dict], state_dir: Path) -> int:
    """Send pending requests as batches and cache every result; a crashed run's open batches are collected first."""
    state_dir.mkdir(parents=True, exist_ok=True)
    for f in sorted(state_dir.glob("*.json")):  # resume
        if not json.loads(f.read_text()).get("collected"):
            _collect(f)
    todo = {k: v for k, v in pending.items() if _cached(k) is None}
    files = []
    for keys in _chunks(todo):
        try:
            b = _anthropic().messages.batches.create(
                requests=[{"custom_id": k, "params": todo[k]["request"]} for k in keys])
        except Exception as e:
            if is_credit_error(e):
                raise _stop(e, todo[keys[0]]["model"]) from None
            raise
        f = state_dir / f"{b.id}.json"
        f.write_text(json.dumps({"id": b.id, "created": datetime.now(timezone.utc).isoformat(), "collected": False,
                                 "models": {k: todo[k]["model"] for k in keys}}, indent=1) + "\n")
        print(f"submitted batch {b.id}: {len(keys)} requests (state in {f})", flush=True)
        files.append(f)
    for f in files:
        _collect(f)
    return len(todo)


def batch_status(batch_id: str) -> dict:
    b = _anthropic().messages.batches.retrieve(batch_id)
    counts = getattr(b, "request_counts", None)
    return {"id": b.id, "processing_status": b.processing_status,
            "request_counts": counts.model_dump() if hasattr(counts, "model_dump") else counts,
            "created_at": str(getattr(b, "created_at", "")), "ended_at": str(getattr(b, "ended_at", ""))}


def batch_cancel(batch_id: str) -> str:
    return _anthropic().messages.batches.cancel(batch_id).processing_status
