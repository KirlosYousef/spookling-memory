import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpHome } from './helpers.mjs';
import { createRun, listRuns } from '../src/backup.js';
import { restore } from '../src/restore.js';
import { main } from '../src/main.js';

const tmp = () => tmpHome('spk-rs-');
const posix = { skip: process.platform === 'win32' && 'POSIX modes and symlinks' };

function setup() {
  const home = tmp();
  const a = join(home, 'cfg', 'settings.json'), b = join(home, 'codex', 'hooks.json');
  mkdirSync(dirname(a), { recursive: true });
  mkdirSync(dirname(b), { recursive: true });
  writeFileSync(a, '{"theme":"dark"}\n', { mode: 0o644 });
  writeFileSync(b, '{"hooks":{}}\n');
  const run = createRun(home, () => new Date(Date.UTC(2026, 10, 4, 10, 0, 0)));
  run.add(a); run.add(b);
  writeFileSync(a, '{"theme":"ruined"}\n');
  rmFile(b);
  return { home, a, b, stamp: run.stamp };
}
import { rmSync } from 'node:fs';
const rmFile = (p) => rmSync(p, { force: true });
const out = () => { const lines = []; return { lines, write: (s) => lines.push(s), text: () => lines.join('') }; };

test('restore with no argument lists the runs and their files', async () => {
  const { home, a, b, stamp } = setup();
  const o = out();
  assert.equal(await restore({ home, write: o.write }), 0);
  assert.equal(o.text(), `${stamp}  2 files\n  ${a.replace(home, '~')}\n  ${b.replace(home, '~')}\nRestore one with: spookling restore <timestamp>\n`);
  const empty = out();
  assert.equal(await restore({ home: tmp(), write: empty.write }), 0);
  assert.match(empty.text(), /No backups yet/);
});

test('restore <timestamp> shows what would change, asks, saves the current files first, then restores', posix, async () => {
  const { home, a, b, stamp } = setup();
  const o = out(), asked = [];
  const code = await restore({ home, stamp, write: o.write, tty: true, confirm: async (q, def) => { asked.push([q, def]); return true; } });
  assert.equal(code, 0);
  assert.match(o.text(), new RegExp(`Restoring from ${stamp}:\\n  ${a.replace(home, '~')}  \\(differs from the current file\\)\\n  ${b.replace(home, '~')}  \\(missing now\\)`));
  assert.deepEqual(asked, [['Restore 2 files? The current versions are backed up first.', false]], 'the default answer is no');
  assert.equal(readFileSync(a, 'utf8'), '{"theme":"dark"}\n');
  assert.equal(readFileSync(b, 'utf8'), '{"hooks":{}}\n');
  assert.equal(statSync(a).mode & 0o777, 0o644, 'the original mode comes back');
  const runs = listRuns(home);
  assert.equal(runs.length, 2, 'restoring made its own backup run');
  const mine = join(home, '.spookling', 'backups', runs[0]);
  assert.match(o.text(), /Restored 2 files\. The files they replaced: ~\/\.spookling\/backups\/\d{8}-\d{6}\//);
  assert.equal(readFileSync(join(mine, encodeURIComponent(a)), 'utf8'), '{"theme":"ruined"}\n', 'the ruined current version was saved');
});

test('declining restores nothing; without a terminal it needs --yes', posix, async () => {
  const { home, a, stamp } = setup();
  let o = out();
  assert.equal(await restore({ home, stamp, write: o.write, tty: true, confirm: async () => false }), 0);
  assert.match(o.text(), /Nothing restored\./);
  assert.equal(readFileSync(a, 'utf8'), '{"theme":"ruined"}\n');
  o = out();
  assert.equal(await restore({ home, stamp, write: o.write, tty: false }), 1);
  assert.match(o.text(), /This is not a terminal\. Add --yes to restore these files\./);
  assert.equal(readFileSync(a, 'utf8'), '{"theme":"ruined"}\n');
  o = out();
  assert.equal(await restore({ home, stamp, yes: true, write: o.write, tty: false }), 0);
  assert.equal(readFileSync(a, 'utf8'), '{"theme":"dark"}\n');
});

test('restore refuses an unknown or malformed timestamp and a symlink target', posix, async () => {
  const { home, a, stamp } = setup();
  for (const bad of ['20990101-000000', '../../etc', 'x']) {
    const o = out();
    assert.equal(await restore({ home, stamp: bad, yes: true, write: o.write }), 1, bad);
    assert.match(o.text(), /No backup run/);
  }
  rmFile(a);
  const victim = join(home, 'victim.txt');
  writeFileSync(victim, 'keep');
  symlinkSync(victim, a);
  const o = out();
  assert.equal(await restore({ home, stamp, yes: true, write: o.write }), 1);
  assert.match(o.text(), /it is a symlink; restore it by hand/);
  assert.equal(readFileSync(victim, 'utf8'), 'keep');
  void chmodSync;
});

test('main routes restore, and the help lists it', async () => {
  const got = [];
  const written = [];
  const w = process.stdout.write;
  process.stdout.write = (s) => { written.push(String(s)); return true; };
  const deps = { home: '/h', cwd: '/c', exit: () => {}, restore: async (o) => { got.push(o); return 0; } };
  try {
    await main(['node', 's', 'restore'], deps);
    await main(['node', 's', 'restore', '20261104-100000', '--yes'], deps);
    await main(['node', 's', 'help'], deps);
  } finally { process.stdout.write = w; }
  assert.deepEqual(got, [{ home: '/h', stamp: undefined, yes: false }, { home: '/h', stamp: '20261104-100000', yes: true }]);
  assert.match(written.join(''), /spookling restore \[<timestamp>\] \[--yes\]/);
});
