# spookling

The install wizard for Spookling Memory. Node 18 or newer, no dependencies. Works on macOS, Linux (WSL included) and native Windows; what was run on which is listed under [Tested](#tested).

```bash
npx spookling init                 # the intro, then the step-by-step install, for this project
npx spookling init --scope user    # the same, wired for every project you open in Claude Code
npx spookling demo                 # the whole install as you would see it, answered for you; writes nothing
npx spookling status               # is the server up, what is wired (project and user files), which tagger, and a `cloud` line (see Team memory); exit 0 when all is well
npx spookling backfill [--since <date>] [--all]   # log turns missing from .memory/ back from the Claude Code transcripts (~/.claude/projects, or $CLAUDE_CONFIG_DIR/projects); this project's, or every project's with --all; no duplicates, so it is safe to repeat; the uploader sends them with the next session stop
npx spookling uninstall            # remove the hooks and the MCP entry (add --scope user for the user files), keep .memory/
npx spookling update [--check] [--version x [--force]]   # install the newest version and re-wire hooks and MCP entries (--check: exit 10 if one is available)
npx spookling restore [<timestamp>] [--yes]   # list the config backups init, update and uninstall made, or put one run's files back (--yes without a terminal)
npx spookling login                # sign in in the browser, pick a default org, offer to upload past sessions; init does not do this
npx spookling logout               # forget the saved token
npx spookling whoami               # name and email, the API URL, the default org
npx spookling orgs                 # the orgs you belong to, as id and name
npx spookling tokens               # your CLI tokens: id, label, created, last used, (this device)
npx spookling tokens revoke <id>   # revoke one (a unique prefix of 6+ characters works); this device's token also forgets the login
npx spookling tokens revoke --all  # revoke every token, this device included
npx spookling refresh [--org <id or name>]   # pull the org feeds into ~/.spookling/team-feed.json
npx spookling sessions [project] [--limit N | --all]   # your uploaded sessions, newest 20 by default: private or shared, and the auto-share rules
npx spookling share [<session id> | --last] [--org <id or name>] [--yes]     # share a session with an org; no id: the current session, else this project's newest; asks first unless --yes
npx spookling unshare <session id> [--org <id or name>]   # stop sharing it (all orgs without --org)
npx spookling autoshare <project> on|off [--org <id or name>] [--backfill]   # share every new session of a project
npx spookling delete <session id> [--yes]   # delete one uploaded session from the cloud; .memory/ is not touched
npx spookling delete --all [--yes]          # delete every session you uploaded (asks you to type DELETE; --yes without a terminal)
```

`orgs`, `refresh` and the sharing commands need a saved login (or `SPOOKLING_TOKEN`, see [Advanced](#advanced)); without one they say so and exit 1. `whoami` exits 1 when logged out. An unknown command prints `Unknown command: <name>` to stderr, then the help, and exits 1; a bare `spookling`, `help`, `-h` and `--help` print the help and exit 0. `orgs` lists the orgs where you are an active member; `--org` takes either column. See [Team memory](#team-memory).

`init` never logs in and does not need an account. It installs the hooks and a `spookling` command (`~/.local/bin/spookling`, or `%USERPROFILE%\AppData\Local\spookling-memory\bin\spookling.cmd` on Windows).

`spookling login` and the saved credentials:

- It uses the Spookling app at `https://api.spookling.com`. It saves the token in `~/.spookling/credentials.json` (mode `0600`) with the server that issued it, and sends it to that server only. The rules, and how to choose another server, are under [Advanced](#advanced).
- Credentials, the upload state and the login are written to a temp file with mode 0600 and renamed into place; a symlink at the target is refused.
- Every request sends `User-Agent: spookling/<version> (<platform>; node/<version>)` and refuses redirects.
- Text from the server is stripped of control characters before it is printed. The token is never printed.
- A login poll that is rate-limited waits and tries again; it does not log you out.
- Dock-launched Claude Code does not inherit a shell export.

Upgrading from an older version: see [Updating](#updating).

`init` copies the package's `server/` and `hooks/` to a folder per version, `~/.spookling-memory/<version>/` (`%LOCALAPPDATA%\spookling-memory\<version>\` on Windows), runs `uv sync` there and wires that folder, so nothing Claude Code runs lives in the npx cache, which npm may clear. A new version gets a new folder; `uninstall` leaves them.

## Install from a clone

One repo has everything: the wizard, the hooks and the server, the memory algorithm included (`server/spookling_memory/core/`; memory-bench is not needed). Run `init` from the project folder you want the memory in; `.memory/` is created there. `init` copies the clone's `server/` and `hooks/` as it does from the package, so after a `git pull`, run `init` again to wire the new code.

### macOS (zsh)

```bash
brew install node                                   # Node 18+, or the installer from nodejs.org
curl -LsSf https://astral.sh/uv/install.sh | sh     # uv, which runs the Python server
mkdir -p ~/src && cd ~/src
git clone https://github.com/Spookling/spookling-memory.git spookling-memory
cd ~/code/your-project
node ~/src/spookling-memory/bin/spookling-memory.js init                 # this project
node ~/src/spookling-memory/bin/spookling-memory.js init --scope user    # or every project
```

### Linux and WSL (bash)

The same commands as macOS, with Node from your package manager or nvm. In WSL, run everything in the WSL shell, with Claude Code installed in WSL, and keep the clone and the project on the Linux side (`~/...`), not under `/mnt/c`.

### Windows, native Claude Code (PowerShell)

```powershell
winget install OpenJS.NodeJS.LTS                                       # Node 18+, or the installer from nodejs.org
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
# open a new PowerShell window so node and uv are on PATH
mkdir $HOME\src; cd $HOME\src
git clone https://github.com/Spookling/spookling-memory.git spookling-memory
cd $HOME\code\your-project
node $HOME\src\spookling-memory\bin\spookling-memory.js init                # this project
node $HOME\src\spookling-memory\bin\spookling-memory.js init --scope user   # or every project
```

Git for Windows is not needed: the hooks run `node` directly, with no shell. The first `uv sync` downloads Python 3.12 if you do not have it (about two minutes here).

### One server in WSL, Claude Code on Windows too

With WSL's mirrored networking (`networkingMode=mirrored` in `%USERPROFILE%\.wslconfig`, the setup tested here), Windows and WSL share 127.0.0.1, so one server in WSL can serve both sides and both share one memory.

1. In WSL, from your project: `node ~/src/spookling-memory/bin/spookling-memory.js init` (or `--scope user`). This installs the server in WSL's `~/.spookling-memory/<version>/` and starts it.
2. In PowerShell, point at the same clone through the WSL share:
   `node \\wsl.localhost\Ubuntu-24.04\home\<you>\src\spookling-memory\bin\spookling-memory.js init --scope user`
   The wizard sees the clone is inside WSL. It copies nothing to Windows and skips `uv sync` (a Windows `.venv` would replace the one WSL runs), wires the hooks to the scripts on the share, and writes the MCP entry as `wsl.exe -d <distro> -- bash -lc "exec uv run --project '<path>' spookling-memory mcp"`, so the MCP tools run inside WSL too.

Windows sessions then log into the WSL project's `.memory/`; the server reads their `C:\...` transcripts through `/mnt/c`. Starting a hook from the share took 1 to 3 seconds per event here. NAT networking (`localhostForwarding`) was not tested.

## Flags

- `--org <id or name>` (refresh, share, unshare, autoshare) picks the org. Left out, `share` and `autoshare on` use the default org saved at login (if it is still one of yours), else your only org. `unshare`, `autoshare off` and `refresh` without `--org` cover every org, so a default never leaves a session shared elsewhere.
- `--limit N` and `--all` (sessions): 20 newest by default, then `Showing 20 of 43. spookling sessions --all for all.` Titles are cut at 80 characters. `--backfill` (autoshare) also shares sessions already uploaded.
- `--scope project` (default) or `--scope user`, for `init` and `uninstall`. See the table below.
- `--no-ghost` (init) skips the question about the ghost in the Claude Code status line, and leaves the status line alone.
- `--allow-share` and `--no-allow-share` (init) add or leave out the four share tools in `permissions.allow` without asking. Without either, init asks at a terminal. Use only one of them.
- `--yes` (share, delete) skips the confirmation. Without a terminal, share and delete refuse unless it is given.
- `--no-anim` skips the animation: the wordmark prints as a still and the ghost's lines print as plain text.
- `--fast` (demo only) drops the pauses. Without it the demo takes about a minute; any key cuts the current pause short.
- `--frames N` (demo only) prints N frames from across the intro, one after another, and stops. Useful for checking the drawing without a live terminal.

The intro animates at 40 x 16 or larger.

- **During `init`** the ghost then stays at the top of the screen: it drifts and bobs on a purple band and says one line per step in a speech bubble, while the steps scroll below it.
- **Size:** that stage needs 80 x 24 and takes the top 9 rows; from 30 rows it shows a larger ghost and takes 11.
- **Redraw:** 12 fps while a step runs; it holds still while a prompt waits, so typing is never disturbed.
- **Screen:** it uses the alternate screen. When it closes, the whole log of the steps is printed again in the normal screen, so it stays in your scrollback (also on Ctrl-C).
- **No animation** with `NO_COLOR`, output that is not a terminal, `--no-anim`, a smaller terminal, or a Windows console older than Windows 10 (no escape sequences): the ghost's lines print as `spookling: ...` among the steps.
- **Colour** is 24-bit when `COLORTERM` is `truecolor` or `24bit`, or in Windows Terminal (`WT_SESSION`), 256 colours otherwise. `FORCE_COLOR=1` keeps colour in piped output.
- **Keys:** any key skips the intro; Ctrl-C restores the terminal and exits.

At a terminal, the harness and the tagger are picked from menus (arrows, then Enter) and a key shows as bullets while you type or paste it; the key itself is never printed.

## The tagger

Step 3 asks how the tagger runs: the small model that reads each chat once, after it ends, and tags the facts in it. Retrieval never calls it.

| Choice | Server started with | Needs | Checked by |
| --- | --- | --- | --- |
| 1 Jev through an OpenRouter key (the default) | `--model typesafe/jev-router` | `OPENROUTER_API_KEY` | the first tag. About $0.002 a chat: the router is billed per call (199 chats cost $0.30 when we measured it) and Jev itself is $0.042 per million input tokens |
| 2 Anthropic API key | `--model anthropic/claude-haiku-4.5` | `ANTHROPIC_API_KEY` (starts `sk-ant-`) | the first tag. Haiku 4.5 at Anthropic's API price |
| 3 Your Codex subscription | `--model codex` | the `codex` CLI on the server's PATH, logged in with ChatGPT (Plus or higher) | `codex login status`, run by the wizard, its line shown |

`codex login status` only checks that a login is saved: it has said `Logged in using ChatGPT` while every call failed with an expired refresh token. The first tag is the real check; a failed one leaves its reason in `.memory/server.log` and the chat untagged until the next try. Fix it with `codex logout`, then `codex login`.

A subscription tagger is slower: several seconds per chat (it starts the CLI each time), against about a second over an API. The Stop hook does not wait for it, but the server tags one chat at a time, so a prompt sent while a chat is being tagged waits, and recall for that prompt is dropped if the wait passes 15 s. Each tagged chat uses a little of your plan's allowance, and your own subscription terms apply. How the server runs `codex exec`, and the docs behind each flag: [docs/subscription-taggers.md](https://github.com/Spookling/spookling-memory/blob/main/docs/subscription-taggers.md).

To switch the tagger, stop the server (`uninstall`, or kill the pid in `.memory/server.pid`) and run `init` again; `init` reports a running server that tags with something else. `status` shows which tagger the running server uses.

## demo

`demo` runs the same steps and prompts as `init`, with the answers typed on screen for you: the harness menu moves to Claude Code, the tagger menu moves down to Codex and back to Jev, the OpenRouter key is typed as bullets, each write is answered y. The checks run for real (they only read). Nothing is written, started or run, and nothing in the folder is read: each write shows exactly what `init` would write (the JSON merged into `settings.json` and `.mcp.json` included) and then `demo: not written`; the server install shows its progress line and `demo: skipped`; the smoke test shows the request and a sample reply. A quiet `demo, nothing is written` sits in the top right corner throughout. It is `init` with a dry-run flag, not a copy, so it cannot drift from the real wizard.

Without a terminal (an assistant's shell, a pipe), answers are read from stdin. When stdin ends, or stays open and says nothing for 20 seconds, every prompt takes its default. Every write is still printed before it happens, so the log shows exactly what a default wrote.

## What `init` writes

Every write is shown before it happens; answer `n` to skip it. Every command it runs is shown the same way.

| Where | What |
| --- | --- |
| `~/.spookling-memory/<version>/` (`%LOCALAPPDATA%\spookling-memory\<version>\` on Windows) | `server/` and `hooks/`, copied from the package (a clone's `.venv` and caches stay behind); `uv sync` then makes `server/.venv` there |
| `.memory/keys.env` | the tagger's key: `OPENROUTER_API_KEY` for Jev or `ANTHROPIC_API_KEY` for Haiku; nothing for Codex. Taken from your environment, or typed at a hidden prompt; never printed. Mode 600 on macOS and Linux; on Windows it has the folder's own access rules. |
| `.memory/.gitignore` | `keys.env`, `server.pid`, `server.log`, the server's caches `cache.sqlite*` (model replies) and `vectors.sqlite*` (embeddings), and the hooks' `pulse.json*`; missing lines are added to a file you already have |
| `.memory/server.pid`, `.memory/server.log` | the background server: `uv run --project <server> spookling-memory serve --folder .memory --port 7447 --model <tagger>` |
| `.claude/settings.json` (project) or `~/.claude/settings.json` (user) | three hooks merged in, `PreCompact`, `UserPromptSubmit` and `Stop`, each `{"type": "command", "command": "node", "args": ["<hooks>/<event>.js"]}`, the first two with a `statusMessage` for the spinner; if you said yes to the ghost, `statusLine` (see [The ghost](#the-ghost)) |
| `.mcp.json` (project) | `mcpServers.spookling-memory`: stdio, `uv run --project <server> spookling-memory mcp`, with `SPOOKLING_MEMORY_URL` in its `env` |
| user MCP list (user scope) | the same entry, added with `claude mcp add-json spookling-memory '<entry>' --scope user`. Claude Code keeps it in `~/.claude.json`, a file it writes itself, so the wizard only reads that file. |
| `.codex/hooks.json` (Codex, project) or `$CODEX_HOME/hooks.json` (Codex, user; default `~/.codex/hooks.json`) | SessionStart, UserPromptSubmit, PreCompact and Stop hooks merged in; existing hooks stay |
| `.codex/config.toml` (Codex, project) or `$CODEX_HOME/config.toml` (Codex, user; default `~/.codex/config.toml`) | `[mcp_servers.spookling-memory]` with `command`, `args` and an `[mcp_servers.spookling-memory.env]` table: the same `uv run --project <server> spookling-memory mcp` entry Claude gets, so Codex can call the memory and team tools. User scope runs `codex mcp add` (and `codex mcp remove` first for a stale entry); project scope edits only our own table. Codex reads a project `.codex/config.toml` only for a trusted project. |

It also runs `uv sync` in the server folder. `<server>` and `<hooks>` are the `server/` and `hooks/` folders in `~/.spookling-memory/<version>/`, never the package itself (from Windows through `\\wsl.localhost`, the clone's own, on the share). `CLAUDE_CONFIG_DIR` moves the user files, as it does for Claude Code. On Windows, `~` is `%USERPROFILE%`. Every other key in each file is kept. A file that is not valid JSON is left untouched and reported, never overwritten.

## What Claude Code does with it

Each fact below, with its source, is in [docs/claude-code-facts.md](https://github.com/Spookling/spookling-memory/blob/main/docs/claude-code-facts.md).

- The hooks use exec form (`command` plus `args`), which Claude Code spawns with no shell on every OS, so no path needs quoting. It needs Claude Code v2.1.139 or later.
- In an interactive session, hooks wait until you accept the folder's trust dialog, and Claude Code asks you once to approve the project's `.mcp.json` server.
- Recalled memory arrives as `additionalContext`, at most 10,000 characters. The server cuts there, because Claude Code would otherwise save a longer value to a file and show Claude only a 2,000-character preview.
- With the server down, the hooks print nothing and exit 0, within about a second, so a prompt is never blocked.
- To see them: `/hooks` in Claude Code lists them; `claude --debug` writes each run to `~/.claude/debug/<session-id>.txt`.

## The ghost

What shows where, and when (facts 49 to 66 in [docs/claude-code-facts.md](https://github.com/Spookling/spookling-memory/blob/main/docs/claude-code-facts.md)):

| Where | When | What |
| --- | --- | --- |
| spinner | while UserPromptSubmit or PreCompact runs | `👻 remembering`, `👻 keeping your rules` (the handler's `statusMessage`) |
| transcript, under your prompt | the prompt recalled facts, timeline events or past chats | `👻 3 facts and 1 rule from memory` (UserPromptSubmit's `systemMessage`). Standing rules ride on every prompt, so they alone add no line. PreCompact's `systemMessage` is dropped by Claude Code, so it prints nothing; Stop stays silent so it can never keep Claude going. |
| status line | Claude Code refreshes it: at session start, on each assistant message, after `/compact`, and every 5 s when the line is ours alone | the ghost and the last thing memory did: `3 facts · 1 rule recalled`, `listening` (nothing recalled), `saved`, `kept your 2 rules and 38 lines`, `asleep, server off`, or `remembering you` (nothing in this session yet, or nothing for 10 minutes) |

How it works:

- The three hooks write `.memory/pulse.json` after each call: `{at, session, event, up, ...counts}`. It goes in the project's `.memory/`, else `~/.memory/` (the folder `status` picks), and never creates either. `up` is false only when the server could not be reached.
- The counts come from the server, in an `x-spookling-pulse` response header, so the hook bodies Claude Code and Codex read are unchanged: for a prompt, `facts` (fact records), `rules`, `events` (timeline lines), `chats` (dated past-chat blocks), `chars` and `cap` (the recall's size and the 10,000-character hook cap); for PreCompact, `kept`, `rules` and `lines` in the survivor block. An older server sends no header; the hooks then print its reply untouched.
- `hooks/status-line.js` reads Claude Code's stdin JSON and `pulse.json`, prints the ghost and exits 0. No network, no server call: about 24 ms wall clock here, 19 of them node starting. A pulse from another session (`session_id`) is not shown.
- The ghost (`hooks/ghost.js`, shared with the Codex hook) is a 16 x 16 pixel ghost drawn with half blocks, 16 columns by 8 rows, built the way [pixel-profile](https://github.com/TheMysteriousGhost/pixel-profile) (MIT) builds its ghost: a dark outline, shading down one side, small eyes, blush, a scalloped hem. Its state comes from the pulse alone: `active` (green) when this prompt's recall completed, `ready` after a save, a compaction or once the news is old, `degraded` when the last hook could not reach the server, `waiting` (asleep) before any hook of this session. Beside it, only what the pulse says: what was recalled, how much of the 10,000-character room it took, when the last hook ran, and which `.memory` it was.
- Colour: 24-bit codes where the terminal says it has them (`COLORTERM=truecolor` or `24bit`, or Windows Terminal), the xterm 256 palette otherwise; each state's colours stay apart there. `NO_COLOR` drops every escape and prints one 👻 line.
- Some fonts have no half blocks (Monaco, the font of Terminal.app's Pro profile); the terminal borrows them from another font, which puts rows out of line and floats the top row off the head. On Terminal.app the ghost reads the profile's font from Terminal's settings (cached until they change) and then draws a 10 x 9 ghost drawn by hand for one pixel a cell, background-coloured spaces only: 20 columns by 9 rows, in line on any font. `SPOOKLING_GHOST=half` or `cells` chooses by hand.
- Settings: with no status line, init writes `{"type": "command", "command": "node '<hooks>/status-line.js'", "refreshInterval": 5}`. With one, it only changes `command` to `node '<hooks>/status-line.js' --then '<yours>'`: your command runs first through the same shell Claude Code uses (`sh`; on Windows Git Bash, else PowerShell), and the ghost takes its own rows below (one line after two spaces under `NO_COLOR`); your `padding` and `refreshInterval` stay yours. Uninstall restores `command` from `--then`, or removes `statusLine` when there was none. On Windows the path goes in double quotes with forward slashes; a path or command holding `"`, `$`, a backtick or `!` (which Git Bash and PowerShell read differently) is refused, with a pointer to `--no-ghost`.
- With any status line set, Claude Code hides most footer hints (`esc to interrupt`, `? for shortcuts`). The status line needs the folder's trust and is skipped under `disableAllHooks`, `allowManagedHooksOnly` and `--safe-mode`.

## login

`spookling login` prints, then waits:

```
Opening your browser to sign in to Spookling…
  <verification URL, with the code in it>
Confirm this code matches: 6HYE-3R4C
Waiting for approval… (Ctrl-C to cancel)
```

The browser is opened only for an https link (http on this machine) on the API's host, a `spookling.com` host, or this machine when the API is on this machine; Windows uses `rundll32 url.dll,FileProtocolHandler`, never `cmd`. A well-formed link on any other host is not opened on its own: at a terminal it asks `Open it in your browser? [y/N]` (No is the default, and only an explicit y opens it); with no terminal it is printed under a warning and left unopened. A link that fails validation (a bad scheme, a login in the URL, not a URL) is never opened and never offered. When `device/start` answers 403 without the app's error envelope (API Gateway's bare `Forbidden` for a wrong address or stage), login says `that address doesn't look like a Spookling API` and to check the URL, including any stage path such as `/v1`. With no browser or no display it adds `Open the link above in a browser.` Colour is used only on a terminal; with `NO_COLOR` or a pipe the output is plain. Polling retries network errors and 5xx with a growing wait (capped at 30 s) until the code expires; only a 404 (invalid code), a denial or expiry end it, and an expiry after a dead network says so. A 429 waits for `Retry-After`. An unreachable API prints `Couldn't reach <api>. Check your connection, or SPOOKLING_API_URL if you set it.`, here and in `logout`, `orgs`, `refresh` and the sharing commands.

After approval, three more steps, none of which can fail the login:

1. **Default org.** `GET /cli/orgs`. One org becomes `defaultOrgId` (and `defaultOrgName`) in `~/.spookling/credentials.json`, mode `0600`, and it prints `Default org: <name>`. Several: on a terminal you pick one from a menu; with no terminal the first is taken after 20 s. None: it says so. A re-login replaces the default. `logout` clears it.
2. **Past sessions.** It looks in `<current folder>/.memory/log.jsonl` and `~/.memory/log.jsonl`, the two logs Stop reads (there is no list of other projects), and counts the sessions there that `~/.spookling/upload-state.json` shows as not fully uploaded.
3. **Ask.** `Upload your N past sessions privately? Only you can see them until you share. [Y/n]`. Yes is the default, also after 20 s with no terminal. It then prints `Uploaded N sessions privately.` and the logs it looked in. Projects elsewhere upload when their next session stops. If the upload fails, the turns stay queued for the next Stop.

## Advanced

- **A different server:** `spookling login --api-url <url>` (or `SPOOKLING_API_URL` for that login) picks the origin; it is saved as `apiUrl` with the token.
- **CI and headless use:** `SPOOKLING_TOKEN` is used instead of the saved login, and only with an explicit `SPOOKLING_API_URL` that passes the https rule; `whoami` then shows no API line.
- **Origin pinning:** a saved login only talks to the server it was issued by (an older credentials file without `apiUrl` is pinned to the shipped app). A different `SPOOKLING_API_URL` is ignored for authenticated calls: interactive commands print one line saying so, hooks say nothing. Origins must be `https`, except `localhost`, `127.0.0.1` and `[::1]`.

## Team memory

Optional, and never part of `init`. The full picture is in the [main README](https://github.com/Spookling/spookling-memory#team-memory); the parts the CLI owns:

- **Upload.** With a saved login, the Stop hook waits for the session's log to go quiet, then uploads its turns, private to you.
  - Masking: turns are masked first (`cli/src/mask.js`: JWTs, PEM private-key blocks, `scheme://user:pass@`, Slack `xox?-` tokens, Stripe `sk_live_`/`rk_live_`/test keys, plus the API-key and `NAME_TOKEN=value` patterns the server applies) and cut to 16,000 characters (a cut ends with "…"). `log.jsonl` is never rewritten.
  - Network down: the turns are queued in `~/.spookling/upload-state.json`. That file is kept per account and server (the saved user id plus the API origin): after you switch servers or log in as someone else, the cursors, queue, skips and share jobs of the other account are parked, not applied, and an unscoped file from an older version is kept under `legacy` while the current account starts fresh. If the server answers `400 seq_gap` (the saved position is ahead of what it holds), the client asks it how many turns it has, resets the cursor to that and resends once. `upload.log` records the reason, for example `upload queued: BAD_REQUEST seq_gap`, never the token or any turn text.
  - 429: waits once and retries.
  - 5xx and other failures (network down included): queued, and retried at the next Stop or login. `upload.log` names the status and code, for example `500 INTERNAL_ERROR`. `refresh` does not retry uploads.
  - 409 `seq_conflict`: retried on the next Stop, then skipped; `status` names the session.
  - Final refusals, which never block the other sessions: 403 `org_owned` (shared with an org you left), 400 `turn_limit` and 400 `session_limit` (that one also stops creating new sessions in the same push while existing sessions keep growing). They are recorded in `upload-state.json` and `status` lists them.
  - 401: stops the push, keeps your login, and makes `status` print `login expired, run spookling login` until the next login or successful upload.
  - Limits: `project` is cut to 100 characters and `title` to 120, the API's limits.
- **Share.** `share`, `unshare` and `autoshare` change who can see your own sessions; the org owns what is shared to it. Unsharing cannot un-tell someone who already read it. The MCP tools `memory_share`, `memory_autoshare` and `memory_share_status` call the same code.
  - No id: `share` takes the session in `SPOOKLING_SESSION_ID` or `CLAUDE_SESSION_ID`, else the newest session in the local log for this project, else your newest upload. It prints the web link after a successful share.
  - A session not on the server yet is uploaded now from its local log. If that fails, the share is queued in `upload-state.json` and applied after the session's next save. `unshare` cancels it; `memory_share_status` reports `share pending`.
  - `init` writes the `/spookling-share` command to `.claude/commands/` (or the user config folder with `--scope user`). It runs `spookling share <session> --yes`, so typing it is the confirmation.
  - Allow rule: `init` and `login` offer to add `mcp__spookling-memory__memory_share`, `memory_share_status`, `team_sessions` and `team_session` to `permissions.allow`. A "no" from `login` or `update` is kept in `~/.spookling/share-allow.json`. `uninstall` removes the rules Spookling added (a rule you had before stays).
- **Forks.** The server (`hooks.py`, `fork_of`) spots a forked Claude Code transcript: its leading lines carry another `sessionId` (the parent's) than the file's own.
  - Record: `{parent, relation, branched_at, copied}` in `forks.json` beside `log.jsonl` (which keeps the whole conversation, as before).
  - Upload: the uploader reads that file. A new fork sends only the turns after the first `copied`, numbered from 0, and its PUT carries `parentSessionId`, `branchedAtTurn` and `relation`; the title comes from its first new user message.
  - `branchedAtTurn` is the number of the parent's own turns in the copy, minus 1, which is the seq the parent uploads with (a fork of a fork counts only the direct parent's turns; a parent that is itself an already-uploaded duplicate is not corrected for).
  - `relation` is `continued` when a `summary` line with a `leafUuid` (or an `isCompactSummary` line) sits at the top and there is no "forked this session" note, else `side_chat`. The continued marker follows Claude Code's format and was not seen in a real file here.
  - Earlier sessions: one uploaded before forks were known keeps its numbering (`forkModes` in `upload-state.json`) and is linked with one PUT.
  - Codex rollouts: no fork marker was found in the local files, so Codex forks upload like any session.
- **Read.** `team_sessions` and `team_session` (MCP) refresh every org feed when called, then read `~/.spookling/team-feed.json`; if the refresh fails they answer from the cache with a stale note. There is no background pull and no hook injects colleague text. `refresh` does the same pull by hand and keeps the old cache when the API is down. If the feed reports `sharedIdsTruncated` (more than 500 shared sessions in an org), the purge of unshared sessions is skipped for that org. Session reads use pages of 100 and follow `nextAfter`.
- **`status` cloud line.** `logged in as <email>; last sync <time or never>; N turns in M sessions not uploaded yet`, or `not logged in`. Local files only (credentials, team feed cache, upload queue), so it cannot hang offline. Last sync is the newest org feed time in the cache; pending is the turns queued in `upload-state.json`, not turns Stop has yet to read. It does not change the exit code.

## Undo

`npx spookling uninstall` (with `--scope user` for the user files) removes only the Spookling hooks, the ghost's status line (yours comes back) and the `spookling-memory` MCP entry; everything else in those files stays exactly as it was. It also offers to stop the server named in `.memory/server.pid`: a SIGTERM to its process group on macOS and Linux, `taskkill /T /F` on Windows. Your memory in `.memory/` stays, keys included. To remove that too, delete the folder yourself. The server and hooks stay in `~/.spookling-memory/<version>/` (it says so); delete that folder, after uninstall in every project and scope that used it, to remove them.

On Windows the stop is forced, so the server cannot remove its temporary copy of the log: delete `%TEMP%\spookling-log-*` if you want it gone. On macOS and Linux the server removes it on the way out.

## Codex

Run `node <clone>/bin/spookling-memory.js init` and select **Codex** (add `--scope user` for user hooks). The wizard uses the same server, `.memory/` folder and tagger choices as Claude Code. It merges native hooks into `.codex/hooks.json` for this project, or `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`) for user scope. No Codex executable or source files are patched. The hooks need no MCP entry, but the team tools do, so `init` also registers the `spookling-memory` MCP server for Codex: `codex mcp add` for user scope, a merge of our own `[mcp_servers.spookling-memory]` table into `.codex/config.toml` for project scope (Codex loads project config only when the project is trusted). Re-running `init` replaces an entry that points at an older version folder; every other line of `config.toml` stays. `status` shows it on a `codex-mcp` line.

In Codex, open `/hooks` and review/trust the new commands; project hooks also require a trusted project. Installation does not grant trust. Changed hook definitions require another review. `status` reports configuration and server availability; it does not claim to verify Codex's trust or that hooks ran.

- **SessionStart:** check `/v1/stats`; show the `ready` ghost only when the memory server answers successfully, with its `n_events`, `n_facts`, `n_rules` and folder beside it. Codex renders a hook message's colours and keeps its lines, so the ghost (`hooks/ghost.js`, the status line's) is drawn under a first line of words.
- **UserPromptSubmit:** recall through the existing `/v1/hook/user-prompt-submit` endpoint, pass its bounded `additionalContext` to Codex, then show the green `active` ghost with the counts from the server's `x-spookling-pulse` header beside it. A successful search with no matches still counts as completed recall: one `active` line, no ghost, so the history is not a ghost per prompt.
- **Stop / PreCompact:** reuse the existing background capture and compaction endpoints, reading Codex's rollout transcript on the server. No Stop continuation decisions or extra model turns.
- **Unavailable:** show the `degraded` ghost (`memory unavailable`) on a failed health check or recall; continue Codex normally. `SPOOKLING_TAGGING=1` skips the hooks to avoid recursion when Codex itself is the tagger.

The ghost appears in hook activity and informational messages (Codex surfaces `systemMessage` as a warning), not as a permanent screen widget. It confirms the stated operation, not that the model used every recalled fact or that future tagging will succeed. The integration uses [Codex's documented hook contract](https://learn.chatgpt.com/docs/hooks). Transcript parsing follows the internal `response_item` format observed with codex-cli 0.164.0; that format can change. Native Windows hook execution has not been verified.

Remove only Codex's hooks and MCP entry with `node <clone>/bin/spookling-memory.js uninstall --harness codex` (add `--scope user` for user scope). Memory, other hooks and other MCP servers remain. The existing optional server-stop prompt still applies.

## Updating

**The upgrade path.** On 0.1.x, run `npx spookling init` once. From 0.2 on, run `spookling update`. Each version installs into its own folder, so until one of those runs, your wiring keeps using the old folder (see [After an upgrade](#after-an-upgrade)).

`spookling update [--check] [--version x [--force]]` finds the newest published version (a `fetch` of `https://registry.npmjs.org/spookling/latest` with a 5 s limit, then `npm view spookling version --json`), compares semver, and for a newer one runs `npx --yes spookling@<version> init --update` in your current folder.

Exit codes:

- `0`: done, or already up to date.
- `1`: offline, no `npx`, or the init failed. It prints `Couldn't check for updates (<reason>). Try again later, or run npx spookling@latest init.` or the manual `npx` line.
- `2`: a bad `--version`.
- `10`: with `--check`, an update is available.

More:

- `--version` must be semver (for example `0.2.1`). A version older than the running one is refused without `--force`, because an old version may not know `--update` and then asks its questions.
- Already on the latest version but the hooks point at an older folder: `update` re-wires to this one.

`init --update` is the non-interactive re-init. It runs the same step functions as `init` with every answer supplied: no cutscene, no prompts, no colour with `NO_COLOR`, fine without a TTY. Where the answers come from:

- **What is wired:** the same files `status` reads: `.claude/settings.json` and `~/.claude/settings.json` (hooks, the ghost's `statusLine`), `.mcp.json`, `~/.claude.json`, the Claude desktop config, Codex `hooks.json` and `config.toml`. User scope is always considered; project scope only for the current folder and only if it is wired. Project installs elsewhere (from `install.json`) are named, not touched.
- **The choices:** `~/.spookling/install.json` first (harness, scope, project, ghost, tagger, whether the server runs), written atomically with mode `0600` after every successful `init` or `init --update`. Without an entry: the ghost from the status line on disk, the tagger from the running server (`/v1/stats`), else `.memory/keys.env` (`ANTHROPIC_API_KEY` means Haiku), else Jev; the server is started if one is answering or a pid file exists. A key that is in neither your environment nor `keys.env` is not asked for; the step reports it.
- **The running server:** a pid file whose process is a Spookling server from another version folder (the command line must contain `spookling-memory/<version>/server … serve`) is stopped like `uninstall` does, then started again from the new folder, in the folder it ran from. Any other process is left alone.
- **Old folders** are never deleted. It ends with the same lines as `status`, without the update notice.

The update notice (`! update   0.2.1 is available. Run spookling update.`, where the version is whatever is newest):

- It appears in `status`, and in `whoami` at most once a day.
- The registry is asked at most once per 24 h with a 2 s limit, and the answer is cached in `~/.spookling/update-check.json`.
- Nothing runs from hooks, the MCP server or `init`. It is skipped when `CI` is set.

## Backups and restore

`init`, `init --update`, `update` and `uninstall` save each config file they are about to change, before the change: `~/.spookling/backups/<timestamp>/<path, URL-encoded>` (mode `0600`, folder `0700`) plus a `manifest.json` with the original paths and modes. Covered: `~/.claude/settings.json`, `~/.claude.json` (a copy before `claude mcp add-json` / `remove` edits it), the Claude desktop config, `~/.codex/hooks.json`, `~/.codex/config.toml` (also before `codex mcp`), and the project's `.claude/settings.json`, `.mcp.json` and `.codex/*`. `.memory/` is not copied (it holds your keys). One line at the end names the folder. The newest 20 runs stay; a run beyond that is removed only when it is at least 7 days old, so at least 5 always remain. A run that changed nothing leaves no folder.

Before it writes, each file is read again and must still parse: invalid JSON, or TOML that fails a syntax screen (`cli/src/toml-check.js`; there is no TOML library), is refused, named with the reason, and left byte for byte as it was. Merges touch only Spookling's keys: `enabledPlugins`, `extraKnownMarketplaces`, `theme`, `model`, `permissions` and the rest survive (tested).

`spookling restore` has two forms:

- `spookling restore` lists the runs and their files.
- `spookling restore <timestamp>` shows each file as `differs from the current file`, `same as now` or `missing now`, and asks `[y/N]` (no is the default; without a terminal it needs `--yes`). It then backs up the current versions as a new run and puts the files back with their original modes. It will not write through a symlink.

## When the model key stops working

Turns are written to `.memory/log.jsonl` before any model is asked, so a key that is over its limit, invalid or out of credit (OpenRouter's 403 `Key limit exceeded`, a 401, a 402, Anthropic's credit error) never loses a turn, and the uploader keeps working. The server stops calling the model, `status` shows a `model` line with the reason and the time, hooks answer without recall instead of failing, and the MCP save tool says the turns are saved. Turns not yet judged are listed in `.memory/pending.json` and judged on the next call that works, or when the server starts again. Top up the key or change it in `.memory/keys.env`, then restart with `spookling init --update`. `spookling backfill` puts back turns that earlier versions dropped while the key was failing.

## After an upgrade

Each version installs into its own folder, and `init` never touches the old one. Until you re-point them (`npx spookling init` on 0.1.x, `spookling update` from 0.2; see [Updating](#updating)):

- Your hooks, MCP entries (Claude, the desktop app, Codex) and the `spookling` command keep pointing at the old folder, which still works: the memory hooks, and any upload code that version had, keep running as they were.
- A new version's changes (new MCP tools, title and project fixes) arrive only when those are re-pointed.
- `status` shows one line, for example `! upgrade  hooks still use 0.1.3. Run spookling update to finish upgrading to 0.2.1.`, in place of "scripts missing". `scripts missing` stays for the real case: wired to this version, but the files are gone.
- `status` exits 1 while an upgrade is pending.

## Tested

Run by hand on one PC: WSL2 Ubuntu 24.04 (Node 24.19, uv 0.12.5) and native Windows 11 (Node 24.7, uv 0.9.29, Python 3.12.12 fetched by uv).

- WSL: `npm test` and the server suite; `init`, `status` and `uninstall` in both scopes, in a sandbox home.
- Windows: `node --test test/hooks.test.js` and the server suite (the `.sh` hooks and a WSL-only path test are skipped there); `init`, `status` and `uninstall` (project scope) in a temp project, with the hooks and MCP entry it wrote driven the way Claude Code drives them, and the server tree gone after uninstall; `init` against the WSL clone through `\\wsl.localhost`.
- Not run: macOS (no Mac to hand), Claude Code itself firing these hooks (that needs a model call), Windows without mirrored networking.

After the move to one package, on WSL only: `npm test` and the server suite from a fresh clone; `npm pack`, the tarball unpacked, its `server/` and `hooks/` copied out by the wizard's `install()`, `uv sync` there and `serve` answering. CI (`.github/workflows/ci.yml`) runs the same on Linux, macOS and Windows with Node 18, 20 and 24.

## Develop

From the repo root (`package.json` is there, so `npm pack` ships `bin/`, `cli/src/`, `hooks/` and `server/`):

```bash
npm test                                   # every cli/test/*.test.js under node:test, no network, inside a real-home guard
node bin/spookling-memory.js demo --fast   # the whole install, dry
node bin/spookling-memory.js demo --frames 3
npm pack --dry-run                         # what the package ships
```

`npm test` runs `cli/test/run-suite.mjs`: it records the size and mtime of your real `~/.claude/settings.json`, `~/.codex/hooks.json` and `~/.codex/config.toml`, the number of test-looking paths (`/var/folders`, `spk-…`) in `~/.claude.json` (which Claude Code rewrites on its own, so only that count is compared) and the runs in `~/.spookling/backups`, and fails the run if a test changed any of them. Tests that write wiring must point `HOME` at a temp folder.

`hooks/package.json` says `"type": "commonjs"`: the root one says `module`, and the hooks use `require`.

The ghost is generated from `brand/logos/ghost-mark.png`, not drawn by hand. None of these tools ship in the package:

- `python3 cli/tools/make-ghost.py` (Pillow) writes `src/ghost-sprite.js`: 38 x 40 pixels, 20 text rows, downsampled from the logo with hand-placed eyes and smile; and two small ghosts drawn by hand in the script, 13 x 14 and 19 x 20, since a downsample that small turns the face into a smudge; 4 tail frames each, only the lilac streaks move. It renders them back to PNG in `renders/` beside the logo, to check by eye.
- `python3 cli/tools/render-frames.py` (POSIX) replays the CLI's own output through a small terminal interpreter and saves `renders/cutscene-frame.png`, `renders/cutscene-end.png` and `renders/wizard-frame.png` (80 x 24, 800 x 480 px), and `renders/wizard-frame-30.png` (80 x 30, 800 x 600 px). `raw FILE OUT 120x30` renders any byte stream at another size, with emoji in Noto Color Emoji.
- `node cli/tools/ghost-screen.mjs pixel 80 24` prints a Claude Code screen with the real status line and transcript wording, for `raw`; `renders/ghost-status-line.png` came from it.

## Contributing / local development

- Point a login at a local backend: `spookling login --api-url http://127.0.0.1:4000` (or `SPOOKLING_API_URL=http://127.0.0.1:4000` for that login). Plain `http` is accepted for localhost only.
- `SPOOKLING_INIT_PORT` points the wizard's server probes at another port; the tests use it so they never talk to a real server on 7447.
- `SPOOKLING_NO_UPDATE_CHECK=1` turns off the update check (`CI` and `node --test` do too).
