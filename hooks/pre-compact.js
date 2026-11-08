#!/usr/bin/env node
// Claude Code PreCompact hook: POST stdin to the local server, print nothing (Claude Code drops PreCompact's systemMessage), exit 0.
if (process.env.SPOOKLING_TAGGING) process.exit(0); // a tagging call the server started
const http = require('node:http');
const pulse = require('./pulse.js');
const url = (process.env.SPOOKLING_MEMORY_URL || 'http://127.0.0.1:7447').replace(/\/+$/, '') + '/v1/hook/pre-compact';
const CONNECT_MS = 1000; // the server must accept the connection within this: WSL drops a dead port instead of refusing it
const COMPACT_REPLY_MS = 60000; // compaction rebuilds the survivor block, which can take a while
const done = () => process.exit(0);
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', done);
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  let p = {}, up = false;
  try { p = JSON.parse(input) || {}; } catch {}
  try {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, timeout: CONNECT_MS }, (res) => {
      res.resume();
      res.on('end', () => {
        pulse.write(p, { event: 'compact', up: true, ...(res.statusCode === 200 && pulse.counts(res.headers['x-spookling-pulse'])) });
        done();
      });
    });
    req.on('socket', (s) => s.once('connect', () => { up = true; req.setTimeout(COMPACT_REPLY_MS); }));
    req.on('timeout', () => req.destroy());
    req.on('error', () => { pulse.write(p, { event: 'compact', up }); done(); });
    req.end(input);
  } catch { done(); }
});
