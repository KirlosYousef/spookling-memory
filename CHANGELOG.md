# Changelog

## 0.2.2 (unreleased)

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
