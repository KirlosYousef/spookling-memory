// A copy of every config file before init, update or uninstall changes it, so a mistake is never final.
// ~/.spookling/backups/<timestamp>/<path with its slashes encoded>, files 0600, folders 0700, and a manifest to restore from.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { writeFileSecure } from './credentials.js';

export const KEEP_RUNS = 20, MIN_RUNS = 5, MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const STAMP = /^\d{8}-\d{6}(?:-\d+)?$/;
export const isStamp = (s) => typeof s === 'string' && STAMP.test(s);

export const backupsDir = (home = homedir()) => join(home, '.spookling', 'backups');
const pad = (n, w = 2) => String(n).padStart(w, '0');
const stampOf = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
const dateOf = (stamp) => {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(stamp);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
};
export const encodeName = (path) => encodeURIComponent(path);

/** Run stamps, newest first. */
export function listRuns(home = homedir()) {
  try { return readdirSync(backupsDir(home)).filter(isStamp).sort().reverse(); } catch { return []; }
}

export function readManifest(home, stamp) {
  try {
    const raw = JSON.parse(readFileSync(join(backupsDir(home), stamp, 'manifest.json'), 'utf8'));
    return Array.isArray(raw?.files) ? raw.files.filter((f) => f && typeof f.path === 'string' && typeof f.name === 'string') : [];
  } catch { return []; }
}

/** Keep the newest 20 runs and never fewer than 5; a run younger than 7 days is never removed. */
export function pruneBackups(home = homedir(), now = Date.now()) {
  const runs = listRuns(home);
  runs.slice(KEEP_RUNS).forEach((stamp, i) => {
    if (runs.length - i <= MIN_RUNS) return;
    if (now - dateOf(stamp) < MIN_AGE_MS) return;
    try { rmSync(join(backupsDir(home), stamp), { recursive: true, force: true }); } catch { /* next time */ }
  });
}

/** One run per command. The folder appears with the first file, so a run that changed nothing leaves nothing. */
export function createRun(home = homedir(), now = () => new Date()) {
  const run = { home, stamp: null, dir: null, files: [], seen: new Set(), count: 0 };
  const open = () => {
    if (run.dir) return;
    const base = stampOf(now());
    let stamp = base;
    for (let i = 2; existsSync(join(backupsDir(home), stamp)); i++) stamp = `${base}-${i}`;
    run.stamp = stamp;
    run.dir = join(backupsDir(home), stamp);
    mkdirSync(run.dir, { recursive: true, mode: 0o700 });
    for (const d of [join(home, '.spookling'), backupsDir(home), run.dir]) { try { chmodSync(d, 0o700); } catch { /* not ours to change */ } }
  };
  /** Copy `path` if it exists. Once per path per run. Returns true when a copy was made. Throws if the copy fails: never write what is not saved. */
  run.add = (path) => {
    if (run.seen.has(path) || !existsSync(path)) return false;
    const body = readFileSync(path);
    open();
    const name = encodeName(path);
    writeFileSecure(join(run.dir, name), body);
    run.seen.add(path);
    run.files.push({ path, name, mode: statSync(path).mode & 0o777 });
    run.count = run.files.length;
    writeFileSecure(join(run.dir, 'manifest.json'), JSON.stringify({ createdAt: now().toISOString(), files: run.files }, null, 2) + '\n');
    pruneBackups(home, now().getTime());
    return true;
  };
  run.label = () => (run.dir ? `Backups of the files I changed: ${tilde(run.dir, home)}/` : null);
  return run;
}

export const tilde = (p, home = homedir()) => {
  const r = relative(home, p);
  return r && !r.startsWith('..') ? join('~', r) : p;
};
