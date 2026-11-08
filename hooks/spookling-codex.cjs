#!/usr/bin/env node
// Spookling's native Codex hooks, Node 18+, no dependencies. Shares Claude Code's HTTP server.
// Only a checked server response can say ready/active. Errors are visible but never block a turn.
// Stop and PreCompact print nothing: a Stop decision must never create a continuation loop.
if (process.env.SPOOKLING_TAGGING) process.exit(0);
const http = require('node:http');
const { homedir } = require('node:os');
const ghost = require('./ghost.js');
const pulse = require('./pulse.js');
const base = (process.env.SPOOKLING_MEMORY_URL || 'http://127.0.0.1:7447').replace(/\/+$/, '');
const events = { UserPromptSubmit: 'user-prompt-submit', PreCompact: 'pre-compact', Stop: 'stop' };
const CONNECT_MS = 1000; // the server must accept the connection within this: WSL drops a dead port instead of refusing it
const REPLY_MS = 15000; // once connected, the longest the server may take to answer
const COMPACT_REPLY_MS = 60000; // compaction rebuilds the survivor block
const chunks = [];
let p = null;
const done = () => {
  try {
    if (p && p.hook_event_name === 'Stop') {
      require('./upload-session.cjs').startUpload(p); // checks for a login itself
    }
  } catch { /* a partial copy has no uploader; Codex still continues */ }
  process.exit(0);
};
const emit = (value) => process.stdout.write(JSON.stringify(value), done);
let visible = false;
// What Codex shows: its hook messages render ANSI colour and keep every line, so the ghost is drawn under a first line
// of words (Codex puts "↳ Hook · " before that one). Only the server's own answers fill it.
const GREY = '#8a8a8a';
const said = (state, title, details) => {
  const level = ghost.colourLevel();
  const head = level === 'none' ? `spookling ${state} · ${title}`
    : `\x1b[1m${ghost.paint(`spookling ${state}`, level, ghost.PALETTE[state].O)}\x1b[0m${ghost.paint(` · ${title}`, level, GREY)}`;
  return details ? [head, ...ghost.card(state, details.map((t) => [[t, GREY]]))].join('\n') : head;
};
const unavailable = () => visible
  ? emit({ systemMessage: said('degraded', 'memory unavailable', ['the local server did not answer', 'check it with: spookling-memory status']) })
  : done();
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', done);
process.stdin.on('end', () => {
  try { p = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return done(); }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return done();
  const start = p.hook_event_name === 'SessionStart';
  if (!start && !Object.hasOwn(events, p.hook_event_name)) return done();
  if (p.hook_event_name === 'UserPromptSubmit' && (typeof p.prompt !== 'string' || !p.prompt.trim())) return done();
  visible = start || p.hook_event_name === 'UserPromptSubmit';
  const timeout = p.hook_event_name === 'PreCompact' ? COMPACT_REPLY_MS : REPLY_MS;
  // A wall-clock deadline also covers a connected server that never finishes its response.
  const deadline = setTimeout(unavailable, timeout + CONNECT_MS);
  const fail = () => { clearTimeout(deadline); unavailable(); };
  try {
    const req = http.request(base + (start ? '/v1/stats' : `/v1/hook/${events[p.hook_event_name]}`), {
      method: start ? 'GET' : 'POST', timeout: CONNECT_MS, headers: { 'content-type': 'application/json' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('error', fail);
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        clearTimeout(deadline);
        if (res.statusCode !== 200) return unavailable();
        let reply;
        try { reply = JSON.parse(body); } catch { return unavailable(); }
        if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return unavailable();
        if (!visible) return done();
        if (start) {
          if (!Number.isInteger(reply.n_events) || !reply.tagger || typeof reply.folder !== 'string') return unavailable();
          const { n } = pulse;
          return emit({ systemMessage: said('ready', 'local server connected', [
            `${n(reply.n_events, 'message')} remembered`,
            `${n(reply.n_facts || 0, 'fact')} in force · ${n(reply.n_rules || 0, 'standing rule')}`,
            reply.folder.replace(homedir(), '~'),
          ]) });
        }
        // Pass the server's bounded recall block through unchanged, including a successful empty search.
        const context = reply.hookSpecificOutput;
        if (Object.keys(reply).length && !(context?.hookEventName === 'UserPromptSubmit' && typeof context.additionalContext === 'string')) return unavailable();
        const c = pulse.counts(res.headers['x-spookling-pulse']);
        const room = c.cap ? `≈${ghost.kilo(c.chars || 0)} of the ${ghost.kilo(c.cap)} characters of room` : null;
        emit({ ...reply, systemMessage: c.facts || c.events || c.chats
          ? said('active', `${pulse.said(c)} recalled`, [room].filter(Boolean))
          : said('active', 'recall ran: nothing on record for this prompt') }); // a line, not a ghost every prompt
      });
    });
    req.on('socket', (s) => s.once('connect', () => req.setTimeout(timeout)));
    req.on('timeout', () => req.destroy());
    req.on('error', fail);
    req.end(start ? undefined : JSON.stringify({ ...p, harness: 'codex' }));
  } catch { fail(); }
});
