// Private file writes: a new file in the same folder, created with mode 0600, then renamed over the target.
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

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
