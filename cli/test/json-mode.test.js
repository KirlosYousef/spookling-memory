// --json (the Mac app's machine mode): stdout is only NDJSON, nothing is asked, the key never shows up outside keys.env,
// a key is checked before anything is wired, and every run ends with exactly one result event.
// Each run is a child process with a temp HOME, a stub `uv` and `claude` on PATH, a stub fetch (no network) and a stub
// /v1/stats server on a free port, so nothing real is touched.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN, envelope, listen, tmpHome } from './helpers.mjs';
import { claudeDesktopConfigPath } from '../src/hooks.js';

const KEY = 'sk-or-v1-test-only-0123456789';
const EVENT_TYPES = new Set(['step', 'info', 'warn', 'device', 'error', 'result']);

let stats;
let port;
let bin;
const stubs = [];

before(async () => {
  stats = await listen((req, res) => envelope(res, 200, { n_events: 0, n_facts: 0, n_rows: 0, reset: null }));
  port = stats.address().port;
  bin = tmpHome('spk-bin-');
  for (const name of ['uv', 'claude']) {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} 0.0.0-test"\nexit 0\n`);
    chmodSync(file, 0o755);
  }
});
after(() => { stats?.close(); });

// a module preloaded into each run: fetch answers as `body` with `status`, or fails the way a dropped network does
function fetchStub({ status = 200, body = {}, fail = false } = {}) {
  const dir = tmpHome('spk-fetch-');
  const file = join(dir, 'stub-fetch.mjs');
  const impl = fail
    ? 'async () => { throw new TypeError("fetch failed"); }'
    : `async () => new Response(${JSON.stringify(JSON.stringify(body))}, { status: ${status}, headers: { 'content-type': 'application/json' } })`;
  writeFileSync(file, `globalThis.fetch = ${impl};\n`);
  stubs.push(dir);
  return file;
}

// port: the stats server to probe; a closed port (1) means "no server running"
function run(args, { home, stdin = '', fetch, closedPort = false } = {}) {
  return new Promise((resolve) => {
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, SPOOKLING_INIT_PORT: String(closedPort ? 1 : port), NO_COLOR: '1', CI: '1' };
    if (fetch) env.NODE_OPTIONS = `--import ${fetch}`;
    const child = spawn(process.execPath, [BIN, ...args], { env, cwd: home });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr, events: parse(stdout) }));
    child.stdin.end(stdin);
  });
}

// every stdout line is one JSON event: anything else is a failure of the contract
function parse(stdout) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    const e = JSON.parse(line);
    assert.equal(e.v, 1, 'every event carries the protocol version');
    assert.ok(EVENT_TYPES.has(e.type), `known event type: ${e.type}`);
    return e;
  });
}

const results = (events) => events.filter((e) => e.type === 'result');
const errors = (events) => events.filter((e) => e.type === 'error');
const keysFile = (home) => join(home, '.memory', 'keys.env');

test('status --json on an empty home: one result, not healthy, nothing written', async () => {
  const home = tmpHome();
  const r = await run(['status', '--json'], { home, closedPort: true });
  assert.equal(r.code, 1);
  assert.equal(results(r.events).length, 1);
  const [res] = results(r.events);
  assert.equal(res.ok, false);
  assert.equal(res.data.healthy, false);
  assert.equal(res.data.server.up, false);
  assert.deepEqual(res.data.harnesses, { claude: false, claudeDesktop: false, codex: false });
  assert.equal(res.data.plan, 'unknown');
  assert.equal(existsSync(join(home, '.memory')), false);
});

test('init --json for the desktop app: NDJSON only, the key stays in keys.env (0600), MCP uses an absolute uv', async () => {
  const home = tmpHome();
  const r = await run(['init', '--json', '--keys', '--harness', 'claude-desktop', '--key-stdin'],
    { home, stdin: KEY, fetch: fetchStub({ body: { data: { limit_remaining: null } } }) });
  assert.equal(r.code, 0, r.stderr);
  // stdout is the event stream and nothing else; the human text went to stderr
  assert.ok(r.events.length > 0);
  assert.equal(r.stdout.trim().split('\n').length, r.events.length);
  // golden order: every stage starts and ends, then the one result
  const seq = r.events.filter((e) => e.type === 'step').map((e) => `${e.id}:${e.status}`);
  assert.deepEqual(seq, ['checks:start', 'checks:ok', 'harness:start', 'harness:ok', 'tagger:start', 'tagger:ok',
    'server:start', 'server:ok', 'wire:start', 'wire:ok', 'smoke:start', 'smoke:ok', 'done:start', 'done:ok']);
  assert.equal(r.events.at(-1).type, 'result');
  const [res] = results(r.events);
  assert.equal(res.ok, true);
  assert.equal(res.data.harnesses[0].harness, 'claude-desktop');
  // the key is nowhere but the file: not in the events, not in the human text
  assert.equal(r.stdout.includes(KEY), false);
  assert.equal(r.stderr.includes(KEY), false);
  assert.ok(readFileSync(keysFile(home), 'utf8').includes(`OPENROUTER_API_KEY=${KEY}`));
  assert.equal(statSync(keysFile(home)).mode & 0o777, 0o600);
  // the desktop config names the uv binary by absolute path, as a GUI launch needs
  const cfg = JSON.parse(readFileSync(claudeDesktopConfigPath(home), 'utf8'));
  assert.equal(cfg.mcpServers['spookling-memory'].command, join(bin, 'uv'));
});

test('a key the provider refuses stops the run before any file is written', async () => {
  const home = tmpHome();
  const r = await run(['init', '--json', '--keys', '--harness', 'claude-desktop', '--key-stdin'],
    { home, stdin: KEY, fetch: fetchStub({ status: 401, body: { error: 'nope' } }) });
  assert.equal(r.code, 1);
  assert.equal(errors(r.events)[0].code, 'KEY_INVALID');
  assert.equal(results(r.events)[0].ok, false);
  assert.equal(existsSync(keysFile(home)), false);
  assert.equal(existsSync(claudeDesktopConfigPath(home)), false);
  assert.equal(r.stdout.includes(KEY), false);
});

test('a key with no credit left is KEY_NO_CREDIT', async () => {
  const home = tmpHome();
  const r = await run(['init', '--json', '--keys', '--harness', 'claude-desktop', '--key-stdin'],
    { home, stdin: KEY, fetch: fetchStub({ body: { data: { limit_remaining: 0 } } }) });
  assert.equal(r.code, 1);
  assert.equal(errors(r.events)[0].code, 'KEY_NO_CREDIT');
  assert.equal(existsSync(keysFile(home)), false);
});

test('a network failure while checking the key is KEY_CHECK_FAILED and writes nothing', async () => {
  const home = tmpHome();
  const r = await run(['init', '--json', '--keys', '--harness', 'claude-desktop', '--key-stdin'],
    { home, stdin: KEY, fetch: fetchStub({ fail: true }) });
  assert.equal(r.code, 1);
  assert.equal(errors(r.events)[0].code, 'KEY_CHECK_FAILED');
  assert.equal(existsSync(keysFile(home)), false);
});

test('no key anywhere: MISSING_INPUT names the field, and nothing is asked', async () => {
  const home = tmpHome();
  const r = await run(['init', '--json', '--keys', '--harness', 'claude-desktop'], { home, stdin: '' });
  assert.equal(r.code, 1);
  const err = errors(r.events)[0];
  assert.equal(err.code, 'MISSING_INPUT');
  assert.equal(err.field, 'OPENROUTER_API_KEY');
  assert.equal(existsSync(keysFile(home)), false);
});

test('cloud mode without a saved login is NOT_LOGGED_IN', async () => {
  const home = tmpHome();
  const r = await run(['init', '--json', '--cloud', '--harness', 'claude-desktop'], { home });
  assert.equal(r.code, 1);
  assert.equal(errors(r.events)[0].code, 'NOT_LOGGED_IN');
  assert.equal(results(r.events)[0].ok, false);
});

test('cloud mode with a saved login reaches the done stage', async () => {
  const home = tmpHome();
  mkdirSync(join(home, '.spookling'), { recursive: true });
  writeFileSync(join(home, '.spookling', 'credentials.json'),
    JSON.stringify({ token: 'spk_test_only', user: { email: 'tester@example.test' }, apiUrl: 'https://api.example.test' }));
  const r = await run(['init', '--json', '--cloud', '--harness', 'claude-desktop'],
    { home, fetch: fetchStub({ body: { success: true, data: { orgs: [] } } }) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(results(r.events)[0].data.mode, 'cloud');
  assert.equal(r.stdout.includes('spk_test_only'), false);
});

test('usage mistakes exit 2 with one USAGE error and one result', async () => {
  const home = tmpHome();
  const cases = [
    ['init', '--json', '--cloud', '--keys'],
    ['init', '--json', '--harness', 'vim'],
    ['init', '--json', '--node', 'node'],
    ['init', '--json', '--allow-share', '--no-allow-share'],
    ['sessions', '--json'],
  ];
  for (const args of cases) {
    const r = await run(args, { home });
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(errors(r.events)[0].code, 'USAGE', args.join(' '));
    assert.equal(results(r.events).length, 1, args.join(' '));
  }
});

test('a key for another tagger is a usage error, not a wrong install', async () => {
  const home = tmpHome();
  const r = await run(['init', '--json', '--keys', '--tagger', 'anthropic', '--harness', 'claude-desktop', '--key-stdin'],
    { home, stdin: KEY });
  assert.equal(r.code, 2);
  assert.equal(errors(r.events)[0].code, 'USAGE');
  assert.equal(existsSync(keysFile(home)), false);
});

test('uninstall --json removes the desktop entry and returns one result', async () => {
  const home = tmpHome();
  const install = await run(['init', '--json', '--keys', '--harness', 'claude-desktop', '--key-stdin'],
    { home, stdin: KEY, fetch: fetchStub({ body: { data: { limit_remaining: null } } }) });
  assert.equal(install.code, 0, install.stderr);
  const r = await run(['uninstall', '--json', '--scope', 'user'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(results(r.events)[0].ok, true);
  const cfg = JSON.parse(readFileSync(claudeDesktopConfigPath(home), 'utf8'));
  assert.equal(cfg.mcpServers?.['spookling-memory'], undefined);
});

test('prepare --json copies the engine out and syncs it, with one result', async () => {
  const home = tmpHome();
  const r = await run(['prepare', '--json'], { home });
  assert.equal(r.code, 0, r.stderr);
  const [res] = results(r.events);
  assert.equal(res.ok, true);
  assert.ok(existsSync(join(res.data.engine, 'server', 'pyproject.toml')));
});

test('serve without --foreground is a usage error, not a server start', async () => {
  const home = tmpHome();
  const r = await run(['serve'], { home });
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '');
});

test('login --json --no-browser: a device event with the code, then one result; the token is saved and never printed', async () => {
  const home = tmpHome();
  // a stub API: the device starts, is approved on the first poll, and has no orgs
  let base = '';
  const api = await listen(async (req, res) => {
    if (req.url === '/cli/device/start') return envelope(res, 200, { success: true, data: { deviceCode: 'dev-test', userCode: 'ABCD-EFGH', verificationUri: `${base}/cli?code=ABCD-EFGH`, expiresIn: 600, interval: 1 } });
    if (req.url === '/cli/device/token') return envelope(res, 200, { success: true, data: { status: 'approved', token: 'spk_device_test_only', user: { email: 'tester@example.test' } } });
    if (req.url === '/cli/orgs') return envelope(res, 200, { success: true, data: { orgs: [] } });
    return envelope(res, 404, { success: false, error: { code: 'NOT_FOUND' } });
  });
  base = `http://127.0.0.1:${api.address().port}`;
  try {
    const r = await run(['login', '--json', '--no-browser', '--api-url', base, '--client', 'Spookling for Mac/1.0 (test)'], { home });
    assert.equal(r.code, 0, r.stderr);
    const device = r.events.find((e) => e.type === 'device');
    assert.ok(device, 'a device event is emitted');
    assert.equal(device.userCode, 'ABCD-EFGH');
    assert.match(device.verificationUri, /\/cli\?code=ABCD-EFGH$/);
    assert.equal(results(r.events)[0].ok, true);
    assert.equal(r.stdout.includes('spk_device_test_only'), false);
    assert.equal(r.stderr.includes('spk_device_test_only'), false);
    const creds = JSON.parse(readFileSync(join(home, '.spookling', 'credentials.json'), 'utf8'));
    assert.equal(creds.token, 'spk_device_test_only');
  } finally {
    api.close();
  }
});

test('Claude Code (project scope): every hook runs the --node path given, and the run is ok', async () => {
  const home = tmpHome();
  const node = process.execPath; // an absolute path, as the app passes it
  const r = await run(['init', '--json', '--keys', '--harness', 'claude', '--scope', 'project', '--node', node, '--key-stdin'],
    { home, stdin: KEY, fetch: fetchStub({ body: { data: { limit_remaining: null } } }) });
  const [res] = results(r.events);
  assert.equal(res.data.harnesses[0].harness, 'claude');
  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  const commands = Object.values(settings.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(commands.length >= 4, 'the hooks are wired');
  for (const c of commands) assert.equal(c, node);
  assert.ok(existsSync(join(home, '.mcp.json')), 'the project MCP entry is written');
  assert.equal(r.stdout.includes(KEY), false);
});
