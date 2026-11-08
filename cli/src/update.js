// `spookling update`: find the newest published version, then let that version's own `init --update` re-wire everything.
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { homedir } from 'node:os';
import { compareVersions, isSemver, latestVersion } from './registry.js';
import { VERSION, detectInstall, initUpdate, staleWiring } from './wizard.js';

const say = (write, line) => write(`${line}\n`);
const MANUAL = 'npx spookling@latest init';

/**
 * Exit codes: 0 done or up to date; 1 could not (offline, no npx, the init failed); 2 bad arguments;
 * 10 with --check when an update is available.
 */
export async function update({
  home = homedir(), cwd = process.cwd(), check = false, version, force = false, current = VERSION,
  fetchImpl, run = spawnSync, write = (s) => process.stdout.write(s),
  reinit = initUpdate, detect = detectInstall, lookup = latestVersion, isStale = staleWiring,
} = {}) {
  if (version !== undefined && !isSemver(version)) {
    say(write, `--version takes a version like 1.2.3, not "${String(version).slice(0, 40).replace(/[^\x20-\x7e]/g, '')}".`);
    return 2;
  }
  let target = version?.trim();
  if (!target) {
    try { target = await lookup({ fetchImpl, run }); } catch (e) {
      say(write, `Couldn't check for updates (${String(e.message).replace(/[^\x20-\x7e]/g, '')}). Try again later, or run ${MANUAL}.`);
      return 1;
    }
  }
  const order = compareVersions(target, current);
  if (check) {
    if (order > 0) {
      say(write, `spookling ${target} is available (you have ${current}). Run spookling update.`);
      return 10;
    }
    say(write, `spookling ${current} is the latest.`);
    return 0;
  }
  if (order < 0 && !force) {
    say(write, version ? `Refusing to go from ${current} to ${target}. Add --force to install an older version.`
      : `spookling ${current} is the latest.`);
    return version ? 1 : 0;
  }
  if (order === 0) {
    if (!version) say(write, `spookling ${current} is the latest.`);
    // already on it: re-wire only when the hooks or MCP entries still point at an older folder
    if (!version && !isStale(cwd, home)) return 0;
    const { targets } = await detect({ project: cwd, home });
    if (!targets.length) return 0;
    say(write, 'Your hooks still use an older version folder; re-wiring them to this one.');
    return reinit({ project: cwd, home });
  }
  say(write, `${order > 0 ? 'Updating' : 'Installing'} spookling ${current} → ${target}…`);
  if (order < 0) say(write, 'An older version may not know `init --update` and ask its questions instead.');
  const r = run('npx', ['--yes', `spookling@${target}`, 'init', '--update'], {
    cwd, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true,
  });
  if (r?.error?.code === 'ENOENT') {
    say(write, `npx is not on your PATH. Run this yourself: npx --yes spookling@${target} init --update`);
    return 1;
  }
  if (r?.status !== 0) {
    say(write, `The update did not finish (npx ${r?.error ? r.error.code || r.error.message : `exited ${r?.status}`}). Run ${MANUAL} by hand.`);
    return 1;
  }
  say(write, 'Restart open Claude Code / Codex sessions to load the new version.');
  return 0;
}

