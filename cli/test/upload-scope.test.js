import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CloudError } from '../src/cloud.js';
import { writeCredentials } from '../src/credentials.js';
import { pendingUploads, teamMemoryHook, uploadedCursors } from '../src/push.js';
import { accountScope, legacyState, readState, statePath } from '../src/upload-state.js';
import { tmpHome } from './helpers.mjs';

const logOf = (...ids) => ids.flatMap((id) => [0, 1, 2, 3].map((i) => JSON.stringify({
  session_id: id, role: i % 2 ? 'assistant' : 'user', ts: `2026-11-03T09:00:0${i}Z`, text: `${id} turn ${i}`,
}))).join('\n') + '\n';
const as = (home, { origin = 'https://api.one.test', id = 'user-1', token = 'spk_one' } = {}) => writeCredentials({ token, user: { id, name: 'Ada' }, apiUrl: origin }, { home });

// a server that keeps what it was sent and answers like the real one: a hole is 400 seq_gap, a replay is a no-op
function server(held = {}) {
  const sent = [];
  return {
    held, sent,
    upsertSession: async () => ({}),
    postTurns: async ({ sid, turns }) => {
      const have = held[sid] ?? 0;
      if (turns[0].seq > have) throw new CloudError('BAD_REQUEST', { status: 400, code: 'BAD_REQUEST', reason: 'seq_gap' });
      for (const t of turns) if (t.seq >= have) { sent.push(`${sid}:${t.seq}`); held[sid] = t.seq + 1; }
      return { lastSeq: held[sid] - 1 };
    },
    getSession: async ({ sid }) => {
      const clientId = sid.split(':')[1];
      if (!(clientId in held)) throw new CloudError('NOT_FOUND', { status: 404, code: 'NOT_FOUND' });
      return { session: { id: sid, turnCount: held[clientId] }, turns: [], nextAfter: null };
    },
    listAutoShare: async () => ({ rules: [] }),
  };
}
const push = (home, cloud, text, extra = {}) => teamMemoryHook({ logText: text, home, env: {}, cloud, log: () => {}, ...extra });

test('switching the server: each origin keeps its own cursors, and the new one starts from nothing', async () => {
  const home = tmpHome('spk-scope-');
  as(home, { origin: 'https://local.one.test' });
  const local = server();
  await push(home, local, logOf('s1'));
  assert.deepEqual(uploadedCursors(home), { s1: 3 });
  as(home, { origin: 'https://dev.two.test' }); // same user, another server
  assert.deepEqual(uploadedCursors(home), {}, 'the other server\'s cursors do not apply');
  const dev = server();
  await push(home, dev, logOf('s1'));
  assert.deepEqual(dev.sent, ['s1:0', 's1:1', 's1:2', 's1:3'], 'sent from the start, not from seq 4');
  as(home, { origin: 'https://local.one.test' }); // and back
  assert.deepEqual(uploadedCursors(home), { s1: 3 }, 'the first server\'s position was kept');
  const again = server({ s1: 4 });
  await push(home, again, logOf('s1'));
  assert.deepEqual(again.sent, [], 'nothing is sent twice');
});

test('switching the account on one server does not carry the other account\'s cursors, skips, queue or shares', async () => {
  const home = tmpHome('spk-scope-');
  as(home, { id: 'user-1', token: 'spk_one' });
  const down = server();
  down.upsertSession = async () => { throw new CloudError('network error', { code: 'ECONNREFUSED' }); };
  await push(home, server(), logOf('s1'));
  await push(home, down, logOf('q1')); // queued for user 1
  assert.equal(pendingUploads(home).sessions, 1);
  as(home, { id: 'user-2', token: 'spk_two' });
  assert.equal(pendingUploads(home).sessions, 0, 'user 1\'s queue is not user 2\'s');
  assert.deepEqual(uploadedCursors(home), {});
  const two = server();
  await push(home, two, logOf('s1'));
  assert.equal(two.sent.length, 4, 'user 2 uploads s1 in full');
  as(home, { id: 'user-1', token: 'spk_one' });
  assert.equal(pendingUploads(home).sessions, 1, 'user 1 gets their queue back');
  assert.deepEqual(uploadedCursors(home), { s1: 3 });
  assert.notEqual(accountScope(home), `${'https://api.one.test'}|user-2`);
});

test('an old flat state is kept aside and the current account starts fresh', async () => {
  const home = tmpHome('spk-scope-');
  as(home);
  mkdirSync(join(home, '.spookling'), { recursive: true });
  writeFileSync(statePath(home), JSON.stringify({ cursors: { s1: 88 }, skipped: {}, queue: [{ sid: 'x', session: {}, turns: [{ seq: 88 }] }], shares: [] }));
  assert.deepEqual(uploadedCursors(home), {}, 'unscoped cursors are not trusted');
  assert.equal(pendingUploads(home).sessions, 0);
  const cloud = server();
  await push(home, cloud, logOf('s1'));
  assert.deepEqual(cloud.sent, ['s1:0', 's1:1', 's1:2', 's1:3']);
  const file = JSON.parse(readFileSync(statePath(home), 'utf8'));
  assert.equal(file.scopeKey, accountScope(home));
  assert.deepEqual(file.legacy.cursors, { s1: 88 }, 'the old state is still there');
  assert.equal(legacyState(home).queue.length, 1);
  assert.deepEqual(readState(home).cursors, { s1: 3 });
});

test('seq_gap: the server holds none, the saved cursor says 88; ask the server, resend from 0, every turn once', async () => {
  const home = tmpHome('spk-scope-');
  as(home);
  const cloud = server(); // knows nothing
  mkdirSync(join(home, '.spookling'), { recursive: true });
  writeFileSync(statePath(home), JSON.stringify({ scopeKey: accountScope(home), cursors: { s1: 2 }, skipped: {}, queue: [], shares: [] }));
  const notes = [];
  const r = await push(home, cloud, logOf('s1'), { log: (m) => notes.push(m) });
  assert.equal(r.ok, true);
  assert.deepEqual(cloud.sent, ['s1:0', 's1:1', 's1:2', 's1:3'], 'from 0, each once');
  assert.deepEqual(readState(home).cursors, { s1: 3 });
  assert.match(notes.join('\n'), /the server holds 0 turns/);
  assert.equal(notes.join('\n').includes('s1 turn'), false, 'no turn text in the log');
});

test('seq_gap: the server holds some turns; only the ones it lacks are sent', async () => {
  const home = tmpHome('spk-scope-');
  as(home);
  const cloud = server({ s1: 2 }); // seq 0, 1 held
  mkdirSync(join(home, '.spookling'), { recursive: true });
  // the saved cursor says 0..2 were sent (it came from a server that held 3 turns); this server holds only 0 and 1
  writeFileSync(statePath(home), JSON.stringify({ scopeKey: accountScope(home), cursors: { s1: 2 }, skipped: {}, queue: [], shares: [] }));
  await push(home, cloud, logOf('s1'));
  assert.deepEqual(cloud.sent, ['s1:2', 's1:3'], 'seq 0 and 1 were not resent');
  assert.deepEqual(readState(home).cursors, { s1: 3 });
});

test('seq_gap heals once per upload: a server that keeps refusing does not loop', async () => {
  const home = tmpHome('spk-scope-');
  as(home);
  const cloud = server();
  let posts = 0;
  cloud.postTurns = async () => { posts += 1; throw new CloudError('BAD_REQUEST', { status: 400, code: 'BAD_REQUEST', reason: 'seq_gap' }); };
  const notes = [];
  const r = await push(home, cloud, logOf('s1'), { log: (m) => notes.push(m) });
  assert.equal(posts, 2, 'the first try and one retry');
  assert.equal(r.ok, false);
  assert.match(notes.join('\n'), /upload queued: 400 BAD_REQUEST seq_gap/, 'the reason is logged');
});

test('seq_conflict still skips after a repeat', async () => {
  const home = tmpHome('spk-scope-');
  as(home);
  const cloud = server();
  cloud.postTurns = async () => { throw new CloudError('CONFLICT', { status: 409, code: 'CONFLICT', reason: 'seq_conflict' }); };
  const notes = [];
  await push(home, cloud, logOf('s1'), { log: (m) => notes.push(m) });
  await push(home, cloud, logOf('s1'), { log: (m) => notes.push(m) });
  assert.match(notes.join('\n'), /seq_conflict; retrying on the next Stop/);
  assert.match(notes.join('\n'), /skipped: seq_conflict/);
  assert.equal(readState(home).skipped.s1.seen, 2);
});

test('the log gets the reason of an error, never the token', async () => {
  const home = tmpHome('spk-scope-');
  as(home, { token: 'spk_super_secret_token_value' });
  const cloud = server();
  cloud.upsertSession = async () => { throw new CloudError('BAD_REQUEST', { status: 400, code: 'BAD_REQUEST', reason: 'weird_reason' }); };
  const notes = [];
  await push(home, cloud, logOf('s1'), { log: (m) => notes.push(m) });
  assert.deepEqual(notes, ['upload queued: 400 BAD_REQUEST weird_reason']);
});
