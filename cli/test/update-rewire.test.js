import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpHome } from './helpers.mjs';
import { hookHandlers, codexHandlers, addHooks, addMcp, mcpEntry, codexMcpToml, ourHookCommands, installVersions } from '../src/hooks.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WIZARD = new URL('../src/wizard.js', import.meta.url).href;
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const OLD = '0.0.9';

// `initUpdate` in a throw-away HOME with hooks wired to an old version folder; returns the settings/hooks files and staleWiring after.
function updateIn({ cloudSessionStart = true, codex = false, claude = true } = {}) {
  const home = tmpHome('spk-rewire-');
  const project = join(home, 'proj');
  const old = join(home, '.spookling-memory', OLD, 'hooks');
  const put = (file, obj) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(obj)); };
  const settings = addHooks({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }, hookHandlers(old, undefined, { cloud: cloudSessionStart }));
  if (claude) put(join(home, 'claude', 'settings.json'), settings);
  if (codex) put(join(home, 'codex', 'hooks.json'), addHooks({}, codexHandlers(old)));
  // an install record for the user scope with no mode, as on the real machine
  put(join(home, '.spookling', 'install.json'), { installs: [{ harness: codex && !claude ? 'codex' : 'claude', scope: 'user', project: home }] });
  mkdirSync(project, { recursive: true });
  const script = `
    import { initUpdate, staleWiring } from ${JSON.stringify(WIZARD)};
    const code = await initUpdate({ project: ${JSON.stringify(home)}, home: ${JSON.stringify(home)}, withStatus: false, probe: async () => null, ps: async () => [], stop: async () => {}, alive: () => false, pause: async () => {} });
    console.log('RESULT ' + JSON.stringify({ code, stale: staleWiring(${JSON.stringify(home)}, ${JSON.stringify(home)}) }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 150000, cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), NO_COLOR: '1', OPENROUTER_API_KEY: 'sk-test' },
  });
  const m = /RESULT (.*)/.exec(r.stdout);
  assert.ok(m, r.stdout + r.stderr);
  const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
  return { ...JSON.parse(m[1]), before: settings, after: claude ? read(join(home, 'claude', 'settings.json')) : null, codexAfter: codex ? read(join(home, 'codex', 'hooks.json')) : null, log: r.stdout };
}

const events = (s) => Object.keys(s.hooks).sort();

test('update rewires a cloud SessionStart even when the install record has no mode', { skip: process.platform === 'win32' }, () => {
  const r = updateIn();
  assert.ok(events(r.before).includes('SessionStart'));
  assert.deepEqual(events(r.after), events(r.before), 'no hook added or removed');
  const cmds = ourHookCommands(r.after);
  assert.equal(cmds.length, ourHookCommands(r.before).length);
  for (const c of cmds) assert.deepEqual(installVersions(c), [VERSION], c);
  assert.ok(cmds.some((c) => c.includes('session-start.js')));
  assert.equal(r.after.hooks.Stop.some((g) => g.hooks.some((h) => h.command === 'echo mine')), true, 'the user hook stays');
  assert.equal(r.after.model, 'x');
  assert.equal(r.stale, false, r.log);
});

test('update does not add SessionStart when it was not wired', { skip: process.platform === 'win32' }, () => {
  const r = updateIn({ cloudSessionStart: false });
  assert.ok(!events(r.after).includes('SessionStart'));
  assert.equal(r.stale, false, r.log);
});

test('Codex hooks.json is rewired to the new folder on update', { skip: process.platform === 'win32' }, () => {
  const r = updateIn({ codex: true, claude: false });
  const cmds = ourHookCommands(r.codexAfter);
  assert.equal(cmds.length, 4);
  for (const c of cmds) assert.deepEqual(installVersions(c), [VERSION], c + r.log);
});

// ---- every install recorded in install.json, wherever update runs from ----

// One initUpdate shared by the assertions below (it copies the whole server folder per install).
let allRun;
function updateAll({ deleteB = false } = {}) {
  const home = tmpHome('spk-all-');
  const A = join(home, 'dev', 'a'), B = join(home, 'dev', 'b'), elsewhere = join(home, 'elsewhere');
  const oldHooks = join(home, '.spookling-memory', OLD, 'hooks'), oldServer = join(home, '.spookling-memory', OLD, 'server');
  const put = (file, obj) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  const mine = { type: 'command', command: 'echo mine' };
  const claudeSettings = (cloud) => addHooks({ model: 'x', hooks: { Stop: [{ hooks: [mine] }] } }, hookHandlers(oldHooks, undefined, { cloud }));
  const mcp = () => addMcp({ keep: 1, mcpServers: { other: { command: 'x' } } }, mcpEntry(oldServer, 'http://127.0.0.1:7447'));
  const files = {
    userSettings: join(home, 'claude', 'settings.json'),
    aSettings: join(A, '.claude', 'settings.json'), aMcp: join(A, '.mcp.json'),
    homeSettings: join(home, '.claude', 'settings.json'), homeMcp: join(home, '.mcp.json'),
    bHooks: join(B, '.codex', 'hooks.json'), bToml: join(B, '.codex', 'config.toml'),
  };
  put(files.userSettings, claudeSettings(true));
  put(files.aSettings, claudeSettings(true)); put(files.aMcp, mcp());
  put(files.homeSettings, claudeSettings(false)); put(files.homeMcp, mcp());
  put(files.bHooks, { keep: 2, ...addHooks({}, codexHandlers(oldHooks)) });
  put(files.bToml, `model = "o"\n\n${codexMcpToml(mcpEntry(oldServer, 'http://127.0.0.1:7447'))}\n[other]\nx = 1\n`);
  mkdirSync(elsewhere, { recursive: true });
  put(join(home, '.spookling', 'credentials.json'), { token: 'tok', user: { email: 'a@b.c' } });
  put(join(home, '.spookling', 'install.json'), { installs: [
    { harness: 'claude', scope: 'user', project: home },
    { harness: 'claude', scope: 'project', project: A, mode: 'cloud' },
    { harness: 'claude', scope: 'project', project: home, mode: 'keys' },
    { harness: 'codex', scope: 'project', project: B },
    { harness: 'claude', scope: 'project', project: join(home, 'gone') }, // deleted folder
  ] });
  if (deleteB) rmSync(B, { recursive: true, force: true });
  const before = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, existsSync(f) ? readFileSync(f, 'utf8') : null]));
  const script = `
    import { initUpdate, staleWiring, wiredVersions } from ${JSON.stringify(WIZARD)};
    const pre = wiredVersions(${JSON.stringify(elsewhere)}, ${JSON.stringify(home)});
    const code = await initUpdate({ project: ${JSON.stringify(elsewhere)}, home: ${JSON.stringify(home)}, withStatus: false, probe: async () => null, ps: async () => [], stop: async () => {}, alive: () => false, pause: async () => {},
      cloud: { base: () => 'http://127.0.0.1:1', listOrgs: async () => [] } });
    console.log('RESULT ' + JSON.stringify({ code, pre, stale: staleWiring(${JSON.stringify(elsewhere)}, ${JSON.stringify(home)}) }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 400000, cwd: elsewhere,
    env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), NO_COLOR: '1', OPENROUTER_API_KEY: 'sk-test' },
  });
  const m = /RESULT (.*)/.exec(r.stdout);
  assert.ok(m, r.stdout + r.stderr);
  return { home, A, B, files, before, ...JSON.parse(m[1]), log: r.stdout };
}

const parse = (t) => JSON.parse(t);
const readF = (f) => readFileSync(f, 'utf8');
const mcpCmd = (cfg) => (cfg.mcpServers['spookling-memory'].args ?? []).join(' ');

test('update rewires every recorded install from an unrelated folder', { skip: process.platform === 'win32', timeout: 450000 }, () => {
  const r = allRun ??= updateAll();
  assert.deepEqual(r.pre, [OLD], 'status sees the stale project wiring before the update');
  for (const k of ['userSettings', 'aSettings', 'homeSettings']) {
    const b = parse(r.before[k]), a = parse(readF(r.files[k]));
    assert.deepEqual(Object.keys(a.hooks).sort(), Object.keys(b.hooks).sort(), `${k}: no hook added or removed`);
    const cmds = ourHookCommands(a);
    assert.equal(cmds.length, ourHookCommands(b).length, k);
    for (const c of cmds) assert.deepEqual(installVersions(c), [VERSION], `${k}: ${c}`);
    assert.ok(a.hooks.Stop.some((g) => g.hooks.some((h) => h.command === 'echo mine')), `${k}: user hook stays`);
    assert.equal(a.model, 'x');
  }
  assert.ok(Object.keys(parse(readF(r.files.aSettings)).hooks).includes('SessionStart'));
  assert.ok(!Object.keys(parse(readF(r.files.homeSettings)).hooks).includes('SessionStart'), 'not added where it was not');
  for (const k of ['aMcp', 'homeMcp']) {
    const a = parse(readF(r.files[k]));
    assert.deepEqual(Object.keys(a.mcpServers).sort(), ['other', 'spookling-memory'], k);
    assert.equal(a.keep, 1);
    assert.deepEqual(a.mcpServers.other, { command: 'x' });
    assert.deepEqual(installVersions(mcpCmd(a)), [VERSION], k);
  }
  const hooks = parse(readF(r.files.bHooks));
  assert.equal(hooks.keep, 2);
  assert.equal(ourHookCommands(hooks).length, 4);
  for (const c of ourHookCommands(hooks)) assert.deepEqual(installVersions(c), [VERSION], c);
  const toml = readF(r.files.bToml);
  assert.deepEqual(installVersions(toml), [VERSION]);
  assert.equal((toml.match(/\[mcp_servers\.spookling-memory\]/g) || []).length, 1);
  assert.ok(toml.includes('model = "o"') && toml.includes('[other]\nx = 1'), 'other TOML kept');
  assert.equal(r.stale, false, r.log);
});

test('a recorded project folder that is gone is skipped, not recreated', { skip: process.platform === 'win32' }, () => {
  const r = allRun ??= updateAll();
  assert.ok(/gone[^\n]*the folder is gone, skipped/.test(r.log), r.log);
  assert.equal(existsSync(join(r.home, 'gone')), false);
});

test('a recorded project whose config files were deleted is skipped without error', { skip: process.platform === 'win32', timeout: 450000 }, () => {
  const r = updateAll({ deleteB: true });
  assert.ok(/Codex, project [^\n]*b: the folder is gone, skipped/.test(r.log), r.log);
  assert.equal(existsSync(r.B), false, 'not recreated');
  assert.equal(r.stale, false, r.log);
});
