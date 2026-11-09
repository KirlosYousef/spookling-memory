import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backfill, transcripts } from '../src/backfill.js';
import { main } from '../src/main.js';
import { envelope, listen, readReq, tmpHome } from './helpers.mjs';

// ~/.claude/projects/<folder>/<session>.jsonl, written in a temp home: never the real one
function setup() {
  const home = tmpHome('spk-bf-');
  const project = join(home, 'work', 'app'), other = join(home, 'work', 'other');
  for (const d of [project, other, join(home, '.claude', 'projects', 'a'), join(home, '.claude', 'projects', 'b')]) mkdirSync(d, { recursive: true });
  const put = (folder, sid, cwd, day) => {
    const file = join(home, '.claude', 'projects', folder, `${sid}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } })}\n`);
    const t = new Date(`${day}T12:00:00Z`);
    utimesSync(file, t, t);
    return file;
  };
  put('a', 'old-mine', project, '2026-10-01');
  put('a', 'new-mine', project, '2026-11-05');
  put('b', 'new-other', other, '2026-11-06');
  return { home, project, other };
}

// a stand-in for POST /v1/backfill that counts what it already holds per session, as Store.ingest does
async function fakeServer(held = new Map()) {
  const calls = [];
  const server = await listen(async (req, res) => {
    const b = await readReq(req);
    calls.push(b.session_id);
    const had = held.get(b.session_id) || 0;
    held.set(b.session_id, 2);
    envelope(res, 200, { logged: 2 - had });
  });
  return { server, calls, env: { SPOOKLING_MEMORY_URL: `http://127.0.0.1:${server.address().port}` } };
}

test('backfill finds this project\'s transcripts, newest changes only with --since', () => {
  const { home } = setup();
  const env = { CLAUDE_CONFIG_DIR: join(home, '.claude') };
  assert.deepEqual(transcripts({ env, home }).map((t) => t.sessionId).sort(), ['new-mine', 'new-other', 'old-mine']);
  assert.deepEqual(transcripts({ env, home, since: new Date('2026-11-01') }).map((t) => t.sessionId).sort(), ['new-mine', 'new-other']);
  assert.deepEqual(transcripts({ env: { CLAUDE_CONFIG_DIR: join(home, 'nowhere') }, home }), []);
});

test('backfill is idempotent: a second run adds nothing, and only this project is read', async () => {
  const { home, project } = setup();
  const { server, calls, env } = await fakeServer();
  const say = [];
  try {
    const run = (extra = {}) => backfill({ project, home, env: { ...env, CLAUDE_CONFIG_DIR: join(home, '.claude') }, write: (s) => say.push(s), ...extra });
    const first = await run();
    assert.equal(first.logged, 4);
    assert.deepEqual(calls.sort(), ['new-mine', 'old-mine']); // new-other was written in another project
    const second = await run();
    assert.equal(second.logged, 0);
    assert.equal(second.sessions, 2);
    assert.ok(say.some((l) => /0 turns added from 2 of 2 transcripts/.test(l)));
    calls.length = 0;
    assert.equal((await run({ since: new Date('2026-11-01') })).sessions, 1);
    assert.deepEqual(calls, ['new-mine']);
    calls.length = 0;
    await run({ all: true });
    assert.equal(calls.length, 3);
  } finally { server.close(); }
});

test('backfill with the server down says so and fails', async () => {
  const { home, project } = setup();
  const say = [];
  const r = await backfill({ project, home, env: { CLAUDE_CONFIG_DIR: join(home, '.claude'), SPOOKLING_MEMORY_URL: 'http://127.0.0.1:9' }, write: (s) => say.push(s) });
  assert.equal(r.logged, 0);
  assert.match(r.error, /no Spookling Memory server answered/);
});

test('spookling backfill routes to it, and refuses a bad --since', async () => {
  const { home, project } = setup();
  let got;
  const deps = { home, cwd: project, env: {}, backfill: async (o) => { got = o; return { logged: 0, error: '' }; }, exit: () => {} };
  assert.equal(await main(['node', 'spookling', 'backfill', '--since', '2026-11-01'], deps), 0);
  assert.equal(got.project, project);
  assert.equal(got.since.toISOString().slice(0, 10), '2026-11-01');
  const err = [], write = process.stderr.write;
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  try { assert.equal(await main(['node', 'spookling', 'backfill', '--since', 'soon'], deps), 2); } finally { process.stderr.write = write; }
  assert.match(err.join(''), /--since takes a date/);
});
