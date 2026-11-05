import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpHome } from './helpers.mjs';
import { CloudError, createCloud } from '../src/cloud.js';
import { readCredentials, writeCredentials } from '../src/credentials.js';
import { tokens } from '../src/account.js';
import { main } from '../src/main.js';

const homeOf = () => tmpHome('spk-ct-');
const setup = () => { const home = homeOf(); writeCredentials({ token: 'spk_t', user: { name: 'Ada' }, apiUrl: 'https://api.t.test' }, { home }); return home; };

test('details.reason survives in a CloudError', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'x', details: { reason: 'org_owned' } } }), { status: 403 });
  const cloud = createCloud({ env: { SPOOKLING_API_URL: 'https://api.t.test' }, home: homeOf(), token: 'spk_x', fetchImpl });
  await assert.rejects(cloud.upsertSession({ sid: 's', session: {} }), (e) => e.status === 403 && e.reason === 'org_owned');
});

const row = (id, extra = {}) => ({ id, label: 'laptop', createdAt: '2026-11-01T10:00:00Z', lastUsedAt: '2026-11-03T12:30:00Z', current: false, ...extra });
function tokenApi(rows) {
  const calls = [];
  return {
    calls,
    listTokens: async () => ({ tokens: rows }),
    revokeToken: async ({ id }) => { calls.push(`DELETE ${id}`); },
    revokeAllTokens: async () => { calls.push('DELETE all'); },
  };
}
const run = async (home, cloud, opts = {}) => { let out = ''; const code = await tokens({ home, env: {}, cloud, write: (s) => { out += s; }, ...opts }); return { code, out }; };

test('tokens lists label, created, last used and this device; server text is cleaned', async () => {
  const home = setup();
  const r = await run(home, tokenApi([row('a'.repeat(64), { current: true }), row('b'.repeat(64), { label: 'ci\x1b[2J', lastUsedAt: null })]));
  assert.equal(r.code, 0);
  assert.equal(r.out, [`${'a'.repeat(64)}  laptop  created 2026-11-01 10:00  last used 2026-11-03 12:30  (this device)`,
    `${'b'.repeat(64)}  ci[2J  created 2026-11-01 10:00  last used never`, ''].join('\n'));
});

test('tokens revoke: another token leaves the login; this device clears it; a prefix works', async () => {
  const home = setup();
  const cloud = tokenApi([row('a'.repeat(64), { current: true }), row('b'.repeat(64))]);
  let r = await run(home, cloud, { revoke: true, id: 'bbbbbb' });
  assert.equal(r.code, 0);
  assert.deepEqual(cloud.calls, [`DELETE ${'b'.repeat(64)}`]);
  assert.equal(readCredentials({ home, env: {} }).token, 'spk_t');
  r = await run(home, cloud, { revoke: true, id: 'a'.repeat(64) });
  assert.match(r.out, /logged out/);
  assert.equal(readCredentials({ home, env: {} }).token, null);
});

test('tokens revoke --all clears local credentials; unknown id, short prefix and logged out are refused', async () => {
  const home = setup();
  const cloud = tokenApi([row('a'.repeat(64), { current: true })]);
  assert.equal((await run(home, cloud, { revoke: true, id: 'zzzzzz' })).out.trim(), 'No token with that id.');
  assert.equal((await run(home, cloud, { revoke: true, id: 'aaa' })).code, 1, 'a prefix under 6 characters never matches');
  assert.equal((await run(home, cloud, { revoke: true })).code, 2);
  const r = await run(home, cloud, { revoke: true, all: true });
  assert.equal(r.code, 0);
  assert.deepEqual(cloud.calls, ['DELETE all']);
  assert.equal(readCredentials({ home, env: {} }).token, null);
  assert.equal((await run(home, cloud)).out.trim(), 'Not logged in. Run spookling login.');
});

test('main routes tokens and the help lists it', async () => {
  const got = [];
  const out = [];
  const w = process.stdout.write, e = process.stderr.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = () => true;
  const deps = { home: homeOf(), cwd: homeOf(), exit: () => {}, tokens: async (o) => { got.push(o); return 0; } };
  try {
    await main(['node', 's', 'tokens'], deps);
    await main(['node', 's', 'tokens', 'revoke', 'abcdef12'], deps);
    await main(['node', 's', 'tokens', 'revoke', '--all'], deps);
    assert.equal(await main(['node', 's', 'tokens', 'nope'], deps), 2);
    await main(['node', 's', 'help'], deps);
  } finally { process.stdout.write = w; process.stderr.write = e; }
  assert.deepEqual(got.map((o) => [o.revoke, o.id, o.all]), [[false, '', false], [true, 'abcdef12', false], [true, '', true]]);
  assert.match(out.join(''), /spookling tokens revoke <id>/);
  assert.match(out.join(''), /spookling tokens revoke --all/);
});

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
