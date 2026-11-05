import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './helpers.mjs';
import { writeCredentials } from '../src/credentials.js';
import { orgs } from '../src/account.js';
import { main } from '../src/main.js';
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

test('status: the email comes from the saved login', async () => {
  const home = homeOf();
  writeCredentials({ token: 'spk_x', user: { email: 'ada@example.com', name: 'Ada' } }, { home });
  const line = cloudLine(await statusText(home));
  assert.match(line, /logged in as ada@example\.com/);
  assert.doesNotMatch(line, /spk_x/);
});

test('status: logged in; never touches the network', async () => {
  const home = homeOf();
  writeCredentials({ token: 'spk_x', user: { name: 'Ada' } }, { home });
  const real = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('status must not use the network'); };
  let line;
  try { line = cloudLine(await statusText(home)); } finally { globalThis.fetch = real; }
  assert.match(line, /logged in as Ada/);
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
