import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpHome } from './helpers.mjs';

const homeOf = () => tmpHome('spk-ct-');
import { mkdirSync as mk, writeFileSync as wf } from 'node:fs';
import { smokeFailure, waitForStats } from '../src/wizard.js';

test('smoke test: an already-running server that misses the first probe still passes', async () => {
  const seen = [];
  const answers = [null, null, { n_events: 1 }];
  const probe = async (timeout) => { seen.push(timeout); return answers.shift() ?? null; };
  const r = await waitForStats({ project: '/nowhere' }, { probe, pause: async () => {}, alive: () => { throw new Error('no pid to check'); } });
  assert.deepEqual(r, { n_events: 1 });
  assert.deepEqual(seen, [1500, 3000, 3000], 'a longer timeout after the first miss');
});

test('smoke test: tries the whole backoff for a server init did not start', async () => {
  let n = 0;
  const r = await waitForStats({}, { probe: async () => { n += 1; return null; }, pause: async () => {} });
  assert.equal(r, null);
  assert.equal(n, 8);
});

test('smoke test: a server init started that has died fails at once', async () => {
  let n = 0;
  const r = await waitForStats({ pid: 4242 }, { probe: async () => { n += 1; return null; }, pause: async () => {}, alive: () => false });
  assert.equal(r, null);
  assert.equal(n, 1);
  n = 0;
  await waitForStats({ pid: 4242 }, { probe: async () => { n += 1; return n > 2 ? { ok: 1 } : null; }, pause: async () => {}, alive: () => true });
  assert.equal(n, 3, 'a live pid keeps retrying');
});

test('smoke test failure names a log that exists, never one that does not', () => {
  const project = homeOf(), home = homeOf();
  const ctx = { project, mem: join(project, '.memory') };
  const none = smokeFailure(ctx, home);
  assert.match(none, /a server this run did not start/);
  assert.doesNotMatch(none, /server\.log/);
  assert.match(none, /Run spookling status/);
  mk(join(home, '.memory'), { recursive: true });
  wf(join(home, '.memory', 'server.log'), '');
  const m = smokeFailure({ ...ctx, reused: true }, home);
  assert.match(m, /answered at step 4\)\. Its log may be /);
  assert.ok(m.includes(join(home, '.memory', 'server.log')), m);
  assert.match(m, /\. Run spookling status\.$/);
  mk(ctx.mem, { recursive: true });
  wf(join(ctx.mem, 'server.log'), '');
  assert.match(smokeFailure(ctx, home), /Its log may be \.memory[\\/]server\.log/);
  assert.match(smokeFailure({ ...ctx, pid: 1 }, home), /Look in \.memory[\\/]server\.log\./);
});
