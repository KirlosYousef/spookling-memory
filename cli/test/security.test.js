import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  USER_AGENT, apiBase, clean, createCloud, DEFAULT_API_URL, loginBase, originWarning, validateOrigin,
} from '../src/cloud.js';
import { tmpHome } from './helpers.mjs';
import { readCredentials, setDefaultOrg, writeCredentials, writeFileSecure } from '../src/credentials.js';
import { login, openerCommand, orgs, safeVerificationUri, whoami } from '../src/account.js';
import { main } from '../src/main.js';

const homeOf = () => tmpHome('spk-sec-');
const ok = (data) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
const PKG = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));

test('origins: https only, http for localhost, 127.0.0.1 and [::1]; no embedded login', () => {
  assert.equal(validateOrigin('https://api.spookling.com/'), 'https://api.spookling.com');
  assert.equal(validateOrigin('https://x.test/v1/?a=1#h'), 'https://x.test/v1');
  for (const good of ['http://localhost:4000', 'http://127.0.0.1:4000', 'http://[::1]:4000']) assert.ok(validateOrigin(good), good);
  for (const bad of ['http://evil.example', 'http://127.0.0.1.evil.example', 'ftp://x.test', 'file:///etc/passwd', 'not a url', 'https://u:p@x.test', '']) {
    assert.throws(() => validateOrigin(bad), { code: 'BAD_API_URL' }, bad);
  }
});

test('a saved login is pinned: SPOOKLING_API_URL is ignored for authenticated calls', async () => {
  const home = homeOf();
  writeCredentials({ token: 'spk_saved', user: { name: 'Ada' }, apiUrl: 'https://api.good.test' }, { home });
  const env = { SPOOKLING_API_URL: 'https://evil.test' };
  assert.equal(apiBase(env, { home }), 'https://api.good.test');
  const urls = [];
  const cloud = createCloud({ env, home, fetchImpl: async (url) => { urls.push(String(url)); return ok({ orgs: [] }); } });
  await cloud.listOrgs();
  await cloud.postTurns({ sid: 's', turns: [] });
  assert.ok(urls.every((u) => u.startsWith('https://api.good.test/')), urls.join(' '));
  assert.match(originWarning(env, { home }), /^Ignoring SPOOKLING_API_URL \(https:\/\/evil\.test\): your login is pinned to https:\/\/api\.good\.test\./);
  assert.equal(originWarning({ SPOOKLING_API_URL: 'https://api.good.test/' }, { home }), null);
  assert.equal(originWarning({}, { home }), null);
});

test('a saved token without a saved origin is pinned to the shipped app', () => {
  const home = homeOf();
  writeCredentials({ token: 'spk_old' }, { home });
  assert.equal(apiBase({ SPOOKLING_API_URL: 'https://evil.test' }, { home }), DEFAULT_API_URL);
});

test('a saved http origin that is not local is refused', () => {
  const home = homeOf();
  writeCredentials({ token: 'spk_bad', apiUrl: 'http://evil.example' }, { home });
  assert.throws(() => apiBase({}, { home }), { code: 'BAD_API_URL' });
});

test('SPOOKLING_TOKEN pairs only with an explicit https SPOOKLING_API_URL', () => {
  const home = homeOf();
  writeCredentials({ token: 'spk_file', apiUrl: 'https://api.good.test' }, { home });
  assert.throws(() => apiBase({ SPOOKLING_TOKEN: 'spk_env' }, { home }), { code: 'NO_API' });
  assert.throws(() => apiBase({ SPOOKLING_TOKEN: 'spk_env', SPOOKLING_API_URL: 'http://evil.example' }, { home }), { code: 'BAD_API_URL' });
  assert.equal(apiBase({ SPOOKLING_TOKEN: 'spk_env', SPOOKLING_API_URL: 'https://api.mine.test/' }, { home }), 'https://api.mine.test');
  assert.equal(originWarning({ SPOOKLING_TOKEN: 'spk_env', SPOOKLING_API_URL: 'https://api.mine.test' }, { home }), null);
});

test('login chooses its origin: env var, --api-url, else saved, else the shipped app; it is saved with the token', async () => {
  const home = homeOf();
  assert.equal(loginBase({}, { home }), DEFAULT_API_URL);
  assert.equal(loginBase({ SPOOKLING_API_URL: 'https://env.test' }, { home }), 'https://env.test');
  assert.equal(loginBase({ SPOOKLING_API_URL: 'https://env.test' }, { home, apiUrl: 'https://flag.test' }), 'https://flag.test');
  assert.throws(() => loginBase({}, { home, apiUrl: 'http://evil.example' }), { code: 'BAD_API_URL' });

  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const path = new URL(url).pathname;
    if (path === '/cli/device/start') return ok({ deviceCode: 'd', userCode: 'AAAA-BBBB', verificationUri: 'https://flag.test/cli', interval: 1, expiresIn: 60 });
    if (path === '/cli/device/token') return ok({ status: 'approved', token: 'spk_new', user: { name: 'Ada' } });
    return ok({ orgs: [] });
  };
  let out = '';
  const code = await login({
    home, env: { SPOOKLING_API_URL: 'https://env.test' }, apiUrl: 'https://flag.test', sleep: async () => {}, openUrl: () => true,
    cloud: createCloud({ env: { SPOOKLING_API_URL: 'https://env.test' }, home, fetchImpl, loginUrl: 'https://flag.test' }), write: (s) => { out += s; },
  });
  assert.equal(code, 0, out);
  assert.ok(urls.every((u) => u.startsWith('https://flag.test/')), urls.join(' '));
  assert.equal(readCredentials({ home, env: {} }).apiUrl, 'https://flag.test');
});

test('login refuses an http non-local origin before sending anything', async () => {
  const home = homeOf();
  let out = '', hit = 0;
  const code = await login({
    home, env: {}, apiUrl: 'http://evil.example', write: (s) => { out += s; },
    cloud: createCloud({ env: {}, home, loginUrl: 'http://evil.example', fetchImpl: async () => { hit += 1; return ok({}); } }),
  });
  assert.equal(code, 1);
  assert.equal(hit, 0);
  assert.match(out, /must be https/);
});

test('--api-url is only for login and needs a value', async () => {
  const run = (args, deps = {}) => { let got; return main(['node', 'spookling', ...args], { home: homeOf(), cwd: homeOf(), exit: () => {}, login: async (o) => { got = o; return 0; }, ...deps }).then((code) => ({ code, got })); };
  const w = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal((await run(['login', '--api-url', 'https://x.test'])).got.apiUrl, 'https://x.test');
    assert.equal((await run(['login', '--api-url=https://y.test'])).got.apiUrl, 'https://y.test');
    assert.equal((await run(['login', '--api-url'])).code, 2);
    assert.equal((await run(['status', '--api-url', 'https://x.test'], { status: async () => 0 })).code, 2);
  } finally { process.stderr.write = w; }
});

test('the sign-in link is opened only on the API host, spookling.com, or this machine', () => {
  const api = 'https://api.spookling.com';
  assert.ok(safeVerificationUri('https://app.spookling.com/cli?code=A', api));
  assert.ok(safeVerificationUri('https://api.spookling.com/cli', api));
  assert.ok(safeVerificationUri('http://127.0.0.1:3000/cli?code=A', 'http://127.0.0.1:4000'));
  assert.ok(safeVerificationUri('https://app.acme.test/x', 'https://app.acme.test'));
  for (const bad of ['https://evil.example/cli', 'https://spookling.com.evil.example/', 'http://app.spookling.com/cli', 'javascript:alert(1)',
    'file:///etc/passwd', 'https://user:pw@app.spookling.com/', 'http://127.0.0.1:3000/cli', 'nonsense', '']) {
    assert.equal(safeVerificationUri(bad, api), null, bad);
  }
  assert.equal(safeVerificationUri('https://app.spookling.com/', 'https://api.acme.test'), null, 'a spookling.com link needs a spookling.com API');
});

test('openers: Windows uses rundll32, never cmd /c start', () => {
  assert.deepEqual(openerCommand('https://a.test/x?a=1&b=2', 'win32'), { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', 'https://a.test/x?a=1&b=2'] });
  assert.deepEqual(openerCommand('https://a.test', 'darwin'), { cmd: 'open', args: ['https://a.test'] });
  assert.deepEqual(openerCommand('https://a.test', 'linux'), { cmd: 'xdg-open', args: ['https://a.test'] });
});

test('login does not open a link on another host and says so', async () => {
  const home = homeOf();
  const opened = [];
  let out = '';
  const cloud = {
    base: () => 'https://api.spookling.com',
    deviceStart: async () => ({ deviceCode: 'd', userCode: 'AAAA-BBBB', verificationUri: 'https://evil.example/cli?code=AAAA-BBBB', interval: 1, expiresIn: 60 }),
    pollToken: async () => ({ status: 'denied' }),
  };
  await login({ home, env: {}, cloud, sleep: async () => {}, openUrl: (u) => { opened.push(u); return true; }, write: (s) => { out += s; } });
  assert.deepEqual(opened, []);
  assert.match(out, /^Warning: this sign-in link is not on api\.spookling\.com or spookling\.com, so it was not opened\. Check it before you visit it:\n  https:\/\/evil\.example/);
});

test('credential writes are atomic, private, and refuse a symlink', { skip: process.platform === 'win32' && 'POSIX modes and symlinks' }, () => {
  const home = homeOf();
  const path = writeCredentials({ token: 'spk_a', user: { name: 'Ada' } }, { home });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, '.spookling')).mode & 0o777, 0o700);
  // an existing, too-open file is tightened and replaced; no temp file is left
  writeFileSync(path, '{}', { mode: 0o644 });
  writeCredentials({ token: 'spk_b', user: { name: 'Ada' } }, { home });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readCredentials({ home, env: {} }).token, 'spk_b');
  assert.equal(setDefaultOrg({ id: 'o', name: 'O' }, { home }), true);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const stray = (dir) => spawnSync('ls', [dir], { encoding: 'utf8' }).stdout.split('\n').filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(stray(join(home, '.spookling')), []);

  // a symlink planted at the target is not followed
  const victim = join(home, 'victim.txt');
  writeFileSync(victim, 'keep me');
  const home2 = homeOf();
  mkdirSync(join(home2, '.spookling'), { recursive: true });
  symlinkSync(victim, join(home2, '.spookling', 'credentials.json'));
  assert.throws(() => writeCredentials({ token: 'spk_c' }, { home: home2 }), /symlink/);
  assert.equal(readFileSync(victim, 'utf8'), 'keep me');
  assert.equal(lstatSync(join(home2, '.spookling', 'credentials.json')).isSymbolicLink(), true);
  assert.throws(() => writeFileSecure(join(home2, '.spookling', 'credentials.json'), 'x'), /symlink/);
});

test('every request says who is asking, redirects are refused', async () => {
  assert.equal(USER_AGENT, `spookling/${PKG.version} (${process.platform}; node/${process.versions.node})`);
  const seen = [];
  const cloud = createCloud({ env: { SPOOKLING_API_URL: 'https://api.t.test' }, home: homeOf(), token: undefined,
    fetchImpl: async (url, opts) => { seen.push({ url: String(url), headers: opts.headers, redirect: opts.redirect }); return ok({}); } });
  await cloud.deviceStart({ label: 'x' });
  await cloud.pollToken({ deviceCode: 'd' });
  const authed = createCloud({ env: { SPOOKLING_API_URL: 'https://api.t.test' }, home: homeOf(), token: 'spk_x',
    fetchImpl: async (url, opts) => { seen.push({ url: String(url), headers: opts.headers, redirect: opts.redirect }); return ok({}); } });
  await authed.listOrgs();
  assert.equal(seen.length, 3);
  for (const s of seen) {
    assert.equal(s.headers['user-agent'], USER_AGENT, s.url);
    assert.equal(s.redirect, 'error', s.url);
  }
  assert.match(seen[0].url, /device\/start$/);
});

test('control characters are stripped from server text, newlines stay', async () => {
  assert.equal(clean('a\x1b[31mred\x1b[0m\x07b‮c\u0000\nd'), 'a[31mred[0mb' + 'c\nd');
  const home = homeOf();
  writeCredentials({ token: 't', user: { name: 'Ev\x1b[2Jil', email: 'e@x.test' }, apiUrl: 'https://api.good.test' }, { home });
  let out = '';
  whoami({ home, env: {}, write: (s) => { out += s; } });
  assert.equal(out.includes('\x1b'), false);
  out = '';
  await orgs({ home, env: {}, write: (s) => { out += s; },
    cloud: { listOrgs: async () => ({ orgs: [{ org: { id: 'o\x1b1', name: 'Acme\x1b]0;pwn\x07' }, membership: { status: 'active' } }] }) } });
  assert.equal(out, 'o1  Acme]0;pwn\n');
});
