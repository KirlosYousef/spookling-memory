// ~/.spookling/upload-state.json: what has been uploaded, what is waiting, what is skipped. Several uploaders can run at once
// (two sessions stopping together, a Stop during `login`'s backfill, `spookling share`), so every change is a locked
// read-modify-write: read the file again, change it, write it, release. No network call is ever made while the lock is held.
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { apiBase } from './cloud.js';
import { readCredentials, writeFileSecure } from './credentials.js';

const LOCK_STALE_MS = 30_000; // a lock older than this belongs to a process that died
const LOCK_WAIT_MS = 2_000; // a hook never waits longer than this for the lock; it queues instead
const LOCK_RETRY_MS = 40;
const CLAIM_STALE_MS = 120_000; // longest a session may be "being uploaded": a few batches at the 15 s request timeout, with margin

export class StateBusy extends Error {
  constructor() { super('upload state is locked by another uploader'); this.name = 'StateBusy'; }
}

export const statePath = (home) => join(home, '.spookling', 'upload-state.json');

// A job is { sid, project } (auto-share rule, decided after the upload) or { sid, project, orgId } (an explicit share the user asked
// for before the session was on the server; project may then be '').
export function shareJobs(raw) {
  if (!Array.isArray(raw)) return [];
  const jobs = [];
  for (const item of raw) {
    if (!item || typeof item.sid !== 'string' || !item.sid) continue;
    const orgId = typeof item.orgId === 'string' && item.orgId ? item.orgId : '';
    if (typeof item.project !== 'string' || (!item.project && !orgId)) continue;
    if (jobs.some((job) => job.sid === item.sid && job.project === item.project && (job.orgId || '') === orgId)) continue;
    const text = (v, n) => (typeof v === 'string' && v ? { v: v.slice(0, n) } : null);
    const at = typeof item.at === 'string' && !Number.isNaN(Date.parse(item.at)) ? item.at : '';
    jobs.push({
      sid: item.sid, project: item.project, ...(orgId ? { orgId } : {}),
      ...(at ? { at } : {}), ...(text(item.title, 120) ? { title: item.title.slice(0, 120) } : {}), ...(text(item.org, 80) ? { org: item.org.slice(0, 80) } : {}),
    });
  }
  return jobs;
}

// A queued share that was dropped for good, kept until the user has been told: { sid, title, org, reason, at }
export function shareFailures(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((f) => f && typeof f.sid === 'string' && typeof f.reason === 'string' && f.reason)
    .map((f) => ({ sid: f.sid, title: String(f.title || f.sid).slice(0, 120), org: String(f.org || '').slice(0, 80), reason: f.reason.slice(0, 120), at: String(f.at || '') }));
}

export const SHARE_JOB_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** A line in ~/.spookling/upload.log (the same file the Stop hook writes). Never throws. */
export function noteUpload(home, message) {
  try {
    const dir = join(home, '.spookling');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, 'upload.log');
    appendFileSync(path, `${message}\n`);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  } catch { /* logging must not break anything */ }
}

const blank = () => ({ cursors: {}, skipped: {}, queue: [], shares: [], shareFailures: [], auth: null, forkModes: {}, links: {} });

function normalize(raw) {
  return {
    cursors: raw?.cursors && typeof raw.cursors === 'object' ? raw.cursors : {},
    skipped: raw?.skipped && typeof raw.skipped === 'object' ? raw.skipped : {},
    queue: Array.isArray(raw?.queue) ? raw.queue : [],
    shares: shareJobs(raw?.shares),
    shareFailures: shareFailures(raw?.shareFailures),
    auth: raw?.auth && typeof raw.auth === 'object' && raw.auth.expired ? { expired: true, at: String(raw.auth.at || '') } : null,
    forkModes: raw?.forkModes && typeof raw.forkModes === 'object' ? raw.forkModes : {},
    links: raw?.links && typeof raw.links === 'object' ? raw.links : {},
  };
}

const hasData = (st) => Object.keys(st.cursors).length || Object.keys(st.skipped).length || st.queue.length || st.shares.length || st.shareFailures.length
  || Object.keys(st.forkModes).length || Object.keys(st.links).length;

/**
 * Whose state this is: the API origin a token is pinned to plus the account (the saved user's id; a short hash of the token when
 * there is no user). A cursor means "the server of this account has these turns", so it is only valid for that pair: after switching
 * servers or accounts it would point past what the new server holds.
 */
export function accountScope(home, env = process.env) {
  const creds = readCredentials({ home, env });
  let origin = 'unknown';
  try { origin = apiBase(env, { home }).toLowerCase().replace(/\/+$/, ''); } catch { /* no usable origin: its own scope */ }
  const user = creds.user?.id || (creds.token ? `token-${createHash('sha256').update(creds.token).digest('hex').slice(0, 12)}` : 'nobody');
  return `${origin}|${user}`;
}

function readRaw(home) {
  try { return JSON.parse(readFileSync(statePath(home), 'utf8')) || {}; } catch { return {}; }
}

/**
 * The state of one account on one server. The file holds the active scope's state at the top level (plus its `scopeKey`), the
 * others parked under `others`, and, from before state was scoped, whatever an older version left under `legacy`. That old
 * state cannot be tied to an account, so it is kept, never used, and the current account starts fresh: the next upload asks
 * the server where it is (seq_gap), so a fresh start is safe.
 */
export function readState(home, scope = accountScope(home)) {
  const raw = readRaw(home);
  if (raw.scopeKey === scope) return normalize(raw);
  return raw.others?.[scope] ? normalize(raw.others[scope]) : blank();
}

/** The unscoped state an older version wrote, kept for reference. */
export function legacyState(home) {
  const raw = readRaw(home);
  return raw.legacy ? normalize(raw.legacy) : null;
}

// switch the file to `scope`: park the previous active state, take this scope's parked one (or a blank), keep old unscoped data aside
function activate(raw, scope) {
  const others = { ...(raw.others || {}) };
  let legacy = raw.legacy;
  if (raw.scopeKey === scope) return { scopeKey: scope, ...normalize(raw), others, ...(legacy ? { legacy } : {}) };
  if (raw.scopeKey) {
    const parked = normalize(raw);
    if (hasData(parked)) others[raw.scopeKey] = parked;
  } else if (hasData(normalize(raw))) {
    legacy = normalize(raw);
  }
  const active = others[scope] ? normalize(others[scope]) : blank();
  delete others[scope];
  return { scopeKey: scope, ...active, others, ...(legacy ? { legacy } : {}) };
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

/** Read the state again under the lock, let `mutate` change this scope's part (and return something), write it back. Throws StateBusy. */
export async function updateState(home, mutate, { waitMs = LOCK_WAIT_MS, scope = accountScope(home) } = {}) {
  const lock = `${statePath(home)}.lock`;
  if (!(await takeFile(lock, { staleMs: LOCK_STALE_MS, waitMs }))) throw new StateBusy();
  try {
    const file = activate(readRaw(home), scope);
    const state = normalize(file);
    const result = mutate(state);
    writeFileSecure(statePath(home), JSON.stringify({ ...file, ...state }) + '\n');
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

/** Dropped queued shares not yet shown to the user. Local only. */
export function peekShareFailures(home, env = process.env) {
  return readState(home, accountScope(home, env)).shareFailures;
}

export const failureText = (f) => `Share of '${f.title}' to ${f.org || 'the org'} did not apply: ${f.reason}`;

/** The dropped-share notes as text lines, and forget them: they are shown once. Throws StateBusy only if the lock stays taken. */
export async function takeShareFailures(home, env = process.env) {
  const scope = accountScope(home, env);
  if (!readState(home, scope).shareFailures.length) return [];
  try {
    const list = await updateState(home, (st) => { const l = st.shareFailures; st.shareFailures = []; return l; }, { scope });
    return list.map(failureText);
  } catch (e) {
    if (e instanceof StateBusy) return readState(home, scope).shareFailures.map(failureText); // shown now, cleared next time
    throw e;
  }
}
