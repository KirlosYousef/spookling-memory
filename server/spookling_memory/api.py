"""Local HTTP API. A browser page can reach 127.0.0.1 too, hence the Host check and JSON-only POSTs (no CORS)."""
from __future__ import annotations

import io
import json
import threading
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from pydantic_core import PydanticSerializationError
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import hooks
from .portability import read_archive
from .store import Busy, Store

HOST, PORT = "127.0.0.1", 7447
POST_TYPES = ("application/json", "application/octet-stream")
WAIT = 10  # seconds before a 503: under the hooks' 15 s, so they hear back


class TurnIn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class SessionIn(BaseModel):
    id: str
    ts: str | None = None
    turns: list[TurnIn]
    agent: str = "user"
    tail: bool = False  # turns is the whole conversation so far


class BackfillIn(BaseModel):
    session_id: str
    transcript_path: str
    harness: Literal["claude", "codex"] = "claude"


class QuestionIn(BaseModel):
    question: str
    ts: str | None = None


class SessionRef(BaseModel):
    session_id: str


class NoteIn(BaseModel):
    note: str = ""


def create_app(store: Store) -> FastAPI:
    app = FastAPI(title="Spookling Memory", version="0.2.2")
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=[HOST, "localhost"])

    @app.middleware("http")
    async def no_simple_posts(request: Request, call_next):
        if request.method == "POST" and request.headers.get("content-type", "").split(";")[0].strip() not in POST_TYPES:
            return JSONResponse({"detail": "send content-type application/json (application/octet-stream for /v1/import)"}, 415)
        return await call_next(request)

    @app.exception_handler(ValueError)
    async def refused(request: Request, e: ValueError):
        if isinstance(e, PydanticSerializationError):  # a ValueError too, but our bug: a 500, not a 409
            raise e
        return JSONResponse({"detail": str(e)}, 409)

    @app.exception_handler(RuntimeError)
    async def unavailable(request: Request, e: RuntimeError):  # the writer model failed, or Busy
        busy = {"Retry-After": str(Busy.retry_after)} if isinstance(e, Busy) else None
        return JSONResponse({"detail": str(e)}, 503, headers=busy)

    @app.post("/v1/ingest")
    def ingest(s: SessionIn) -> dict:
        out = {"logged": store.ingest(s.id, [t.model_dump() for t in s.turns], s.ts, s.agent, s.tail)}
        note = store.model_note()  # the turns are saved either way; say when the model could not read them yet
        return out | {"note": note} if note else out

    @app.post("/v1/backfill")
    def backfill(b: BackfillIn) -> dict:
        """Log the turns of one transcript file that the LOG does not hold yet, replies an earlier version dropped included;
        a repeat adds nothing."""
        agent = "codex" if b.harness == "codex" else "claude-code"
        out = {"logged": hooks.log_transcript(store, agent, b.session_id, b.transcript_path, patient=True, recover=True)}
        note = store.model_note()
        return out | {"note": note} if note else out

    @app.post("/v1/retrieve")
    def retrieve(q: QuestionIn) -> dict:
        return store.retrieve(q.question, q.ts)

    @app.post("/v1/compact")
    def compact(s: SessionRef) -> dict:
        return store.compact(s.session_id)

    @app.post("/v1/reset")
    def reset(n: NoteIn) -> dict:
        return store.reset(n.note)

    @app.post("/v1/reset/undo")
    def undo() -> dict:
        return store.undo_reset()

    @app.get("/v1/export")
    def export() -> Response:
        buf = io.BytesIO()
        store.export(buf)
        return Response(buf.getvalue(), media_type="application/gzip",
                        headers={"content-disposition": 'attachment; filename="memory.spookling"'})

    @app.post("/v1/import")
    async def import_(request: Request) -> dict:
        events, decisions, _ = read_archive(io.BytesIO(await request.body()))
        return await run_in_threadpool(store.restore, events, decisions)

    @app.get("/v1/stats")
    def stats() -> dict:
        return store.stats()

    said: set[str] = set()

    @app.post("/v1/hook/{event}")
    async def hook(event: str, request: Request, tasks: BackgroundTasks):
        """Read by hand: as `payload: dict`, FastAPI answered an empty body 422 and said nothing."""
        if event not in hooks.EVENTS:
            raise HTTPException(404, f"hook events: {', '.join(hooks.EVENTS)}")
        body = await request.body()
        try:
            payload = hooks.payload(body)
        except ValueError as e:
            kind = str(e).split(" at character")[0]
            if (event, kind) not in said:
                said.add((event, kind))
                hooks.LOG.warning("hook %s: %d-byte body refused, logged once per kind: %s; it starts %r", event,
                                  len(body), e, body[:80])
            return JSONResponse({"detail": str(e)}, 400)
        if event == "stop":  # reply at once: the tagging runs after the response
            tasks.add_task(quietly, store, event, payload)
            return {}
        try:
            body, pulse = await run_in_threadpool(hooks.handle, store, event, payload)
        except Exception as e:  # noqa: BLE001  # a hook never fails Claude Code: no recall this time
            hooks.LOG.warning("hook %s: answered with nothing (%s: %s)", event, type(e).__name__, e)
            body, pulse = {}, {}
        return JSONResponse(body, headers={hooks.PULSE: json.dumps(pulse, separators=(",", ":"))} if pulse else None)

    return app


def quietly(store, event: str, payload: dict) -> None:
    """After the reply an error cannot reach Claude: log it; the next Stop logs the turns."""
    try:
        hooks.handle(store, event, payload)
    except Exception as e:  # noqa: BLE001
        hooks.LOG.warning("hook %s: the turns were not logged this time (%s: %s)", event, type(e).__name__, e)


def serve(folder: str, port: int = PORT, **adapter) -> None:
    """Listens at once; the folder opens in the background, 503 until then."""
    import uvicorn

    store = Store(folder, background=True, wait=WAIT, **adapter)
    app = create_app(store)

    @asynccontextmanager
    async def lifespan(_):
        yield
        # here too: uvicorn re-raises SIGINT or SIGTERM after shutdown, which ends the process before a finally runs
        store.close()

    app.router.lifespan_context = lifespan
    server = uvicorn.Server(uvicorn.Config(app, host=HOST, port=port))

    def opened():
        store.ready.wait()
        if store.failed is not None:
            hooks.LOG.error("%s could not be opened: %r", folder, store.failed)
            server.should_exit = True

    threading.Thread(target=opened, daemon=True).start()
    try:
        server.run()
    finally:
        store.close()  # covers a failed start
    if store.failed is not None:
        raise store.failed
