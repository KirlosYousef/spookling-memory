// The one-time offer to let Claude call the share tools without Claude Code's own block. Spookling still confirms each share.
// A "no" is remembered in ~/.spookling/share-allow.json so `login` and `init --update` do not ask again; `init` always may.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { SHARE_TOOLS, addPermissions, hasPermissions, readJson, settingsPath, wiring } from './hooks.js';

export const ALLOW_SHARE_QUESTION = 'Let Claude share sessions to your team when you ask? Spookling still asks you to confirm each share.';
const file = (home) => join(home, '.spookling', 'share-allow.json');

// share-allow.json: { declined: bool, added: { <settings file>: [the allow rules Spookling put there] } }
function readAllow(home) {
  try { const j = JSON.parse(readFileSync(file(home), 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; }
}
function writeAllow(home, data) {
  try {
    mkdirSync(dirname(file(home)), { recursive: true });
    writeFileSync(file(home), JSON.stringify(data) + '\n');
  } catch { /* a missed note only means we may ask once more, or leave a rule behind */ }
}

export function shareDeclined(home = homedir()) {
  return readAllow(home).declined === true;
}
export function setShareDeclined(declined, home = homedir()) {
  writeAllow(home, { ...readAllow(home), declined: !!declined });
}

/** The allow rules Spookling added to this settings file (never ones the user already had). */
export function addedRules(path, home = homedir()) {
  const list = readAllow(home).added?.[path];
  return Array.isArray(list) ? list.filter((r) => typeof r === 'string') : [];
}
export function recordAdded(path, rules, home = homedir()) {
  const all = readAllow(home);
  writeAllow(home, { ...all, added: { ...(all.added || {}), [path]: [...new Set([...addedRules(path, home), ...rules])] } });
}
export function forgetAdded(path, home = homedir()) {
  const all = readAllow(home);
  if (!all.added?.[path]) return;
  const { [path]: _gone, ...rest } = all.added;
  writeAllow(home, { ...all, added: rest });
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
    const before = readJson(target);
    const had = Array.isArray(before.permissions?.allow) ? before.permissions.allow : [];
    writeFileSync(target, JSON.stringify(addPermissions(before), null, 2) + '\n');
    recordAdded(target, SHARE_TOOLS.filter((r) => !had.includes(r)), home);
    write(`Allowed the Spookling share tools in ${target}.\n`);
    return true;
  } catch { return false; }
}
