import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { basename, join } from 'node:path';
import { readCredentials, writeCredentials } from '../src/credentials.js';
import { createCloud } from '../src/cloud.js';
import { logout } from '../src/account.js';
import { projectLog, skippedSessionIds, teamMemoryHook } from '../src/push.js';
import { status } from '../src/wizard.js';
import { tmpHome, listen, envelope, readReq, waitFor, runHook, runUploader, STOP, CODEX, sampleLog, projectWithLog, hookEnv } from './helpers.mjs';

// A generous ceiling for "the hook did not wait for the upload": it only has to beat a hung API, and a loaded CI box can be slow
// to start node. The assertions on the state file are the real check that the hook returned before the upload finished.
const HOOK_MAX_MS = 10_000;

const homeOf = () => tmpHome('spk-uplo-');

test('log.jsonl projects to turns and is not rewritten', () => {
  const line = (session_id, turn_index, role, text, agent = 'claude-code') => JSON.stringify({
    seq: 50, hash: 'abc123hash', agent, session_id, turn_index, role, ts: '2026-11-03T09:00:12Z', text,
  });
  const raw = [
    line('abc#0', 0, 'user', 'Make the sync idempotent'),
    line('abc#0', 1, 'assistant', 'Done.'),
    line('abc#2', 0, 'user', 'Ship it', 'codex'),
  ].join('\n') + '\n';
  const [session] = projectLog(raw);
  assert.equal(session.sid, 'abc');
  assert.deepEqual(session.turns, [
    { seq: 0, role: 'user', text: 'Make the sync idempotent', ts: '2026-11-03T09:00:12Z' },
    { seq: 1, role: 'assistant', text: 'Done.', ts: '2026-11-03T09:00:12Z' },
    { seq: 2, role: 'user', text: 'Ship it', ts: '2026-11-03T09:00:12Z' },
  ]);
  assert.equal(session.session.agent, 'codex');
  assert.equal(session.session.title, 'Make the sync idempotent');
  assert.equal(JSON.stringify(session).includes('abc123hash'), false);
  assert.equal(JSON.stringify(session).includes('turn_index'), false);
});

test('a failed network call does not raise out of the hook path', async () => {
  const home = homeOf();
  const token = 'spk_push_secret';
  writeCredentials({ token, user: { name: 'Ada' } }, { home });
  const logPath = join(home, 'log.jsonl');
  const raw = `${JSON.stringify({
    seq: 1, hash: 'hhh', agent: 'claude-code', session_id: 'sess#0', turn_index: 0,
    role: 'user', ts: '2026-11-03T09:00:12Z', text: 'hello',
  })}\n`;
  writeFileSync(logPath, raw);
  const notes = [];
  const cloud = createCloud({ env: { SPOOKLING_API_URL: 'http://127.0.0.1:9' }, timeoutMs: 800 });
  const result = await teamMemoryHook({ logPath, home, env: {}, cloud, project: 'spookling-memory', log: (m) => notes.push(m) });
  assert.equal(result.ok, false);
  assert.equal(result.queued, true);
  assert.equal(readFileSync(logPath, 'utf8'), raw);
  const state = readFileSync(join(home, '.spookling', 'upload-state.json'), 'utf8');
  assert.match(state, /hello/);
  assert.equal(state.includes(token), false);
  assert.equal(notes.join('\n').includes(token), false);
  assert.equal(readCredentials({ home, env: {} }).token, token);
});

test('a 429 waits, retries, and is not logout', async () => {
  const home = homeOf();
  const token = 'spk_rate_secret';
  writeCredentials({ token, user: { name: 'Ada' } }, { home });
  const raw = `${JSON.stringify({
    seq: 1, hash: 'hhh', agent: 'claude-code', session_id: 'sess', turn_index: 0,
    role: 'user', ts: '2026-11-03T09:00:12Z', text: 'hello',
  })}\n`;
  let posts = 0;
  const urls = [];
  const fetchImpl = async (url, opts) => {
    urls.push(String(url));
    if (String(url).endsWith('/turns')) {
      posts += 1;
      if (posts === 1) {
        return new Response(JSON.stringify({
          success: false, error: { code: 'RATE_LIMITED', message: 'slow', details: {} },
        }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '90' } });
      }
      const body = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        success: true, data: { stored: body.turns.length, lastSeq: body.turns.at(-1).seq, turnCount: body.turns.length },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: true, data: { id: 'u:sess' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const cloud = createCloud({ env: { SPOOKLING_API_URL: 'http://127.0.0.1:4000' }, fetchImpl });
  let waited = 0;
  const result = await teamMemoryHook({
    logText: raw, home, env: {}, cloud, maxWaitMs: 2000,
    sleep: async (ms) => { waited += ms; },
    log: () => {},
  });
  assert.equal(waited, 2000);
  assert.equal(posts, 2);
  assert.equal(result.ok, true);
  assert.equal(result.queued, false);
  assert.equal(readCredentials({ home, env: {} }).token, token);
  assert.equal(urls.some((u) => u.includes('/cli/tokens')), false);
});

test('auto-share shares a matching project after upload and retries a down share', async () => {
  const home = homeOf();
  writeCredentials({ token: 'spk_share', user: { name: 'Ada' } }, { home });
  const line = (sid, text) => JSON.stringify({
    seq: 1, hash: 'hhh', agent: 'claude-code', session_id: sid, turn_index: 0,
    role: 'user', ts: '2026-11-03T09:00:12Z', text,
  });
  const shares = [];
  let shareFails = true;
  const fetchImpl = async (url, opts) => {
    const path = new URL(String(url)).pathname;
    if (path === '/memory/projects/autoshare') {
      return new Response(JSON.stringify({
        success: true,
        data: {
          rules: [
            { project: 'spookling-memory', orgId: 'org-1', createdAt: '2026-11-03T09:00:00Z' },
            { project: 'other', orgId: 'org-9', createdAt: '2026-11-03T09:00:00Z' },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (opts?.method === 'PUT' && path.endsWith('/shares/org-1')) {
      if (shareFails) {
        shareFails = false;
        throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
      }
      shares.push(path);
      return new Response(JSON.stringify({ success: true, data: { id: 'u:abc', sharedWith: ['org-1'] } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (path.endsWith('/turns')) {
      const body = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        success: true, data: { stored: body.turns.length, lastSeq: body.turns.at(-1).seq, turnCount: body.turns.length },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: true, data: { id: 'u:abc' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const cloud = createCloud({ env: { SPOOKLING_API_URL: 'http://127.0.0.1:4000' }, home, fetchImpl, timeoutMs: 2000 }); // home: never the developer's real login
  const first = await teamMemoryHook({
    logText: `${line('abc', 'hello')}\n`, home, env: {}, cloud, project: 'spookling-memory', log: () => {},
  });
  assert.equal(first.ok, false);
  assert.equal(first.queued, true);
  assert.deepEqual(shares, []);
  const state = JSON.parse(readFileSync(join(home, '.spookling', 'upload-state.json'), 'utf8'));
  assert.equal(state.cursors.abc, 0);
  assert.deepEqual(state.shares, [{ sid: 'abc', project: 'spookling-memory' }]);
  assert.equal(JSON.stringify(state).includes('spk_share'), false);

  const second = await teamMemoryHook({
    logText: `${line('def', 'manual')}\n`, home, env: {}, cloud, project: 'other-app', log: () => {},
  });
  assert.equal(second.ok, true);
  assert.equal(second.queued, false);
  assert.deepEqual(shares, ['/memory/sessions/abc/shares/org-1']);
  const after = JSON.parse(readFileSync(join(home, '.spookling', 'upload-state.json'), 'utf8'));
  assert.deepEqual(after.shares, []);
  assert.equal(after.cursors.def, 0);
});

test('one seq_conflict is retried; a repeat stays skipped and status names it', async () => {
  const home = homeOf();
  writeCredentials({ token: 'spk_conflict', user: { name: 'Ada' } }, { home });
  const line = (text) => JSON.stringify({
    seq: 1, hash: 'hhh', agent: 'claude-code', session_id: 'sess', turn_index: 0,
    role: 'user', ts: '2026-11-03T09:00:12Z', text,
  });
  const raw = `${line('hello')}\n`;
  let posts = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/turns')) {
      posts += 1;
      return new Response(JSON.stringify({
        success: false, error: { code: 'CONFLICT', message: 'differs', details: { reason: 'seq_conflict' } },
      }), { status: 409, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: true, data: { id: 'u:sess' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const cloud = createCloud({ env: { SPOOKLING_API_URL: 'http://127.0.0.1:4000' }, fetchImpl });
  const notes = [];
  const once = await teamMemoryHook({ logText: raw, home, env: {}, cloud, log: (m) => notes.push(m) });
  assert.equal(once.queued, false);
  assert.match(notes.join('\n'), /session sess seq_conflict; retrying on the next Stop/);
  assert.equal(posts, 1);
  assert.deepEqual(skippedSessionIds(home), []);
  await teamMemoryHook({ logText: raw, home, env: {}, cloud, log: (m) => notes.push(m) });
  assert.equal(posts, 2);
  assert.match(notes.join('\n'), /session sess skipped: seq_conflict/);
  assert.deepEqual(skippedSessionIds(home), ['sess']);
  await teamMemoryHook({ logText: `${raw}${line('later')}\n`, home, env: {}, cloud, log: () => {} });
  assert.equal(posts, 2);
  const said = [];
  const write = process.stdout.write;
  process.stdout.write = (s) => { said.push(String(s)); return true; };
  try {
    await status(home, async () => null, home);
  } finally {
    process.stdout.write = write;
  }
  assert.match(said.join('').replace(/\x1b\[[0-9;]*m/g, ''), /sess skipped after seq_conflict/);
});

test('a seq_conflict that succeeds on the next Stop uploads later turns', async () => {
  const home = homeOf();
  writeCredentials({ token: 'spk_conflict_ok', user: { name: 'Ada' } }, { home });
  const line = (text) => JSON.stringify({
    session_id: 'sess', role: 'user', ts: '2026-11-03T09:00:12Z', text,
  });
  let posts = 0;
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    if (String(url).endsWith('/turns')) {
      posts += 1;
      const body = JSON.parse(opts.body);
      bodies.push(body.turns.map((t) => t.seq));
      if (posts === 1) {
        return new Response(JSON.stringify({
          success: false, error: { code: 'CONFLICT', message: 'differs', details: { reason: 'seq_conflict' } },
        }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      const last = body.turns.at(-1).seq;
      return new Response(JSON.stringify({
        success: true, data: { stored: body.turns.length, lastSeq: last, turnCount: last + 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: true, data: { id: 'u:sess' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const cloud = createCloud({ env: { SPOOKLING_API_URL: 'http://127.0.0.1:4000' }, fetchImpl });
  await teamMemoryHook({ logText: `${line('hello')}\n`, home, env: {}, cloud, log: () => {} });
  await teamMemoryHook({ logText: `${line('hello')}\n`, home, env: {}, cloud, log: () => {} });
  assert.equal(posts, 2);
  assert.deepEqual(skippedSessionIds(home), []);
  await teamMemoryHook({ logText: `${line('hello')}\n${line('later')}\n`, home, env: {}, cloud, log: () => {} });
  assert.equal(posts, 3);
  assert.deepEqual(bodies[2], [1]);
});

test('a batch that fails after an earlier batch succeeded is resent and a 200 advances the cursor', async () => {
  const home = homeOf();
  writeCredentials({ token: 'spk_partial', user: { name: 'Ada' } }, { home });
  const raw = Array.from({ length: 201 }, (_, i) => JSON.stringify({
    session_id: 'sess', role: i % 2 ? 'assistant' : 'user', ts: '2026-11-03T09:00:12Z', text: `t${i}`,
  })).join('\n') + '\n';
  let posts = 0;
  const fetchImpl = async (url, opts) => {
    if (String(url).endsWith('/turns')) {
      posts += 1;
      const body = JSON.parse(opts.body);
      if (posts === 2) return new Response('no', { status: 500, headers: { 'content-type': 'text/plain' } });
      const last = body.turns.at(-1).seq;
      return new Response(JSON.stringify({
        success: true, data: { stored: posts === 1 ? body.turns.length : 1, lastSeq: last, turnCount: last + 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: true, data: { id: 'u:sess' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const cloud = createCloud({ env: { SPOOKLING_API_URL: 'http://127.0.0.1:4000' }, fetchImpl });
  const first = await teamMemoryHook({ logText: raw, home, env: {}, cloud, log: () => {} });
  assert.equal(first.ok, false);
  assert.equal(posts, 2);
  const state = JSON.parse(readFileSync(join(home, '.spookling', 'upload-state.json'), 'utf8'));
  assert.equal(state.cursors.sess, undefined);
  assert.deepEqual(state.skipped, {});
  const second = await teamMemoryHook({ logText: raw, home, env: {}, cloud, log: () => {} });
  assert.equal(second.ok, true);
  const after = JSON.parse(readFileSync(join(home, '.spookling', 'upload-state.json'), 'utf8'));
  assert.equal(after.cursors.sess, 200);
  assert.deepEqual(after.skipped, {});
  assert.deepEqual(skippedSessionIds(home), []);
});


test('a logged-out upload does not call the network', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('network'); };
  const cloud = createCloud({ env: { SPOOKLING_API_URL: 'http://127.0.0.1:4000' }, fetchImpl });
  const result = await teamMemoryHook({
    logText: sampleLog(), home: homeOf(), env: {}, cloud, log: () => {},
  });
  assert.equal(calls, 0);
  assert.equal(result.skipped, 'logged-out');
});

test('a logged-out Stop hook does not call the network', async () => {
  const seen = [];
  const server = await listen((req, res) => { seen.push(req.url); res.end('no'); });
  const { port } = server.address();
  const home = homeOf();
  const { project } = projectWithLog(home);
  const input = { hook_event_name: 'Stop', session_id: 'abc', cwd: project };
  try {
    const env = hookEnv(home, project, `http://127.0.0.1:${port}`);
    for (const script of [STOP, CODEX]) {
      const ran = await runHook(script, input, env);
      assert.equal(ran.code, 0);
      assert.equal(ran.out, '');
      assert.ok(ran.ms < HOOK_MAX_MS, `hook blocked for ${ran.ms}ms`);
    }
    // Logged out, the hook starts no detached uploader at all. Run the uploader itself to completion and wait for its exit, so
    // "nothing was sent" is judged after an upload attempt really finished, not after a fixed sleep.
    assert.equal(await runUploader(input, env), 0);
    assert.deepEqual(seen, []);
    assert.equal(existsSync(join(home, '.spookling', 'upload-state.json')), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function hang() {
  return new Promise((resolve) => {
    const server = http.createServer(() => {});
    const sockets = new Set();
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.listen(0, '127.0.0.1', () => resolve({ server, sockets }));
  });
}

test('Stop returns when the API is down and the session is queued', async () => {
  const hung = await hang();
  const { port } = hung.server.address();
  try {
    await Promise.all([STOP, CODEX].map(async (script) => {
      const home = homeOf();
      const token = 'spk_hook_secret';
      writeCredentials({ token, user: { name: 'Ada' } }, { home });
      const { project, logPath, before } = projectWithLog(home);
      const env = { ...hookEnv(home, project, `http://127.0.0.1:${port}`), SPOOKLING_UPLOAD_TIMEOUT_MS: '1200' };
      const ran = await runHook(script, { hook_event_name: 'Stop', session_id: 'abc', cwd: project }, env);
      assert.equal(ran.code, 0);
      assert.equal(ran.out, '');
      assert.equal(ran.err.includes(token), false);
      assert.ok(ran.ms < HOOK_MAX_MS, `${script} blocked for ${ran.ms}ms`);
      const statePath = join(home, '.spookling', 'upload-state.json');
      assert.equal(existsSync(statePath), false, 'the hook waited for the upload');
      const state = await waitFor(() => (existsSync(statePath) ? readFileSync(statePath, 'utf8') : ''), 4000);
      assert.match(state, /Make the sync idempotent/);
      assert.equal(state.includes(token), false);
      assert.deepEqual(readFileSync(logPath), before);
      assert.equal(readCredentials({ home, env: {} }).token, token);
    }));
  } finally {
    for (const s of hung.sockets) s.destroy();
    await new Promise((resolve) => hung.server.close(resolve));
  }
});

test('Stop puts the session and posts turns in log order', async () => {
  const seen = [];
  const server = await listen(async (req, res) => {
    const body = await readReq(req);
    seen.push({ method: req.method, url: req.url, body, auth: req.headers.authorization || null });
    if (req.method === 'PUT') return envelope(res, 200, { success: true, data: { id: 'u:abc', clientId: 'abc' } });
    if (req.method === 'POST') {
      const last = body.turns.at(-1).seq;
      return envelope(res, 200, { success: true, data: { stored: body.turns.length, lastSeq: last, turnCount: last + 1 } });
    }
    return envelope(res, 404, { success: false, error: { code: 'NOT_FOUND', message: 'no', details: {} } });
  });
  const { port } = server.address();
  const home = homeOf();
  const token = 'spk_put_secret';
  writeCredentials({ token, user: { name: 'Ada' }, apiUrl: `http://127.0.0.1:${port}` }, { home });
  const { project, logPath, before } = projectWithLog(home);
  try {
    const ran = await runHook(STOP, { hook_event_name: 'Stop', session_id: 'abc', cwd: project }, hookEnv(home, project, `http://127.0.0.1:${port}`));
    assert.equal(ran.code, 0);
    assert.equal(ran.out, '');
    assert.ok(ran.ms < HOOK_MAX_MS, `hook blocked for ${ran.ms}ms`);
    const posted = await waitFor(() => seen.find((s) => s.method === 'POST' && s.url === '/memory/sessions/abc/turns'));
    assert.ok(posted, 'turns were not posted');
    assert.equal(posted.auth, `Bearer ${token}`);
    assert.deepEqual(posted.body.turns.map((t) => t.seq), [0, 1, 2]);
    assert.equal(JSON.stringify(posted.body).includes('abc123hash'), false);
    assert.equal(JSON.stringify(posted.body).includes('turn_index'), false);
    const put = seen.find((s) => s.method === 'PUT');
    assert.equal(put.url, '/memory/sessions/abc');
    assert.equal(put.body.agent, 'claude-code');
    assert.equal(put.body.project, basename(project));
    assert.equal(put.body.title, 'Make the sync idempotent');
    assert.ok(seen.findIndex((s) => s.method === 'PUT') < seen.findIndex((s) => s.method === 'POST'));
    assert.deepEqual(readFileSync(logPath), before);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a repo cwd is not named after the home folder when the log lives in ~', async () => {
  const seen = [];
  const server = await listen(async (req, res) => {
    const body = await readReq(req);
    seen.push({ method: req.method, body });
    if (req.method === 'PUT') return envelope(res, 200, { success: true, data: { id: 'u:abc' } });
    if (req.method === 'POST') {
      const last = body.turns.at(-1).seq;
      return envelope(res, 200, { success: true, data: { stored: body.turns.length, lastSeq: last, turnCount: last + 1 } });
    }
    return envelope(res, 404, { success: false, error: { code: 'NOT_FOUND', message: 'no', details: {} } });
  });
  const { port } = server.address();
  const root = tmpHome('spk-home-');
  const home = join(root, 'alex');
  const repo = join(home, 'Developer', 'spookling-memory');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(home, '.memory'), { recursive: true });
  writeFileSync(join(home, '.memory', 'log.jsonl'), sampleLog());
  writeCredentials({ token: 'spk_repo_name', user: { name: 'Ada' }, apiUrl: `http://127.0.0.1:${port}` }, { home });
  const env = {
    ...hookEnv(home, home, `http://127.0.0.1:${port}`),
    SPOOKLING_UPLOAD_SETTLE_MS: '0',
    SPOOKLING_UPLOAD_MAX_WAIT_MS: '0',
    SPOOKLING_UPLOAD_POLL_MS: '20',
  };
  try {
    const ran = await runHook(STOP, { hook_event_name: 'SessionEnd', session_id: 'abc', cwd: repo }, env);
    assert.equal(ran.code, 0);
    const put = await waitFor(() => seen.find((s) => s.method === 'PUT'));
    assert.ok(put, 'session was not uploaded');
    assert.equal(put.body.project, 'spookling-memory');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Stop logs a seq_conflict and skips that session', async () => {
  let posts = 0;
  const server = await listen(async (req, res) => {
    const body = await readReq(req);
    if (req.method === 'POST') {
      posts += 1;
      return envelope(res, 409, { success: false, error: { code: 'CONFLICT', message: 'differs', details: { reason: 'seq_conflict' } } });
    }
    void body;
    return envelope(res, 200, { success: true, data: { id: 'u:abc' } });
  });
  const { port } = server.address();
  const home = homeOf();
  const token = 'spk_conflict_hook';
  writeCredentials({ token, user: { name: 'Ada' }, apiUrl: `http://127.0.0.1:${port}` }, { home });
  const { project, logPath, before } = projectWithLog(home);
  const env = {
    ...hookEnv(home, project, `http://127.0.0.1:${port}`),
    SPOOKLING_UPLOAD_SETTLE_MS: '0',
    SPOOKLING_UPLOAD_MAX_WAIT_MS: '0',
    SPOOKLING_UPLOAD_POLL_MS: '20',
  };
  const input = { hook_event_name: 'Stop', session_id: 'abc', cwd: project };
  try {
    const ran = await runHook(STOP, input, env);
    assert.equal(ran.code, 0);
    assert.equal(ran.out, '');
    const state = await waitFor(() => {
      const path = join(home, '.spookling', 'upload-state.json');
      if (!existsSync(path)) return '';
      const text = readFileSync(path, 'utf8');
      return text.includes('seq_conflict') ? text : '';
    });
    assert.match(state, /retrying on the next Stop|seq_conflict/);
    const log = readFileSync(join(home, '.spookling', 'upload.log'), 'utf8');
    assert.match(log, /session abc seq_conflict; retrying on the next Stop/);
    assert.equal(log.includes(token), false);
    assert.equal(posts, 1);
    await runHook(STOP, input, env);
    const skipped = await waitFor(() => {
      const path = join(home, '.spookling', 'upload.log');
      if (!existsSync(path)) return '';
      const text = readFileSync(path, 'utf8');
      return text.includes('skipped: seq_conflict') ? text : '';
    });
    assert.match(skipped, /session abc skipped: seq_conflict/);
    assert.equal(posts, 2);
    // The third attempt runs the uploader in the foreground and waits for its exit: a skipped session must not be posted again.
    assert.equal(await runUploader(input, env), 0);
    assert.equal(posts, 2);
    assert.deepEqual(readFileSync(logPath), before);
    assert.equal(readCredentials({ home, env: {} }).token, token);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
