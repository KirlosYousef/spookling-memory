// Spookling's entries in settings.json and .mcp.json: pure functions that never drop a key they did not add.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path, { join } from 'node:path';

export const HOOK_FILES = {
  PreCompact: 'pre-compact.js',
  UserPromptSubmit: 'user-prompt-submit.js',
  Stop: 'stop.js',
  // The desktop app closes a code session without a model Stop. Same uploader as Stop.
  SessionEnd: 'stop.js',
};
export const MCP_NAME = 'spookling-memory';

export const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreCompact', 'Stop'];
// Codex command hooks use a shell command, not Claude Code's command + args form.
// Single quotes protect spaces, apostrophes and shell substitutions in POSIX paths.
export const codexHandlers = (hooksDir, p = path) => {
  const script = p.join(hooksDir, 'spookling-codex.cjs');
  const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  // Use a quoted native Windows path; reject shell expansion/control characters rather than misquote them.
  if (p === path.win32 && /["%$`!\r\n]/.test(script)) throw new Error('Codex hook path contains unsupported Windows shell characters');
  const command = p === path.win32 ? `node "${script}"` : `node ${quote(script)}`;
  return Object.fromEntries(CODEX_EVENTS.map((ev) => [ev, {
    type: 'command', command, timeout: ev === 'PreCompact' ? 65 : 20, statusMessage: '👻 Spookling memory',
    ...(ev === 'UserPromptSubmit' && { additionalContextLimit: 4000 }),
  }]));
};
export const codexHooksPath = (project, scope = 'project', env = process.env) =>
  join(scope === 'user' ? (env.CODEX_HOME || join(homedir(), '.codex')) : join(project, '.codex'), 'hooks.json');

// exec form (Claude Code v2.1.139+): no shell on any OS, so the path needs no quoting; statusMessage is the spinner's text
const SPINNER = { UserPromptSubmit: '👻 remembering', PreCompact: '👻 keeping your rules' };
export const hookHandlers = (hooksDir, p = path) => Object.fromEntries(Object.entries(HOOK_FILES)
  .map(([ev, f]) => [ev, { type: 'command', command: 'node', args: [p.join(hooksDir, f)], ...(SPINNER[ev] && { statusMessage: SPINNER[ev] }) }]));

// \\wsl.localhost\<distro>\... or \\wsl$\<distro>\... -> { distro, path }
export const wslShare = (dir) => {
  const m = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)((?:\\[^\\]+)*)\\?$/i.exec(dir);
  return m && { distro: m[1], path: m[2].replace(/\\/g, '/') || '/' };
};

// a folder inside WSL runs in WSL: a Windows uv would build a Windows .venv over WSL's; bash -l puts uv on PATH
export const mcpEntry = (serverDir, url, command = 'uv') => {
  const w = wslShare(serverDir);
  if (!w) return { type: 'stdio', command, args: ['run', '--project', serverDir, 'spookling-memory', 'mcp'], env: { SPOOKLING_MEMORY_URL: url } };
  const q = `'${w.path.replace(/'/g, `'\\''`)}'`;
  return {
    type: 'stdio', command: 'wsl.exe', args: ['-d', w.distro, '--', 'bash', '-lc', `exec uv run --project ${q} spookling-memory mcp`],
    env: { SPOOKLING_MEMORY_URL: url, WSLENV: 'SPOOKLING_MEMORY_URL' },
  };
};

// ours: one of our scripts (.js, or .sh from an older install) under a spookling path
const SCRIPT = /[\\/]hooks[\\/](?:(pre-compact|user-prompt-submit|stop)\.(js|sh)|spookling-codex\.cjs)\b/;
export const isOurs = (h) => {
  const s = typeof h === 'string' ? h : [h?.command, ...(Array.isArray(h?.args) ? h.args : [])].filter((x) => typeof x === 'string').join(' ');
  return /spookling/i.test(s) && SCRIPT.test(s);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function checkShape(settings) {
  if (!isObj(settings)) throw new Error('settings.json is not a JSON object');
  if (settings.hooks === undefined) return;
  if (!isObj(settings.hooks)) throw new Error('"hooks" in settings.json is not an object');
  for (const [ev, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) throw new Error(`hooks.${ev} in settings.json is not a list`);
    for (const g of groups) if (!isObj(g) || !Array.isArray(g.hooks ?? [])) throw new Error(`hooks.${ev} has an entry without a "hooks" list`);
  }
}
const ours = (g) => (g.hooks ?? []).some(isOurs);
// drop a group only if we emptied it
const strip = (groups, keep = () => false) => groups.flatMap((g) => {
  if (!ours(g)) return [g];
  const hooks = g.hooks.filter((h) => !isOurs(h) || keep(h));
  return hooks.length ? [{ ...g, hooks }] : [];
});

// no matcher: on PreCompact none means manual and auto
export function addHooks(settings, handlers) {
  checkShape(settings);
  const out = structuredClone(settings);
  out.hooks ??= {};
  for (const [ev, handler] of Object.entries(handlers)) {
    const groups = strip(out.hooks[ev] ?? [], (h) => same(h, handler));
    if (!groups.some((g) => (g.hooks ?? []).some((h) => same(h, handler)))) groups.push({ hooks: [handler] });
    out.hooks[ev] = groups;
  }
  return out;
}

// permissions.allow rules for the share tools. Other rules, and the other keys of permissions, are never touched.
export const SHARE_TOOLS = ['memory_share', 'memory_share_status', 'team_sessions', 'team_session'].map((t) => `mcp__${MCP_NAME}__${t}`);
function checkPerms(settings) {
  if (!isObj(settings)) throw new Error('settings.json is not a JSON object');
  const p = settings.permissions;
  if (p === undefined) return;
  if (!isObj(p)) throw new Error('"permissions" in settings.json is not an object');
  if (p.allow !== undefined && !Array.isArray(p.allow)) throw new Error('"permissions.allow" in settings.json is not a list');
}
export function addPermissions(settings, rules = SHARE_TOOLS) {
  checkPerms(settings);
  const out = structuredClone(settings);
  const allow = out.permissions?.allow ?? [];
  const add = rules.filter((r, i) => !allow.includes(r) && rules.indexOf(r) === i);
  if (!add.length) return out;
  out.permissions = { ...out.permissions, allow: [...allow, ...add] };
  return out;
}
export function removePermissions(settings, rules = SHARE_TOOLS) {
  checkPerms(settings);
  const out = structuredClone(settings);
  if (!out.permissions?.allow) return out;
  const kept = out.permissions.allow.filter((r) => !rules.includes(r));
  if (kept.length === out.permissions.allow.length) return out;
  if (kept.length) out.permissions.allow = kept;
  else delete out.permissions.allow;
  if (!Object.keys(out.permissions).length) delete out.permissions;
  return out;
}
export const hasPermissions = (settings, rules = SHARE_TOOLS) =>
  Array.isArray(settings?.permissions?.allow) && rules.every((r) => settings.permissions.allow.includes(r));

// /spookling-share: the user typing it is the consent, so it may run `spookling share` without a prompt
export const SHARE_COMMAND_FILE = 'spookling-share.md';
const SHARE_MARK = '<!-- spookling-memory: share command -->';
export const shareCommand = () => `---
description: Share this Claude Code session with your Spookling team
argument-hint: [org name or id]
allowed-tools: Bash(spookling share:*)
---
${SHARE_MARK}
Share the current session with the user's Spookling team. The user typed this command, so that is their confirmation.

Run this one Bash command and show its output as it is:

- No argument given: \`spookling share --yes\`
- Argument given ($ARGUMENTS): \`spookling share --yes --org "$ARGUMENTS"\`

If it fails, tell the user what it printed and stop. Do not try another way to share, and do not change any settings.
`;
export const isOurShareCommand = (text) => typeof text === 'string' && text.includes(SHARE_MARK);
export const commandsPath = (project, scope = 'project', env = process.env, home = homedir()) =>
  join(scope === 'user' ? configDir(env, home) : join(project, '.claude'), 'commands', SHARE_COMMAND_FILE);

export function removeHooks(settings) {
  checkShape(settings);
  const out = structuredClone(settings);
  if (!out.hooks) return out;
  for (const [ev, groups] of Object.entries(out.hooks)) {
    if (!groups.some(ours)) continue;
    const kept = strip(groups);
    if (kept.length) out.hooks[ev] = kept;
    else delete out.hooks[ev];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

// statusLine.command always runs in a shell (sh, Git Bash or PowerShell); the status line you had rides along as --then
export const STATUS_FILE = 'status-line.js';
const WIN_BAD = /["$`!\r\n]/; // what double quotes do not keep literal in Git Bash or PowerShell
const posixQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
export function statusCommand(hooksDir, prev, p = path) {
  if (p !== path.win32) return `node ${posixQuote(p.join(hooksDir, STATUS_FILE))}${prev ? ` --then ${posixQuote(prev)}` : ''}`;
  const script = p.join(hooksDir, STATUS_FILE).replaceAll('\\', '/'); // Git Bash eats unquoted backslashes
  if ([script, prev ?? ''].some((s) => WIN_BAD.test(s))) {
    throw new Error('the status line path or your current status line command has a character Git Bash and PowerShell read differently ("$`!); run init with --no-ghost');
  }
  return `node "${script}"${prev ? ` --then "${prev}"` : ''}`;
}
export const isOurStatus = (sl) => isObj(sl) && typeof sl.command === 'string' && /spookling/i.test(sl.command)
  && /[\\/]hooks[\\/]status-line\.js\b/.test(sl.command);
const previous = (cmd) => {
  const m = / --then (?:'((?:[^']|'\\'')*)'|"([^"]*)")$/.exec(cmd);
  return m ? m[1]?.replaceAll("'\\''", "'") ?? m[2] : null;
};

// a status line of your own keeps everything but command; with none we refresh every 5 s so the ghost moves while idle
export function addStatusLine(settings, hooksDir, p = path) {
  checkShape(settings);
  const sl = settings.statusLine;
  if (sl !== undefined && !isObj(sl)) throw new Error('"statusLine" in settings.json is not an object');
  const prev = isOurStatus(sl) ? previous(sl.command) : sl?.command || null;
  const out = structuredClone(settings);
  out.statusLine = sl ? { ...sl, type: 'command', command: statusCommand(hooksDir, prev, p) }
    : { type: 'command', command: statusCommand(hooksDir, null, p), refreshInterval: 5 };
  return out;
}

export function removeStatusLine(settings) {
  if (!isOurStatus(settings?.statusLine)) return settings;
  const out = structuredClone(settings), prev = previous(out.statusLine.command);
  if (prev) out.statusLine.command = prev;
  else delete out.statusLine;
  return out;
}

export function addMcp(cfg, entry) {
  if (!isObj(cfg)) throw new Error('.mcp.json is not a JSON object');
  if (cfg.mcpServers !== undefined && !isObj(cfg.mcpServers)) throw new Error('"mcpServers" in .mcp.json is not an object');
  return { ...structuredClone(cfg), mcpServers: { ...structuredClone(cfg.mcpServers ?? {}), [MCP_NAME]: entry } };
}

export function removeMcp(cfg) {
  if (!isObj(cfg) || !isObj(cfg.mcpServers) || !(MCP_NAME in cfg.mcpServers)) return cfg;
  const out = structuredClone(cfg);
  delete out.mcpServers[MCP_NAME];
  return out;
}

export function wiring(settings, cfg) {
  const events = Object.entries(isObj(settings?.hooks) ? settings.hooks : {})
    .filter(([, gs]) => Array.isArray(gs) && gs.some((g) => isObj(g) && ours(g)))
    .map(([ev]) => ev);
  return { events, mcp: isObj(cfg?.mcpServers) && MCP_NAME in cfg.mcpServers };
}

// unreadable JSON throws, so no caller overwrites a file it could not parse
export function readJson(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch (e) { throw new Error(`${path} is not valid JSON (${e.message}); left it untouched`); }
}

const configDir = (env, home = homedir()) => env.CLAUDE_CONFIG_DIR || join(home, '.claude');
export const settingsPath = (project, scope = 'project', env = process.env, home = homedir()) =>
  scope === 'user' ? join(configDir(env, home), 'settings.json') : join(project, '.claude', 'settings.json');
export const mcpPath = (project, scope = 'project', env = process.env) =>
  scope === 'user' ? (env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json'))
    : join(project, '.mcp.json');

// Claude Desktop (and its Code tab) reads this file. It does not use ~/.claude.json.
// macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
export function claudeDesktopConfigPath(home = homedir(), platform = process.platform, env = process.env) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

// ---- Codex MCP: [mcp_servers.spookling-memory] in config.toml ----
// `codex mcp add` writes only the user file ($CODEX_HOME/config.toml). Codex also reads <project>/.codex/config.toml,
// but only for a trusted project. There is no TOML library here: only our own two tables are edited, every other line stays.
export const codexConfigPath = (project, scope = 'project', env = process.env) =>
  join(scope === 'user' ? (env.CODEX_HOME || join(homedir(), '.codex')) : join(project, '.codex'), 'config.toml');

// Claude's mcpEntry in Codex's shape: command, args and env (no "type")
export const codexEntry = (e) => ({ command: e.command, args: [...(e.args ?? [])], env: isObj(e.env) ? { ...e.env } : {} });

const tstr = (s) => JSON.stringify(String(s)).replaceAll('\x7f', '\\u007f'); // a JSON string is a TOML basic string
const tkey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tstr(k));
export function codexMcpToml(entry, eol = '\n') {
  const e = codexEntry(entry), env = Object.entries(e.env);
  return [`[mcp_servers.${MCP_NAME}]`, `command = ${tstr(e.command)}`, `args = [${e.args.map(tstr).join(', ')}]`,
    ...(env.length ? ['', `[mcp_servers.${MCP_NAME}.env]`, ...env.map(([k, v]) => `${tkey(k)} = ${tstr(v)}`)] : [])].join(eol) + eol;
}

// a.b or a."b.c" -> ['a', 'b.c']
function tomlKey(s) {
  const parts = [];
  for (let i = 0; i < s.length;) {
    if (/\s|\./.test(s[i])) { i++; continue; }
    if (s[i] === '"' || s[i] === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== s[i]) j += s[i] === '"' && s[j] === '\\' ? 2 : 1;
      const raw = s.slice(i + 1, j);
      parts.push(s[i] === "'" ? raw : (() => { try { return JSON.parse(`"${raw}"`); } catch { return raw; } })());
      i = j + 1;
    } else { let j = i; while (j < s.length && !/[\s.]/.test(s[j])) j++; parts.push(s.slice(i, j)); i = j; }
  }
  return parts;
}

// table headers outside multi-line strings and arrays: [{ name, start, end }] by line, end exclusive
function tomlTables(lines) {
  const tables = [];
  let ml = null, depth = 0;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (!ml && !depth) {
      const m = /^\s*\[\[?\s*(.+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
      if (m) {
        if (tables.length) tables.at(-1).end = i;
        tables.push({ name: tomlKey(m[1]), start: i, end: lines.length });
        return;
      }
    }
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ml) { if (line.startsWith(ml, c) && (ml === "'''" || line[c - 1] !== '\\')) { c += 2; ml = null; } continue; }
      if (ch === '#') break;
      if (line.startsWith('"""', c) || line.startsWith("'''", c)) { ml = line.slice(c, c + 3); c += 2; }
      else if (ch === '"' || ch === "'") { c++; while (c < line.length && line[c] !== ch) c += ch === '"' && line[c] === '\\' ? 2 : 1; }
      else if (ch === '[') depth++;
      else if (ch === ']') depth = Math.max(0, depth - 1);
    }
  });
  return tables;
}

const isMain = (n) => n.length === 2 && n[0] === 'mcp_servers' && n[1] === MCP_NAME;
const isEnv = (n) => n.length === 3 && n[0] === 'mcp_servers' && n[1] === MCP_NAME && n[2] === 'env';
const isOurTable = (n) => n.length >= 2 && n[0] === 'mcp_servers' && n[1] === MCP_NAME;

// value at s[i]: a string, or an array of strings; anything else (number, table, bool) reads as undefined
function tomlValue(s, i) {
  const skip = () => { for (;;) { while (/\s/.test(s[i] ?? '')) i++; if (s[i] === '#') while (i < s.length && s[i] !== '\n') i++; else return; } };
  skip();
  if (s[i] === '"' || s[i] === "'") {
    const q = s[i++]; let j = i;
    while (j < s.length && s[j] !== q) j += q === '"' && s[j] === '\\' ? 2 : 1;
    const raw = s.slice(i, j); i = j + 1;
    if (q === "'") return { v: raw, end: i };
    try { return { v: JSON.parse(`"${raw}"`), end: i }; } catch { return { v: undefined, end: i }; }
  }
  if (s[i] === '[') {
    i++; const arr = [];
    for (;;) {
      skip();
      if (i >= s.length) return { v: undefined, end: i };
      if (s[i] === ']') return { v: arr, end: i + 1 };
      if (s[i] === ',') { i++; continue; }
      const r = tomlValue(s, i);
      if (r.end === i || r.v === undefined) return { v: undefined, end: r.end };
      arr.push(r.v); i = r.end;
    }
  }
  while (i < s.length && s[i] !== '\n') i++;
  return { v: undefined, end: i };
}

function tomlKeyValues(lines) {
  const text = lines.join('\n'), out = {};
  for (let i = 0; i < text.length;) {
    const m = /^[ \t]*([A-Za-z0-9_-]+|"[^"\n]*"|'[^'\n]*')[ \t]*=/m.exec(text.slice(i));
    if (!m) break;
    const r = tomlValue(text, i + m.index + m[0].length);
    out[tomlKey(m[1])[0]] = r.v;
    i = Math.max(r.end, i + m.index + m[0].length);
    while (i < text.length && text[i] !== '\n') i++;
  }
  return out;
}

// what the file says about our server: { command, args, env }, or null (nothing there, or not readable by this reader)
export function codexMcpEntry(text) {
  const lines = String(text).split('\n'), tables = tomlTables(lines);
  const main = tables.find((t) => isMain(t.name));
  if (!main) return null;
  const kv = tomlKeyValues(lines.slice(main.start + 1, main.end));
  const env = tables.find((t) => isEnv(t.name));
  const ev = env ? tomlKeyValues(lines.slice(env.start + 1, env.end)) : {};
  if (typeof kv.command !== 'string' || !Array.isArray(kv.args)) return null;
  return { command: kv.command, args: kv.args, env: Object.fromEntries(Object.entries(ev).filter(([, v]) => typeof v === 'string')) };
}

function tomlGuard(text) {
  if (text.split('\n').some((l) => /^\s*(?:mcp_servers\s*\.\s*)?["']?spookling-memory["']?\s*[.=]/.test(l))) {
    throw new Error(`config.toml sets ${MCP_NAME} as an inline or dotted key; edit it by hand`);
  }
}
const blank = (l) => !l.trim();

export function addCodexMcp(text, entry) {
  text = String(text ?? '');
  tomlGuard(text);
  const have = codexMcpEntry(text), want = codexEntry(entry);
  if (have && JSON.stringify(have) === JSON.stringify(want)) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n', cr = eol === '\r\n' ? '\r' : '';
  const block = codexMcpToml(entry, '\n').trimEnd().split('\n').map((l) => l + cr);
  const lines = text.split('\n'), tables = tomlTables(lines).filter((t) => isMain(t.name) || isEnv(t.name));
  const trimmed = (t) => { let e = t.end; while (e > t.start + 1 && blank(lines[e - 1])) e--; return e; };
  if (!tables.length) {
    if (!text) return block.join('\n') + '\n';
    const body = text.endsWith('\n') ? text : text + eol;
    const last = body.slice(0, -1).split('\n').at(-1);
    return body + (blank(last) ? '' : eol) + block.join('\n') + '\n';
  }
  // our table is replaced in place; a separate env table goes with it; sub-tables of ours (tools, ...) stay
  const first = tables.find((t) => isMain(t.name)) ?? tables[0];
  for (const t of [...tables].sort((a, b) => b.start - a.start)) {
    if (t === first) lines.splice(t.start, trimmed(t) - t.start, ...block);
    else lines.splice(t.start, t.end - t.start);
  }
  return lines.join('\n');
}

export function removeCodexMcp(text) {
  text = String(text ?? '');
  tomlGuard(text);
  const lines = text.split('\n'), endsNl = lines.length > 1 && lines.at(-1) === '';
  if (endsNl) lines.pop();
  for (const t of tomlTables(lines).filter((x) => isOurTable(x.name)).sort((a, b) => b.start - a.start)) {
    lines.splice(t.start, t.end - t.start);
    // we were the last thing in the file: the blank line we were appended after goes too
    if (t.start >= lines.length || lines.slice(t.start).every(blank)) {
      let s = t.start; while (s > 0 && blank(lines[s - 1])) s--;
      lines.splice(s, t.start - s);
    }
  }
  const out = lines.join('\n') + (endsNl && lines.length ? '\n' : '');
  return out.trim() ? out : '';
}

// the install folder a path in a hook or MCP entry points at: ~/.spookling-memory/<version>/{hooks,server,bin}
const INSTALL_REF = /spookling-memory[\\/](\d+\.\d+\.\d+[^\\/\s'"]*)[\\/](?:hooks|server|bin)(?=[\\/\s'"]|$)/g;
export const installVersions = (s) => [...String(s ?? '').matchAll(INSTALL_REF)].map((m) => m[1]);
const words = (h) => (typeof h === 'string' ? h : [h?.command, ...(Array.isArray(h?.args) ? h.args : [])].filter((x) => typeof x === 'string').join(' '));
// the command line of each of our hooks in settings.json or hooks.json
export const ourHookCommands = (settings) => Object.values(isObj(settings?.hooks) ? settings.hooks : {})
  .flatMap((gs) => (Array.isArray(gs) ? gs : [])).flatMap((g) => (isObj(g) && Array.isArray(g.hooks) ? g.hooks.filter(isOurs) : [])).map(words);
export const mcpCommand = (cfg) => { const e = cfg?.mcpServers?.[MCP_NAME]; return isObj(e) ? words(e) : ''; };
