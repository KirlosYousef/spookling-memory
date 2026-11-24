# Changelog

## 0.2.7 (24 Nov 2026)

- Sharing a session works again when the local memory server was not running. `spookling share <id>` used to read only the local log, which the Stop hook fills through that server, so a real session missing from the log was reported as "No session … found here or in the cloud". It now falls back to the agent's own transcript (Claude Code under `~/.claude/projects`, Codex rollouts under `~/.codex/sessions`), uploads from it, then shares. An id found in no log, no transcript and not on the server is still reported as a typo. The installed hooks folder carries the new `transcript.js` too.

## 0.2.6 (23 Nov 2026)

- Project rules. Team rules every AI session on a project follows ("Use MVVM for all UI code"), kept in the Spookling cloud per org and project and set only by a person. Typing `/spookling-rules <rule>` in Claude Code saves it at once (typing it is the confirmation); `/spookling-rules replace <id> <text>` changes one and `/spookling-rules remove <id>` removes one; `/spookling-rules` alone lists them. The AI can only check a change and show you the exact line to type: the MCP server has no write path any more. `spookling rules set "<rule>" [--replace <id>]` and `spookling rules remove <id>` at a terminal show the change and ask y/N; `spookling rules history <id>` shows every version. Every change is recorded with its source (`slash` or `cli`) and notified to the team. There is no `--yes`, and without a terminal set and remove refuse and send nothing. A rule changed by someone else meanwhile is never overwritten: you see its current text. `project_rules` joins the allow rule. Known limits of `/spookling-rules`: a backslash followed by a space, or two in a row, fails Claude Code's permission check, so nothing is saved; in auto mode the model may be handed the shell step (it is told not to run it; nothing enforces that); a line equal to `SPOOKLING_RULE_END` in the text ends the input early.
- Rules come from the cloud engine, only in cloud mode. Session start adds the project rules in their own `<project-rules>` block before the brief (rules alone when there is no brief); the brief is cut first when the two pass 10,000 characters. Any later prompt gets the block again only after a rule changed, because the session start marks the rules it showed (`ruleIds`) and every retrieved item id is remembered per session. There is no local copy: offline, or without cloud mode, no rules are added and the session is never blocked. The Codex SessionStart hook now sets `additionalContextLimit: 4000`.
- The installed hooks folder now carries `delete.js` too, so its copy of the team bridge loads.

## 0.2.5 (22 Nov 2026)

- Confirmation dialogs work again in Claude Code: sharing, auto-share and delete now ask with Accept and Decline buttons in the chat instead of always sending you to the terminal. Current Claude Code versions (terminal and desktop) use a newer MCP protocol on which the old way of asking failed, and the failure was shown as "this chat cannot show a confirmation dialog". The tools now ask the way each protocol expects, so the dialog appears on both the new and the older protocols. Nothing changes in what is safe: nothing is shared, turned on or deleted unless you accept and tick confirm; Decline, Cancel or an unticked box leaves everything as it was; and with several orgs the chat asks which one first, never guessing. A client that really has no dialogs still gets the exact terminal command. If asking fails for another reason, the Spookling server log now records the reason (never your data) and you still get the terminal command.

## 0.2.4 (22 Nov 2026)

- `spookling update` now rewires every Spookling install on the machine, including project folders and a cloud SessionStart hook, so no session keeps running an old version. Before, it only rewired your user files and the folder you ran it from. A project folder you had set up earlier (its `.mcp.json`, `.claude/settings.json`, `.codex/hooks.json` and `.codex/config.toml`) kept pointing at the old version, and a stale `.mcp.json` in your home folder overrode the new MCP entry for every session under it, so the new tools were missing. Now one `spookling update` (or `init --update`) rewires every install listed in `~/.spookling/install.json`, wherever you run it from. A project folder that no longer exists, or whose Spookling files are gone, is skipped with one line and not recreated. Only Spookling's own entries change; your other hooks, servers and settings stay as they are, and nothing is added that was not there. A problem with one install no longer stops the others from being updated.
- A cloud SessionStart hook added by an earlier cloud-mode install is rewired on update even when the install record has no mode, instead of staying on an old version folder.
- `spookling status` and the update notice now check every recorded install, so stale project wiring is reported and `spookling update` heals it.

## 0.2.3 (19 Nov 2026)

- Cloud mode. `init` now first asks "How should Spookling build memory?": log in and use your Spookling plan (no key, no local tagger, no server to start), or enter API keys as before. In cloud mode the prompt hooks (Claude Code and Codex) ask Spookling for memory first, within about 1.8 s, and fall back to the local server (or say nothing) when offline, logged out, slow or unavailable. Uninformative prompts ("ok", "continue") are skipped on your machine, a repeated prompt is answered from a 60 s cache, and each session is not shown the same item twice. A SessionStart hook injects the project brief once per session. The `memory_retrieve` tool goes cloud first through node, so the token never enters the Python server. `spookling status` shows `mode: cloud, logged in as ..., org ...`. `init --cloud` and `init --keys` skip the question; the mode is stored in `~/.spookling/install.json`. Question text is never logged.
- `spookling update` also finds an old memory server by the port it listens on (macOS and Linux), so one with no pid file, or a stale one, no longer keeps answering after an update. It is restarted in the folder it ran from; if that folder cannot be read, the update says which pid to stop.
- A turn now keeps up to 30,000 characters (it was 16,000) before it is cut, and the backend accepts up to 32,000. Uploads are sent in batches of at most 200 turns or about 500,000 characters, so long turns stay under the API's request size.
- `spookling orgs default [org]` shows the default org as the API reports it, or changes it by name or id. An ambiguous name lists the matching ids instead of guessing. `orgs` and `whoami` mark the live default and fall back to the saved one offline.
- Each uploaded session carries the project's git remote (`repoUrl`), with credentials and query stripped and masked, so the cloud can tie clones of one repo to one project. It is omitted when there is no remote and cached per project for a day.
- `spookling status` lists each wiring location once when the project is your home folder, reports a folder wired in cloud mode, and the update notice follows one rule from one version source.

## 0.2.2 (10 Nov 2026)

### Sharing

- Share a session before it has uploaded. If it is not on the server yet, it is uploaded on demand; if that is refused (offline, rate limit, server error) the share waits as a pending share and is applied after the session's next save. Pending shares expire after 7 days, and a share the server refuses is reported once by `spookling status`.
- `spookling share` with no id shares the current session (else this project's newest). `--last`, `--yes` and `--org <id or name>` are supported. It shows the session, project and org, and asks first; without a terminal it needs `--yes`. A mistyped id is rejected instead of queued.
- With several orgs and no `--org`, `share` and `autoshare on` show a numbered picker at a terminal and require `--org` otherwise. They never use a stale saved default, and they say which org was used (and when it is your only org).
- `spookling unshare` cancels a share that is still pending.
- Claude can share for you: `init` and `update` offer to add the five share tools (`memory_share`, `memory_share_status`, `team_sessions`, `team_session`, `team_orgs`) to `permissions.allow`. Each share is still confirmed by Spookling, `memory_delete` and `memory_autoshare` are never allowed, and uninstall removes only the rules Spookling added. An earlier yes covers tools added later without a new question. `--allow-share` and `--no-allow-share` skip the prompt.
- New `/spookling-share` command for Claude Code.
- No-dialog hand-off: in a client that cannot show a confirmation dialog, `memory_share` and `memory_autoshare` change nothing and return the exact `spookling share ...` command (and the slash command) for you to run.
- Share links open the session in the web app using its owner and session id.

### Orgs

- Org lists are read live: `whoami`, `orgs`, `status` and the `team_orgs` tool ask the API each time, and a saved default org that is no longer one of yours (or was saved for another API or account) is cleared with a note.
- A cached team feed saved for another API or account is ignored and deleted at login or logout.

### Upload and login

- `spookling refresh` retries queued uploads and shares after pulling the feeds.
- Past-session upload at login prints readable status lines, paces itself between sessions, backs off when the server asks it to slow down, and ends with a summary that adds up. Sessions it skips are one line ("3 sessions skipped: the server already has a different copy of them"); per-session detail is in `~/.spookling/upload.log`. Rate-limit waits stay as live status.

### Status and help

- `spookling status` shows pending shares, uploads waiting, sessions skipped for good and refused shares.
- `spookling help` lists every command, including `update`, `share`, `unshare`, `autoshare`, `refresh`, `orgs` and `help`, and a test keeps it in step with the command table.
