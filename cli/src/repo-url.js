// The project's git remote, sent with a session as `repoUrl` so the server can tell two folders (or two people) on one repository
// apart from two projects that share a folder name. `git remote get-url origin`, run in the project's git root, with credentials
// and the query stripped and the rest masked. Omitted when there is no remote. The answer is cached per project in upload-state,
// so git runs once a day per project, not once per upload.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { maskSecrets } from './mask.js';
import { StateBusy, accountScope, readState, updateState } from './upload-state.js';

const MAX_GIT_DEPTH = 24; // parent folders searched for .git: far deeper than any project, and it ends a symlink loop
const URL_MAX = 300; // the API refuses a longer repoUrl
export const REPO_URL_TTL_MS = 24 * 3600 * 1000;

/** https://user:token@host/org/repo.git?x#y -> https://host/org/repo.git. scp-style git@host:org/repo is left as it is. Masked after. */
export function cleanRemote(raw) {
  let url = String(raw ?? '').trim();
  if (!url || /\s/.test(url)) return '';
  url = url.replace(/[?#].*$/, '');
  url = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
  url = maskSecrets(url);
  return url.length > 0 && url.length <= URL_MAX ? url : '';
}

/** The folder at or above `dir` that holds .git (a folder, or a file for a worktree or submodule); '' when there is none. */
export function findGitRoot(dir, exists = existsSync) {
  try {
    let d = dir ? resolve(dir) : '';
    for (let i = 0; i < MAX_GIT_DEPTH && d; i += 1) {
      if (exists(join(d, '.git'))) return d;
      const parent = dirname(d);
      if (parent === d) break;
      d = parent;
    }
  } catch { /* no repo */ }
  return '';
}

function runGit(root, run) {
  try {
    const r = run('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return r && r.status === 0 ? cleanRemote(r.stdout) : '';
  } catch { return ''; }
}

/**
 * The cleaned `origin` URL for the project containing `dir`, or '' (no repo, no origin, the home folder). Cached per git root for
 * a day, a miss included. Never throws; a busy state file just means git runs again next time.
 */
export async function repoUrlFor(dir, {
  home, env = process.env, run = spawnSync, exists = existsSync, now = Date.now, ttlMs = REPO_URL_TTL_MS,
} = {}) {
  try {
    const root = findGitRoot(dir, exists);
    if (!root || (home && resolve(root) === resolve(home))) return '';
    const scope = accountScope(home, env);
    const hit = readState(home, scope).repoUrls[root];
    if (hit && typeof hit.url === 'string' && Number.isFinite(hit.at) && now() - hit.at >= 0 && now() - hit.at < ttlMs) return hit.url;
    const url = runGit(root, run);
    try {
      await updateState(home, (st) => { st.repoUrls = { ...st.repoUrls, [root]: { url, at: now() } }; }, { scope });
    } catch (e) {
      if (!(e instanceof StateBusy)) throw e;
    }
    return url;
  } catch { return ''; }
}
