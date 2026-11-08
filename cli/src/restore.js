// `spookling restore [<timestamp>] [--yes]`: list the backups init, update and uninstall made, or put one run's files back.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { backupsDir, createRun, isStamp, listRuns, readManifest, tilde } from './backup.js';
import { clean } from './cloud.js';
import { writeFileSecure } from './credentials.js';

const say = (write, line) => write(`${line}\n`);
const same = (a, b) => { try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; } };

export async function restore({
  home = homedir(), stamp, yes = false, write = (s) => process.stdout.write(s),
  tty = !!(process.stdin.isTTY && process.stdout.isTTY), confirm,
} = {}) {
  const runs = listRuns(home);
  if (stamp === undefined) {
    if (!runs.length) {
      say(write, 'No backups yet. init, update and uninstall save a copy of each file before they change it.');
      return 0;
    }
    for (const s of runs) {
      const files = readManifest(home, s);
      say(write, `${s}  ${files.length} file${files.length === 1 ? '' : 's'}`);
      for (const f of files) say(write, `  ${clean(tilde(f.path, home))}`);
    }
    say(write, 'Restore one with: spookling restore <timestamp>');
    return 0;
  }
  if (!isStamp(stamp) || !runs.includes(stamp)) {
    say(write, `No backup run "${clean(String(stamp)).slice(0, 40)}". Run spookling restore to list them.`);
    return 1;
  }
  const dir = join(backupsDir(home), stamp), files = readManifest(home, stamp).filter((f) => existsSync(join(dir, f.name)));
  if (!files.length) {
    say(write, `Backup ${stamp} holds no files.`);
    return 1;
  }
  say(write, `Restoring from ${stamp}:`);
  for (const f of files) {
    const now = !existsSync(f.path) ? 'missing now' : same(f.path, join(dir, f.name)) ? 'same as now' : 'differs from the current file';
    say(write, `  ${clean(tilde(f.path, home))}  (${now})`);
  }
  if (!yes) {
    if (!tty) {
      say(write, 'This is not a terminal. Add --yes to restore these files.');
      return 1;
    }
    const ask = confirm || (await import('./term.js')).confirm;
    if (!(await ask(`Restore ${files.length} file${files.length === 1 ? '' : 's'}? The current versions are backed up first.`, false))) {
      say(write, 'Nothing restored.');
      return 0;
    }
  }
  const run = createRun(home);
  let failed = 0, done = 0;
  for (const f of files) {
    try {
      if (existsSync(f.path) && lstatSync(f.path).isSymbolicLink()) throw new Error('it is a symlink; restore it by hand');
      run.add(f.path); // the current version first
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSecure(f.path, readFileSync(join(dir, f.name)));
      if (process.platform !== 'win32' && Number.isInteger(f.mode)) chmodSync(f.path, f.mode & 0o777);
      done += 1;
    } catch (e) {
      failed += 1;
      say(write, `Could not restore ${clean(tilde(f.path, home))} (${clean(e.code || e.message)}).`);
    }
  }
  say(write, `Restored ${done} file${done === 1 ? '' : 's'}.${run.label() ? ` The files they replaced: ${run.label().replace(/^Backups of the files I changed: /, '')}` : ''}`);
  return failed ? 1 : 0;
}
