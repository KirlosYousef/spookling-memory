import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './helpers.mjs';
import { addHooks, hookHandlers, SHARE_TOOLS } from '../src/hooks.js';
import { offerAllowShare, recordAdded, setShareDeclined, shareDeclined } from '../src/allow-share.js';

function setup({ wired = true, rules = [] } = {}) {
  const home = tmpHome('spk-allow-'), cwd = join(home, 'proj');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  let s = wired ? addHooks({}, hookHandlers(join(home, '.spookling-memory', '0.2.1', 'hooks'))) : {};
  if (rules.length) s = { ...s, permissions: { allow: rules } };
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(s));
  return { home, cwd, env: { CLAUDE_CONFIG_DIR: join(home, '.claude') }, file: join(home, '.claude', 'settings.json') };
}
const run = (t, answer, tty = true) => {
  const asked = [];
  return offerAllowShare({ home: t.home, cwd: t.cwd, env: t.env, tty, write: () => {}, confirm: async (q) => { asked.push(q); return answer; } }).then((r) => ({ r, asked }));
};

test('login offers once: yes adds the five tools, no is remembered', async () => {
  const t = setup();
  let { r, asked } = await run(t, true);
  assert.equal(r, true);
  assert.match(asked[0], /Let Claude share sessions to your team when you ask\? Spookling still asks you to confirm each share/);
  assert.deepEqual(JSON.parse(readFileSync(t.file, 'utf8')).permissions.allow, SHARE_TOOLS);
  ({ asked } = await run(t, true));
  assert.deepEqual(asked, [], 'already set: no question');

  const d = setup();
  ({ r } = await run(d, false));
  assert.equal(r, false);
  assert.ok(shareDeclined(d.home));
  assert.equal(JSON.parse(readFileSync(d.file, 'utf8')).permissions, undefined);
  ({ asked } = await run(d, true));
  assert.deepEqual(asked, [], 'declined before: no question');
});

test('login does not ask without a terminal, or when Spookling is not wired', async () => {
  const a = setup();
  assert.deepEqual((await run(a, true, false)).asked, []);
  const b = setup({ wired: false });
  assert.deepEqual((await run(b, true)).asked, []);
  assert.ok(!existsSync(join(b.home, '.spookling')));
});

test('login adds only the new rule for an earlier yes, without asking; a decline or an unrecorded file gets nothing', async () => {
  const old = SHARE_TOOLS.slice(0, 4);
  const t = setup({ rules: ['Bash(ls:*)', ...old] });
  recordAdded(t.file, old, t.home);
  const { r, asked } = await run(t, true);
  assert.equal(r, true);
  assert.deepEqual(asked, [], 'no question');
  assert.deepEqual(JSON.parse(readFileSync(t.file, 'utf8')).permissions.allow, ['Bash(ls:*)', ...old, SHARE_TOOLS[4]]);
  assert.deepEqual(JSON.parse(readFileSync(join(t.home, '.spookling', 'share-allow.json'), 'utf8')).added[t.file], SHARE_TOOLS);
  assert.equal((await run(t, true)).r, false, 'nothing more to add');

  // a user who removed an old rule of their own: it is not put back
  const u = setup({ rules: [SHARE_TOOLS[0]] });
  recordAdded(u.file, SHARE_TOOLS.slice(0, 4), u.home);
  await run(u, true);
  assert.deepEqual(JSON.parse(readFileSync(u.file, 'utf8')).permissions.allow, [SHARE_TOOLS[0], SHARE_TOOLS[4]]);

  const d = setup({ rules: [...old] });
  setShareDeclined(true, d.home);
  assert.equal((await run(d, true)).r, false);
  assert.deepEqual(JSON.parse(readFileSync(d.file, 'utf8')).permissions.allow, old, 'declined stays declined');
});
