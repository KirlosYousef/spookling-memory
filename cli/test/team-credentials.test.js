import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCredentials, writeCredentials } from '../src/credentials.js';
import { apiBase, createCloud, DEFAULT_API_URL } from '../src/cloud.js';
import { login, logout, whoami } from '../src/account.js';
import { main } from '../src/main.js';
import { linkCli, status } from '../src/wizard.js';
import { tmpHome, listen, envelope, readReq, BIN, modeOf } from './helpers.mjs';

const homeOf = () => tmpHome('spk-cred-');

test('credentials file is created mode 0600', { skip: process.platform === 'win32' && 'POSIX mode bits' }, () => {
  const home = homeOf();
  const path = writeCredentials({ token: 'spk_file', user: { name: 'Ada' }, label: 'test' }, { home });
  assert.equal(modeOf(path), 0o600);
  assert.equal(modeOf(join(home, '.spookling')), 0o700);
});

test('SPOOKLING_TOKEN overrides the file and is not printed', () => {
  const home = homeOf();
  writeCredentials({ token: 'spk_file', user: { name: 'Ada' }, label: 'test' }, { home });
  const env = { SPOOKLING_TOKEN: 'spk_env' };
  const creds = readCredentials({ home, env });
  assert.equal(creds.token, 'spk_env');
  assert.equal(creds.fromEnv, true);
  let out = '';
  assert.equal(whoami({ home, env, write: (s) => { out += s; } }), 0);
  assert.match(out, /^Logged in with SPOOKLING_TOKEN\.\nDefault org none\n$/, 'no API line: an env token has no origin without SPOOKLING_API_URL');
  assert.equal(out.includes('spk_env'), false);
  assert.equal(out.includes('spk_file'), false);
});

test('logout removes the token when the API is down', async () => {
  const home = homeOf();
  const token = 'spk_logout_secret';
  writeCredentials({ token, user: { name: 'Ada' } }, { home });
  const cloud = createCloud({ env: { SPOOKLING_API_URL: 'http://127.0.0.1:9' }, timeoutMs: 800 });
  const notes = [];
  let out = '';
  const code = await logout({
    home, env: {}, cloud, write: (s) => { out += s; }, log: (m) => notes.push(m),
  });
  assert.equal(code, 0);
  assert.equal(readCredentials({ home, env: {} }).token, null);
  const left = existsSync(join(home, '.spookling', 'credentials.json'))
    ? readFileSync(join(home, '.spookling', 'credentials.json'), 'utf8') : '';
  assert.equal(left.includes(token), false);
  assert.equal(`${out}\n${notes.join('\n')}`.includes(token), false);
  assert.match(out, /Logged out/);
});

test('login prints the API verification URI, waits on 429, and saves mode 0600', async () => {
  const token = 'spk_approved_secret';
  const deviceCode = 'device-code-not-for-stdout';
  const uri = 'http://127.0.0.1:3000/cli?code=KQWZ-7TPD';
  let polls = 0;
  const seen = [];
  const server = await listen(async (req, res) => {
    const body = await readReq(req);
    seen.push({ url: req.url, body, auth: req.headers.authorization || null });
    if (req.url === '/cli/device/start') {
      return envelope(res, 200, { success: true, data: { deviceCode, userCode: 'KQWZ-7TPD', verificationUri: uri, interval: 1, expiresIn: 60 } });
    }
    if (req.url === '/cli/device/token') {
      polls += 1;
      if (polls === 1) {
        return envelope(res, 429, { success: false, error: { code: 'RATE_LIMITED', message: 'slow down', details: {} } }, { 'retry-after': '2' });
      }
      if (polls === 2) return envelope(res, 200, { success: true, data: { status: 'pending' } });
      return envelope(res, 200, { success: true, data: { status: 'approved', token, user: { id: 'u1', email: 'a@x.com', name: 'Ada' } } });
    }
    if (req.method === 'PUT' && req.url.startsWith('/memory/sessions/')) {
      return envelope(res, 200, { success: true, data: { id: 'u1:abc', clientId: 'abc' } });
    }
    if (req.method === 'POST' && req.url.endsWith('/turns')) {
      return envelope(res, 200, { success: true, data: { stored: body.turns.length, lastSeq: body.turns.at(-1).seq, turnCount: body.turns.length } });
    }
    return envelope(res, 404, { success: false, error: { code: 'NOT_FOUND', message: 'no', details: {} } });
  });
  const { port } = server.address();
  const home = homeOf();
  let t = 0;
  let out = '';
  const opened = [];
  try {
    const code = await login({
      home,
      cloud: createCloud({ env: { SPOOKLING_API_URL: `http://127.0.0.1:${port}` }, timeoutMs: 2000 }),
      sleep: async (ms) => { t += ms; },
      now: () => t,
      openUrl: (url) => opened.push(url),
      label: 'test-host',
      write: (s) => { out += s; },
    });
    assert.equal(code, 0);
    assert.equal(opened[0], uri);
    assert.ok(out.includes(uri));
    assert.match(out, /Confirm this code matches: KQWZ-7TPD/);
    assert.match(out, /Logged in as Ada/);
    assert.equal(out.includes(token), false);
    assert.equal(out.includes(deviceCode), false);
    const path = join(home, '.spookling', 'credentials.json');
    if (process.platform !== 'win32') assert.equal(modeOf(path), 0o600);
    const saved = readCredentials({ home, env: {} });
    assert.equal(saved.token, token);
    assert.equal(saved.apiUrl, `http://127.0.0.1:${port}`);
    assert.ok(t >= 3000, 'poll interval plus the 429 wait');

    const cloud = createCloud({ env: { SPOOKLING_API_URL: `http://127.0.0.1:${port}` }, token });
    const posted = await cloud.postTurns({
      sid: 'abc',
      turns: [{ seq: 0, role: 'user', text: 'hi', ts: '2026-11-03T09:00:12Z' }],
    });
    assert.equal(posted.stored, 1);
    assert.equal(seen.some((s) => s.url === '/memory/sessions/abc/turns' && s.auth === `Bearer ${token}`), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a 429 during login does not remove an existing token', async () => {
  const server = await listen(async (req, res) => {
    await readReq(req);
    if (req.url === '/cli/device/start') {
      return envelope(res, 200, {
        success: true,
        data: { deviceCode: 'd', userCode: 'AAAA-BBBB', verificationUri: 'http://127.0.0.1:3000/cli?code=AAAA-BBBB', interval: 1, expiresIn: 30 },
      });
    }
    return envelope(res, 429, { success: false, error: { code: 'RATE_LIMITED', message: 'wait', details: {} } }, { 'retry-after': '1' });
  });
  const { port } = server.address();
  const home = homeOf();
  writeCredentials({ token: 'spk_keep', user: { name: 'Ada' } }, { home });
  let t = 0;
  let polls = 0;
  try {
    const code = await login({
      home,
      cloud: createCloud({ env: { SPOOKLING_API_URL: `http://127.0.0.1:${port}` }, timeoutMs: 2000 }),
      sleep: async (ms) => {
        t += ms;
        if (ms === 1000) polls += 1;
        if (polls > 2) t = 999999;
      },
      now: () => t,
      openUrl: () => {},
      write: () => {},
    });
    assert.equal(code, 1);
    assert.equal(readCredentials({ home, env: {} }).token, 'spk_keep');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('init does not log in', async () => {
  const wizard = readFileSync(fileURLToPath(new URL('../src/wizard.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(wizard, /device\/start|credentials\.json/);
  let init = 0, logged = 0;
  const code = await main(['node', 'spookling', 'init', '--no-anim'], {
    home: homeOf(),
    init: async () => { init += 1; return 0; },
    login: async () => { logged += 1; return 9; },
    exit: () => {},
  });
  assert.equal(code, 0);
  assert.equal(init, 1);
  assert.equal(logged, 0);
  const help = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /spookling login/);
  assert.match(help.stdout, /init does not do this/);
  assert.match(help.stdout, /Advanced \(custom API, tokens for CI\): see the README/);
  assert.doesNotMatch(help.stdout, /SPOOKLING_API_URL|127\.0\.0\.1:4000/);
  assert.match(wizard, /linkCli/);
  assert.doesNotMatch(wizard, /from '\.\/account\.js'/);
  assert.doesNotMatch(wizard, /team-feed|\/memory\/orgs/);
});

test('the default API is used when SPOOKLING_API_URL is unset; a saved login is pinned to its origin', () => {
  const home = homeOf();
  assert.equal(apiBase({}, { home }), DEFAULT_API_URL);
  writeCredentials({ token: 'spk_saved', user: { name: 'Ada' }, apiUrl: 'https://saved.example/v1/' }, { home });
  assert.equal(apiBase({}, { home }), 'https://saved.example/v1');
  assert.equal(apiBase({ SPOOKLING_API_URL: 'http://127.0.0.1:4000/' }, { home }), 'https://saved.example/v1', 'the saved login stays pinned');
  assert.equal(apiBase({ SPOOKLING_API_URL: 'http://127.0.0.1:4000/' }, { home: homeOf() }), 'http://127.0.0.1:4000', 'with no login the env var chooses');
});

test('login with no env uses the default API and saves it', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const path = new URL(url).pathname;
    const data = path.endsWith('/cli/device/start')
      ? { deviceCode: 'dev', userCode: 'ABCD-EFGH', verificationUri: 'https://app.spookling.com/cli?code=ABCD-EFGH', interval: 1, expiresIn: 30 }
      : { status: 'approved', token: 'spk_default_secret', user: { name: 'Ada' } };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ success: true, data }) };
  };
  const home = homeOf();
  let t = 0;
  let out = '';
  const code = await login({
    home,
    env: {},
    cloud: createCloud({ env: {}, home, fetchImpl }),
    sleep: async (ms) => { t += ms; },
    now: () => t,
    openUrl: () => {},
    write: (s) => { out += s; },
  });
  assert.equal(code, 0);
  assert.equal(urls[0], `${DEFAULT_API_URL}/cli/device/start`);
  assert.equal(readCredentials({ home, env: {} }).apiUrl, DEFAULT_API_URL);
  assert.equal(readCredentials({ home, env: {} }).token, 'spk_default_secret');
  assert.equal(out.includes('spk_default_secret'), false);
  if (process.platform !== 'win32') assert.equal(modeOf(join(home, '.spookling', 'credentials.json')), 0o600);
});
