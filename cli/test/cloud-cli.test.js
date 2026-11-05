import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './helpers.mjs';
import { writeCredentials } from '../src/credentials.js';
import { maskSecrets } from '../src/mask.js';
import { orgs } from '../src/account.js';
import { main } from '../src/main.js';
import { pendingUploads, projectLog } from '../src/push.js';
import { accountScope } from '../src/upload-state.js';
import { status } from '../src/wizard.js';

const homeOf = () => tmpHome('spk-cc-');
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

async function statusText(home) {
  const said = [], write = process.stdout.write, env = process.env.SPOOKLING_TOKEN;
  delete process.env.SPOOKLING_TOKEN;
  process.stdout.write = (s) => { said.push(String(s)); return true; };
  try { await status(home, async () => null, home); } finally {
    process.stdout.write = write;
    if (env !== undefined) process.env.SPOOKLING_TOKEN = env;
  }
  return plain(said.join(''));
}

const cloudLine = (text) => text.split('\n').find((l) => /^\s+\S\s+cloud\b/.test(l)) || '';

test('status: logged out says so', async () => {
  const line = cloudLine(await statusText(homeOf()));
  assert.match(line, /not logged in/);
});

test('status: email and pending turns come from local files', async () => {
  const home = homeOf();
  writeCredentials({ token: 'spk_x', user: { email: 'ada@example.com', name: 'Ada' } }, { home });
  writeFileSync(join(home, '.spookling', 'upload-state.json'), JSON.stringify({
    scopeKey: accountScope(home), cursors: {}, skipped: {}, shares: [],
    queue: [{ sid: 'a', session: {}, turns: [{ seq: 0 }, { seq: 1 }] }, { sid: 'b', session: {}, turns: [{ seq: 0 }] }],
  }));
  assert.deepEqual(pendingUploads(home), { sessions: 2, turns: 3 });
  const line = cloudLine(await statusText(home));
  assert.match(line, /logged in as ada@example\.com/);
  assert.match(line, /3 turns in 2 sessions not uploaded yet/);
  assert.doesNotMatch(line, /spk_x/);
});

test('status: logged in with nothing queued; never touches the network', async () => {
  const home = homeOf();
  writeCredentials({ token: 'spk_x', user: { name: 'Ada' } }, { home });
  const real = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('status must not use the network'); };
  let line;
  try { line = cloudLine(await statusText(home)); } finally { globalThis.fetch = real; }
  assert.match(line, /logged in as Ada; no turns waiting/);
});


const listing = { orgs: [
  { org: { id: 'o1', name: 'Acme' }, membership: { status: 'active' } },
  { org: { id: 'o2', name: 'Gone' }, membership: { status: 'removed' } },
] };

test('orgs: lists active orgs with the CLI token', async () => {
  const home = homeOf();
  writeCredentials({ token: 'spk_o' }, { home });
  let seen, out = '';
  const code = await orgs({ home, env: {}, cloud: { listOrgs: async ({ token }) => { seen = token; return listing; } }, write: (s) => { out += s; } });
  assert.equal(code, 0);
  assert.equal(seen, 'spk_o');
  assert.equal(out, 'o1  Acme\n');
});

test('orgs: logged out, offline and rejected token each exit 1 with a message', async () => {
  const home = homeOf();
  let out = '';
  const write = (s) => { out += s; };
  assert.equal(await orgs({ home, env: {}, write }), 1);
  assert.match(out, /Not logged in/);
  writeCredentials({ token: 'spk_o' }, { home });
  out = '';
  assert.equal(await orgs({ home, env: {}, cloud: { listOrgs: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); } }, write }), 1);
  assert.match(out, /Couldn't reach https:\/\/api\.spookling\.com\. Check your connection, or SPOOKLING_API_URL if you set it\./);
  out = '';
  assert.equal(await orgs({ home, env: {}, cloud: { listOrgs: async () => { throw Object.assign(new Error('x'), { status: 401 }); } }, write }), 1);
  assert.match(out, /spookling login/);
});

test('orgs: not in any org', async () => {
  const home = homeOf();
  writeCredentials({ token: 'spk_o' }, { home });
  let out = '';
  assert.equal(await orgs({ home, env: {}, cloud: { listOrgs: async () => ({ orgs: [] }) }, write: (s) => { out += s; } }), 0);
  assert.match(out, /not in an org/);
});

test('main routes orgs and the help lists it', async () => {
  let got;
  const write = process.stdout.write;
  let help = '';
  process.stdout.write = (s) => { help += s; return true; };
  try {
    assert.equal(await main(['node', 'spookling', 'orgs'], { orgs: async (o) => { got = o; return 0; }, home: '/h', cwd: '/c' }), 0);
    await main(['node', 'spookling', 'help'], {});
  } finally { process.stdout.write = write; }
  assert.equal(got.home, '/h');
  assert.match(help, /spookling orgs /);
});


const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const PEM = '\u002d----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\nabcdef\n-----END RSA PRIVATE KEY-----';
const cases = {
  jwt: [`token ${JWT} here`, JWT],
  pem: [`key:\n${PEM}\nthanks`, 'MIIEowIBAAKCAQEA7'],
  'pem without END': ['\u002d----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq', 'MIIEvQIBADANBgkq'],
  'url credentials': ['psql postgres://admin:hunter2pw@db.example.com:5432/app', 'hunter2pw'],
  slack: ['\u0078oxb-1234567890-abcdefghijkl', 'abcdefghijkl'],
  'slack user': ['\u0078oxp-1234567890-abcdefghijkl', 'abcdefghijkl'],
  'stripe live': ['\u0073k_live_51HabcdEFGHijklMNOP', '51HabcdEFGHijklMNOP'],
  'stripe restricted': ['\u0072k_live_51HabcdEFGHijklMNOP', '51HabcdEFGHijklMNOP'],
  'stripe test': ['\u0073k_test_4eC39HqLyjWDarjtT1zdp7dc', '4eC39HqLyjWDarjtT1zdp7dc'],
  'openai style': ['\u0073k-abcdefghijklmnopqrstuvwxyz0123', 'abcdefghijklmnopqrstuvwxyz0123'],
  'name=value': ['export MY_API_KEY=abc123xyz', 'abc123xyz'],
};
for (const [name, [text, secret]] of Object.entries(cases)) {
  test(`mask: ${name}`, () => {
    const out = maskSecrets(text);
    assert.ok(!out.includes(secret), out);
    assert.match(out, /\[secret\]/);
  });
}

test('mask: ordinary text and URLs without credentials stay as they are', () => {
  const text = 'See https://example.com/a?b=c and git@github.com:me/x.git, port 5432, user:pass in prose.';
  assert.equal(maskSecrets(text), text);
  assert.equal(maskSecrets('postgres://admin:hunter2pw@db/x'), 'postgres://[secret]@db/x');
});

test('uploaded turns and title are masked, a key split by the 4000 cap too, and the log text is untouched', () => {
  const line = (o) => JSON.stringify({ session_id: 's', ts: '2026-11-03T09:00:00Z', ...o });
  const long = `${'a '.repeat(1990)}${JWT}`;
  const raw = [
    line({ role: 'user', text: `use ${JWT} please` }),
    line({ role: 'assistant', text: PEM }),
    line({ role: 'user', text: long }),
  ].join('\n');
  const before = raw.slice();
  const [s] = projectLog(raw);
  assert.equal(raw, before);
  const sent = JSON.stringify(s);
  assert.ok(!sent.includes('SflKxwRJ'), 'jwt signature');
  assert.ok(!sent.includes('eyJzdWIi'), 'jwt payload');
  assert.ok(!sent.includes('MIIEowIBAAKCAQEA7'), 'pem');
  assert.equal(s.session.title, 'use [secret] please');
  assert.ok(s.turns[2].text.length <= 4000);
});
