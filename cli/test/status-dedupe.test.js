import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpHome } from './helpers.mjs';
import { hookHandlers, addHooks, codexHandlers } from '../src/hooks.js';
import { VERSION } from '../src/version.js';
import { VERSION as WIZARD_VERSION } from '../src/wizard.js';
import { VERSION as CLOUD_VERSION } from '../src/cloud.js';
import { noticeFor, updateAvailable, cachedNotice } from '../src/registry.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WIZARD = new URL('../src/wizard.js', import.meta.url).href;
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const count = (s, sub) => s.split(sub).length - 1;

// status with project === home (or a project inside it), hooks written into the user scope and optionally the project scope
function statusAt({ projectIsHome, projectHooks = false, cache }) {
  const home = tmpHome('spk-dedupe-');
  const project = projectIsHome ? home : join(home, 'proj');
  mkdirSync(project, { recursive: true });
  const hooks = addHooks({}, hookHandlers(join(home, '.spookling-memory', VERSION, 'hooks')));
  put(join(home, '.claude', 'settings.json'), JSON.stringify(hooks));
  if (projectHooks && !projectIsHome) put(join(project, '.claude', 'settings.json'), JSON.stringify(hooks));
  const cx = addHooks({}, codexHandlers(join(home, '.spookling-memory', VERSION, 'hooks')));
  put(join(home, '.codex', 'hooks.json'), JSON.stringify(cx));
  if (projectHooks && !projectIsHome) put(join(project, '.codex', 'hooks.json'), JSON.stringify(cx));
  if (cache) put(join(home, '.spookling', 'update-check.json'), cache);
  const script = `
    import { status } from ${JSON.stringify(WIZARD)};
    await status(${JSON.stringify(project)}, async () => ({ tagger: { model: 'stub', via: 'openrouter' } }), ${JSON.stringify(home)}, { noUpdate: ${!cache} });
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 30000, cwd: project,
    env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', NO_COLOR: '1', NODE_TEST_CONTEXT: '' },
  });
  return r.stdout + r.stderr;
}

test('project === home: each hook location is listed once', { skip: process.platform === 'win32' }, () => {
  const out = statusAt({ projectIsHome: true });
  const hooksLine = out.split('\n').find((l) => /\bhooks\s/.test(l));
  assert.equal(count(hooksLine, '.claude/settings.json'), 1, out);
  const codexLine = out.split('\n').find((l) => /\bcodex\s/.test(l));
  assert.equal(count(codexLine, 'hooks.json'), 1, out);
  assert.doesNotMatch(hooksLine, /;/);
});

test('project !== home: both scopes are listed when both have hooks', { skip: process.platform === 'win32' }, () => {
  const out = statusAt({ projectIsHome: false, projectHooks: true });
  const hooksLine = out.split('\n').find((l) => /\bhooks\s/.test(l));
  assert.equal(count(hooksLine, 'settings.json'), 2, out);
  const codexLine = out.split('\n').find((l) => /\bcodex\s/.test(l));
  assert.equal(count(codexLine, 'hooks.json'), 2, out);
});

// ---- the update notice

test('one version source: wizard, cloud and version.js agree and match package.json', () => {
  assert.equal(WIZARD_VERSION, VERSION);
  assert.equal(CLOUD_VERSION, VERSION);
  assert.equal(VERSION, JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
});

test('noticeFor: newer than running code and than the hooks, malformed input never gives a notice', () => {
  assert.equal(noticeFor('0.2.1', '0.2.2'), null);
  assert.equal(noticeFor('0.2.2', '0.2.1'), '0.2.2');
  assert.equal(noticeFor('0.2.2', '0.2.1', ['0.2.2']), null); // hooks already point at it
  assert.equal(noticeFor('0.2.3', '0.2.1', ['0.2.2', 'junk']), '0.2.3');
  for (const bad of [null, undefined, '', 'latest', '1.2', {}, 5]) assert.equal(noticeFor(bad, '0.2.1'), null);
  assert.equal(noticeFor('0.2.2', 'unknown'), null);
});

const NOW = 1_700_000_000_000;
const withCache = (cache) => { const home = tmpHome('spk-notice-'); if (cache !== undefined) put(join(home, '.spookling', 'update-check.json'), typeof cache === 'string' ? cache : JSON.stringify(cache)); return home; };
const registry = (version) => async () => new Response(JSON.stringify({ version }));
const fresh = (latest) => ({ checkedAt: NOW - 1000, latest, noticedAt: 0 });
const env = {};

test('cache 0.2.1, running 0.2.2: no notice', async () => {
  const home = withCache(fresh('0.2.1'));
  assert.equal(await updateAvailable({ home, current: '0.2.2', env, now: () => NOW }), null);
  assert.equal(cachedNotice({ home, current: '0.2.2', env, now: () => NOW }), null);
});

test('cache 0.2.2, running 0.2.1: exactly one notice, 0.2.2', async () => {
  const home = withCache(fresh('0.2.2'));
  assert.equal(await updateAvailable({ home, current: '0.2.1', env, now: () => NOW }), '0.2.2');
  assert.equal(cachedNotice({ home, current: '0.2.1', env, now: () => NOW }), '0.2.2');
  assert.equal(cachedNotice({ home, current: '0.2.1', env, now: () => NOW }), null); // shown once a day
});

test('stale cache 0.2.1 and registry 0.2.2: only the newest is reported', async () => {
  const home = withCache({ checkedAt: NOW - 3 * 86400000, latest: '0.2.1', noticedAt: 0 });
  assert.equal(await updateAvailable({ home, current: '0.2.0', env, fetchImpl: registry('0.2.2'), now: () => NOW }), '0.2.2');
});

test('hooks already at 0.2.2: no notice even though the running code is older', async () => {
  const home = withCache(fresh('0.2.2'));
  assert.equal(await updateAvailable({ home, current: '0.2.1', hooksAt: ['0.2.2'], env, now: () => NOW }), null);
});

test('malformed or hostile update-check.json never produces a notice', async () => {
  for (const cache of ['not json', '{"latest":"banana","checkedAt":1}', '{"latest":"0.2.1; rm","checkedAt":1}', '[]', 'null', { checkedAt: NOW, latest: 5 }]) {
    const home = withCache(cache);
    assert.equal(await updateAvailable({ home, current: '0.2.2', env, fetchImpl: async () => { throw new Error('offline'); }, run: () => ({ status: 1 }), now: () => NOW }), null, String(cache));
    assert.equal(cachedNotice({ home, current: '0.2.2', env, now: () => NOW }), null, String(cache));
  }
});

test('a checkedAt in the future is re-checked rather than trusted', async () => {
  const home = withCache({ checkedAt: NOW + 10 * 86400000, latest: '0.2.1', noticedAt: 0 });
  assert.equal(await updateAvailable({ home, current: '0.2.1', env, fetchImpl: registry('0.2.3'), now: () => NOW }), '0.2.3');
});

test('status prints the update line at most once, with the newest version', { skip: process.platform === 'win32' }, () => {
  const out = statusAt({ projectIsHome: false, cache: JSON.stringify({ checkedAt: Date.now(), latest: '99.0.0', noticedAt: 0 }) });
  assert.equal(count(out, 'is available'), 1, out);
  assert.match(out, /99\.0\.0 is available/);
  const none = statusAt({ projectIsHome: false, cache: JSON.stringify({ checkedAt: Date.now(), latest: '0.0.1', noticedAt: 0 }) });
  assert.equal(count(none, 'is available'), 0, none);
});
