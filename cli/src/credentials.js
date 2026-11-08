// ~/.spookling/credentials.json, mode 0600. SPOOKLING_TOKEN overrides the file. The token is never printed.
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

const FILE = 'credentials.json';

function credentialsFile(home = homedir()) {
  return join(home, '.spookling', FILE);
}

function readFile(home) {
  try {
    const raw = JSON.parse(readFileSync(credentialsFile(home), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function savedApiUrl(file) {
  return typeof file?.apiUrl === 'string' && file.apiUrl.trim() ? file.apiUrl.trim().replace(/\/+$/, '') : null;
}

/** The token in use, and the saved user. `fromEnv` means SPOOKLING_TOKEN won over the file. `apiUrl` is only the file. */
export function readCredentials({ env = process.env, home = homedir() } = {}) {
  const file = readFile(home);
  const fromEnv = typeof env.SPOOKLING_TOKEN === 'string' && env.SPOOKLING_TOKEN.length > 0;
  return {
    token: fromEnv ? env.SPOOKLING_TOKEN : (file?.token || null),
    savedToken: file?.token || null,
    user: file?.user ?? null,
    label: file?.label ?? null,
    apiUrl: savedApiUrl(file),
    defaultOrgId: typeof file?.defaultOrgId === 'string' && file.defaultOrgId ? file.defaultOrgId : null,
    defaultOrgName: typeof file?.defaultOrgName === 'string' && file.defaultOrgName ? file.defaultOrgName : null,
    path: credentialsFile(home),
    fromEnv,
  };
}

// Windows refuses a rename while another process (an antivirus scan, a reader) has the target open: EPERM or EBUSY, briefly.
const RENAME_TRIES = 8, RENAME_PAUSE_MS = 25;
function renameWithRetry(from, to) {
  for (let i = 1; ; i++) {
    try { return renameSync(from, to); } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= RENAME_TRIES) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_PAUSE_MS * i);
    }
  }
}

/**
 * Write a private file without a window where it is readable or half written: a new file in the same folder,
 * created exclusively with mode 0600, then renamed over the target. A symlink at the target is refused, so a link
 * planted there cannot make this overwrite another file. An existing file is set to 0600 first.
 */
export function writeFileSecure(path, body) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let st = null;
  try { st = lstatSync(path); } catch { /* new file */ }
  if (st?.isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${path}`);
  if (st && process.platform !== 'win32') chmodSync(path, 0o600);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, body);
    try { fsyncSync(fd); } catch { /* best effort */ }
  } catch (e) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
  closeSync(fd);
  try { renameWithRetry(tmp, path); } catch (e) {
    try { unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
  return path;
}

function protect(path) {
  if (process.platform === 'win32') return;
  chmodSync(path, 0o600);
  chmodSync(dirname(path), 0o700);
}

export function writeCredentials({ token, user = null, label = null, apiUrl }, { home = homedir() } = {}) {
  const path = credentialsFile(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const prev = readFile(home) || {};
  const incoming = apiUrl === undefined ? prev.apiUrl : apiUrl;
  const next = { token, user, label };
  if (prev.defaultOrgId) { next.defaultOrgId = prev.defaultOrgId; if (prev.defaultOrgName) next.defaultOrgName = prev.defaultOrgName; }
  const url = savedApiUrl({ apiUrl: incoming });
  if (url) next.apiUrl = url;
  const body = JSON.stringify(next, null, 2) + '\n';
  writeFileSecure(path, body);
  protect(path);
  return path;
}

/** Save (or with null, clear) the default org next to the token. Mode 0600 is kept. A no-op without a credentials file. */
export function setDefaultOrg(org, { home = homedir() } = {}) {
  const file = readFile(home);
  if (!file) return false;
  if (org?.id) { file.defaultOrgId = org.id; file.defaultOrgName = org.name || org.id; } else { delete file.defaultOrgId; delete file.defaultOrgName; }
  const path = credentialsFile(home);
  writeFileSecure(path, JSON.stringify(file, null, 2) + '\n');
  protect(path);
  return true;
}

/** Drop the saved token. A SPOOKLING_TOKEN in the environment is left for the caller to unset. */
export function removeStoredToken(home = homedir()) {
  const path = credentialsFile(home);
  const file = readFile(home);
  if (!file) return;
  delete file.token;
  delete file.defaultOrgId;
  delete file.defaultOrgName;
  if (!file.user && !file.label && !savedApiUrl(file)) {
    try { unlinkSync(path); } catch { /* already gone */ }
    return;
  }
  writeFileSecure(path, JSON.stringify(file, null, 2) + '\n');
  protect(path);
}
