import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpHome } from './helpers.mjs';
import { writeCredentials } from '../src/credentials.js';
import { pickOrg, setProjectAutoShare, setSessionShare, shareStatus } from '../src/share.js';
import { formatShare } from '../src/main.js';

const home = () => {
  const h = tmpHome('spk-share-');
  writeCredentials({ token: 'spk_t', user: { id: 'u1' }, apiUrl: 'http://x' }, { home: h });
  return h;
};

function fakeCloud({ sessions = [], orgs = [{ org: { id: 'o1', name: 'Org test' }, membership: { status: 'active' } }], rules = [] } = {}) {
  const calls = [];
  return {
    calls,
    listOrgs: async () => ({ orgs }),
    listSessions: async ({ project }) => ({ sessions: sessions.filter((s) => !project || s.project === project), nextCursor: null }),
    listAutoShare: async () => ({ rules }),
    shareSession: async (a) => { calls.push(['share', a.sid, a.orgId]); sessions.find((s) => s.clientId === a.sid).sharedWith = [a.orgId]; },
    unshareSession: async (a) => { calls.push(['unshare', a.sid, a.orgId]); sessions.find((s) => s.clientId === a.sid).sharedWith = []; },
    setAutoShare: async (a) => { calls.push(['auto-on', a.project, a.orgId, a.backfill]); },
    clearAutoShare: async (a) => { calls.push(['auto-off', a.project, a.orgId]); },
  };
}

const sess = (id, project, sharedWith = []) => ({ clientId: id, title: id, project, turnCount: 2, agent: 'claude-code', sharedWith });

test('status says private or shared for one session and names the org', async () => {
  const cloud = fakeCloud({ sessions: [sess('a', 'p'), sess('b', 'p', ['o1'])] });
  const h = home();
  assert.equal((await shareStatus({ sessionId: 'a', home: h, cloud })).visibility, 'private');
  const b = await shareStatus({ sessionId: 'b', home: h, cloud });
  assert.equal(b.visibility, 'shared');
  assert.deepEqual(b.sharedWith, [{ id: 'o1', name: 'Org test' }]);
  assert.equal((await shareStatus({ sessionId: 'zzz', home: h, cloud })).visibility, 'not uploaded');
});

test('status without a session lists the account, filtered by project', async () => {
  const cloud = fakeCloud({ sessions: [sess('a', 'p'), sess('c', 'q')], rules: [{ project: 'p', orgId: 'o1' }] });
  const out = await shareStatus({ project: 'p', home: home(), cloud });
  assert.deepEqual(out.sessions.map((s) => s.sessionId), ['a']);
  assert.deepEqual(out.autoShare, [{ project: 'p', orgId: 'o1', org: 'Org test' }]);
});

test('share defaults to the only org, then unshare with no org removes every share', async () => {
  const cloud = fakeCloud({ sessions: [sess('a', 'p')] });
  const h = home();
  const on = await setSessionShare({ sessionId: 'a', share: true, home: h, cloud });
  assert.equal(on.ok, true);
  assert.equal(on.visibility, 'shared');
  const off = await setSessionShare({ sessionId: 'a', share: false, home: h, cloud });
  assert.equal(off.visibility, 'private');
  assert.deepEqual(cloud.calls, [['share', 'a', 'o1'], ['unshare', 'a', 'o1']]);
});

test('several orgs need a name; an unknown name is refused without a write', async () => {
  const orgs = [{ org: { id: 'o1', name: 'One' } }, { org: { id: 'o2', name: 'Two' } }];
  const cloud = fakeCloud({ sessions: [sess('a', 'p')], orgs });
  const h = home();
  assert.match((await setSessionShare({ sessionId: 'a', share: true, home: h, cloud })).error, /Which org\?/);
  assert.match((await setSessionShare({ sessionId: 'a', share: true, org: 'nope', home: h, cloud })).error, /No org matches/);
  assert.equal((await setSessionShare({ sessionId: 'a', share: true, org: 'two', home: h, cloud })).ok, true);
  assert.deepEqual(cloud.calls, [['share', 'a', 'o2']]);
});

test('an inactive membership is not an org the user can share to', async () => {
  const orgs = [{ org: { id: 'o1', name: 'One' }, membership: { status: 'removed' } }];
  const cloud = fakeCloud({ sessions: [sess('a', 'p')], orgs });
  assert.match((await setSessionShare({ sessionId: 'a', share: true, home: home(), cloud })).error, /not an active member/);
  assert.deepEqual(cloud.calls, []);
});

test('project auto-share on with backfill, and off with no org removes the existing rule', async () => {
  const cloud = fakeCloud({ rules: [{ project: 'p', orgId: 'o1' }] });
  const h = home();
  assert.equal((await setProjectAutoShare({ project: 'p', enabled: true, backfill: true, home: h, cloud })).ok, true);
  assert.equal((await setProjectAutoShare({ project: 'p', enabled: false, home: h, cloud })).ok, true);
  assert.equal((await setProjectAutoShare({ project: 'nope', enabled: false, home: h, cloud })).message, 'No auto-share rule for nope.');
  assert.deepEqual(cloud.calls, [['auto-on', 'p', 'o1', true], ['auto-off', 'p', 'o1']]);
});

test('logged out: a plain message, no network', async () => {
  const h = tmpHome('spk-out-');
  assert.match((await shareStatus({ home: h, env: {} })).error, /Not logged in/);
  assert.match((await setSessionShare({ sessionId: 'a', share: true, home: h, env: {} })).error, /Not logged in/);
});

test('pickOrg and formatShare read plainly', () => {
  assert.equal(pickOrg([{ id: 'o', name: 'N' }], '').org.id, 'o');
  assert.equal(formatShare({ sessions: [{ sessionId: 'a', visibility: 'private', sharedWith: [], project: 'p', title: 't' }], autoShare: [] }).includes('private'), true);
  assert.match(formatShare({ error: 'x' }), /^x$/);
});
