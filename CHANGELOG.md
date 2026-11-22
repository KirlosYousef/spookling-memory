# Changelog

## Unreleased

- Project rules. Team rules every AI session on a project follows ("Use MVVM for all UI code"), kept in the Spookling cloud per org and project and set only by a person. `spookling rules` lists them; `spookling rules set "<rule>" [--replace <id>]` and `spookling rules remove <id>` show the change (old and new text side by side) and ask y/N; `spookling rules history <id>` shows every version. There is no `--yes`, and without a terminal set and remove refuse and send nothing. In chat, `project_rules` lists them and `project_rule_set` / `project_rule_remove` change them only after you accept a dialog naming the project, the org and the rule; a client without dialogs gets the exact `spookling rules ...` command to run. A rule changed by someone else meanwhile is never overwritten: you see its current text and are asked again. `project_rules` joins the allow rule (an earlier yes gets it without a question); the two write tools never do. New `/spookling-rules` command for Claude Code.
- Rules come from the cloud engine, only in cloud mode. Session start adds the project rules in their own `<project-rules>` block before the brief (rules alone when there is no brief); the brief is cut first when the two pass 10,000 characters. Any later prompt gets the block again only after a rule changed, because the session start marks the rules it showed (`ruleIds`) and every retrieved item id is remembered per session. There is no local copy: offline, or without cloud mode, no rules are added and the session is never blocked. The Codex SessionStart hook now sets `additionalContextLimit: 4000`.
- The installed hooks folder now carries `delete.js` too, so its copy of the team bridge loads.

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
