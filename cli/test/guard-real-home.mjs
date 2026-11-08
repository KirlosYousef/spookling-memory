// A safety net for the test suite: no test may touch the developer's real config. `npm test` snapshots these files first
// and fails the run if one changed. ~/.claude.json is rewritten by Claude Code itself while it runs, so for that one only the
// number of test-looking paths in it is compared: it must not grow.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MARKER = /\/(?:private\/)?var\/folders\/|\/tmp\/spk-|[\\/]spk-[A-Za-z0-9]{4,}|AppData[\\/]Local[\\/]Temp[\\/]spk-/g;

export function watched(home = homedir(), env = process.env) {
  const claude = env.CLAUDE_CONFIG_DIR || join(home, '.claude'), codex = env.CODEX_HOME || join(home, '.codex');
  return {
    exact: [join(claude, 'settings.json'), join(codex, 'hooks.json'), join(codex, 'config.toml')],
    drifting: env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json'),
    backups: join(home, '.spookling', 'backups'),
  };
}

export const markerCount = (text) => (String(text).match(MARKER) || []).length;

export function snapshot(home = homedir(), env = process.env) {
  const w = watched(home, env);
  const stat = (p) => { try { const s = statSync(p); return { size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; } };
  let markers = 0;
  try { markers = markerCount(readFileSync(w.drifting, 'utf8')); } catch { /* not there */ }
  let runs = [];
  try { runs = existsSync(w.backups) ? readdirSync(w.backups).sort() : []; } catch { /* none */ }
  return { files: Object.fromEntries(w.exact.map((p) => [p, stat(p)])), drifting: w.drifting, markers, runs };
}

/** What changed between two snapshots, as lines. Empty means the real home was left alone. */
export function changes(before, after) {
  const out = [];
  for (const [p, b] of Object.entries(before.files)) {
    const a = after.files[p];
    if (!b && a) out.push(`${p} was created`);
    else if (b && !a) out.push(`${p} was deleted`);
    else if (b && (b.size !== a.size || b.mtimeMs !== a.mtimeMs)) out.push(`${p} was modified (size ${b.size} -> ${a.size})`);
  }
  if (after.markers > before.markers) out.push(`${before.drifting} gained ${after.markers - before.markers} test path(s) (/var/folders, spk-...)`);
  const added = after.runs.filter((r) => !before.runs.includes(r));
  if (added.length) out.push(`a test made real backup run(s) in ~/.spookling/backups: ${added.join(', ')}`);
  return out;
}
