import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpHome } from './helpers.mjs';
import { CloudError, isNetworkError, networkMessage } from '../src/cloud.js';
import { readCredentials, writeCredentials } from '../src/credentials.js';
import { login, logout, orgs, whoami } from '../src/account.js';

const BIN = fileURLToPath(new URL('../../bin/spookling-memory.js', import.meta.url));
const homeOf = () => tmpHome('spk-lf-');
const down = (code = 'ECONNREFUSED') => new CloudError('network error', { code });
const ORG = (id, name) => ({ org: { id, name }, membership: { status: 'active' } });
const UNREACHABLE = /^Couldn't reach https:\/\/api\.spookling\.com\. Check your connection, or SPOOKLING_API_URL if you set it\.$/;

function fake({ orgList = [ORG('o1', 'Acme')], polls = [{ status: 'approved', token: 'spk_t', user: { name: 'Ada', email: 'ada@x.com' } }], posts } = {}) {
  const queue = [...polls];
  return {
    base: () => 'https://api.test',
    deviceStart: async () => ({ deviceCode: 'dc', userCode: '6HYE-3R4C', verificationUri: 'https://api.test/cli?code=6HYE-3R4C', interval: 1, expiresIn: 600 }),
    pollToken: async () => { const n = queue.length > 1 ? queue.shift() : queue[0]; if (n instanceof Error) throw n; return n; },
    listOrgs: async () => { if (orgList instanceof Error) throw orgList; return { orgs: orgList }; },
    upsertSession: async ({ sid }) => { posts?.push(`PUT ${sid}`); return {}; },
    postTurns: async ({ sid, turns }) => { posts?.push(`POST ${sid} ${turns.length}`); return { lastSeq: turns.at(-1).seq }; },
    listAutoShare: async () => ({ rules: [] }),
  };
}
const run = (home, extra = {}, cloud = fake()) => {
  let out = '', t = 0;
  const sleeps = [];
  const p = login({
    home, env: {}, cloud, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, openUrl: () => true,
    confirm: async () => false, choose: async () => 0, write: (s) => { out += s; }, ...extra,
  }).then((code) => ({ code, out, sleeps }));
  return p;
};

test('login transcript: opening, url, code, waiting, default org', async () => {
  const { code, out } = await run(homeOf());
  assert.equal(code, 0);
  assert.equal(out, [
    'Opening your browser to sign in to Spookling…',
    '  https://api.test/cli?code=6HYE-3R4C',
    'Confirm this code matches: 6HYE-3R4C',
    'Waiting for approval… (Ctrl-C to cancel)',
    'Logged in as Ada.',
    'Default org: Acme',
    '',
  ].join('\n'));
  assert.equal(out.includes('\x1b'), false);
});

test('login says to open the link when the browser cannot be opened', async () => {
  const { out } = await run(homeOf(), { openUrl: async () => false });
  assert.match(out, /https:\/\/api\.test[^\n]*\nConfirm this code matches: 6HYE-3R4C\nOpen the link above in a browser\.\nWaiting for approval…/);
});

test('an unreachable API at login start says so', async () => {
  const cloud = { ...fake(), deviceStart: async () => { throw down('TypeError'); } };
  const { code, out } = await run(homeOf(), {}, cloud);
  assert.equal(code, 1);
  assert.match(out.trim(), UNREACHABLE);
});

test('network failures are recognised, an HTTP status is not', () => {
  for (const c of ['TypeError', 'ECONNREFUSED', 'ENOTFOUND', 'TimeoutError']) assert.equal(isNetworkError(down(c)), true, c);
  assert.equal(isNetworkError(new CloudError('x', { status: 503 })), false);
  assert.equal(isNetworkError(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } })), true);
  assert.equal(networkMessage(new CloudError('x', { status: 404 })), null);
  assert.match(networkMessage(down(), { env: { SPOOKLING_API_URL: 'http://127.0.0.1:1/' }, home: homeOf() }), /^Couldn't reach http:\/\/127.0.0.1:1\./);
});

test('polling retries network errors and 5xx with backoff, then logs in', async () => {
  const polls = [down('TypeError'), new CloudError('HTTP 503', { status: 503 }), down('ETIMEDOUT'), { status: 'pending' },
    { status: 'approved', token: 'spk_t', user: { name: 'Ada' } }];
  const { code, out, sleeps } = await run(homeOf(), {}, fake({ polls }));
  assert.equal(code, 0);
  assert.match(out, /Logged in as Ada/);
  const waits = sleeps.filter((ms) => ms > 1000);
  assert.deepEqual(waits, [2000, 4000, 8000], 'backoff grows after each failure');
});

test('polling ends on 404, denied and expiry; a network that stays down is named', async () => {
  let r = await run(homeOf(), {}, fake({ polls: [new CloudError('x', { status: 404 })] }));
  assert.equal(r.code, 1);
  assert.match(r.out, /no longer valid/);
  r = await run(homeOf(), {}, fake({ polls: [{ status: 'denied' }] }));
  assert.match(r.out, /Login denied/);
  r = await run(homeOf(), {}, fake({ polls: [down()] }));
  assert.equal(r.code, 1);
  assert.match(r.out, /Login expired, and https:\/\/api\.test could not be reached\. Check your connection/);
});

test('default org: one org is saved at once (mode 0600), two ask, none says so', async () => {
  const home = homeOf();
  await run(home);
  const c = readCredentials({ home, env: {} });
  assert.equal(c.defaultOrgId, 'o1');
  assert.equal(c.defaultOrgName, 'Acme');
  if (process.platform !== 'win32') assert.equal(statSync(join(home, '.spookling', 'credentials.json')).mode & 0o777, 0o600);

  const two = homeOf();
  const asked = [];
  const r = await run(two, { choose: async (q, names) => { asked.push(names); return 1; } }, fake({ orgList: [ORG('o1', 'Acme'), ORG('o2', 'Beta')] }));
  assert.deepEqual(asked, [['Acme', 'Beta']]);
  assert.match(r.out, /Default org: Beta/);
  assert.equal(readCredentials({ home: two, env: {} }).defaultOrgId, 'o2');

  const none = homeOf();
  const n = await run(none, {}, fake({ orgList: [] }));
  assert.equal(n.code, 0);
  assert.match(n.out, /not in an org yet/);
  assert.equal(readCredentials({ home: none, env: {} }).defaultOrgId, null);

  const broken = await run(homeOf(), {}, fake({ orgList: down() }));
  assert.equal(broken.code, 0, 'a failed org lookup does not fail the login');
  assert.match(broken.out, /Could not read your orgs/);
});

test('whoami prints name, email, API and default org; logged out exits 1', () => {
  const home = homeOf();
  let out = '';
  assert.equal(whoami({ home, env: {}, write: (s) => { out += s; } }), 1);
  assert.equal(out, 'Not logged in.\n');
  writeCredentials({ token: 't', user: { name: 'Ada', email: 'ada@x.com' }, apiUrl: 'https://api.test' }, { home });
  out = '';
  assert.equal(whoami({ home, env: {}, write: (s) => { out += s; } }), 0);
  assert.equal(out, 'Ada ada@x.com\nAPI https://api.test\nDefault org none\n');
  writeFileSync(join(home, '.spookling', 'credentials.json'), JSON.stringify({ token: 't', user: { name: 'Ada', email: 'ada@x.com' }, defaultOrgId: 'o1', defaultOrgName: 'Acme' }));
  out = '';
  whoami({ home, env: {}, write: (s) => { out += s; } });
  assert.match(out, /Default org Acme\n$/);
});

test('logout and orgs say the API is unreachable', async () => {
  const home = homeOf();
  writeCredentials({ token: 't', user: { name: 'Ada' } }, { home });
  const cloud = new Proxy({}, { get: () => async () => { throw down('TypeError'); } });
  let out = '';
  const write = (s) => { out += s; };
  assert.equal(await orgs({ home, env: {}, cloud, write }), 1);
  assert.match(out.trim(), UNREACHABLE);
  const notes = [];
  await logout({ home, env: {}, cloud, log: (m) => notes.push(m), write });
  assert.match(notes[0], /Couldn't reach .* The saved token was still removed\./);
});

const capture = async (fn) => {
  let out = '', err = '';
  const o = process.stdout.write, e = process.stderr.write;
  process.stdout.write = (s) => { out += s; return true; };
  process.stderr.write = (s) => { err += s; return true; };
  try { return { ...(await fn()), out, err }; } finally { process.stdout.write = o; process.stderr.write = e; }
};

test('unknown command: message on stderr, help, exit 1; bare, help, -h, --help exit 0', () => {
  const r = spawnSync(process.execPath, [BIN, 'frobnicate'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Unknown command: frobnicate\n/);
  assert.match(r.stdout, /spookling init/);
  for (const a of [[], ['help'], ['-h'], ['--help']]) {
    const ok = spawnSync(process.execPath, [BIN, ...a], { encoding: 'utf8' });
    assert.equal(ok.status, 0, a.join(' '));
    assert.equal(ok.stderr, '');
    assert.match(ok.stdout, /spookling init/);
  }
});
