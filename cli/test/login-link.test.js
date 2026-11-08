import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudError } from '../src/cloud.js';
import { tmpHome } from './helpers.mjs';
import { linkTrust, login } from '../src/account.js';

const API = 'https://api.example.test';
const cloudWith = (verificationUri, extra = {}) => ({
  base: () => API,
  deviceStart: async () => ({ deviceCode: 'd', userCode: 'AAAA-BBBB', verificationUri, interval: 1, expiresIn: 60 }),
  pollToken: async () => ({ status: 'denied' }),
  ...extra,
});
async function run(uri, { tty, answer, cloud } = {}) {
  const asked = [], opened = [];
  let out = '';
  await login({
    home: tmpHome('spk-link-'), env: {}, cloud: cloud || cloudWith(uri), sleep: async () => {}, openUrl: (u) => { opened.push(u); return true; },
    write: (s) => { out += s; }, tty,
    confirmOpen: async (q, def) => { asked.push([q, def]); return answer; },
  });
  return { out, asked, opened };
}

test('link classes: trusted, untrusted-but-valid, invalid', () => {
  assert.equal(linkTrust('https://api.example.test/cli', API).kind, 'trusted');
  assert.equal(linkTrust('https://app.spookling.com/cli', 'https://api.spookling.com').kind, 'trusted');
  assert.deepEqual(linkTrust('https://app.other.test/cli?code=1', API), { kind: 'untrusted', href: 'https://app.other.test/cli?code=1', host: 'app.other.test' });
  assert.equal(linkTrust('http://localhost:3000/cli', API).kind, 'untrusted');
  for (const bad of ['ftp://x.test/', 'javascript:alert(1)', 'https://user:pw@app.other.test/', 'http://app.other.test/cli', 'nonsense', '']) {
    assert.equal(linkTrust(bad, API).kind, 'invalid', bad);
  }
});

test('another host at a terminal: asked, default No, opened only on yes', async () => {
  const yes = await run('https://app.other.test/cli?code=AAAA-BBBB', { tty: true, answer: true });
  assert.deepEqual(yes.asked, [['Open it in your browser?', false]]);
  assert.deepEqual(yes.opened, ['https://app.other.test/cli?code=AAAA-BBBB']);
  assert.match(yes.out, /^This sign-in link is on app\.other\.test, not on api\.example\.test or spookling\.com\.\n  https:\/\/app\.other\.test/);
  assert.doesNotMatch(yes.out, /Warning/);
  const no = await run('https://app.other.test/cli', { tty: true, answer: false });
  assert.deepEqual(no.opened, []);
  assert.match(no.out, /Not opened\. Open the link above yourself if you trust it\./);
  const empty = await run('https://app.other.test/cli', { tty: true, answer: undefined });
  assert.deepEqual(empty.opened, [], 'an empty answer is a no');
});

test('another host with no terminal: no prompt, no open, the warning and the link', async () => {
  const r = await run('https://app.other.test/cli', { tty: false, answer: true });
  assert.deepEqual(r.asked, []);
  assert.deepEqual(r.opened, []);
  assert.match(r.out, /^Warning: this sign-in link is not on api\.example\.test or spookling\.com, so it was not opened\. Check it before you visit it:\n  https:\/\/app\.other\.test/);
});

test('an invalid link is never offered and never opened, terminal or not', async () => {
  for (const bad of ['https://user:pw@app.other.test/cli', 'ftp://app.other.test/cli', 'http://app.other.test/cli']) {
    for (const tty of [true, false]) {
      const r = await run(bad, { tty, answer: true });
      assert.deepEqual(r.asked, [], bad);
      assert.deepEqual(r.opened, [], bad);
      assert.match(r.out, /^Warning: this sign-in link is not on/);
    }
  }
});

test('a trusted link still opens at once, without a question', async () => {
  const r = await run('https://api.example.test/cli?code=1', { tty: true, answer: false });
  assert.deepEqual(r.asked, []);
  assert.deepEqual(r.opened, ['https://api.example.test/cli?code=1']);
});

test('a control character in the host or link cannot reach the terminal', async () => {
  const r = await run('https://app.other.test/cli\u001b[2J', { tty: true, answer: false });
  assert.equal(r.out.includes('\u001b'), false);
});

test('device/start 403 without the app\'s error envelope says the address is not a Spookling API', async () => {
  const bare = new CloudError('HTTP 403', { status: 403, code: null });
  const r = await run(null, { cloud: cloudWith(null, { deviceStart: async () => { throw bare; } }), tty: false });
  assert.equal(r.out, "Couldn't start login: that address doesn't look like a Spookling API (got 403). Check the URL, including any stage path such as /v1.\n");
  // the app's own 403 keeps the generic message; so does any other status
  const own = await run(null, { cloud: cloudWith(null, { deviceStart: async () => { throw new CloudError('FORBIDDEN', { status: 403, code: 'FORBIDDEN' }); } }), tty: false });
  assert.match(own.out, /^Could not start login \(FORBIDDEN\)\./);
  const other = await run(null, { cloud: cloudWith(null, { deviceStart: async () => { throw new CloudError('HTTP 500', { status: 500 }); } }), tty: false });
  assert.match(other.out, /^Could not start login \(500\)\./);
});
