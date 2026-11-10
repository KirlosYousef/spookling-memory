// A default org, an org list or a team feed saved for another API or account must never be used for the current one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './helpers.mjs';
import { readCredentials, removeStoredToken, setDefaultOrg, writeCredentials } from '../src/credentials.js';
import { liveOrgs, pickLiveOrg, pickOrg, setSessionShare } from '../src/share.js';
import { cachePath, readCache, shareTarget, writeCache } from '../src/team.js';
import { login, orgs } from '../src/account.js';
import { main } from '../src/main.js';

const home = (extra = {}) => {
  const h = tmpHome('spk-stale-');
  writeCredentials({ token: 'spk_t', user: { id: 'u1' }, apiUrl: 'http://api.one', ...extra }, { home: h });
  return h;
};
const ORG = (id, name) => ({ org: { id, name }, membership: { status: 'active' } });
const cloudOf = (list, sessions = [{ clientId: 'a', title: 'T', project: 'p', turnCount: 1, sharedWith: [] }]) => {
  const calls = [];
  return {
    calls,
    listOrgs: async () => ({ orgs: list }),
    listSessions: async () => ({ sessions, nextCursor: null }),
    listAutoShare: async () => ({ rules: [] }),
    shareSession: async (a) => { calls.push(['share', a.sid, a.orgId]); },
  };
};

test('the default org is saved with its API and account, and only counts for that pair', () => {
  const h = home();
  setDefaultOrg({ id: 'o1', name: 'Spookling' }, { home: h });
  assert.equal(readCredentials({ home: h, env: {} }).defaultOrgId, 'o1');
  // a new login on another API: the default does not come along
  writeCredentials({ token: 'spk_t2', user: { id: 'u1' }, apiUrl: 'http://api.two' }, { home: h });
  const c = readCredentials({ home: h, env: {} });
  assert.equal(c.defaultOrgId, null);
  // another account on the same API too
  setDefaultOrg({ id: 'o1', name: 'Spookling' }, { home: h });
  writeCredentials({ token: 'spk_t3', user: { id: 'u2' }, apiUrl: 'http://api.two' }, { home: h });
  assert.equal(readCredentials({ home: h, env: {} }).defaultOrgId, null);
  // the same account and API keeps it
  setDefaultOrg({ id: 'o9', name: 'Mine' }, { home: h });
  writeCredentials({ token: 'spk_t4', user: { id: 'u2' }, apiUrl: 'http://api.two' }, { home: h });
  assert.equal(readCredentials({ home: h, env: {} }).defaultOrgName, 'Mine');
});

test('a default whose API or account no longer matches the file is ignored and reported as stale', () => {
  const h = home();
  setDefaultOrg({ id: 'o1', name: 'Spookling' }, { home: h });
  const path = join(h, '.spookling', 'credentials.json');
  const file = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...file, apiUrl: 'http://api.other' }));
  const c = readCredentials({ home: h, env: {} });
  assert.equal(c.defaultOrgId, null);
  assert.equal(c.staleDefaultOrg, 'Spookling');
  writeFileSync(path, JSON.stringify({ ...file, user: { id: 'someone-else' } }));
  assert.equal(readCredentials({ home: h, env: {} }).defaultOrgId, null);
  // SPOOKLING_TOKEN is some other identity: the saved default is not used
  writeFileSync(path, JSON.stringify(file));
  assert.equal(readCredentials({ home: h, env: { SPOOKLING_TOKEN: 'x' } }).defaultOrgId, null);
});

test('share: a default that is not among the live orgs is dropped; one org is used and the user is told', async () => {
  const h = home();
  setDefaultOrg({ id: 'prod-org', name: 'Spookling' }, { home: h });
  const cloud = cloudOf([ORG('o1', 'Org test')]);
  const out = await setSessionShare({ sessionId: 'a', share: true, home: h, env: {}, cloud });
  assert.equal(out.ok, true);
  assert.deepEqual(out.orgs, ['Org test']);
  assert.match(out.note, /'Spookling'.*no longer one of your orgs.*Using 'Org test', your only org/);
  assert.deepEqual(cloud.calls, [['share', 'a', 'o1']]);
  assert.equal(readCredentials({ home: h, env: {} }).defaultOrgId, null, 'the stale default is cleared');
});

test('share: several live orgs and a stale default ask for an org; nothing is shared', async () => {
  const h = home();
  setDefaultOrg({ id: 'prod-org', name: 'Spookling' }, { home: h });
  const cloud = cloudOf([ORG('o1', 'One'), ORG('o2', 'Two')]);
  const out = await setSessionShare({ sessionId: 'a', share: true, home: h, env: {}, cloud });
  assert.match(out.error, /several orgs: 'One', 'Two'\. Run again with --org '<name>'\..*'Spookling'.*no longer/);
  assert.equal(out.needOrg, true);
  assert.deepEqual(cloud.calls, []);
});

test('shareTarget reports needOrg with the choices, the session, and which org was picked alone', async () => {
  const h = home();
  const many = await shareTarget({ kind: 'session', sessionId: 'a', home: h, env: {}, cloud: cloudOf([ORG('o1', 'One'), ORG('o2', 'Two')]) });
  assert.equal(many.needOrg, true);
  assert.equal(many.sessionId, 'a');
  assert.deepEqual(many.orgs.map((o) => o.name), ['One', 'Two']);
  const one = await shareTarget({ kind: 'session', sessionId: 'a', home: h, env: {}, cloud: cloudOf([ORG('o1', 'Org test')]) });
  assert.equal(one.orgName, 'Org test');
  assert.equal(one.onlyOrg, true);
  const wrong = await shareTarget({ kind: 'session', sessionId: 'a', org: 'Spookling', home: h, env: {}, cloud: cloudOf([ORG('o1', 'Org test')]) });
  assert.match(wrong.error, /No org matches "Spookling"\. Your orgs: 'Org test'\. Name one of those orgs\./);
});

test('pickOrg: refusals name the orgs and end with what to do', () => {
  assert.match(pickOrg([], '').error, /not an active member of any org.*Join or create an org/);
  assert.match(pickOrg([{ id: '1', name: 'A' }, { id: '2', name: 'B' }], '').error, /Run again with --org '<name>'\.$/);
  assert.equal(pickLiveOrg([{ id: '1', name: 'A' }], '', { defaultOrgId: null, staleDefaultOrg: null }, tmpHome()).org.id, '1');
});

test('team feed saved for another API or account reads as empty; the same one is kept', () => {
  const h = home();
  writeCache({ orgs: { o1: { name: 'Spookling' } }, sessions: {}, apiBase: 'http://api.one', userId: 'u1' }, h);
  assert.deepEqual(Object.keys(readCache(h, {}).orgs), ['o1']);
  writeCache({ orgs: { o1: { name: 'Spookling' } }, sessions: {}, apiBase: 'https://api.spookling.com', userId: 'u1' }, h);
  assert.deepEqual(readCache(h, {}).orgs, {});
  writeCache({ orgs: { o1: { name: 'Spookling' } }, sessions: {}, apiBase: 'http://api.one', userId: 'someone-else' }, h);
  assert.deepEqual(readCache(h, {}).orgs, {});
});

test('logout (removing the token) deletes the cached team feed', () => {
  const h = home();
  writeCache({ orgs: { o1: { name: 'Spookling' } }, sessions: {}, apiBase: 'http://api.one', userId: 'u1' }, h);
  assert.equal(existsSync(cachePath(h)), true);
  removeStoredToken(h);
  assert.equal(existsSync(cachePath(h)), false);
});

test('login as another account or on another API deletes the previous feed; the same account keeps it', async () => {
  const fakeLogin = (user, base) => ({
    base: () => base,
    deviceStart: async () => ({ deviceCode: 'dc', userCode: 'AAAA', verificationUri: `${base}/cli?code=AAAA`, interval: 1, expiresIn: 600 }),
    pollToken: async () => ({ status: 'approved', token: 'spk_new', user }),
    listOrgs: async () => ({ orgs: [ORG('o1', 'Org test')] }),
    listAutoShare: async () => ({ rules: [] }),
  });
  const go = (h, cloud) => { let t = 0; return login({ home: h, env: {}, cloud, now: () => t, sleep: async (ms) => { t += ms; }, openUrl: () => true, confirm: async () => false, choose: async () => 0, write: () => {} }); };
  const h = home();
  writeCache({ orgs: { o1: { name: 'Spookling' } }, sessions: {}, apiBase: 'http://api.one', userId: 'u1' }, h);
  await go(h, fakeLogin({ id: 'u1' }, 'http://api.one'));
  assert.equal(existsSync(cachePath(h)), true, 'same account, same API');
  await go(h, fakeLogin({ id: 'u1' }, 'http://127.0.0.1:9'));
  assert.equal(existsSync(cachePath(h)), false, 'another API');
  writeCache({ orgs: {}, sessions: {}, apiBase: 'http://127.0.0.1:9', userId: 'u1' }, h);
  await go(h, fakeLogin({ id: 'u2' }, 'http://127.0.0.1:9'));
  assert.equal(existsSync(cachePath(h)), false, 'another account');
});

test('spookling orgs asks the API, clears a default that is gone and says so', async () => {
  const h = home();
  setDefaultOrg({ id: 'prod-org', name: 'Spookling' }, { home: h });
  let out = '';
  const code = await orgs({ home: h, env: {}, heading: true, cloud: cloudOf([ORG('o1', 'Org test')]), write: (s) => { out += s; } });
  assert.equal(code, 0);
  assert.match(out, /^Orgs \(checked just now\):\n/);
  assert.match(out, /Your saved default org 'Spookling' is no longer one of your orgs, so it was cleared\./);
  assert.match(out, /o1  Org test\n$/);
  assert.equal(readCredentials({ home: h, env: {} }).defaultOrgId, null);
});

test('liveOrgs returns the orgs now and marks the default only when it is still one of them', async () => {
  const h = home();
  setDefaultOrg({ id: 'o2', name: 'Two' }, { home: h });
  const out = await liveOrgs({ home: h, env: {}, cloud: cloudOf([ORG('o1', 'One'), ORG('o2', 'Two')]) });
  assert.deepEqual(out.orgs.map((o) => [o.name, o.default]), [['One', false], ['Two', true]]);
  assert.equal(out.defaultOrg, 'Two');
  const gone = await liveOrgs({ home: h, env: {}, cloud: cloudOf([ORG('o1', 'One')]) });
  assert.equal(gone.defaultOrg, null);
  assert.match(gone.note, /'Two' is no longer one of your orgs/);
});

// ---- the terminal: spookling share ----

async function runCli(args, deps) {
  let out = '';
  const w = process.stdout.write;
  process.stdout.write = (c) => { out += c; return true; };
  try { const code = await main(['node', 'spookling', ...args], deps); return { code, out }; } finally { process.stdout.write = w; }
}
const shareDeps = (cloud) => ({
  status: async () => ({}),
  session: (a) => setSessionShare({ ...a, cloud }),
  target: (a) => shareTarget({ ...a, cloud }),
});

test('spookling share with one org says which org it picked', async () => {
  const h = home();
  const cloud = cloudOf([ORG('o1', 'Org test')]);
  const r = await runCli(['share', 'a', '--yes'], { home: h, cwd: h, env: {}, tty: false, share: shareDeps(cloud) });
  assert.equal(r.code, 0);
  assert.match(r.out, /org:\s+Org test \(your only org\)/);
  assert.deepEqual(cloud.calls, [['share', 'a', 'o1']]);
});

test('spookling share with several orgs and no --org shows a picker in a terminal, and shares only with the pick', async () => {
  const h = home();
  const cloud = cloudOf([ORG('o1', 'One'), ORG('o2', 'Two')]);
  setDefaultOrg({ id: 'o1', name: 'One' }, { home: h }); // a valid default does not skip the question? it is the user's saved choice and is used
  const answers = [];
  const r = await runCli(['share', 'a', '--yes'], { home: h, cwd: h, env: {}, tty: true, ask: async (q) => { answers.push(q); return '2'; }, share: shareDeps(cloud) });
  assert.equal(r.code, 0);
  assert.deepEqual(cloud.calls, [['share', 'a', 'o1']], 'a still-valid saved default is used');
  // no default: the picker
  const h2 = home();
  const cloud2 = cloudOf([ORG('o1', 'One'), ORG('o2', 'Two')]);
  const r2 = await runCli(['share', 'a', '--yes'], { home: h2, cwd: h2, env: {}, tty: true, ask: async (q) => { answers.push(q); return '2'; }, share: shareDeps(cloud2) });
  assert.equal(r2.code, 0);
  assert.match(answers[0], /1\) One\n  2\) Two/);
  assert.deepEqual(cloud2.calls, [['share', 'a', 'o2']]);
});

test('spookling share with several orgs, no --org and no terminal asks for --org and shares nothing', async () => {
  const h = home();
  const cloud = cloudOf([ORG('o1', 'One'), ORG('o2', 'Two')]);
  const r = await runCli(['share', 'a', '--yes'], { home: h, cwd: h, env: {}, tty: false, ask: async () => { throw new Error('asked'); }, share: shareDeps(cloud) });
  assert.equal(r.code, 1);
  assert.match(r.out, /several orgs: 'One', 'Two'\. Run again with --org '<name>'\./);
  assert.deepEqual(cloud.calls, []);
});

test('spookling share with a stale default and several orgs picks nothing for the user', async () => {
  const h = home();
  setDefaultOrg({ id: 'prod-org', name: 'Spookling' }, { home: h });
  const cloud = cloudOf([ORG('o1', 'One'), ORG('o2', 'Two')]);
  const r = await runCli(['share', 'a', '--yes'], { home: h, cwd: h, env: {}, tty: false, share: shareDeps(cloud) });
  assert.equal(r.code, 1);
  assert.match(r.out, /'Spookling' is no longer one of your orgs/);
  assert.deepEqual(cloud.calls, []);
});

test('a typed session id is confirmed too: asked in a terminal, refused (exit 2) without one unless --yes', async () => {
  const h = home();
  const cloud = cloudOf([ORG('o1', 'Org test')]);
  let asked = 0;
  const no = await runCli(['share', 'a'], { home: h, cwd: h, env: {}, tty: true, ask: async () => { asked += 1; return 'n'; }, share: shareDeps(cloud) });
  assert.equal(asked, 1);
  assert.match(no.out, /Not shared/);
  assert.deepEqual(cloud.calls, []);
  let code = 0;
  const r = await runCli(['share', 'a'], { home: h, cwd: h, env: {}, tty: false, share: shareDeps(cloud), exit: (c) => { code = c; } });
  assert.equal(code, 2);
  assert.deepEqual(cloud.calls, []);
  assert.equal(r.code, 2);
});
