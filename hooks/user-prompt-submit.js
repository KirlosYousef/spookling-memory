#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: POST stdin to the local server, print its reply, exit 0.
if (process.env.SPOOKLING_TAGGING) process.exit(0); // a tagging call the server started
const http = require('node:http');
const pulse = require('./pulse.js');
const url = (process.env.SPOOKLING_MEMORY_URL || 'http://127.0.0.1:7447').replace(/\/+$/, '') + '/v1/hook/user-prompt-submit';
const CONNECT_MS = 1000; // the server must accept the connection within this: WSL drops a dead port instead of refusing it
const REPLY_MS = 15000; // once connected, the longest the server may take to answer (it may be recalling)
const done = () => process.exit(0);
// Logged in: tell the model which session this is, so "share this chat" can name it. The id and nothing else. Never throws; nothing when logged out.
const sessionLine = (p) => {
  try {
    const up = require('./upload-session.cjs');
    if (!up.hasToken() || typeof p.session_id !== 'string' || !p.session_id) return '';
    return `Spookling session: ${p.session_id}`; // the id only: the tools are not advertised on every prompt
  } catch { return ''; }
};
const withSession = (body, p) => {
  const line = sessionLine(p);
  if (!line) return body;
  try {
    const o = body ? JSON.parse(body) : {};
    const h = o.hookSpecificOutput || { hookEventName: 'UserPromptSubmit' };
    h.additionalContext = h.additionalContext ? `${h.additionalContext}\n${line}` : line;
    return JSON.stringify({ ...o, hookSpecificOutput: h });
  } catch { return body; }
};
// No recall to print (the server is down or answered nothing): still tell the model which session this is, when logged in.
const emitOnlySession = (p) => {
  const only = withSession('', p);
  return only ? process.stdout.write(only, done) : done();
};
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', done);
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  let p = {}, up = false;
  try { p = JSON.parse(input) || {}; } catch {}
  try {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, timeout: CONNECT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200 || !body) {
          pulse.write(p, { event: 'prompt', up: true });
          return emitOnlySession(p);
        }
        const c = pulse.counts(res.headers['x-spookling-pulse']);
        pulse.write(p, { event: 'prompt', up: true, ...c });
        // a transcript line only for recall about this prompt: standing rules alone come with every prompt
        if (c.facts || c.events || c.chats) {
          try { body = JSON.stringify({ ...JSON.parse(body), systemMessage: `👻 ${pulse.said(c)} from memory` }); } catch {}
        }
        process.stdout.write(withSession(body, p), done); // exit only once stdout has flushed
      });
    });
    req.on('socket', (s) => s.once('connect', () => { up = true; req.setTimeout(REPLY_MS); }));
    req.on('timeout', () => req.destroy());
    req.on('error', () => {
      pulse.write(p, { event: 'prompt', up });
      return emitOnlySession(p);
    });
    req.end(input);
  } catch { done(); }
});
