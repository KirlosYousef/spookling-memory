// ~/.spookling/upload-state.json: what has been uploaded, what is waiting, what is skipped. Several uploaders can run at once
// (two sessions stopping together, a Stop during `login`'s backfill, `spookling share`), so every change is a locked
// read-modify-write: read the file again, change it, write it, release. No network call is ever made while the lock is held.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSecure } from './credentials.js';

const LOCK_STALE_MS = 30_000; // a lock older than this belongs to a process that died
const LOCK_WAIT_MS = 2_000; // a hook never waits longer than this for the lock; it queues instead
const LOCK_RETRY_MS = 40;
const CLAIM_STALE_MS = 120_000; // longest a session may be "being uploaded": a few batches at the 15 s request timeout, with margin

export class StateBusy extends Error {
  constructor() { super('upload state is locked by another uploader'); this.name = 'StateBusy'; }
}

export const statePath = (home) => join(home, '.spookling', 'upload-state.json');

export function shareJobs(raw) {
  if (!Array.isArray(raw)) return [];
  const jobs = [];
  for (const item of raw) {
    if (!item || typeof item.sid !== 'string' || !item.sid) continue;
    if (typeof item.project !== 'string' || !item.project) continue;
    if (jobs.some((job) => job.sid === item.sid && job.project === item.project)) continue;
    jobs.push({ sid: item.sid, project: item.project });
  }
  return jobs;
}

export function readState(home) {
  try {
    const raw = JSON.parse(readFileSync(statePath(home), 'utf8'));
    return {
      cursors: raw?.cursors && typeof raw.cursors === 'object' ? raw.cursors : {},
      skipped: raw?.skipped && typeof raw.skipped === 'object' ? raw.skipped : {},
      queue: Array.isArray(raw?.queue) ? raw.queue : [],
      shares: shareJobs(raw?.shares),
      auth: raw?.auth && typeof raw.auth === 'object' && raw.auth.expired ? { expired: true, at: String(raw.auth.at || '') } : null,
      forkModes: raw?.forkModes && typeof raw.forkModes === 'object' ? raw.forkModes : {},
      links: raw?.links && typeof raw.links === 'object' ? raw.links : {},
    };
  } catch {
    return { cursors: {}, skipped: {}, queue: [], shares: [], auth: null, forkModes: {}, links: {} };
  }
}

export function writeState(home, state) {
  writeFileSecure(statePath(home), JSON.stringify(state) + '\n');
}

// open(path, 'wx') is atomic on every platform. A stale file is moved aside first (a rename only one process wins) and then removed.
async function takeFile(path, { staleMs, waitMs }) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, `${process.pid} ${Date.now()}\n`);
      closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      if (Date.now() - statSync(path).mtimeMs > staleMs) {
        const aside = `${path}.stale-${randomBytes(4).toString('hex')}`;
        renameSync(path, aside);
        try { unlinkSync(aside); } catch { /* gone */ }
        continue;
      }
    } catch { continue; } // it vanished between the two calls: try again
    if (Date.now() >= deadline) return false;
    await delay(LOCK_RETRY_MS);
  }
}

const drop = (path) => { try { unlinkSync(path); } catch { /* already gone */ } };

/** Read the state again under the lock, let `mutate` change it (and return something), write it back. Throws StateBusy. */
export async function updateState(home, mutate, { waitMs = LOCK_WAIT_MS } = {}) {
  const lock = `${statePath(home)}.lock`;
  if (!(await takeFile(lock, { staleMs: LOCK_STALE_MS, waitMs }))) throw new StateBusy();
  try {
    const state = readState(home);
    const result = mutate(state);
    writeState(home, state);
    return result;
  } finally {
    drop(lock);
  }
}

/** One uploader per session at a time: returns a release function, or null when another uploader holds the session. */
export async function claimSession(home, sid) {
  const path = join(home, '.spookling', 'claims', createHash('sha256').update(sid).digest('hex').slice(0, 32));
  if (!(await takeFile(path, { staleMs: CLAIM_STALE_MS, waitMs: 0 }))) return null;
  return () => drop(path);
}
