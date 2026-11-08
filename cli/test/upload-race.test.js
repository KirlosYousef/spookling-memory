import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CloudError } from '../src/cloud.js';
import { writeCredentials } from '../src/credentials.js';
import { teamMemoryHook } from '../src/push.js';
import { StateBusy, claimSession, readState, statePath, updateState } from '../src/upload-state.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'spk-race-'));
const logOf = (...ids) => ids.flatMap((id) => [
  { session_id: id, role: 'user', ts: '2026-11-03T09:00:00Z', text: `hello ${id}` },
  { session_id: id, role: 'assistant', ts: '2026-11-03T09:00:05Z', text: 'hi' },
].map((e) => JSON.stringify(e))).join('\n') + '\n';
const setup = () => { const home = tmp(); writeCredentials({ token: 'spk_t', apiUrl: 'https://api.t.test' }, { home }); return home; };

// every request takes `ms`, so the uploaders really overlap
function slowApi({ ms = 120, puts = {}, sent = [] } = {}) {
  return {
    sent,
    upsertSession: async ({ sid }) => { await delay(ms); if (puts[sid]) throw puts[sid]; return {}; },
    postTurns: async ({ sid, turns }) => { await delay(ms); for (const t of turns) sent.push(`${sid}:${t.seq}`); return { lastSeq: turns.at(-1).seq }; },
    listAutoShare: async () => ({ rules: [] }),
  };
}
const run = (home, cloud, text) => teamMemoryHook({ logText: text, home, env: {}, cloud, log: () => {} });

test('two concurrent uploads each keep their cursors and the other one\'s skip', async () => {
  const home = setup();
  const sent = [];
  const gone = new CloudError('FORBIDDEN', { status: 403, code: 'FORBIDDEN', reason: 'org_owned' });
  const [a, b] = await Promise.all([
    run(home, slowApi({ sent }), logOf('a1', 'a2')),
    run(home, slowApi({ sent, puts: { c1: gone } }), logOf('b1', 'c1', 'b2')),
  ]);
  assert.equal(a.ok && b.ok, true);
  const st = readState(home);
  assert.deepEqual(Object.keys(st.cursors).sort(), ['a1', 'a2', 'b1', 'b2'], 'no cursor was lost to the other uploader\'s write');
  assert.ok(Object.values(st.cursors).every((c) => c === 1));
  assert.deepEqual(st.skipped.c1, { reason: 'org_owned', permanent: true });
  assert.equal(new Set(sent).size, sent.length, 'no turn was sent twice');
  assert.equal(sent.length, 8);
});

test('two uploaders handed the same sessions send every turn once', async () => {
  const home = setup();
  const sent = [];
  const text = logOf('s1', 's2', 's3');
  await Promise.all([run(home, slowApi({ sent }), text), run(home, slowApi({ sent }), text), run(home, slowApi({ sent }), text)]);
  assert.deepEqual([...sent].sort(), ['s1:0', 's1:1', 's2:0', 's2:1', 's3:0', 's3:1']);
  assert.deepEqual(readState(home).cursors, { s1: 1, s2: 1, s3: 1 });
  await run(home, slowApi({ sent }), text);
  assert.equal(sent.length, 6, 'and nothing again once it is done');
});

test('the cursor is saved after each session, not once at the end', async () => {
  const home = setup();
  const seen = [];
  const cloud = slowApi({ ms: 5 });
  const post = cloud.postTurns;
  cloud.postTurns = async (a) => {
    seen.push(Object.keys(readState(home).cursors).sort().join(','));
    return post(a);
  };
  await run(home, cloud, logOf('x1', 'x2', 'x3'));
  assert.deepEqual(seen, ['', 'x1', 'x1,x2']);
});

test('a failure queues the session without wiping what another uploader saved', async () => {
  const home = setup();
  const down = new CloudError('network error', { code: 'ECONNREFUSED' });
  const [a, b] = await Promise.all([
    run(home, slowApi({ ms: 60, puts: { q1: down } }), logOf('q1')),
    run(home, slowApi({ ms: 60 }), logOf('ok1')),
  ]);
  assert.equal(a.queued, true);
  assert.equal(b.ok, true);
  const st = readState(home);
  assert.deepEqual(st.queue.map((q) => q.sid), ['q1']);
  assert.equal(st.cursors.ok1, 1);
});

test('the state lock: a busy lock is reported quickly, a stale one is broken', async () => {
  const home = setup();
  mkdirSync(join(home, '.spookling'), { recursive: true });
  const lock = `${statePath(home)}.lock`;
  writeFileSync(lock, '1 1\n');
  const t = Date.now();
  await assert.rejects(updateState(home, () => {}, { waitMs: 150 }), StateBusy);
  assert.ok(Date.now() - t < 1500, 'it gave up instead of hanging');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(await updateState(home, (st) => { st.cursors.z = 1; return 'ok'; }), 'ok');
  assert.equal(existsSync(lock), false, 'the lock is released');
  assert.equal(readState(home).cursors.z, 1);
});

test('a hook whose lock stays busy does not hang or fail: it logs and ends', async () => {
  const home = setup();
  mkdirSync(join(home, '.spookling'), { recursive: true });
  writeFileSync(`${statePath(home)}.lock`, '1 1\n');
  const notes = [];
  const t = Date.now();
  const r = await teamMemoryHook({ logText: logOf('b1'), home, env: {}, cloud: slowApi({ ms: 1 }), log: (m) => notes.push(m) });
  assert.ok(Date.now() - t < 6000);
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(notes.some((m) => /state busy/.test(m)));
});

test('a session being uploaded by someone else is claimed; a stale claim is not', async () => {
  const home = setup();
  const release = await claimSession(home, 'sess');
  assert.equal(typeof release, 'function');
  assert.equal(await claimSession(home, 'sess'), null);
  release();
  assert.equal(typeof (await claimSession(home, 'sess')), 'function');
});

// real processes against a slow HTTP server
test('two processes uploading at once lose nothing and send nothing twice', async () => {
  const home = setup();
  const posts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => setTimeout(() => {
      const m = /\/memory\/sessions\/([^/]+)\/turns/.exec(req.url);
      if (m) for (const t of JSON.parse(body).turns) posts.push(`${m[1]}:${t.seq}`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: true, data: m ? { lastSeq: JSON.parse(body).turns.at(-1).seq } : {} }));
    }, 100));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  writeCredentials({ token: 'spk_t', apiUrl: origin }, { home });
  const push = pathToFileURL(fileURLToPath(new URL('../src/push.js', import.meta.url))).href;
  const child = (ids) => new Promise((resolve) => {
    const script = `import { teamMemoryHook } from ${JSON.stringify(push)};
      const text = ${JSON.stringify(logOf(...ids))};
      const r = await teamMemoryHook({ logText: text, home: ${JSON.stringify(home)}, env: {}, log: () => {} });
      process.exit(r.ok ? 0 : 3);`;
    const c = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, HOME: home, SPOOKLING_NO_UPDATE_CHECK: '1' } });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, err }));
  });
  try {
    const [x, y] = await Promise.all([child(['p1', 'shared', 'p2']), child(['q1', 'shared', 'q2'])]);
    assert.deepEqual([x.code, y.code], [0, 0], x.err + y.err);
    assert.deepEqual(Object.keys(readState(home).cursors).sort(), ['p1', 'p2', 'q1', 'q2', 'shared']);
    assert.equal(posts.filter((p) => p.startsWith('shared:')).length, 2, 'the shared session\'s two turns went once');
    assert.equal(new Set(posts).size, posts.length);
    assert.equal(posts.length, 10);
  } finally { server.close(); }
});
