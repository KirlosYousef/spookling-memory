import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './helpers.mjs';
import { projectLog, readForks, teamMemoryHook } from '../src/push.js';
import { writeCredentials } from '../src/credentials.js';

const tmp = () => tmpHome('spk-fk-');
const ts = (i) => `2026-11-04T10:${String(i).padStart(2, '0')}:00Z`;

// the parent's four turns are copied into the fork's log first, then three of its own
const COPIED = ['parent question', 'parent answer', 'second parent question', 'second parent answer'];
const OWN = ['A brand new side question', 'The side answer', 'a follow-up'];
const ev = (sid, i, role, text) => JSON.stringify({ session_id: sid, role, text, ts: ts(i), agent: 'claude' });
const forkLog = (own = OWN) => [...COPIED, ...own].map((t, i) => ev('fork1', i, i % 2 === 0 ? 'user' : 'assistant', t)).join('\n') + '\n';
const FORKS = { fork1: { parent: 'parent1', relation: 'side_chat', branchedAtTurn: 3, copied: 4 } };

test('a fork uploads only its own turns, from seq 0, with the parent fields and a title from what it adds', () => {
  const [s] = projectLog(forkLog(), { forks: FORKS });
  assert.deepEqual(s.turns.map((t) => [t.seq, t.text]), OWN.map((t, i) => [i, t]));
  assert.equal(s.session.title, 'A brand new side question', 'not the copied first message');
  assert.equal(s.session.parentSessionId, 'parent1');
  assert.equal(s.session.branchedAtTurn, 3);
  assert.equal(s.session.relation, 'side_chat');
  assert.equal(s.session.startedAt, ts(4));
  assert.equal(s.mode, 'own');
});

test('a fork with nothing of its own yet sends nothing', () => {
  assert.deepEqual(projectLog(forkLog([]), { forks: FORKS }), []);
});

test('a session already uploaded with the copy keeps its numbering and is only linked, titled by its own turns', () => {
  const [s] = projectLog(forkLog(), { forks: FORKS, modeOf: () => 'full' });
  assert.equal(s.turns.length, 7);
  assert.equal(s.turns[6].seq, 6);
  assert.equal(s.session.title, 'A brand new side question');
  assert.equal(s.session.parentSessionId, 'parent1');
});

test('a transcript that is not a fork projects exactly as before', () => {
  const log = COPIED.map((t, i) => ev('plain1', i, i % 2 === 0 ? 'user' : 'assistant', t)).join('\n') + '\n';
  const [a] = projectLog(log);
  const [b] = projectLog(log, { forks: FORKS, modeOf: () => 'own' });
  assert.deepEqual(a, b);
  assert.equal(a.turns.length, 4);
  assert.equal(a.session.title, 'parent question');
  for (const k of ['parentSessionId', 'branchedAtTurn', 'relation']) assert.equal(k in a.session, false);
  assert.equal('mode' in a, false);
});

test('forks.json is read defensively', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'forks.json'), JSON.stringify({
    ok: { parent: 'p', relation: 'continued', branched_at: 2, copied: 3 },
    odd: { parent: 'p', relation: 'weird', branched_at: 0, copied: 0 },
    self: { parent: 'self', relation: 'side_chat', branched_at: 0, copied: 1 },
    bad: { parent: 'p', relation: 'side_chat', branched_at: -1, copied: 1 },
    junk: 5,
  }));
  assert.deepEqual(readForks(dir), {
    ok: { parent: 'p', relation: 'continued', branchedAtTurn: 2, copied: 3 },
    odd: { parent: 'p', relation: 'side_chat', branchedAtTurn: 0, copied: 0 },
  });
  assert.deepEqual(readForks(tmp()), {});
});

function fakeApi({ puts = [], posts = [] } = {}) {
  return {
    puts, posts,
    upsertSession: async ({ sid, session }) => { puts.push({ sid, session }); return {}; },
    postTurns: async ({ sid, turns }) => { posts.push({ sid, seqs: turns.map((t) => t.seq), texts: turns.map((t) => t.text) }); return { lastSeq: turns.at(-1).seq }; },
    listAutoShare: async () => ({ rules: [] }),
  };
}
const logged = () => {
  const home = tmp(), mem = join(home, 'proj', '.memory');
  mkdirSync(mem, { recursive: true });
  writeCredentials({ token: 'spk_t', apiUrl: 'https://api.t.test' }, { home });
  const logPath = join(mem, 'log.jsonl');
  writeFileSync(logPath, forkLog());
  writeFileSync(join(mem, 'forks.json'), JSON.stringify({ fork1: { parent: 'parent1', relation: 'side_chat', branched_at: 3, copied: 4 } }));
  return { home, mem, logPath };
};

test('upload: the PUT carries the parent, only post-branch turns are posted, and later turns continue the fork\'s own numbering', async () => {
  const { home, logPath } = logged();
  const api = fakeApi();
  await teamMemoryHook({ logPath, home, env: {}, cloud: api, log: () => {} });
  assert.deepEqual(api.puts.map((p) => [p.sid, p.session.parentSessionId, p.session.branchedAtTurn, p.session.relation, p.session.title]),
    [['fork1', 'parent1', 3, 'side_chat', 'A brand new side question']]);
  assert.deepEqual(api.posts, [{ sid: 'fork1', seqs: [0, 1, 2], texts: OWN }]);
  const state = JSON.parse(readFileSync(join(home, '.spookling', 'upload-state.json'), 'utf8'));
  assert.equal(state.forkModes.fork1, 'own');
  assert.equal(state.cursors.fork1, 2);
  // two more turns arrive
  writeFileSync(logPath, forkLog([...OWN, 'more', 'and more']));
  const again = fakeApi();
  await teamMemoryHook({ logPath, home, env: {}, cloud: again, log: () => {} });
  assert.deepEqual(again.posts, [{ sid: 'fork1', seqs: [3, 4], texts: ['more', 'and more'] }]);
  assert.equal(again.puts[0].session.parentSessionId, 'parent1', 'every PUT repeats the link');
});

test('an existing duplicate is linked on its next upload and keeps appending in its old numbering', async () => {
  const { home, logPath } = logged();
  // before this feature: all 7 turns were uploaded, cursor 6
  mkdirSync(join(home, '.spookling'), { recursive: true });
  writeFileSync(join(home, '.spookling', 'upload-state.json'), JSON.stringify({ cursors: { fork1: 6 }, skipped: {}, queue: [], shares: [] }));
  const linkOnly = fakeApi();
  await teamMemoryHook({ logPath, home, env: {}, cloud: linkOnly, log: () => {} });
  assert.equal(linkOnly.puts.length, 1, 'one PUT, no new turns');
  assert.deepEqual([linkOnly.puts[0].session.parentSessionId, linkOnly.puts[0].session.branchedAtTurn], ['parent1', 3]);
  assert.deepEqual(linkOnly.posts, []);
  const none = fakeApi();
  await teamMemoryHook({ logPath, home, env: {}, cloud: none, log: () => {} });
  assert.deepEqual([none.puts.length, none.posts.length], [0, 0], 'linked once; nothing to repeat');
  writeFileSync(logPath, forkLog([...OWN, 'one more']));
  const more = fakeApi();
  await teamMemoryHook({ logPath, home, env: {}, cloud: more, log: () => {} });
  assert.deepEqual(more.posts, [{ sid: 'fork1', seqs: [7], texts: ['one more'] }], 'the old numbering continues: the duplicate turns stay where they are');
  const state = JSON.parse(readFileSync(join(home, '.spookling', 'upload-state.json'), 'utf8'));
  assert.equal(state.forkModes.fork1, 'full');
});
