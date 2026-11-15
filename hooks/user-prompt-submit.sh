#!/usr/bin/env bash
# Claude Code UserPromptSubmit hook (macOS and Linux; the .js is for any OS): print the server's reply, exit 0.
[ -n "${SPOOKLING_TAGGING:-}" ] && exit 0  # a tagging call the server started
# cloud mode (install.json says so): the node hook asks the cloud first, then the local server
if grep -qs '"mode": *"cloud"' "$HOME/.spookling/install.json" && command -v node >/dev/null 2>&1; then
  exec node "$(cd "$(dirname "$0")" && pwd)/user-prompt-submit.js"
fi
curl -sf --noproxy '*' --connect-timeout 1 --max-time 15 -H 'content-type: application/json' --data-binary @- \
  "${SPOOKLING_MEMORY_URL:-http://127.0.0.1:7447}/v1/hook/user-prompt-submit" || true
exit 0
