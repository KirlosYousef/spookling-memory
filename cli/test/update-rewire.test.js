import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpHome } from './helpers.mjs';
import { hookHandlers, codexHandlers, addHooks, ourHookCommands, installVersions } from '../src/hooks.js';

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
