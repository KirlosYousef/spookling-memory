# spookling-memory server

The memory algorithm and its local server. `spookling_memory/core/` is the algorithm (moved from memory-bench on 24 Oct
2026, `../docs/ORIGIN.md`; memory-bench runs it as its `spookling` adapter); the rest puts it behind an HTTP API on
127.0.0.1, a stdio MCP server, and the server side of Claude Code and Codex hooks.

## Run

```bash
cd server
uv sync
uv run spookling-memory serve --folder .memory          # http://127.0.0.1:7447, 127.0.0.1 only
uv run spookling-memory serve --folder .memory --port 8800 --model anthropic/claude-haiku-4.5
uv run spookling-memory serve --folder .memory --model codex       # tag through your Codex subscription
uv run spookling-memory mcp                             # stdio MCP; talks to serve at SPOOKLING_MEMORY_URL
uv run spookling-memory export --folder .memory memory.spookling   # server stopped
uv run spookling-memory import --folder .memory memory.spookling   # into an empty folder
uv run pytest                                           # offline: stub triage, no model calls (the server and core/)
```

Tagging and the slow path call the tagger `--model` picks. `subscription.backend()` is the one place a model id is
mapped to a backend:

| `--model` | backend | needs |
|---|---|---|
| `typesafe/jev-router` (Jev), or any OpenRouter id | `core/models.py`, OpenRouter | `OPENROUTER_API_KEY` (or `~/spookling-rig/openrouter.env`) |
| `anthropic/claude-haiku-4.5` (the default), any `anthropic/` id | the Anthropic API when `ANTHROPIC_API_KEY` is set (`core.models.BACKEND = "anthropic"`), else OpenRouter | `ANTHROPIC_API_KEY` |
| `codex` | your Codex subscription: `codex exec` per call, `gpt-6-luna`, read-only, from an empty temp folder | the `codex` CLI on PATH, logged in with ChatGPT (Plus or higher); check with `codex login status` |

`codex` is a subprocess per call with the prompt on stdin, so it is slower (several seconds per chat), its replies are
not cached, and it runs under your own plan's limits and terms. The server removes `OPENAI_API_KEY` and `CODEX_API_KEY`
from its environment (so the bill stays on the plan), sets `SPOOKLING_TAGGING=1` (the hooks exit at once under it), and
kills its process tree after 90 s. Flags and sources: `../docs/subscription-taggers.md`. Without a key, or with the CLI
missing, failing or timing out, a call that needs the model answers 503 with the reason and the server keeps running. One process owns a folder (an OS lock on `lock`: `fcntl.flock` on macOS and Linux,
`msvcrt.locking` on Windows, released if the process dies); run `serve` once and point the hooks and MCP at it.
`serve` listens at once and opens the folder in the background (6 s for 3,201 turns and 1,152 judgements). A call
waits up to 10 s for the open, or for a rebuild that holds the store, then answers 503 with `Retry-After: 5`; a
failed open stops the server with the reason in its log. Model replies (tagger, slow path, Jev) are cached in
`cache.sqlite` in the memory folder, and with the vectors extra the embedder's in `vectors.sqlite` beside it (caches: not
archived; the wizard's `.memory/.gitignore` keeps them out of git).

## Platforms

macOS, Linux and Windows, Python 3.12 (uv fetches it if missing). Tested on WSL2 Ubuntu and native Windows 11; not
run on macOS.

- **Self-contained**: `uv sync` here needs nothing else; the algorithm is `spookling_memory/core/`. memory-bench depends
  on this package, not the other way round. The npm package carries this folder (pyproject, uv.lock and the sources), and
  `init` copies it to `~/.spookling-memory/<version>/server` (`%LOCALAPPDATA%\spookling-memory\<version>\server` on
  Windows) and runs it from there.
- **Records** are UTF-8 with `\n` line ends on every OS and split on `\n` only, so a `.memory/` folder copied between
  machines opens unchanged.
- **Windows**: run the server with `PYTHONUTF8=1` (the wizard sets it). Python reads files in the locale encoding
  unless told otherwise (the core's `classes.json` included), cp1252 on Windows, which garbles words such as "café". uvicorn runs on asyncio (no uvloop is
  installed). Stop it with Ctrl-C, or `taskkill /PID <pid> /T /F`; the forced stop leaves the adapter's temporary
  copy of the log in `%TEMP%\spookling-log-*`.
- **Local models** (sentence-transformers, this package's `vectors` extra: `uv sync --extra vectors`) are optional
  and not installed by `uv sync`: the server runs keyword-only without them. `SPOOKLING_LOCAL_MODELS=0` turns them off when installed.
- **tiktoken** counts tokens for the recall budget and downloads its `cl100k_base` file (about 1.7 MB) on first use,
  into `TIKTOKEN_CACHE_DIR`, or `data-gym-cache` under the system temp dir (`%TEMP%` on Windows) when unset. On a
  machine without network, copy that cache over first, or set `TIKTOKEN_CACHE_DIR` to a folder that has it.

## Endpoints

| method and path | body | answer |
|---|---|---|
| `POST /v1/ingest` | `{id, ts?, turns: [{role, content}], agent?, tail?}` | `{logged}`: new turns. `tail: true` means `turns` is the whole conversation so far; only the unlogged end is logged, as `<id>#<n>` stamped now |
| `POST /v1/retrieve` | `{question, ts?}` | `{context, digest, strong}` |
| `POST /v1/compact` | `{session_id}` | `{block, kept}`: the `<invariant>` survivor block, and how many items were kept |
| `POST /v1/reset` | `{note?}` | the reset ruling |
| `POST /v1/reset/undo` | `{}` | the undo ruling |
| `GET /v1/export` | | the archive (`application/gzip`) |
| `POST /v1/import` | the archive, `application/octet-stream` | `{events, judgements}`; the memory must be empty |
| `GET /v1/stats` | | store counts, `reset`, `before_reset`, `tagger` (`{model, via}`, via `openrouter`, `anthropic` or `codex`) |
| `POST /v1/hook/{user-prompt-submit,pre-compact,stop}` | the host hook's stdin JSON (`harness: "codex"` for Codex) | what the hook prints |

`ts` is ISO 8601, default now. A refused change (a reset that predates the log, an import into a memory that is not
empty, nothing to undo, a bad timestamp) is 409 with the reason; a store still opening or rebuilding is 503 with
`Retry-After`. A hook body is read as sent: empty is `{}`, and only a body that is not one JSON object is 400 with the
reason (logged once per kind). Every POST must be `application/json` (or
`application/octet-stream` for import) and the Host must be 127.0.0.1 or localhost; with no CORS configured, a web page
cannot drive the server. The MCP tools are `memory_retrieve`, `memory_ingest`, `memory_compact`, `memory_reset`
(`undo: true` reverses), `memory_export`, `memory_import`, `memory_stats`.

## Hooks

`../hooks/*.js` (node, any OS) and `../hooks/*.sh` (bash and curl, macOS and Linux) pipe the hook's JSON to
`/v1/hook/<event>` and always exit 0 (at once, sending nothing, when `SPOOKLING_TAGGING` is set), so a stopped server never blocks Claude; they give a connect 1 second. Stop logs
the turns not yet logged (the server reads `transcript_path`, and adds `last_assistant_message` when the file has not
caught up), PreCompact does the same and then keeps the session's rules, decisions, values, dates, paths and names,
and UserPromptSubmit adds the recalled block as `additionalContext`, cut at 10,000 characters, Claude Code's cap. A
`C:\...` transcript path from a Windows Claude Code is read through `/mnt/c` when the server runs in WSL. What is
logged is the user's own words and every piece of the assistant's prose (a text after a tool call is its own entry), cleaned by
`hooks.clean()`: no `<x-y>` wrapper blocks (system reminders, task notifications, pastes, our own blocks), no fenced
code, no line that looks like JSON, a log, a stack trace, a shell or diff line or a terminal table, no line that is
mostly not letters, API keys and `*_TOKEN=`-style values masked, at most 16,000 characters a turn. A turn that cleans
to nothing (a task notification) keeps its place but is not logged; its tail part is then `<id>#<from>-<to>`. In
`.claude/settings.json` (exec form: no shell, so no path needs quoting; Claude Code v2.1.139 or later):

```json
{"hooks": {
  "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "node", "args": ["/path/to/hooks/user-prompt-submit.js"]}]}],
  "PreCompact": [{"hooks": [{"type": "command", "command": "node", "args": ["/path/to/hooks/pre-compact.js"]}]}],
  "Stop": [{"hooks": [{"type": "command", "command": "node", "args": ["/path/to/hooks/stop.js"]}]}]
}}
```

The hook contract was checked against the Claude Code docs on 21 Oct 2026: `../docs/claude-code-facts.md`. The
transcript line format `hooks.turns()` reads is internal to Claude Code and changes between versions; it was checked
against what 2.1.283 writes.

`../hooks/spookling-codex.cjs` uses these same endpoints, adding `harness: "codex"` so capture reads Codex rollout messages
instead of Claude Code's transcript format. It skips duplicate event records, developer context, reasoning,
commentary and tool output, then uses the existing `clean()` and tail deduplication. SessionStart checks `/v1/stats`;
only checked health/recall responses produce ready/active ghost messages. Stop and PreCompact stay silent. Install,
trust and uninstall details: [Codex](../cli/README.md#codex).


## Reset

`POST /v1/reset` appends one ruling `{step: "reset", at: T, upto: the log's last seq, note}` to the judgement log.
Nothing is deleted.

- **Facts.** Every fact row open at T is closed at T (true until T's day). The adapter's fold is wrapped
  (`reset.fold`) so the cut is applied at the ruling's place in the log. Every full tidy and every restart rebuilds the
  facts with the reset in place. With no active reset, the fold is the adapter's own.
- **Turns and events** recorded before the reset are flagged `before_reset`. A question whose date reaches before T (a
  date, a period, "since X" or an anchor that starts before T's day) is answered from the whole memory. Every other
  question is answered from a view rebuilt from the records after the reset only, so nothing earlier can reach it.
- **Rules and keepers** from before T are not pinned in `<rules>` or `<invariant>`. They stay in the data.
- **Undo.** `POST /v1/reset/undo` appends the reverse ruling. The fold skips that cut and every view is as before.
- **Guards.** A reset cannot predate a turn already logged. After a reset, a session dated before it is refused.

So the facts follow a ruling the fold replays, and retrieval follows a view chosen by the latest active ruling.

## Archive

A `.spookling` file is a tar.gz with three members:

| member | contents |
|---|---|
| `manifest.json` | `{"format": "spookling-memory", "version": 1, "created", "adapter", "counts": {"log", "judgements"}}` |
| `log.jsonl` | the log, one turn per line (`seq, hash, agent, session_id, turn_index, role, ts, text`) |
| `judgements.jsonl` | every adapter decision and every server ruling (`compact`, `reset`, `reset_undo`), one per line |

These are the same two files a memory folder holds, line for line. Import reads the members in memory only, checks the
format, version and line counts, and rebuilds every view with `settle()`. The same question gets the same context
before and after.

## Limits

- Claude Code takes at most 10,000 characters of `additionalContext` per prompt (about 2,500 tokens), so a longer
  recalled block loses its end there. ponytail: cut, not shaped; give the hook its own smaller recall budget if the
  cut starts dropping what matters.

- The after-reset view is rebuilt from zero after every change, as the adapter's full sleep is.
- How often each fact was used (the INDEX page's ordering) is not persisted. After a restart, the page's order can
  differ until the facts are used again.
- If PreCompact runs during a turn, the assistant's partial reply is logged. The rest of that reply is not logged
  later.
