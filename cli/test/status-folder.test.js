import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/main.js';

// `status` looks at the current folder when it holds .memory, else at home when home holds one. A cloud
// install has no .memory in the project, so without this it reported the old wiring at home.
function setup({ homeMemory, cloud }) {
  const root = mkdtempSync(join(tmpdir(), 'spk-status-'));
  const home = join(root, 'home'); const cwd = join(root, 'proj');
  mkdirSync(join(home, '.spookling'), { recursive: true }); mkdirSync(cwd, { recursive: true });
  if (homeMemory) mkdirSync(join(home, '.memory'));
  if (cloud) writeFileSync(join(home, '.spookling', 'install.json'), JSON.stringify({ installs: [{ harness: 'claude', scope: 'project', project: cwd, mode: 'cloud' }] }));
  return { home, cwd };
}
const run = async (o) => { let got = null; await main(['node', 'spookling', 'status'], { status: async (folder) => { got = folder; return 0; }, home: o.home, cwd: o.cwd }); return got; };

test('status: a folder wired in cloud mode is reported even when home has an old .memory', async () => {
  const o = setup({ homeMemory: true, cloud: true });
  assert.equal(await run(o), o.cwd);
});
test('status: a keys-mode folder with no .memory still falls back to home, as before', async () => {
  const o = setup({ homeMemory: true, cloud: false });
  assert.equal(await run(o), o.home);
});
