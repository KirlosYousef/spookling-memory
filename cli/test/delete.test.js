import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './helpers.mjs';
import { writeCredentials } from '../src/credentials.js';
import { CloudError, createCloud } from '../src/cloud.js';
import { deleteAllSessions, deleteSession, formatDelete } from '../src/delete.js';
import { classifyError, deletedSessionIds, pushFromLog, uploadProblems } from '../src/push.js';
import { accountScope, readState, updateState } from '../src/upload-state.js';
import { login } from '../src/account.js';
import { main } from '../src/main.js';

const home = () => {
  const h = tmpHome('spk-del-');
  writeCredentials({ token: 'spk_t', user: { id: 'u1' }, apiUrl: 'http://x.test' }, { home: h });
  return h;
};
const seed = (h, fn) => updateState(h, fn, { scope: accountScope(h) });
const err = (status, reason) => new CloudError('x', { status, code: 'E', reason });

test('cloud: deleteSession and deleteAllSessions use DELETE on the right paths; 204 is null', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push([opts.method, new URL(url).pathname]);
    return url.endsWith('/s%2F1') ? { status: 204, ok: true } : { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ success: true, data: { deleted: 2, skipped: [], remaining: 0 } }) };
  };
  const cloud = createCloud({ env: { SPOOKLING_API_URL: 'http://127.0.0.1:1' }, fetchImpl, token: 'spk_t', home: tmpHome() });
  assert.equal(await cloud.deleteSession({ sid: 's/1' }), null);
  assert.deepEqual(await cloud.deleteAllSessions(), { deleted: 2, skipped: [], remaining: 0 });
  assert.deepEqual(seen, [['DELETE', '/memory/sessions/s%2F1'], ['DELETE', '/memory/sessions']]);
});

test('cloud: 403 org_owned and 410 carry their reason', async () => {
  const fetchImpl = async () => ({ status: 410, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ success: false, error: { code: 'GONE', details: { reason: 'session_deleted' } } }) });
  const cloud = createCloud({ env: { SPOOKLING_API_URL: 'http://127.0.0.1:1' }, fetchImpl, token: 'spk_t', home: tmpHome() });
  await assert.rejects(cloud.postTurns({ sid: 'a', turns: [] }), (e) => e.status === 410 && e.reason === 'session_deleted');
});

test('delete one: calls the API, marks it skipped for good, drops cursor and queue', async () => {
  const h = home();
  await seed(h, (st) => { st.cursors.a = 3; st.cursors.b = 1; st.queue.push({ sid: 'a', session: {}, turns: [] }); });
  const calls = [];
  const out = await deleteSession({ sessionId: 'a', home: h, cloud: { deleteSession: async (a) => { calls.push(a.sid); return null; } } });
  assert.equal(out.ok, true);
  assert.deepEqual(calls, ['a']);
  const st = readState(h, accountScope(h));
  assert.deepEqual(st.skipped.a, { reason: 'session_deleted', permanent: true });
  assert.equal(st.cursors.a, undefined);
  assert.equal(st.cursors.b, 1);
  assert.equal(st.queue.length, 0);
  assert.deepEqual([...deletedSessionIds(h)], ['a']);
  assert.deepEqual(uploadProblems(h).skipped, []); // not shown as a problem in status
  assert.match(formatDelete(out), /Deleted session a.*Local memory .* untouched/);
});

test('delete one: 404 counts as done; 403 org_owned is an error and marks nothing', async () => {
  const h = home();
  const gone = await deleteSession({ sessionId: 'a', home: h, cloud: { deleteSession: async () => { throw err(404); } } });
  assert.equal(gone.ok, true);
  assert.equal(gone.alreadyGone, true);
  assert.match(formatDelete(gone), /already gone/);
  const owned = await deleteSession({ sessionId: 'b', home: h, cloud: { deleteSession: async () => { throw err(403, 'org_owned'); } } });
  assert.match(owned.error, /belongs to it/);
  assert.equal(readState(h, accountScope(h)).skipped.b, undefined);
});

test('delete all: loops while remaining, collects skipped, marks local sessions except org-owned', async () => {
  const h = home();
  await seed(h, (st) => { st.cursors.a = 1; st.cursors.b = 1; st.cursors.owned = 1; st.queue.push({ sid: 'q', session: {}, turns: [] }); });
  const batches = [
    { deleted: 100, skipped: [{ id: 'owned', reason: 'org_owned' }], remaining: 40 },
    { deleted: 40, skipped: [{ id: 'owned', reason: 'org_owned' }], remaining: 0 },
  ];
  let n = 0;
  const out = await deleteAllSessions({ home: h, cloud: { deleteAllSessions: async () => batches[n++] } });
  assert.equal(n, 2);
  assert.equal(out.deleted, 140);
  assert.deepEqual(out.skipped, [{ id: 'owned', reason: 'org_owned' }]);
  const st = readState(h, accountScope(h));
  assert.deepEqual(Object.keys(st.skipped).sort(), ['a', 'b', 'q']);
  assert.equal(st.cursors.owned, 1);
  assert.match(formatDelete(out), /Deleted 140 sessions.*Kept 1 shared with an org.*upload as usual.*untouched/s);
});

test('delete all: stops when a call deletes nothing, and when the cap is hit', async () => {
  const h = home();
  let n = 0;
  const stuck = await deleteAllSessions({ home: h, cloud: { deleteAllSessions: async () => { n += 1; return n === 1 ? { deleted: 5, skipped: [], remaining: 3 } : { deleted: 0, skipped: [{ id: 'o', reason: 'org_owned' }], remaining: 3 }; } } });
  assert.equal(n, 2);
  assert.equal(stuck.ok, true);
  assert.equal(stuck.remaining, 3);
  assert.equal(stuck.incomplete, false);
  const h2 = home();
  await seed(h2, (st) => { st.cursors.a = 1; });
  let m = 0;
  const capped = await deleteAllSessions({ home: h2, maxRounds: 3, cloud: { deleteAllSessions: async () => { m += 1; return { deleted: 1, skipped: [], remaining: 9 }; } } });
  assert.equal(m, 3);
  assert.equal(capped.incomplete, true);
  assert.equal(readState(h2, accountScope(h2)).skipped.a, undefined); // unfinished: nothing marked
  assert.match(formatDelete(capped), /Stopped early/);
});

test('delete all: an error mid-way reports what was deleted and marks nothing', async () => {
  const h = home();
  await seed(h, (st) => { st.cursors.a = 1; });
  let n = 0;
  const out = await deleteAllSessions({ home: h, cloud: { deleteAllSessions: async () => { if (n++) throw err(429); return { deleted: 10, skipped: [], remaining: 5 }; } } });
  assert.match(out.error, /Rate limited.*10 deleted/);
  assert.equal(readState(h, accountScope(h)).skipped.a, undefined);
});

test('classifyError: 410 is permanent session_deleted', () => {
  assert.deepEqual(classifyError(err(410, 'session_deleted')), { kind: 'permanent', reason: 'session_deleted' });
});

const logOf = (sid, n = 2) => Array.from({ length: n }, (_, i) => JSON.stringify({ session_id: sid, seq: i, role: i % 2 ? 'assistant' : 'user', text: `t${i}`, ts: '2026-01-01T00:00:00Z' })).join('\n');

function upCloud(onPut) {
  const puts = [];
  return { puts, upsertSession: async (a) => { puts.includes(a.sid) || puts.push(a.sid); return onPut ? onPut(a) : { lastSeq: 1 }; }, postTurns: async (a) => { puts.includes(a.sid) || puts.push(a.sid); return {}; } };
}

test('upload: a 410 marks the session deleted, drops the cursor, and it is never sent again; new sessions still upload', async () => {
  const h = home();
  const logText = `${logOf('old')}\n${logOf('new')}`;
  const cloud = upCloud((a) => { if (a.sid === 'old') throw err(410, 'session_deleted'); return { lastSeq: 1 }; });
  await pushFromLog({ logText, home: h, cloud, project: 'p', log: () => {} });
  assert.deepEqual(cloud.puts.sort(), ['new', 'old']);
  assert.equal(readState(h, accountScope(h)).skipped.old.reason, 'session_deleted');
  const again = upCloud();
  await pushFromLog({ logText: `${logText}\n${logOf('fresh')}`, home: h, cloud: again, project: 'p', log: () => {} });
  assert.deepEqual(again.puts, ['fresh']); // old stays skipped, new is done, fresh uploads
});

test('after delete --all, hooks do not resend old sessions but later sessions upload', async () => {
  const h = home();
  const first = upCloud();
  await pushFromLog({ logText: `${logOf('a')}\n${logOf('b')}`, home: h, cloud: first, project: 'p', log: () => {} });
  assert.equal(first.puts.length, 2);
  await deleteAllSessions({ home: h, cloud: { deleteAllSessions: async () => ({ deleted: 2, skipped: [], remaining: 0 }) } });
  const next = upCloud();
  // session a keeps growing locally (still open) and a brand new one starts
  await pushFromLog({ logText: `${logOf('a', 4)}\n${logOf('b')}\n${logOf('c')}`, home: h, cloud: next, project: 'p', log: () => {} });
  assert.deepEqual(next.puts, ['c']);
});

test('seq_gap heal does not resend a session that was deleted meanwhile', async () => {
  const h = home();
  await seed(h, (st) => { st.cursors.old = 0; });
  const puts = [];
  const cloud = {
    upsertSession: async (a) => { puts.push(a.sid); await seed(h, (st) => { st.skipped.old = { reason: 'session_deleted', permanent: true }; }); throw err(400, 'seq_gap'); },
    postTurns: async (a) => { puts.push(a.sid); await seed(h, (st) => { st.skipped.old = { reason: 'session_deleted', permanent: true }; }); throw err(400, 'seq_gap'); },
    getSession: async () => { throw err(404); },
    listSessions: async () => ({ sessions: [] }),
  };
  await pushFromLog({ logText: logOf('old', 4), home: h, cloud, project: 'p', log: () => {} });
  assert.equal(puts.length, 1); // no whole-session resend
});

test('login backfill does not offer deleted sessions', async () => {
  const h = tmpHome('spk-del-login-');
  writeCredentials({ token: 'spk_t', user: { id: 'u1' }, apiUrl: 'https://api.test' }, { home: h });
  const cwd = tmpHome('spk-proj-');
  mkdirSync(join(cwd, '.memory'));
  const turn = (sid, role) => JSON.stringify({ session_id: sid, role, ts: '2026-11-03T09:00:00Z', text: `hello ${sid}` });
  writeFileSync(join(cwd, '.memory', 'log.jsonl'), ['gone', 'keep'].flatMap((id) => [turn(id, 'user'), turn(id, 'assistant')]).join('\n') + '\n');
  await seed(h, (st) => { st.skipped.gone = { reason: 'session_deleted', permanent: true }; });
  const prompts = [], pushes = [];
  const cloud = {
    base: () => 'https://api.test', deviceStart: async () => ({ deviceCode: 'd', userCode: 'U', verificationUri: 'https://api.test/c', interval: 1, expiresIn: 600 }),
    pollToken: async () => ({ status: 'approved', token: 'spk_t', user: { id: 'u1' } }), listOrgs: async () => ({ orgs: [] }),
    upsertSession: async (a) => { pushes.push(a.sid); return {}; }, postTurns: async (a) => { pushes.push(a.sid); return { lastSeq: 1 }; },
  };
  let t = 0;
  await login({ home: h, env: {}, cwd, cloud, now: () => t, sleep: async (ms) => { t += ms; }, openUrl: () => true, write: () => {}, choose: async () => 0, confirm: async (q) => { prompts.push(q); return true; } });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Upload your 1 past session /);
  assert.ok(pushes.includes('keep') && !pushes.includes('gone'));
});

test('cli: --yes deletes without asking; non-TTY without --yes is a usage error (exit 2) and calls nothing', async () => {
  const calls = [], io = [], w = process.stdout.write;
  const deps = { home: '/h', cwd: '/c', ask: async () => { throw new Error('asked'); }, delete: { one: async (a) => { calls.push(['one', a.sessionId]); return { ok: true, action: 'deleted', sessionId: a.sessionId, deleted: 1 }; }, all: async () => { calls.push(['all']); return { ok: true, deleted: 2, remaining: 0, skipped: [] }; } } };
  process.stdout.write = (s) => { io.push(String(s)); return true; };
  try {
    assert.equal(await main(['n', 's', 'delete', 'abc', '--yes'], { ...deps, tty: false }), 0);
    assert.equal(await main(['n', 's', 'delete', '--all', '--yes'], { ...deps, tty: false }), 0);
    let code = null;
    assert.equal(await main(['n', 's', 'delete', 'abc'], { ...deps, tty: false, exit: (c) => { code = c; } }), 2);
    assert.equal(code, 2);
    assert.equal(await main(['n', 's', 'delete'], { ...deps, tty: false, exit: () => {} }), 2);
  } finally { process.stdout.write = w; }
  assert.deepEqual(calls, [['one', 'abc'], ['all']]);
  assert.match(io.join(''), /Deleted session abc from the cloud/);
});

test('cli: on a terminal y confirms one, anything else cancels; --all needs DELETE typed', async () => {
  const calls = [], w = process.stdout.write, out = [];
  const answers = [];
  const deps = { home: '/h', cwd: '/c', tty: true, ask: async () => answers.shift(), delete: { one: async (a) => { calls.push(a.sessionId); return { ok: true, action: 'deleted', sessionId: a.sessionId }; }, all: async () => { calls.push('all'); return { ok: true, deleted: 1, remaining: 0, skipped: [] }; } } };
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try {
    for (const [a, argv] of [['y', ['delete', 'x']], ['', ['delete', 'x']], ['n', ['delete', 'x']], ['delete', ['delete', '--all']], ['y', ['delete', '--all']], ['DELETE', ['delete', '--all']]]) {
      answers.push(a);
      assert.equal(await main(['n', 's', ...argv], deps), 0);
    }
  } finally { process.stdout.write = w; }
  assert.deepEqual(calls, ['x', 'all']);
  assert.equal(out.filter((s) => /Nothing deleted/.test(s)).length, 4);
  assert.match(out.join(''), /Local memory \(\.memory\/\) is not touched/);
});
