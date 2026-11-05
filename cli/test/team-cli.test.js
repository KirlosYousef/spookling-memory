import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { readCredentials, writeCredentials } from '../src/credentials.js';
import { createCloud, DEFAULT_API_URL } from '../src/cloud.js';
import { login, logout, orgs, whoami } from '../src/account.js';
import { teamMemoryHook } from '../src/push.js';
import { install, linkCli, status } from '../src/wizard.js';
import { tmpHome, listen, envelope, readReq, waitFor, runHook, ROOT, modeOf, projectWithLog, hookEnv } from './helpers.mjs';

const homeOf = () => tmpHome('spk-cli-');

test('init links a spookling command and does not log in', { skip: process.platform === 'win32' && 'POSIX shim' }, () => {
  const home = homeOf();
  const to = join(tmpHome('spk-inst-'), '0.1.3');
  install(ROOT, to);
  const cmd = linkCli(to, home);
  assert.equal(cmd, join(home, '.local', 'bin', 'spookling'));
  assert.equal(modeOf(cmd), 0o755);
  assert.equal(existsSync(join(home, '.spookling', 'credentials.json')), false);
  const ran = spawnSync(cmd, ['--help'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
  });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /spookling login/);
  assert.match(ran.stdout, /init does not do this/);
  assert.equal(existsSync(join(home, '.spookling', 'credentials.json')), false);
});

test('init copies the uploader next to the hooks', async () => {
  const to = join(tmpHome('spk-inst-'), '0.1.3');
  install(ROOT, to);
  assert.equal(existsSync(join(to, 'hooks', 'stop.js')), true);
  assert.equal(existsSync(join(to, 'hooks', 'upload-session.cjs')), true);
  assert.equal(existsSync(join(to, 'hooks', 'lib', 'push.js')), true);
  assert.equal(JSON.parse(readFileSync(join(to, 'hooks', 'lib', 'package.json'), 'utf8')).type, 'module');
  const home = homeOf();
  writeCredentials({ token: 'spk_copied', user: { name: 'Ada' } }, { home });
  const { project, logPath, before } = projectWithLog(home);
  const ran = await runHook(join(to, 'hooks', 'stop.js'), { hook_event_name: 'Stop', session_id: 'abc', cwd: project }, hookEnv(home, project, 'http://127.0.0.1:9'));
  assert.equal(ran.code, 0);
  assert.equal(ran.out, '');
  const state = await waitFor(() => {
    const path = join(home, '.spookling', 'upload-state.json');
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  });
  assert.match(state, /Make the sync idempotent/);
  assert.deepEqual(readFileSync(logPath), before);
});

function memoryApi(seen) {
  return listen(async (req, res) => {
    const body = await readReq(req);
    seen.push(req.url);
    if (req.method === 'PUT' && req.url.startsWith('/memory/sessions/')) {
      return envelope(res, 200, { success: true, data: { id: 'u1:abc' } });
    }
    if (req.method === 'POST' && req.url.endsWith('/turns')) {
      return envelope(res, 200, { success: true, data: { stored: body.turns.length, lastSeq: body.turns.at(-1).seq, turnCount: body.turns.length } });
    }
    if (req.method === 'DELETE' && req.url === '/cli/tokens/current') return envelope(res, 204, null);
    if (req.method === 'GET' && req.url === '/cli/orgs') return envelope(res, 200, { success: true, data: { orgs: [] } });
    return envelope(res, 404, { success: false, error: { code: 'NOT_FOUND', message: 'no', details: {} } });
  });
}

test('upload uses apiUrl from credentials when SPOOKLING_API_URL is unset and flushes the queue', async () => {
  const seen = [];
  const server = await memoryApi(seen);
  const { port } = server.address();
  const home = homeOf();
  const api = `http://127.0.0.1:${port}`;
  const token = 'spk_file_url';
  writeCredentials({ token, user: { name: 'Ada' }, apiUrl: `${api}/` }, { home });
  const { project, logPath } = projectWithLog(home);
  mkdirSync(join(home, '.spookling'), { recursive: true });
  writeFileSync(join(home, '.spookling', 'upload-state.json'), `${JSON.stringify({
    cursors: {},
    skipped: {},
    queue: [{
      sid: 'queued',
      session: { agent: 'claude-code', project: 'spookling-memory', title: 'queued earlier', startedAt: '2026-11-03T08:00:00Z' },
      turns: [{ seq: 0, role: 'user', text: 'from the queue', ts: '2026-11-03T08:00:00Z' }],
    }],
  })}\n`);
  try {
    const result = await teamMemoryHook({
      logPath, home, env: {}, project: 'spookling-memory', log: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.queued, false);
    assert.equal(result.pushed, 2);
    assert.equal(seen.includes('/memory/sessions/queued/turns'), true);
    assert.equal(seen.includes('/memory/sessions/abc/turns'), true);
    assert.equal(readCredentials({ home, env: {} }).apiUrl, api);
    assert.equal(readCredentials({ home, env: {} }).token, token);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('SPOOKLING_API_URL cannot move a saved token: the upload goes to the saved origin only', async () => {
  const seen = [], attacked = [];
  const server = await memoryApi(seen);
  const attacker = await listen((req, res) => { attacked.push(req.url); envelope(res, 200, { success: true, data: {} }); });
  const home = homeOf();
  writeCredentials({ token: 'spk_override', user: { name: 'Ada' }, apiUrl: `http://127.0.0.1:${server.address().port}` }, { home });
  const { logPath } = projectWithLog(home);
  try {
    const result = await teamMemoryHook({
      logPath,
      home,
      env: { SPOOKLING_API_URL: `http://127.0.0.1:${attacker.address().port}` },
      project: 'spookling-memory',
      log: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(seen.includes('/memory/sessions/abc/turns'), true);
    assert.deepEqual(attacked, [], 'nothing reached the host the env var named');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => attacker.close(resolve));
  }
});

test('upload with no saved URL uses the default API and does not throw', async () => {
  const home = homeOf();
  const token = 'spk_no_url';
  writeCredentials({ token, user: { name: 'Ada' } }, { home });
  const { logPath } = projectWithLog(home);
  const urls = [];
  const fetchImpl = async (url) => { urls.push(String(url)); throw new Error('offline'); };
  const notes = [];
  const result = await teamMemoryHook({
    logPath, home, env: {}, project: 'spookling-memory',
    cloud: createCloud({ env: {}, home, fetchImpl, timeoutMs: 500 }),
    log: (m) => notes.push(m),
  });
  assert.equal(result.ok, false);
  assert.equal(result.queued, true);
  assert.equal(urls[0].startsWith(`${DEFAULT_API_URL}/`), true);
  assert.doesNotMatch(notes.join('\n'), /NO_API/);
  assert.match(readFileSync(join(home, '.spookling', 'upload-state.json'), 'utf8'), /Make the sync idempotent/);
  assert.equal(readCredentials({ home, env: {} }).token, token);
  let out = '';
  assert.equal(whoami({ home, env: {}, write: (s) => { out += s; } }), 0);
  assert.match(out, /Ada/);
});

test('logout and orgs use saved apiUrl when the env var is unset', async () => {
  const seen = [];
  const server = await memoryApi(seen);
  const { port } = server.address();
  const home = homeOf();
  const api = `http://127.0.0.1:${port}`;
  writeCredentials({ token: 'spk_logout_url', user: { name: 'Ada' }, apiUrl: api }, { home });
  try {
    let out = '';
    const code = await logout({ home, env: {}, write: (s) => { out += s; }, log: () => {} });
    assert.equal(code, 0);
    assert.match(out, /Logged out/);
    assert.equal(seen.includes('/cli/tokens/current'), true);
    assert.equal(readCredentials({ home, env: {} }).token, null);
    assert.equal(readCredentials({ home, env: {} }).apiUrl, api);
    writeCredentials({ token: 'spk_refresh_url', user: { name: 'Ada' }, apiUrl: api }, { home });
    let orgsOut = '';
    await orgs({ home, env: {}, write: (s) => { orgsOut += s; } });
    assert.match(orgsOut, /not in an org/);
    assert.equal(seen.includes('/cli/orgs'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the installed stop hook uploads with saved apiUrl and no shell URL', async () => {
  const seen = [];
  const server = await memoryApi(seen);
  const { port } = server.address();
  const to = join(tmpHome('spk-inst-'), '0.1.3');
  install(ROOT, to);
  const home = homeOf();
  const api = `http://127.0.0.1:${port}`;
  writeCredentials({ token: 'spk_hook_url', user: { name: 'Ada' }, apiUrl: api }, { home });
  const { project, logPath, before } = projectWithLog(home);
  mkdirSync(join(home, '.spookling'), { recursive: true });
  writeFileSync(join(home, '.spookling', 'upload-state.json'), `${JSON.stringify({
    cursors: {},
    skipped: {},
    queue: [{
      sid: 'queued',
      session: { agent: 'claude-code', project: 'spookling-memory', title: 'queued earlier', startedAt: '2026-11-03T08:00:00Z' },
      turns: [{ seq: 0, role: 'user', text: 'from the queue', ts: '2026-11-03T08:00:00Z' }],
    }],
  })}\n`);
  const env = hookEnv(home, project, api);
  delete env.SPOOKLING_API_URL;
  try {
    const ran = await runHook(join(to, 'hooks', 'stop.js'), { hook_event_name: 'Stop', session_id: 'abc', cwd: project }, env);
    assert.equal(ran.code, 0);
    assert.equal(ran.out, '');
    const hit = await waitFor(() => (
      seen.includes('/memory/sessions/abc/turns') && seen.includes('/memory/sessions/queued/turns') ? seen.join('\n') : ''
    ));
    assert.match(hit || '', /\/memory\/sessions\/abc\/turns/);
    assert.match(hit || '', /\/memory\/sessions\/queued\/turns/);
    assert.deepEqual(readFileSync(logPath), before);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
