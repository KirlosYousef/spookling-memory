#!/usr/bin/env node
// Claude Code SessionStart hook, wired in cloud mode only: inject the project brief once per session from the Spookling cloud.
// Prints nothing when there is no brief, the cloud is slow or offline, or this session already has one. Never fails the session.
if (process.env.SPOOKLING_TAGGING) process.exit(0);
const cloud = require('./cloud.cjs');
const done = () => process.exit(0);
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', done);
process.stdin.on('end', async () => {
  let p = {};
  try { p = JSON.parse(Buffer.concat(chunks)) || {}; } catch { return done(); }
  const brief = await cloud.brief(p);
  if (!brief) return done();
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: brief },
    systemMessage: '👻 project brief from Spookling memory' }), done);
});
