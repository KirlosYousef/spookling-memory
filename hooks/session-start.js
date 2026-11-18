#!/usr/bin/env node
// Claude Code SessionStart hook, wired in cloud mode only: inject the project rules, then the project brief, once per session
// from the Spookling cloud (the rules from the offline copy when the cloud is slow or offline).
// Prints nothing when there is neither, or this session already has them. Never fails the session.
if (process.env.SPOOKLING_TAGGING) process.exit(0);
const cloud = require('./cloud.cjs');
const done = () => process.exit(0);
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', done);
process.stdin.on('end', async () => {
  let p = {};
  try { p = JSON.parse(Buffer.concat(chunks)) || {}; } catch { return done(); }
  const b = await cloud.brief(p);
  if (!b) return done();
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: b.context },
    systemMessage: `👻 ${cloud.startMessage(b)} from Spookling memory` }), done);
});
