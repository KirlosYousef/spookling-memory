import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgradeAdvice } from '../src/wizard.js';
import { tmpHome } from './helpers.mjs';
import { hookHandlers, installVersions, mcpEntry, addHooks, addMcp } from '../src/hooks.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WIZARD = new URL('../src/wizard.js', import.meta.url).href;
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const OLD = '0.1.3';

// `status` in a throw-away HOME: hooks and MCP entries written by the test, the install folder as it is on that machine
function statusIn({ hooksVersion, mcpVersion, linkVersion, install = false }) {
  const home = tmpHome('spk-upgrade-');
  const project = join(home, 'proj');
  const dir = (v) => join(home, '.spookling-memory', v);
  const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
  if (hooksVersion) {
    put(join(home, 'claude', 'settings.json'), JSON.stringify(addHooks({}, hookHandlers(join(dir(hooksVersion), 'hooks')))));
  }
  if (mcpVersion) put(join(home, 'claude', '.claude.json'), JSON.stringify(addMcp({}, mcpEntry(join(dir(mcpVersion), 'server'), 'http://127.0.0.1:7447'))));
  if (linkVersion) put(join(home, '.local', 'bin', 'spookling'), `#!/bin/sh\nexec node '${join(dir(linkVersion), 'bin', 'spookling-memory.js')}' "$@"\n`);
  mkdirSync(project, { recursive: true });
  const script = `
    import { status${install ? ', install, INSTALL_DIR' : ''} } from ${JSON.stringify(WIZARD)};
    ${install ? `install(${JSON.stringify(ROOT)}, INSTALL_DIR);` : ''}
    process.exitCode = await status(${JSON.stringify(project)}, async () => ({ tagger: { model: 'stub', via: 'openrouter' } }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 30000, cwd: project,
    env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), NO_COLOR: '1' },
  });
  return { out: r.stdout, code: r.status, err: r.stderr, home };
}

test('installVersions reads the version folder out of hook and MCP paths', () => {
  assert.deepEqual(installVersions('node /Users/a/.spookling-memory/0.1.3/hooks/stop.js'), ['0.1.3']);
  assert.deepEqual(installVersions('run --project C:\\Users\\a\\AppData\\Local\\spookling-memory\\0.2.0\\server spookling-memory mcp'), ['0.2.0']);
  assert.deepEqual(installVersions('node /Users/a/Developer/spookling-memory/hooks/stop.js'), []); // a clone, not an install
});

test('hooks still wired to the previous version: one upgrade line, no "scripts missing"', { skip: process.platform === 'win32' }, () => {
  const { out, code, err } = statusIn({ hooksVersion: OLD, mcpVersion: OLD, linkVersion: OLD });
  assert.match(out, new RegExp(`! upgrade  hooks, MCP entries and the spookling command still use ${OLD.replaceAll('.', '\\.')}\\. Run npx spookling@latest init to finish upgrading to ${VERSION.replaceAll('.', '\\.')}\\.`), err + out);
  assert.doesNotMatch(out, /scripts/);
  assert.equal(code, 1);
});

test('only the MCP entry is old: the upgrade line names it, the hooks are checked as before', { skip: process.platform === 'win32' }, () => {
  const { out } = statusIn({ hooksVersion: VERSION, mcpVersion: OLD, install: true });
  assert.match(out, /! upgrade  MCP entries still use 0\.1\.3\./);
  assert.doesNotMatch(out, /scripts/);
});

test('wired to this version but the files are gone: "scripts missing", no upgrade line', () => {
  const { out, code } = statusIn({ hooksVersion: VERSION, mcpVersion: VERSION });
  assert.match(out, /! scripts  missing in .*pre-compact\.js, user-prompt-submit\.js, stop\.js/);
  assert.doesNotMatch(out, /! upgrade/);
  assert.equal(code, 1);
});

test('everything on this version: neither line', { skip: process.platform === 'win32' }, () => {
  const { out, err } = statusIn({ hooksVersion: VERSION, mcpVersion: VERSION, linkVersion: VERSION, install: true });
  assert.doesNotMatch(out, /! upgrade|! scripts/, err + out);
});

test('the upgrade hint: npx for a wiring older than 0.2.0 (no update command there), spookling update from 0.2.0 on', { skip: process.platform === 'win32' }, () => {
  assert.equal(upgradeAdvice(['0.1.3']), 'Run npx spookling@latest init');
  assert.equal(upgradeAdvice(['0.1.9', '0.2.1']), 'Run npx spookling@latest init', 'any pre-0.2 reference means the installed command may be old');
  assert.equal(upgradeAdvice(['0.2.0']), 'Run spookling update');
  assert.equal(upgradeAdvice(['0.3.1']), 'Run spookling update');
  const { out } = statusIn({ hooksVersion: '0.2.5', mcpVersion: '0.2.5', linkVersion: '0.2.5' });
  assert.match(out, new RegExp(`! upgrade  .* still use 0\\.2\\.5\\. Run spookling update to finish upgrading to ${VERSION.replaceAll('.', '\\.')}\\.`), out);
  assert.doesNotMatch(out, /npx spookling@latest/);
});
