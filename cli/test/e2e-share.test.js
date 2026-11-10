// End to end in a sandbox: temp HOME, fake claude and uv, a fake cloud on loopback. The whole sharing life of a session:
// install -> login -> share while the upload is refused (pending) -> refresh uploads it and shares it -> unshare -> uninstall.
// Nothing outside the temp folders is touched, and the user's own settings and rules must survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpHome } from './helpers.mjs';
import { TAGGERS } from '../src/wizard.js';

const BIN = fileURLToPath(new URL('../../bin/spookling-memory.js', import.meta.url));
const posix = { skip: process.platform === 'win32' && 'POSIX fake binaries' };

const THEIRS = {
  theme: 'dark',
  model: 'opus',
  permissions: { allow: ['Bash(git status)'], deny: ['Read(./.env)'], defaultMode: 'acceptEdits' },
};

function fakeBin(dir) {
  mkdirSync(dir, { recursive: true });
  const script = (name, body) => { const p = join(dir, name); writeFileSync(p, `#!${process.execPath}\n${body}\n`); chmodSync(p, 0o755); };
  script('uv', 'process.exit(process.argv[2] === "--version" ? (console.log("uv 0.9.0"), 0) : 0);');
  script('claude', `
const fs = require('fs'), path = require('path'), a = process.argv.slice(2);
if (a[0] === '--version') { console.log('2.1.200 (Claude Code)'); process.exit(0); }
const f = path.join(process.env.HOME, '.claude.json');
const j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
if (a[0] === 'mcp' && a[1] === 'add-json') { j.mcpServers = { ...(j.mcpServers || {}), [a[2]]: JSON.parse(a[3]) }; fs.writeFileSync(f, JSON.stringify(j)); }
if (a[0] === 'mcp' && a[1] === 'remove') { delete (j.mcpServers || {})[a[2]]; fs.writeFileSync(f, JSON.stringify(j)); }
`);
}

// a tiny stateful cloud: one org, sessions with their shares
async function cloud() {
  const state = { refuse: false, sessions: new Map(), calls: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const ok = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, data })); };
      const bad = (status, code) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: false, error: { code } })); };
      state.calls.push(`${req.method} ${url.pathname}`);
      const m = url.pathname.match(/^\/memory\/sessions\/([^/]+)(?:\/(turns)|\/shares\/([^/]+))?$/);
      if (url.pathname === '/cli/device/start') return ok({ deviceCode: 'dc', userCode: 'AAAA-BBBB', verificationUri: 'https://login.elsewhere.invalid/cli', interval: 0.01, expiresIn: 600 });
      if (url.pathname === '/cli/device/token') return ok({ status: 'approved', token: 'spk_e2e', user: { id: 'u1', name: 'Ada' } });
      if (url.pathname === '/cli/orgs') return ok({ orgs: [{ org: { id: 'o1', name: 'Acme' }, membership: { status: 'active' } }] });
      if (url.pathname === '/memory/projects/autoshare') return ok({ rules: [] });
      if (url.pathname === '/memory/orgs/o1/feed') return ok({ sessions: [], nextCursor: null });
      if (url.pathname === '/memory/sessions' && req.method === 'GET') {
        return ok({ sessions: [...state.sessions.values()].map((s) => ({ clientId: s.id, title: s.title, project: s.project, turnCount: s.turns, sharedWith: [...s.shares] })), nextCursor: null });
      }
      if (m) {
        const [, id, turns, org] = m;
        if (req.method === 'PUT' && !org) {
          if (state.refuse) return bad(503, 'UNAVAILABLE');
          const j = JSON.parse(body || '{}');
          if (!state.sessions.has(id)) state.sessions.set(id, { id, title: j.title || id, project: j.project || '', turns: 0, shares: new Set() });
          return ok({});
        }
        const s = state.sessions.get(id);
        if (turns) { if (state.refuse || !s) return bad(state.refuse ? 503 : 404, 'X'); const t = JSON.parse(body).turns; s.turns += t.length; return ok({ lastSeq: t.at(-1).seq }); }
        if (org && !s) return bad(404, 'NOT_FOUND');
        if (org && req.method === 'PUT') { s.shares.add(org); return ok({}); }
        if (org && req.method === 'DELETE') { s.shares.delete(org); return ok({}); }
      }
      return bad(404, 'NOT_FOUND');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { state, server, url: `http://127.0.0.1:${server.address().port}` };
}

let initPort = 0;
const cli = (home, cwd, args, input = '') => new Promise((resolve) => {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd,
    env: { PATH: `${join(home, 'bin')}:${process.env.PATH}`, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), NO_COLOR: '1',
      SPOOKLING_NO_UPDATE_CHECK: '1', OPENROUTER_API_KEY: 'sk-or-test', SPOOKLING_INIT_PORT: String(initPort) },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr, out: stdout + stderr }));
  child.stdin.end(input);
});

test('install, login, pending share, upload, shared, unshare, uninstall: nothing is left and their settings survive', posix, async () => {
  const home = tmpHome('spk-e2e-'), project = join(home, 'work', 'app');
  mkdirSync(join(project, '.git'), { recursive: true });
  fakeBin(join(home, 'bin'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  const settings = join(home, '.claude', 'settings.json');
  writeFileSync(settings, `${JSON.stringify(THEIRS, null, 2)}\n`);
  const api = await cloud();
  // the local memory server the wizard probes
  const memory = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ n_events: 0, tagger: { model: TAGGERS[0].model, via: 'openrouter' } })); });
  await new Promise((r) => memory.listen(0, '127.0.0.1', r));
  initPort = memory.address().port;
  try {
    // install (user scope), allowing the share tools
    let r = await cli(home, project, ['init', '--scope', 'user', '--no-ghost', '--no-anim', '--allow-share']);
    assert.equal(r.status, 0, r.out);
    let s = JSON.parse(readFileSync(settings, 'utf8'));
    assert.ok(s.hooks?.Stop && s.permissions.allow.includes('mcp__spookling-memory__memory_share'));
    assert.ok(existsSync(join(home, '.claude', 'commands', 'spookling-share.md')));

    // login against the fake cloud; the link is on another host so nothing opens a browser
    r = await cli(home, project, ['login', '--api-url', api.url]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Logged in as Ada\./);
    assert.match(r.out, /Default org: Acme/);

    // a session that was logged locally; the cloud refuses the upload, so the share is pending
    mkdirSync(join(project, '.memory'), { recursive: true });
    writeFileSync(join(project, '.memory', 'log.jsonl'), [
      { session_id: 'e2e1', role: 'user', ts: '2026-11-03T09:00:00Z', text: 'how do I fix the build' },
      { session_id: 'e2e1', role: 'assistant', ts: '2026-11-03T09:00:05Z', text: 'clear the cache' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    api.state.refuse = true;
    r = await cli(home, project, ['share', 'e2e1', '--yes']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Will be shared with Acme after this session's next save/);
    assert.equal(api.state.sessions.size, 0);
    r = await cli(home, project, ['status']);
    assert.match(r.out, /1 share waiting for the session to upload/);

    // the cloud is back: refresh uploads it and applies the share
    api.state.refuse = false;
    r = await cli(home, project, ['refresh']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual([...api.state.sessions.get('e2e1').shares], ['o1']);
    r = await cli(home, project, ['sessions']);
    assert.match(r.out, /e2e1\s+shared → Acme/);

    // unshare
    r = await cli(home, project, ['unshare', 'e2e1']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual([...api.state.sessions.get('e2e1').shares], []);
    r = await cli(home, project, ['sessions']);
    assert.match(r.out, /e2e1\s+private/);

    // uninstall: theirs stays, ours goes
    r = await cli(home, project, ['uninstall', '--scope', 'user']);
    assert.equal(r.status, 0, r.out);
    s = JSON.parse(readFileSync(settings, 'utf8'));
    assert.deepEqual(s, THEIRS, 'settings.json is what the user had');
    assert.ok(!existsSync(join(home, '.claude', 'commands', 'spookling-share.md')), 'the slash command is gone');
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers || {}, {}, 'the MCP entry is gone');
    assert.ok(existsSync(join(project, '.memory', 'log.jsonl')), 'local memory is kept');
    // what Spookling recorded about its rules is gone too; the login and the local memory stay until logout / the user deletes them
    const rec = JSON.parse(readFileSync(join(home, '.spookling', 'share-allow.json'), 'utf8'));
    assert.deepEqual(rec.added || {}, {}, 'no record of rules that are no longer there');
    assert.ok(existsSync(join(home, '.spookling', 'credentials.json')), 'uninstall does not log out');
    r = await cli(home, project, ['status']);
    assert.doesNotMatch(r.out, /✓ hooks/, r.out);
    // a second uninstall is harmless and still leaves their file alone
    r = await cli(home, project, ['uninstall', '--scope', 'user']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), THEIRS);
  } finally { api.server.close(); memory.close(); }
});
