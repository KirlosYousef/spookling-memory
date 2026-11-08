import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpHome } from './helpers.mjs';
import { compareVersions, cachedNotice, isSemver, latestVersion, updateAvailable } from '../src/registry.js';
import { update } from '../src/update.js';
import { main } from '../src/main.js';
import { whoami } from '../src/account.js';
import { TAGGERS, VERSION, detectInstall, serverVersion, status, stopOldServers } from '../src/wizard.js';
import {
  addHooks, addMcp, addStatusLine, claudeDesktopConfigPath, codexHandlers, codexHooksPath, hookHandlers, mcpEntry, mcpPath, settingsPath,
} from '../src/hooks.js';

const BIN = fileURLToPath(new URL('../../bin/spookling-memory.js', import.meta.url));
const tmp = (p = 'spk-up-') => tmpHome(p);
const collect = () => { const lines = []; return { lines, write: (s) => lines.push(s) }; };
const text = (c) => c.lines.join('');

// ---- versions and the registry

test('semver: parsed, ordered, pre-releases before releases', () => {
  assert.equal(isSemver('0.2.1'), true);
  for (const bad of ['', '1.2', 'v1.2.3', '1.2.3.4', 'latest', '1.2.x', undefined]) assert.equal(isSemver(bad), false, String(bad));
  assert.equal(compareVersions('0.2.1', '0.2.0'), 1);
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1);
});

const registry = (version, { status = 200 } = {}) => async (url) => {
  assert.equal(String(url), 'https://registry.npmjs.org/spookling/latest');
  return new Response(JSON.stringify({ version }), { status });
};

test('latestVersion: fetch first, npm view as the fallback, the reason when both fail', async () => {
  assert.equal(await latestVersion({ fetchImpl: registry('0.2.1') }), '0.2.1');
  const offline = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  const npm = (stdout, status = 0) => () => ({ status, stdout });
  assert.equal(await latestVersion({ fetchImpl: offline, run: npm('"0.3.0"\n') }), '0.3.0');
  await assert.rejects(latestVersion({ fetchImpl: offline, run: npm('', 1) }), /ENOTFOUND/);
  await assert.rejects(latestVersion({ fetchImpl: registry('0.2.1', { status: 503 }), run: npm('', 1) }), /registry answered 503/);
});

// ---- spookling update

const base = (extra = {}) => {
  const c = collect(), calls = [];
  return {
    c, calls,
    opts: {
      home: tmp(), cwd: tmp(), current: '0.2.0', write: c.write,
      lookup: async () => '0.2.0',
      run: (cmd, args, o) => { calls.push({ cmd, args, o }); return { status: 0 }; },
      isStale: () => false, detect: async () => ({ targets: [{}] }), reinit: async () => 0,
      ...extra,
    },
  };
};

test('update: up to date', async () => {
  const { c, calls, opts } = base();
  assert.equal(await update(opts), 0);
  assert.equal(text(c), 'spookling 0.2.0 is the latest.\n');
  assert.deepEqual(calls, []);
});

test('update: a newer version runs that version\'s init --update through npx', async () => {
  const { c, calls, opts } = base({ lookup: async () => '0.2.1' });
  assert.equal(await update(opts), 0);
  assert.equal(text(c), 'Updating spookling 0.2.0 → 0.2.1…\nRestart open Claude Code / Codex sessions to load the new version.\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'npx');
  assert.deepEqual(calls[0].args, ['--yes', 'spookling@0.2.1', 'init', '--update']);
  assert.equal(calls[0].o.cwd, opts.cwd);
  assert.equal(calls[0].o.stdio, 'inherit');
});

test('update --check: 0 when current, 10 when an update is available, nothing is run', async () => {
  let r = base({ check: true });
  assert.equal(await update(r.opts), 0);
  assert.match(text(r.c), /spookling 0\.2\.0 is the latest\./);
  r = base({ check: true, lookup: async () => '0.2.1' });
  assert.equal(await update(r.opts), 10);
  assert.match(text(r.c), /spookling 0\.2\.1 is available \(you have 0\.2\.0\)\. Run spookling update\./);
  assert.deepEqual(r.calls, []);
});

test('update: offline says so and exits 1', async () => {
  const { c, opts } = base({ lookup: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal(await update(opts), 1);
  assert.equal(text(c), "Couldn't check for updates (ENOTFOUND). Try again later, or run npx spookling@latest init.\n");
});

test('update: no npx, or an init that fails, prints the manual command and exits 1', async () => {
  let r = base({ lookup: async () => '0.2.1', run: () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }), status: null }) });
  assert.equal(await update(r.opts), 1);
  assert.match(text(r.c), /npx is not on your PATH\. Run this yourself: npx --yes spookling@0\.2\.1 init --update/);
  r = base({ lookup: async () => '0.2.1', run: () => ({ status: 3 }) });
  assert.equal(await update(r.opts), 1);
  assert.match(text(r.c), /did not finish \(npx exited 3\)\. Run npx spookling@latest init by hand\./);
  assert.doesNotMatch(text(r.c), /Restart/);
});

test('update --version: validated as semver; a downgrade needs --force', async () => {
  let r = base({ version: 'banana' });
  assert.equal(await update(r.opts), 2);
  assert.match(text(r.c), /--version takes a version like 1\.2\.3/);
  r = base({ version: '1.2' });
  assert.equal(await update(r.opts), 2);
  r = base({ version: '0.1.3', current: '0.2.0' });
  assert.equal(await update(r.opts), 1);
  assert.match(text(r.c), /Refusing to go from 0\.2\.0 to 0\.1\.3\. Add --force/);
  assert.deepEqual(r.calls, []);
  r = base({ version: '0.1.3', current: '0.2.0', force: true });
  assert.equal(await update(r.opts), 0);
  assert.deepEqual(r.calls[0].args, ['--yes', 'spookling@0.1.3', 'init', '--update']);
  r = base({ version: '0.3.0' });
  assert.equal(await update(r.opts), 0);
  assert.deepEqual(r.calls[0].args, ['--yes', 'spookling@0.3.0', 'init', '--update']);
});

test('update on the latest version still re-wires when the hooks use an older folder', async () => {
  const seen = [];
  let r = base({ isStale: () => true, reinit: async (o) => { seen.push(o.project); return 0; } });
  assert.equal(await update(r.opts), 0);
  assert.match(text(r.c), /is the latest\.\nYour hooks still use an older version folder; re-wiring them to this one\./);
  assert.deepEqual(seen, [r.opts.cwd]);
  assert.deepEqual(r.calls, []);
  seen.length = 0;
  r = base({ isStale: () => false, reinit: async (o) => { seen.push(o); return 0; } });
  await update(r.opts);
  assert.deepEqual(seen, []);
});

test('main routes update and init --update, and the help lists update', async () => {
  const got = [];
  const out = [];
  const w = process.stdout.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  const deps = { home: '/h', cwd: '/c', exit: () => {}, update: async (o) => { got.push(o); return 0; }, initUpdate: async (o) => { got.push({ init: o }); return 0; } };
  try {
    await main(['node', 's', 'update'], deps);
    await main(['node', 's', 'update', '--check'], deps);
    await main(['node', 's', 'update', '--version', '0.1.3', '--force'], deps);
    await main(['node', 's', 'init', '--update'], deps);
    assert.equal(await main(['node', 's', 'update', '--version'], deps), 2);
    await main(['node', 's', 'help'], deps);
  } finally { process.stdout.write = w; }
  assert.deepEqual(got.map((o) => o.init ? ['init', o.init.project] : [o.check, o.version, o.force]), [[false, undefined, false], [true, undefined, false], [false, '0.1.3', true], ['init', '/c']]);
  assert.match(out.join(''), /spookling update \[--check\] \[--version x \[--force\]\]/);
});

// ---- the daily notice

test('the update notice is cached for 24 h, skipped by SPOOKLING_NO_UPDATE_CHECK and CI', async () => {
  const home = tmp();
  let asked = 0, t = 1_000_000;
  const fetchImpl = async (u) => { asked += 1; return registry('0.2.1')(u); };
  const args = (env = {}) => ({ home, current: '0.2.0', env, fetchImpl, now: () => t });
  assert.equal(await updateAvailable(args()), '0.2.1');
  assert.equal(await updateAvailable(args()), '0.2.1');
  assert.equal(asked, 1, 'the second call is answered from update-check.json');
  assert.equal(statSync(join(home, '.spookling', 'update-check.json')).mode & 0o777, process.platform === 'win32' ? statSync(join(home, '.spookling', 'update-check.json')).mode & 0o777 : 0o600);
  t += 23 * 3600_000;
  await updateAvailable(args());
  assert.equal(asked, 1, 'still inside 24 h');
  t += 2 * 3600_000;
  await updateAvailable(args());
  assert.equal(asked, 2, 'after 24 h it asks again');
  const fresh = tmp();
  assert.equal(await updateAvailable({ ...args({ SPOOKLING_NO_UPDATE_CHECK: '1' }), home: fresh }), null);
  assert.equal(await updateAvailable({ ...args({ CI: 'true' }), home: fresh }), null);
  assert.equal(asked, 2);
  assert.equal(existsSync(join(fresh, '.spookling', 'update-check.json')), false);
  assert.equal(await updateAvailable({ ...args(), current: '0.2.1' }), null, 'nothing newer than what you run');
});

test('a failed check is remembered for the day and never throws', async () => {
  const home = tmp();
  let asked = 0;
  const fetchImpl = async () => { asked += 1; throw new TypeError('offline'); };
  const a = { home, current: '0.2.0', env: {}, fetchImpl, run: () => ({ status: 1 }), now: () => 5 };
  assert.equal(await updateAvailable(a), null);
  assert.equal(await updateAvailable(a), null);
  assert.equal(asked, 1);
});

test('status prints the update line; whoami prints it at most once a day, from the cache', async () => {
  const home = tmp();
  const said = [];
  const w = process.stdout.write;
  process.stdout.write = (s) => { said.push(String(s)); return true; };
  try { await status(home, async () => null, home, { update: { env: {}, fetchImpl: registry('0.2.1') } }); } finally { process.stdout.write = w; }
  assert.match(said.join('').replace(/\x1b\[[0-9;]*m/g, ''), /! update   0\.2\.1 is available\. Run spookling update\./);
  // the cache is now warm; whoami reads it and shows the line once
  const t = Date.now();
  assert.equal(cachedNotice({ home, current: VERSION === '0.2.1' ? '0.2.0' : VERSION, env: {}, now: () => t }), '0.2.1');
  assert.equal(cachedNotice({ home, current: '0.2.0', env: {}, now: () => t + 3600_000 }), null, 'not again within a day');
  assert.equal(cachedNotice({ home, current: '0.2.0', env: {}, now: () => t + 25 * 3600_000 }), '0.2.1');
  assert.equal(cachedNotice({ home, current: '0.2.0', env: { SPOOKLING_NO_UPDATE_CHECK: '1' }, now: () => t + 99 * 3600_000 }), null);
  void whoami;
});

test('status: the upgrade line points at spookling update, or npx for a wiring from before 0.2.0', async () => {
  const src = readFileSync(fileURLToPath(new URL('../src/wizard.js', import.meta.url)), 'utf8');
  assert.match(src, /'Run spookling update'/);
  assert.match(src, /'Run npx spookling@latest init'/);
  assert.doesNotMatch(src, /Run npx spookling init to finish upgrading/);
});

// ---- stopping the old server: only when it is ours

test('an old server is stopped only when its command line says it is ours, and then restarted where it ran', async () => {
  const home = tmp();
  const project = join(home, 'work');
  mkdirSync(join(project, '.memory'), { recursive: true });
  const ours = (v) => `uv run --project ${home}/.spookling-memory/${v}/server spookling-memory serve --folder .memory --port 7447`;
  assert.equal(serverVersion(ours('0.1.3')), '0.1.3');
  assert.equal(serverVersion('node /tmp/other.js serve'), null);
  const run = async (command) => {
    writeFileSync(join(project, '.memory', 'server.pid'), `${process.pid}\n`);
    const stopped = [];
    const ctx = { project, problems: [], skipped: [], written: [], say: async () => {}, auto: {
      home, ps: () => command, stop: (pid) => { stopped.push(pid); return true; }, alive: () => false, pause: async () => {},
    } };
    await stopOldServers(ctx);
    return { stopped, ctx };
  };
  let r = await run(ours('0.1.3'));
  assert.deepEqual(r.stopped, [process.pid]);
  assert.equal(r.ctx.serverHome, project);
  assert.equal(r.ctx.auto.start, true);
  assert.equal(existsSync(join(project, '.memory', 'server.pid')), false);
  r = await run('/usr/bin/python3 -m http.server 7447');
  assert.deepEqual(r.stopped, [], 'not ours: left alone');
  assert.equal(existsSync(join(project, '.memory', 'server.pid')), true);
  r = await run(null);
  assert.deepEqual(r.stopped, [], 'a command line we could not read is not ours');
  r = await run(ours(VERSION));
  assert.deepEqual(r.stopped, [], 'the current version keeps running');
});

// ---- detecting what is wired, and what was chosen

// user-scope files live under the real home unless HOME points elsewhere. These tests write wiring, so every path is checked first:
// nothing outside the temp folder is ever written, and HOME is pointed at the temp home while detection reads it.
const TMP = realpathSync(tmpdir());
function guard(path) {
  if (!path.startsWith(TMP) && !path.startsWith(tmpdir())) throw new Error(`test would write outside the temp folder: ${path}`);
  return path;
}
function atHome(home, fn) {
  const keep = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, HOMEDRIVE: process.env.HOMEDRIVE, HOMEPATH: process.env.HOMEPATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  // os.homedir() reads HOME on POSIX and USERPROFILE on Windows (Python's Path.home() also tries HOMEDRIVE+HOMEPATH)
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.HOMEDRIVE = parse(home).root.replace(/[\\/]$/, '');
  process.env.HOMEPATH = home.slice(parse(home).root.length - 1);
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  const done = () => { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  try { const r = fn(); if (r?.then) return r.finally(done); done(); return r; } catch (e) { done(); throw e; }
}
function put(path, body) {
  guard(path);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}
function wireClaude(home, project, scope, { ghost = true, version = '0.1.3' } = {}) {
  return atHome(home, () => {
    const dir = join(home, '.spookling-memory', version, 'hooks');
    let s = addHooks({}, hookHandlers(dir));
    if (ghost) s = addStatusLine(s, dir);
    const where = scope === 'user' ? home : project;
    put(settingsPath(where, scope), JSON.stringify(s, null, 2));
    put(mcpPath(where, scope), JSON.stringify(addMcp({}, mcpEntry(join(home, '.spookling-memory', version, 'server'), 'http://127.0.0.1:7447')), null, 2));
  });
}
function wireCodex(home, project, scope, version = '0.1.3') {
  return atHome(home, () => {
    put(codexHooksPath(scope === 'user' ? home : project, scope), JSON.stringify(addHooks({}, codexHandlers(join(home, '.spookling-memory', version, 'hooks')))));
  });
}
const noServer = async () => null;

test('detect: Claude Code, user scope, ghost on', async () => {
  const home = tmp(), project = tmp();
  wireClaude(home, project, 'user');
  const d = await atHome(home, () => detectInstall({ project, home, probe: noServer }));
  assert.deepEqual(d.targets.map((t) => [t.harness, t.scope, t.ghost, t.tagger, t.start]), [['claude', 'user', true, 0, false]]);
});

test('detect: Claude Code in the project plus Codex for the user; the project is reported only when this folder is wired', async () => {
  const home = tmp(), project = tmp(), other = tmp();
  wireClaude(home, project, 'project', { ghost: false });
  wireCodex(home, project, 'user');
  mkdirSync(join(project, '.memory'), { recursive: true });
  writeFileSync(join(project, '.memory', 'keys.env'), 'ANTHROPIC_API_KEY=sk-ant-x\n');
  let d = await atHome(home, () => detectInstall({ project, home, probe: noServer }));
  assert.deepEqual(d.targets.map((t) => [t.harness, t.scope, t.ghost, t.tagger]).sort(), [['claude', 'project', false, 1], ['codex', 'user', null, 1]]);
  d = await atHome(home, () => detectInstall({ project: other, home, probe: noServer }));
  assert.deepEqual(d.targets.map((t) => [t.harness, t.scope]), [['codex', 'user']], 'no project-scope install in this folder');
});

test('detect: the running server\'s tagger and install.json win over guesses', async () => {
  const home = tmp(), project = tmp();
  wireClaude(home, project, 'user', { ghost: true });
  const live = async () => ({ tagger: { model: TAGGERS[2].model, via: 'codex' } });
  assert.equal((await atHome(home, () => detectInstall({ project, home, probe: live }))).targets[0].tagger, 2);
  mkdirSync(join(home, '.spookling'), { recursive: true });
  writeFileSync(join(home, '.spookling', 'install.json'), JSON.stringify({ installs: [
    { harness: 'claude', scope: 'user', project: null, ghost: false, tagger: 1, start: false },
    { harness: 'claude', scope: 'project', project: join(home, 'elsewhere'), ghost: true, tagger: 0, start: true },
  ] }));
  mkdirSync(join(home, 'elsewhere'));
  const d = await atHome(home, () => detectInstall({ project, home, probe: live }));
  assert.deepEqual(d.targets.map((t) => [t.ghost, t.tagger, t.start]), [[false, 1, false]]);
  assert.deepEqual(d.elsewhere, [join(home, 'elsewhere')], 'known project installs are named, not touched');
});

// ---- init --update end to end, with fakes on PATH and a temp HOME

const fakeBin = (dir) => {
  mkdirSync(dir, { recursive: true });
  const script = (name, body) => { const p = join(dir, name); writeFileSync(p, `#!${process.execPath}\n${body}\n`); chmodSync(p, 0o755); };
  script('uv', 'process.exit(process.argv[2] === "--version" ? (console.log("uv 0.9.0"), 0) : 0);');
  script('claude', `
const fs = require('fs'), path = require('path'), a = process.argv.slice(2);
if (a[0] === '--version') { console.log('2.1.200 (Claude Code)'); process.exit(0); }
if (a[0] === 'mcp' && a[1] === 'add-json') {
  const f = path.join(process.env.HOME, '.claude.json');
  const j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  j.mcpServers = { ...(j.mcpServers || {}), [a[2]]: JSON.parse(a[3]) };
  fs.writeFileSync(f, JSON.stringify(j));
}
if (a[0] === 'mcp' && a[1] === 'remove') { const f = path.join(process.env.HOME, '.claude.json'); const j = JSON.parse(fs.readFileSync(f, 'utf8')); delete j.mcpServers[a[2]]; fs.writeFileSync(f, JSON.stringify(j)); }
`);
};

async function runUpdate({ wire, install, files = {} }) {
  const home = tmp('spk-e2e-'), project = tmp('spk-proj-');
  fakeBin(join(home, 'bin'));
  wire(home, project);
  if (install) { mkdirSync(join(home, '.spookling'), { recursive: true }); writeFileSync(join(home, '.spookling', 'install.json'), JSON.stringify({ installs: install(home, project) })); }
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ n_events: 0, tagger: { model: TAGGERS[0].model, via: 'openrouter' } })); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await new Promise((resolve) => {
      const child = spawnSyncAsync(process.execPath, [BIN, 'init', '--update'], {
        cwd: project, input: '', encoding: 'utf8', timeout: 120000,
        env: { PATH: `${join(home, 'bin')}:${process.env.PATH}`, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), NO_COLOR: '1',
          SPOOKLING_INIT_PORT: String(server.address().port), OPENROUTER_API_KEY: 'sk-or-test', SPOOKLING_NO_UPDATE_CHECK: '1' },
      });
      resolve(child);
    });
    return { ...r, home, project };
  } finally { server.close(); }
}
// the server above lives in this process, so the child must not block it
function spawnSyncAsync(cmd, args, o) {
  return new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(cmd, args, { cwd: o.cwd, env: o.env });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(o.input);
    });
  }).then((r) => r);
}

const skipWin = { skip: process.platform === 'win32' && 'POSIX fake binaries' };
const NO_PROMPTS = /Write it\?|Copy them\?|Which one\?|\[Y\/n\]|Start it in the background|step \d of 7/;
const settingsOf = (home, project, scope) => atHome(home, () => JSON.parse(readFileSync(settingsPath(scope === 'user' ? home : project, scope), 'utf8')));
const stopCmd = (s) => s.hooks.Stop[0].hooks[0].args[0];

test('init --update: Claude Code, user scope, ghost kept; re-pointed to this version with no prompts', skipWin, async () => {
  const r = await runUpdate({ wire: (home, project) => wireClaude(home, project, 'user', { ghost: true }) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, NO_PROMPTS);
  const s = settingsOf(r.home, r.project, 'user');
  assert.ok(stopCmd(s).includes(`${join('.spookling-memory', VERSION)}`), stopCmd(s));
  assert.ok(s.statusLine?.command.includes('status-line.js'), 'the ghost stays');
  const file = join(r.home, '.spookling', 'install.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved.installs.map((i) => [i.harness, i.scope, i.ghost, i.tagger]), [['claude', 'user', true, 0]]);
  assert.equal(saved.version, VERSION);
});

test('init --update: Claude Code in the project plus Codex for the user, ghost off', skipWin, async () => {
  const r = await runUpdate({ wire: (home, project) => { wireClaude(home, project, 'project', { ghost: false }); wireCodex(home, project, 'user'); } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, NO_PROMPTS);
  const s = settingsOf(r.home, r.project, 'project');
  assert.ok(stopCmd(s).includes(join('.spookling-memory', VERSION)));
  assert.equal(s.statusLine, undefined, 'ghost off stays off');
  const codex = atHome(r.home, () => JSON.parse(readFileSync(codexHooksPath(r.home, 'user'), 'utf8')));
  assert.ok(JSON.stringify(codex).includes(join('.spookling-memory', VERSION)));
  const saved = JSON.parse(readFileSync(join(r.home, '.spookling', 'install.json'), 'utf8'));
  assert.deepEqual(saved.installs.map((i) => [i.harness, i.scope]).sort(), [['claude', 'project'], ['codex', 'user']]);
  assert.equal(saved.installs.find((i) => i.harness === 'claude').ghost, false);
});

test('init --update: saved choices beat detection (ghost off in install.json, ghost currently on)', skipWin, async () => {
  const r = await runUpdate({
    wire: (home, project) => wireClaude(home, project, 'user', { ghost: true }),
    install: (home) => [{ harness: 'claude', scope: 'user', project: null, ghost: false, tagger: 0, start: false }],
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(settingsOf(r.home, r.project, 'user').statusLine?.command?.includes('status-line.js') ?? false, true, 'an existing ghost is not removed by update');
  assert.deepEqual(JSON.parse(readFileSync(join(r.home, '.spookling', 'install.json'), 'utf8')).installs[0].ghost, false);
});

test('init --update with nothing wired says so and changes nothing', skipWin, async () => {
  const r = await runUpdate({ wire: () => {} });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /No Spookling wiring found/);
  assert.equal(existsSync(join(r.home, '.spookling', 'install.json')), false);
});
