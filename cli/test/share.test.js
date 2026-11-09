import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './helpers.mjs';
import { writeCredentials } from '../src/credentials.js';
import { pickOrg, setProjectAutoShare, setSessionShare, shareStatus, webUrl } from '../src/share.js';
import { formatShare, main } from '../src/main.js';
import { accountScope, readState } from '../src/upload-state.js';
import { flushQueued, pushFromLog } from '../src/push.js';

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

// ---- a session not on the server yet ----

// a cloud that really stores what is uploaded, so the on-demand upload is the real push path
function storingCloud({ failUpload = false, ...rest } = {}) {
  const sessions = [];
  const cloud = fakeCloud({ sessions, ...rest });
  cloud.upsertSession = async ({ sid, session }) => {
    if (failUpload) throw Object.assign(new Error('x'), { name: 'CloudError', status: 503 });
    if (!sessions.find((s) => s.clientId === sid)) sessions.push({ clientId: sid, title: session.title, project: session.project, turnCount: 0, sharedWith: [] });
  };
  cloud.postTurns = async ({ sid, turns }) => { sessions.find((s) => s.clientId === sid).turnCount += turns.length; return { lastSeq: turns[turns.length - 1].seq }; };
  return cloud;
}

function projectWithLog(h, sid, { turns = 2 } = {}) {
  const dir = join(h, 'proj');
  mkdirSync(join(dir, '.memory'), { recursive: true });
  const lines = [];
  for (let i = 0; i < turns; i += 1) lines.push(JSON.stringify({ session_id: sid, role: i % 2 ? 'assistant' : 'user', text: i % 2 ? 'ok' : 'Build the thing', ts: `2026-11-01T10:0${i}:00Z` }));
  writeFileSync(join(dir, '.memory', 'log.jsonl'), lines.length ? `${lines.join('\n')}\n` : '');
  return dir;
}

test('sharing a session that is not uploaded uploads it from the local log first, then shares', async () => {
  const h = home();
  const dir = projectWithLog(h, 'new1');
  const cloud = storingCloud();
  const out = await setSessionShare({ sessionId: 'new1', share: true, projectDir: dir, home: h, cloud });
  assert.equal(out.ok, true);
  assert.equal(out.pending, undefined);
  assert.equal(out.visibility, 'shared');
  assert.deepEqual(cloud.calls, [['share', 'new1', 'o1']]);
  assert.equal(readState(h, accountScope(h)).cursors.new1, 1); // the cursor moved: a later Stop does not resend
  assert.deepEqual(readState(h, accountScope(h)).shares, []);
});

test('with no turns logged yet the share is queued, and status says so', async () => {
  const h = home();
  const dir = projectWithLog(h, 'new1', { turns: 0 });
  const cloud = storingCloud();
  const out = await setSessionShare({ sessionId: 'new1', share: true, projectDir: dir, home: h, cloud, env: { SPOOKLING_SESSION_ID: 'new1' } });
  assert.deepEqual([out.ok, out.pending], [true, true]);
  assert.equal(out.message, "Will be shared with Org test after this session's next save.");
  assert.deepEqual(cloud.calls, []);
  assert.equal(readState(h, accountScope(h)).shares.length, 1);
  const st = await shareStatus({ sessionId: 'new1', home: h, cloud });
  assert.equal(st.visibility, 'share pending');
  assert.match(formatShare(out), /Will be shared with Org test/);
});

test('a failed upload queues the share; the next successful save applies it', async () => {
  const h = home();
  const dir = projectWithLog(h, 'new1');
  const down = storingCloud({ failUpload: true });
  const out = await setSessionShare({ sessionId: 'new1', share: true, projectDir: dir, home: h, cloud: down });
  assert.equal(out.pending, true);
  assert.deepEqual(down.calls, []);
  // later: the Stop hook's upload succeeds, and the queued share rides along
  const up = storingCloud();
  const r = await pushFromLog({ logPath: join(dir, '.memory', 'log.jsonl'), home: h, cloud: up, project: 'proj', sessionId: 'new1', log: () => {} });
  assert.equal(r.pushed, 1);
  assert.deepEqual(up.calls, [['share', 'new1', 'o1']]);
  assert.deepEqual(readState(h, accountScope(h)).shares, []);
});

test('a queued share is not applied before the session is on the server', async () => {
  const h = home();
  const dir = projectWithLog(h, 'new1', { turns: 0 });
  await setSessionShare({ sessionId: 'new1', share: true, projectDir: dir, home: h, cloud: storingCloud(), env: { SPOOKLING_SESSION_ID: 'new1' } });
  const up = storingCloud();
  await pushFromLog({ logText: '', home: h, cloud: up, log: () => {} });
  assert.deepEqual(up.calls, []);
  assert.equal(readState(h, accountScope(h)).shares.length, 1);
});

test('unshare of a queued share removes the queued job', async () => {
  const h = home();
  const dir = projectWithLog(h, 'new1', { turns: 0 });
  const cloud = storingCloud();
  await setSessionShare({ sessionId: 'new1', share: true, projectDir: dir, home: h, cloud, env: { SPOOKLING_SESSION_ID: 'new1' } });
  const out = await setSessionShare({ sessionId: 'new1', share: false, projectDir: dir, home: h, cloud });
  assert.equal(out.ok, true);
  assert.match(out.message, /Cancelled the pending share/);
  assert.deepEqual(readState(h, accountScope(h)).shares, []);
  assert.deepEqual(cloud.calls, []);
});

test('no session id: the newest session in this project is used', async () => {
  const h = home();
  const dir = projectWithLog(h, 'cur1');
  const cloud = storingCloud();
  const out = await setSessionShare({ share: true, projectDir: dir, home: h, env: {}, cloud });
  assert.equal(out.ok, true);
  assert.deepEqual(cloud.calls, [['share', 'cur1', 'o1']]);
  const viaEnv = await setSessionShare({ share: true, projectDir: dir, home: h, env: { SPOOKLING_SESSION_ID: 'other' }, cloud: storingCloud() });
  assert.equal(viaEnv.sessionId, 'other');
});

test('no id and no log: the newest uploaded session of the project', async () => {
  const h = home();
  const cloud = fakeCloud({ sessions: [{ ...sess('a', 'proj'), lastTurnAt: '2026-11-01' }, { ...sess('b', 'proj'), lastTurnAt: '2026-11-03' }] });
  const out = await setSessionShare({ share: true, projectDir: join(h, 'proj'), home: h, env: {}, cloud });
  assert.deepEqual(cloud.calls, [['share', 'b', 'o1']]);
  assert.equal(out.ok, true);
});

test('webUrl: the default API maps to the web app, another API needs SPOOKLING_APP_URL', () => {
  const h = tmpHome('spk-url-');
  writeCredentials({ token: 'spk_t', user: { id: 'u1' }, apiUrl: 'http://x' }, { home: h });
  assert.equal(webUrl('s1', { env: { SPOOKLING_APP_URL: 'https://app.example.com/' }, home: h }), 'https://app.example.com/memory/u1%3As1'); // the web route takes ownerId:clientId
  writeCredentials({ token: 'spk_t', user: { id: 'u1' }, apiUrl: 'https://api.other.example' }, { home: h });
  assert.equal(webUrl('s1', { env: {}, home: h }), ''); // an unknown API has no known web app
  writeCredentials({ token: 'spk_t', user: { id: 'u1' }, apiUrl: 'https://api.spookling.com' }, { home: h });
  assert.equal(webUrl('s1', { env: {}, home: h }), 'https://app.spookling.com/memory/u1%3As1');
  writeCredentials({ token: 'spk_t', apiUrl: 'https://api.spookling.com' }, { home: h });
  assert.equal(webUrl('s1', { env: {}, home: h }), ''); // no saved user id: no link rather than a broken one
});

// ---- the CLI: `spookling share` with no id ----

async function runCli(args, deps) {
  let out = '';
  const w = process.stdout.write;
  process.stdout.write = (c) => { out += c; return true; };
  try { const code = await main(['node', 'spookling', ...args], deps); return { code, out }; } finally { process.stdout.write = w; }
}

test('share with no id shows what will be shared and asks; N shares nothing', async () => {
  const h = home();
  const dir = projectWithLog(h, 'cur1');
  const cloud = storingCloud();
  let asked = 0;
  const share = {
    status: shareStatus,
    session: (a) => setSessionShare({ ...a, cloud }),
    target: async (a) => (await import('../src/team.js')).shareTarget({ ...a, cloud }),
  };
  const no = await runCli(['share'], { home: h, cwd: dir, env: {}, tty: true, ask: async () => { asked += 1; return 'n'; }, share });
  assert.equal(asked, 1);
  assert.match(no.out, /title:\s+Build the thing/);
  assert.match(no.out, /org:\s+Org test/);
  assert.match(no.out, /Not shared/);
  assert.deepEqual(cloud.calls, []);
  const yes = await runCli(['share', '--last'], { home: h, cwd: dir, env: { SPOOKLING_APP_URL: 'https://app.example.com' }, tty: true, ask: async () => 'y', share });
  assert.equal(yes.code, 0);
  assert.match(yes.out, /shared/);
  assert.match(yes.out, /https:\/\/app\.example\.com\/memory\/u1%3Acur1/);
  assert.deepEqual(cloud.calls, [['share', 'cur1', 'o1']]);
});

test('share --yes skips the question; without a terminal and without --yes it refuses', async () => {
  const h = home();
  const dir = projectWithLog(h, 'cur1');
  const cloud = storingCloud();
  const share = { status: shareStatus, session: (a) => setSessionShare({ ...a, cloud }), target: async () => ({ orgName: 'Org test', title: 't', project: 'p' }) };
  const yes = await runCli(['share', '--yes'], { home: h, cwd: dir, env: {}, tty: false, ask: async () => { throw new Error('asked'); }, share });
  assert.equal(yes.code, 0);
  assert.deepEqual(cloud.calls, [['share', 'cur1', 'o1']]);
  let code = 0;
  await runCli(['share'], { home: h, cwd: dir, env: {}, tty: false, share, exit: (c) => { code = c; } });
  assert.equal(code, 2);
});

test('help lists share, unshare, autoshare and update', async () => {
  const { out } = await runCli(['help'], {});
  for (const w of ['spookling share', 'spookling unshare', 'spookling autoshare', 'spookling update']) assert.ok(out.includes(w), w);
});

test('a half-sent upload (session created, turns refused) queues the share instead of sharing it', async () => {
  const h = home();
  const dir = projectWithLog(h, 'new1');
  const cloud = storingCloud();
  cloud.postTurns = async () => { throw Object.assign(new Error('x'), { name: 'CloudError', status: 503 }); };
  const out = await setSessionShare({ sessionId: 'new1', share: true, projectDir: dir, home: h, cloud });
  assert.equal(out.pending, true);
  assert.deepEqual(cloud.calls, []); // the empty session is on the server, but nothing is shared yet
  assert.equal(readState(h, accountScope(h)).shares.length, 1);
});

test('an explicit id is found in the log of a parent folder (Claude cd-ed into a subfolder)', async () => {
  const h = home();
  const dir = projectWithLog(h, 'new1');
  const sub = join(dir, 'src', 'deep');
  mkdirSync(sub, { recursive: true });
  const cloud = storingCloud();
  const out = await setSessionShare({ sessionId: 'new1', share: true, projectDir: sub, home: h, env: {}, cloud });
  assert.equal(out.pending, undefined);
  assert.deepEqual(cloud.calls, [['share', 'new1', 'o1']]);
  assert.equal(readState(h, accountScope(h)).cursors.new1, 1);
});

test('spookling share <id> --yes with an id that is not uploaded uploads it, or queues the share', async () => {
  const h = home();
  const dir = projectWithLog(h, 'new1');
  const cloud = storingCloud();
  const share = { status: shareStatus, session: (a) => setSessionShare({ ...a, cloud }) };
  const up = await runCli(['share', 'new1', '--yes'], { home: h, cwd: dir, env: {}, tty: false, share });
  assert.equal(up.code, 0);
  assert.deepEqual(cloud.calls, [['share', 'new1', 'o1']]);
  const none = storingCloud();
  const queued = await runCli(['share', 'later1', '--yes', '--org', 'Org test'], { home: h, cwd: dir, env: { SPOOKLING_SESSION_ID: 'later1' }, tty: false, share: { status: shareStatus, session: (a) => setSessionShare({ ...a, cloud: none }) } });
  assert.equal(queued.code, 0);
  assert.match(queued.out, /Will be shared with Org test after this session's next save/);
  assert.deepEqual(readState(h, accountScope(h)).shares.map((j) => j.sid), ['later1']);
});

// ---- review fixes ----

import { readFileSync, existsSync } from 'node:fs';
import { takeShareFailures } from '../src/upload-state.js';
import { CloudError } from '../src/cloud.js';

test('a mistyped explicit id (no local log, not on the server) is an error and queues nothing', async () => {
  const h = home();
  const dir = projectWithLog(h, 'real1');
  const out = await setSessionShare({ sessionId: 'typo9', share: true, projectDir: dir, home: h, env: {}, cloud: storingCloud() });
  assert.equal(out.error, 'No session typo9 found here or in the cloud');
  assert.deepEqual(readState(h, accountScope(h)).shares, []);
});

test('a queued share older than 7 days is dropped with a note in upload.log', async () => {
  const h = home();
  const dir = projectWithLog(h, 'new1', { turns: 0 });
  await setSessionShare({ sessionId: 'new1', share: true, projectDir: dir, home: h, cloud: storingCloud(), env: { SPOOKLING_SESSION_ID: 'new1' } });
  const path = join(h, '.spookling', 'upload-state.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.shares[0].at = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  writeFileSync(path, JSON.stringify(raw));
  await pushFromLog({ logText: '', home: h, cloud: storingCloud(), log: () => {} });
  assert.deepEqual(readState(h, accountScope(h)).shares, []);
  assert.match(readFileSync(join(h, '.spookling', 'upload.log'), 'utf8'), /share of session new1 .* dropped: queued more than 7 days/);
});

test('a share refused at flush is recorded, shown once by status, then cleared', async () => {
  const h = home();
  const dir = projectWithLog(h, 'new1');
  const down = storingCloud({ failUpload: true });
  await setSessionShare({ sessionId: 'new1', share: true, projectDir: dir, home: h, cloud: down });
  const up = storingCloud();
  up.shareSession = async () => { throw new CloudError('no', { status: 403 }); };
  const r = await pushFromLog({ logPath: join(dir, '.memory', 'log.jsonl'), home: h, cloud: up, project: 'proj', sessionId: 'new1', log: () => {} });
  assert.equal(r.queued, false, 'no turns are waiting');
  assert.equal(r.sharesPending, 0);
  assert.deepEqual(readState(h, accountScope(h)).shares, []);
  const st = await shareStatus({ sessionId: 'new1', home: h, cloud: up });
  assert.deepEqual(st.notices, ["Share of 'Build the thing' to Org test did not apply: 403 not a member"]);
  assert.match(formatShare(st), /did not apply: 403 not a member/);
  assert.deepEqual((await shareStatus({ sessionId: 'new1', home: h, cloud: up })).notices, undefined);
  assert.deepEqual(await takeShareFailures(h), []);
});

test('a leftover pending share does not make pushFromLog report queued turns', async () => {
  const h = home();
  const dir = projectWithLog(h, 'new1', { turns: 0 });
  await setSessionShare({ sessionId: 'new1', share: true, projectDir: dir, home: h, cloud: storingCloud(), env: { SPOOKLING_SESSION_ID: 'new1' } });
  const r = await pushFromLog({ logText: '', home: h, cloud: storingCloud(), log: () => {} });
  assert.equal(r.queued, false);
  assert.equal(r.sharesPending, 1);
});

test('spookling refresh retries queued uploads and shares, and says what happened', async () => {
  const h = home();
  const dir = projectWithLog(h, 'new1');
  const down = storingCloud({ failUpload: true });
  await setSessionShare({ sessionId: 'new1', share: true, projectDir: dir, home: h, cloud: down });
  let said = '';
  await flushQueued({ home: h, cloud: down, write: (t) => { said += t; } });
  assert.match(said, /1 queued session could not be uploaded: 503\.\n1 share is waiting/);
  said = '';
  const up = storingCloud();
  await flushQueued({ home: h, cloud: up, write: (t) => { said += t; } });
  assert.match(said, /Uploaded 1 queued session\./);
  assert.deepEqual(up.calls, [['share', 'new1', 'o1']]);
  assert.deepEqual(readState(h, accountScope(h)).shares, []);
  said = '';
  await flushQueued({ home: h, cloud: up, write: (t) => { said += t; } });
  assert.equal(said, '', 'nothing queued: silent');
});

test('the refresh command flushes after pulling the feeds', async () => {
  const h = home();
  let flushed = 0;
  const r = await runCli(['refresh'], { home: h, env: {}, refresh: async () => 0, flush: async () => { flushed += 1; } });
  assert.equal(r.code, 0);
  assert.equal(flushed, 1);
});
