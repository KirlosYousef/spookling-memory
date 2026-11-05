import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpHome } from './helpers.mjs';
import { CloudError, isNetworkError, networkMessage } from '../src/cloud.js';
import { readCredentials, writeCredentials } from '../src/credentials.js';
import { login, logout, orgs, whoami } from '../src/account.js';
import { accountScope } from '../src/upload-state.js';

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
const logLines = (...ids) => ids.flatMap((id) => [
  { session_id: id, role: 'user', ts: '2026-11-03T09:00:00Z', text: `hello ${id}` },
  { session_id: id, role: 'assistant', ts: '2026-11-03T09:00:05Z', text: 'hi' },
].map((e) => JSON.stringify(e))).join('\n') + '\n';
const writeLog = (dir, ...ids) => { mkdirSync(join(dir, '.memory'), { recursive: true }); writeFileSync(join(dir, '.memory', 'log.jsonl'), logLines(...ids)); };

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

test('past sessions: asked, uploaded privately, counted; already uploaded ones are not', async () => {
  const home = homeOf(), proj = join(home, 'work', 'app');
  mkdirSync(join(proj, '.git'), { recursive: true });
  writeLog(proj, 's1', 's2');
  writeLog(home, 'h1');
  mkdirSync(join(home, '.spookling'), { recursive: true });
  writeCredentials({ token: 'spk_t', apiUrl: 'https://api.test' }, { home }); // the account the login below ends up as
  writeFileSync(join(home, '.spookling', 'upload-state.json'), JSON.stringify({ scopeKey: accountScope(home), cursors: { h1: 1 }, skipped: {}, queue: [], shares: [] }));
  const posts = [], asked = [];
  const r = await run(home, { cwd: proj, confirm: async (q, def) => { asked.push([q, def]); return true; } }, fake({ posts }));
  assert.equal(r.code, 0);
  assert.deepEqual(asked, [['Upload your 2 past sessions privately? Only you can see them until you share.', true]]);
  assert.deepEqual(posts.sort(), ['POST s1 2', 'POST s2 2', 'PUT s1', 'PUT s2']);
  assert.match(r.out, /Uploaded 2 sessions privately\./);
  assert.match(r.out, /Looked in .*app[\\/]\.memory[\\/]log\.jsonl and ~[\\/]\.memory[\\/]log\.jsonl\. Other projects upload when their next session stops\./);
});

test('declining the backfill uploads nothing', async () => {
  const home = homeOf();
  writeLog(home, 's1');
  const posts = [];
  const r = await run(home, { confirm: async () => false }, fake({ posts }));
  assert.equal(r.code, 0);
  assert.deepEqual(posts, []);
  assert.match(r.out, /Skipped\. They upload one by one when a session stops\./);
});

test('a backfill that fails never fails the login', async () => {
  const home = homeOf();
  writeLog(home, 's1');
  const cloud = { ...fake(), upsertSession: async () => { throw down(); } };
  const r = await run(home, { confirm: async () => true }, cloud);
  assert.equal(r.code, 0);
  assert.match(r.out, /Uploaded 0 sessions privately\.\nSome turns did not go up .*retry at the next Stop/);
  assert.equal(readCredentials({ home, env: {} }).token, 'spk_t');
});

test('with no TTY the real prompt takes Yes by default', () => {
  const home = homeOf();
  writeLog(home, 's1', 's2', 's3');
  const script = join(homeOf(), 'run.mjs');
  const src = pathToFileURL(fileURLToPath(new URL('../src/account.js', import.meta.url))).href;
  writeFileSync(script, `
    import { login } from ${JSON.stringify(src)};
    const posts = [];
    const cloud = {
      base: () => 'https://api.test',
      deviceStart: async () => ({ deviceCode: 'd', userCode: 'AAAA-BBBB', verificationUri: 'https://api.test/x', interval: 1, expiresIn: 60 }),
      pollToken: async () => ({ status: 'approved', token: 'spk_t', user: { name: 'Ada' } }),
      listOrgs: async () => ({ orgs: [] }),
      upsertSession: async () => ({}),
      postTurns: async ({ sid, turns }) => { posts.push(sid); return { lastSeq: turns.at(-1).seq }; },
      listAutoShare: async () => ({ rules: [] }),
    };
    const code = await login({ home: ${JSON.stringify(home)}, env: {}, cloud, sleep: async () => {}, openUrl: () => true });
    console.log('POSTS ' + posts.sort().join(','));
    process.exit(code);
  `);
  const r = spawnSync(process.execPath, [script], { input: '', encoding: 'utf8', timeout: 30000, env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Upload your 3 past sessions privately\? Only you can see them until you share\. \[Y\/n\]/);
  assert.match(r.stdout, /Uploaded 3 sessions privately\./);
  assert.match(r.stdout, /POSTS s1,s2,s3/);
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
