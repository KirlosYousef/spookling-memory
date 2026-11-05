import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './helpers.mjs';
import { CloudError, createCloud } from '../src/cloud.js';
import { readCredentials, writeCredentials } from '../src/credentials.js';
import { tokens } from '../src/account.js';
import { skippedSessionIds, teamMemoryHook, uploadProblems } from '../src/push.js';
import { readCache, refresh, teamSession, writeCache } from '../src/team.js';
import { main } from '../src/main.js';
import { status } from '../src/wizard.js';

const homeOf = () => tmpHome('spk-ct-');
const err = (status, reason, code = 'X') => new CloudError(code, { status, code, reason });
const logOf = (...ids) => ids.flatMap((id) => [
  { session_id: id, role: 'user', ts: '2026-11-03T09:00:00Z', text: `hello ${id}` },
  { session_id: id, role: 'assistant', ts: '2026-11-03T09:00:05Z', text: 'hi' },
].map((e) => JSON.stringify(e))).join('\n') + '\n';

function api({ puts = {}, posts = {} } = {}) {
  const calls = [];
  return {
    calls,
    sessions: [],
    upsertSession: async ({ sid, session }) => { calls.push(`PUT ${sid}`); api.last = session; if (puts[sid]) throw puts[sid]; return {}; },
    postTurns: async ({ sid, turns }) => { calls.push(`POST ${sid}`); if (posts[sid]) throw posts[sid]; return { lastSeq: turns.at(-1).seq }; },
    listAutoShare: async () => ({ rules: [] }),
  };
}
const setup = () => { const home = homeOf(); writeCredentials({ token: 'spk_t', user: { name: 'Ada' }, apiUrl: 'https://api.t.test' }, { home }); return home; };
const push = (home, cloud, ids, extra = {}) => teamMemoryHook({ logText: logOf(...ids), home, env: {}, cloud, log: () => {}, ...extra });

test('403 org_owned skips that session for good and the others still upload', async () => {
  const home = setup();
  const cloud = api({ puts: { a: err(403, 'org_owned', 'FORBIDDEN') } });
  const r = await push(home, cloud, ['a', 'b', 'c']);
  assert.deepEqual(cloud.calls, ['PUT a', 'PUT b', 'POST b', 'PUT c', 'POST c']);
  assert.equal(r.ok, true);
  assert.deepEqual(uploadProblems(home), { skipped: [{ sid: 'a', reason: 'org_owned' }], loginExpired: false });
  assert.deepEqual(skippedSessionIds(home), [], 'seq_conflict list is unchanged');
  cloud.calls.length = 0;
  await push(home, cloud, ['a', 'b', 'c', 'd']);
  assert.deepEqual(cloud.calls, ['PUT d', 'POST d'], 'a is not tried again, b and c are done');
});

test('400 turn_limit skips that session for good; the rest go on', async () => {
  const home = setup();
  const cloud = api({ posts: { a: err(400, 'turn_limit', 'BAD_REQUEST') } });
  await push(home, cloud, ['a', 'b']);
  assert.deepEqual(cloud.calls, ['PUT a', 'POST a', 'PUT b', 'POST b']);
  assert.deepEqual(uploadProblems(home).skipped, [{ sid: 'a', reason: 'turn_limit' }]);
});

test('400 session_limit skips it, creates no more new sessions this push, but still appends to existing ones', async () => {
  const home = setup();
  const first = api();
  await push(home, first, ['old']); // old is on the server now
  const cloud = api({ puts: { n1: err(400, 'session_limit', 'BAD_REQUEST') } });
  const text = logOf('n1', 'n2', 'old') + JSON.stringify({ session_id: 'old', role: 'user', ts: '2026-11-03T10:00:00Z', text: 'more' }) + '\n';
  const r = await teamMemoryHook({ logText: text, home, env: {}, cloud, log: () => {} });
  assert.deepEqual(cloud.calls, ['PUT n1', 'PUT old', 'POST old'], 'n2 was not created');
  assert.deepEqual(uploadProblems(home).skipped, [{ sid: 'n1', reason: 'session_limit' }]);
  assert.equal(r.ok, true);
});

test('401 stops the push, keeps the login, and is remembered until an upload works', async () => {
  const home = setup();
  const cloud = api({ puts: { a: err(401, null, 'UNAUTHORIZED') } });
  const r = await push(home, cloud, ['a', 'b']);
  assert.deepEqual(cloud.calls, ['PUT a'], 'b was not tried');
  assert.equal(r.ok, false);
  assert.equal(r.queued, true);
  assert.equal(uploadProblems(home).loginExpired, true);
  assert.equal(readCredentials({ home, env: {} }).token, 'spk_t', 'not logged out automatically');
  const text = await statusText(home);
  assert.match(text, /login\s+expired, run spookling login/);
  const fixed = api();
  await push(home, fixed, ['a', 'b']);
  assert.equal(uploadProblems(home).loginExpired, false);
});

async function statusText(home) {
  const said = [], write = process.stdout.write;
  process.stdout.write = (s) => { said.push(String(s)); return true; };
  try { await status(home, async () => null, home); } finally { process.stdout.write = write; }
  return said.join('').replace(/\x1b\[[0-9;]*m/g, '');
}

test('status names sessions skipped for good', async () => {
  const home = setup();
  await push(home, api({ puts: { gone: err(403, 'org_owned', 'FORBIDDEN') } }), ['gone']);
  assert.match(await statusText(home), /upload\s+gone skipped for good: shared with an org you left/);
});

test('project is cut to 100 characters and title to 120 before upload', async () => {
  const home = setup();
  const cloud = api();
  await teamMemoryHook({ logText: logOf('a').replace('hello a', 'x'.repeat(500)), home, env: {}, cloud, project: 'p'.repeat(300), log: () => {} });
  assert.equal(api.last.project.length, 100);
  assert.ok(api.last.title.length <= 120);
});

test('details.reason survives in a CloudError', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'x', details: { reason: 'org_owned' } } }), { status: 403 });
  const cloud = createCloud({ env: { SPOOKLING_API_URL: 'https://api.t.test' }, home: homeOf(), token: 'spk_x', fetchImpl });
  await assert.rejects(cloud.upsertSession({ sid: 's', session: {} }), (e) => e.status === 403 && e.reason === 'org_owned');
});

const sess = (id, extra = {}) => ({ id, clientId: id.split(':')[1], owner: { id: 'u2', name: 'Ada' }, title: id, project: 'p', lastTurnAt: '2026-11-03T09:00:00Z', turnCount: 1, sharedWith: ['o1'], ...extra });

async function refreshWith(truncated) {
  const home = homeOf();
  writeCredentials({ token: 't', user: { name: 'Ada' }, apiUrl: 'https://api.t.test' }, { home });
  writeCache({
    orgs: { o1: { name: 'Acme', serverTime: '2026-11-02T00:00:00Z', sharedIds: ['u2:keep', 'u2:old'], ownSharedIds: [] } },
    sessions: {
      k: { orgId: 'o1', orgName: 'Acme', session: sess('u2:keep'), turns: [{ seq: 0, role: 'user', text: 'k', ts: 't' }] },
      o: { orgId: 'o1', orgName: 'Acme', session: sess('u2:old'), turns: [{ seq: 0, role: 'user', text: 'o', ts: 't' }] },
    },
  }, home);
  const cloud = {
    listOrgs: async () => ({ orgs: [{ org: { id: 'o1', name: 'Acme' }, membership: { status: 'active' } }] }),
    feed: async () => ({ sessions: [], sharedIds: ['u2:keep'], sharedIdsTruncated: truncated, serverTime: '2026-11-03T00:00:00Z', nextCursor: null }),
    getSession: async ({ sid }) => ({ session: sess(sid), turns: [{ seq: 0, role: 'user', text: 'x', ts: 't' }], nextAfter: null }),
  };
  await refresh({ home, env: {}, cloud, write: () => {} });
  return Object.values(readCache(home).sessions).map((e) => e.session.id).sort();
}

test('refresh purges unshared sessions, but not when the feed says sharedIds was truncated', async () => {
  assert.deepEqual(await refreshWith(false), ['u2:keep']);
  assert.deepEqual(await refreshWith(true), ['u2:keep', 'u2:old']);
});

test('team_session reads pages of at most 100 and follows nextAfter', async () => {
  const home = homeOf();
  writeCredentials({ token: 't', user: { name: 'Ada' }, apiUrl: 'https://api.t.test' }, { home });
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(new URL(url));
    const after = Number(new URL(url).searchParams.get('after') ?? -1);
    const turns = after < 0 ? [{ seq: 0, role: 'user', text: 'first page', ts: 't' }] : [{ seq: 100, role: 'user', text: 'second page', ts: 't' }];
    return new Response(JSON.stringify({ success: true, data: { session: sess('u2:big'), turns, nextAfter: after < 0 ? 99 : null } }), { status: 200 });
  };
  const cloud = createCloud({ env: {}, home, fetchImpl });
  const cache = { orgs: { o1: { name: 'Acme', serverTime: null, sharedIds: [], ownSharedIds: [] } }, sessions: { x: { orgId: 'o1', orgName: 'Acme', session: sess('u2:big'), turns: null } }, apiBase: null };
  const text = await teamSession({ sessionId: 'u2:big', home, env: {}, cache, cloud, writeBack: false, refreshFirst: false });
  assert.match(text, /first page/);
  assert.match(text, /second page/);
  assert.deepEqual(urls.map((u) => [u.searchParams.get('limit'), u.searchParams.get('after')]), [['100', null], ['100', '99']]);
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
