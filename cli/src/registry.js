// What is the newest published spookling, and the once-a-day update notice. Never called from hooks, the MCP server or init.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileSecure } from './credentials.js';

const REGISTRY_LATEST = 'https://registry.npmjs.org/spookling/latest';
const DAY = 24 * 60 * 60 * 1000;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export const isSemver = (v) => typeof v === 'string' && SEMVER.test(v.trim());

/** -1, 0 or 1. A pre-release sorts before its release. */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(String(a).trim()), pb = SEMVER.exec(String(b).trim());
  if (!pa || !pb) throw new Error(`not a version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  const x = pa[4].split('.'), y = pb[4].split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const nx = /^\d+$/.test(x[i]), ny = /^\d+$/.test(y[i]);
    if (nx && ny && Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    if (!nx && x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The latest published version. fetch first (it needs no npm on PATH), then `npm view`. Throws an Error whose message is the reason.
 */
export async function latestVersion({ fetchImpl = globalThis.fetch, run = spawnSync, timeoutMs = 5000 } = {}) {
  let reason = 'no answer';
  try {
    const res = await fetchImpl(REGISTRY_LATEST, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!res.ok) throw new Error(`registry answered ${res.status}`);
    const v = (await res.json())?.version;
    if (!isSemver(v)) throw new Error('the registry sent no version');
    return v.trim();
  } catch (e) {
    reason = e?.name === 'TimeoutError' ? 'timed out' : (e?.cause?.code || e?.code || e?.message || 'offline');
  }
  try {
    const r = run('npm', ['view', 'spookling', 'version', '--json'], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, shell: process.platform === 'win32' });
    if (r?.status === 0) {
      const v = JSON.parse(String(r.stdout).trim());
      if (isSemver(v)) return v.trim();
    }
  } catch { /* the first reason stands */ }
  throw new Error(reason);
}

const cachePath = (home) => join(home, '.spookling', 'update-check.json');
function readCache(home) {
  try {
    const raw = JSON.parse(readFileSync(cachePath(home), 'utf8'));
    return {
      checkedAt: Number(raw?.checkedAt) || 0,
      latest: isSemver(raw?.latest) ? raw.latest : null,
      noticedAt: Number(raw?.noticedAt) || 0,
    };
  } catch { return { checkedAt: 0, latest: null, noticedAt: 0 }; }
}
function writeCache(home, c) {
  try { writeFileSecure(cachePath(home), JSON.stringify(c) + '\n'); } catch { /* a notice is not worth an error */ }
}

// NODE_TEST_CONTEXT is set inside `node --test`: the suite never asks the registry unless a test passes its own env
const off = (env) => env.SPOOKLING_NO_UPDATE_CHECK === '1' || !!env.CI || !!env.NODE_TEST_CONTEXT;

/**
 * The newer version if there is one, else null. Asks the registry at most once in 24 h (a failure counts too), for at most 2 s.
 * Interactive commands only.
 */
export async function updateAvailable({ home = homedir(), current, env = process.env, fetchImpl, run, now = Date.now } = {}) {
  if (off(env)) return null;
  const c = readCache(home);
  if (!c.checkedAt || now() - c.checkedAt >= DAY) {
    let latest = c.latest;
    try { latest = await latestVersion({ fetchImpl, run: run || (() => ({ status: 1 })), timeoutMs: 2000 }); } catch { /* keep the old answer */ }
    c.latest = latest;
    c.checkedAt = now();
    writeCache(home, c);
  }
  return c.latest && compareVersions(c.latest, current) > 0 ? c.latest : null;
}

/** For commands that cannot wait: the cached answer, shown at most once a day. Marks it shown. */
export function cachedNotice({ home = homedir(), current, env = process.env, now = Date.now } = {}) {
  if (off(env)) return null;
  const c = readCache(home);
  if (!c.latest || compareVersions(c.latest, current) <= 0 || now() - c.noticedAt < DAY) return null;
  writeCache(home, { ...c, noticedAt: now() });
  return c.latest;
}
