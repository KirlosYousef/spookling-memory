// The one-time offer to let Claude call the share tools without Claude Code's own block. Spookling still confirms each share.
// A "no" is remembered in ~/.spookling/share-allow.json so `login` and `init --update` do not ask again; `init` always may.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { addPermissions, hasPermissions, readJson, settingsPath, wiring } from './hooks.js';

export const ALLOW_SHARE_QUESTION = 'Let Claude share sessions to your team when you ask? Spookling still asks you to confirm each share.';
const file = (home) => join(home, '.spookling', 'share-allow.json');

export function shareDeclined(home = homedir()) {
  try { return JSON.parse(readFileSync(file(home), 'utf8'))?.declined === true; } catch { return false; }
}
export function setShareDeclined(declined, home = homedir()) {
  try {
    mkdirSync(dirname(file(home)), { recursive: true });
    writeFileSync(file(home), JSON.stringify({ declined: !!declined }) + '\n');
  } catch { /* a missed note only means we may ask once more */ }
}

/** After login: offer once, where our hooks are wired and the rules are not yet set. Never throws. Returns true when it added them. */
export async function offerAllowShare({ home, cwd, env = process.env, confirm, write, tty }) {
  try {
    if (!tty || shareDeclined(home)) return false;
    const spots = [['project', cwd], ['user', cwd]].map(([scope, dir]) => settingsPath(dir, scope, env, home));
    const wired = spots.filter((p) => { try { return wiring(readJson(p), {}).events.length > 0; } catch { return false; } });
    if (!wired.length) return false;
    if (spots.some((p) => { try { return hasPermissions(readJson(p)); } catch { return false; } })) return false;
    if (!(await confirm(`${ALLOW_SHARE_QUESTION}`, true))) { setShareDeclined(true, home); return false; }
    const target = wired[0];
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(addPermissions(readJson(target)), null, 2) + '\n');
    write(`Allowed the Spookling share tools in ${target}.\n`);
    return true;
  } catch { return false; }
}
