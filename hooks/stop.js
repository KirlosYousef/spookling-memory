#!/usr/bin/env node
// Claude Code Stop hook: POST stdin to the local server, print nothing (Stop output could keep Claude going), exit 0.
// The private upload runs in a detached process: a down API is queued there and cannot hold this session.
if (process.env.SPOOKLING_TAGGING) process.exit(0); // a tagging call the server started
const http = require('node:http');
const pulse = require('./pulse.js');
const url = (process.env.SPOOKLING_MEMORY_URL || 'http://127.0.0.1:7447').replace(/\/+$/, '') + '/v1/hook/stop';
const CONNECT_MS = 1000; // the server must accept the connection within this: WSL drops a dead port instead of refusing it
const REPLY_MS = 15000; // once connected, the longest the server may take to answer (it may be tagging)
let settled = false;
let p = {};
const done = () => {
  if (settled) return;
  settled = true;
  try {
    require('./upload-session.cjs').startUpload(p); // checks for a login itself
  } catch { /* missing on a partial copy: the local stop still exits 0 */ }
  process.exit(0);
};
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', done);
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  let up = false;
  try { p = JSON.parse(input) || {}; } catch {}
  try {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, timeout: CONNECT_MS }, (res) => {
      res.resume();
      res.on('end', () => { pulse.write(p, { event: 'stop', up: true }); done(); });
    });
    req.on('socket', (s) => s.once('connect', () => { up = true; req.setTimeout(REPLY_MS); }));
    req.on('timeout', () => req.destroy());
    req.on('error', () => { pulse.write(p, { event: 'stop', up }); done(); });
    req.end(input);
  } catch { done(); }
});
