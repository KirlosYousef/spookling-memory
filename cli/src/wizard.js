// init, status and uninstall; demo is init with dry: the same prompts, answered by a script, nothing written or run.
import process from 'node:process';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { C, DOWN, MODE, UP, askHidden, bail, choose, confirm, fits, paint, press, setFeed, setRaw, sleep, write as out } from './term.js';
import { play } from './cutscene.js';
import { flyOnce } from './ghost.js';
import { stage } from './stage.js';
import {
  HOOK_FILES, MCP_NAME, addHooks, addMcp, claudeDesktopConfigPath, hookHandlers, mcpEntry, mcpPath, readJson, removeHooks, removeMcp, settingsPath,
  wiring, wslShare, CODEX_EVENTS, codexHandlers, codexHooksPath, STATUS_FILE, addStatusLine, removeStatusLine, isOurStatus,
  addCodexMcp, codexConfigPath, codexEntry, codexMcpEntry, codexMcpToml, installVersions, mcpCommand, ourHookCommands, removeCodexMcp,
} from './hooks.js';
import { pendingUploads, skipText, skippedSessionIds, uploadProblems } from './push.js';
import { readCredentials, writeFileSecure } from './credentials.js';
import { compareVersions, updateAvailable } from './registry.js';
import { createRun, tilde } from './backup.js';
import { checkToml } from './toml-check.js';
import { readCache } from './team.js';

const WIN = process.platform === 'win32';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
export const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
// a folder per version, out of the npx cache (npm may clear it); a \\wsl.localhost clone is wired in place
const SHARE = WIN && wslShare(join(ROOT, 'server'));
export const INSTALL_DIR = SHARE ? ROOT
  : WIN ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'spookling-memory', VERSION)
    : join(homedir(), '.spookling-memory', VERSION);
export const SERVER_DIR = join(INSTALL_DIR, 'server'), HOOKS_DIR = join(INSTALL_DIR, 'hooks');
// SPOOKLING_INIT_PORT exists for the tests, which must not talk to a real server on 7447
const PORT = Number(process.env.SPOOKLING_INIT_PORT) || 7447, SERVER_URL = `http://127.0.0.1:${PORT}`, STATS = `${SERVER_URL}/v1/stats`;
const STEPS = ['Checks', 'Harness', 'Tagger', 'Server', 'Wire harness', 'Smoke test', 'Done'];
export const DEMO_LABEL = 'demo, nothing is written';
const IGNORE = ['keys.env', 'server.pid', 'server.log', 'cache.sqlite*', 'vectors.sqlite*', 'pulse.json*'];

// at most 52 characters each, so the bubble fits beside the ghost at 80 columns (tested)
export const SAY = {
  1: 'Hello. First I check what this machine has.',
  2: 'Pick the tool you talk to. I will sit beside it.',
  3: 'A small model tags each chat for me. Pick one.',
  4: 'Moving in. Everything I remember goes in .memory/',
  5: 'I will remind Claude of what you told it before.',
  codex: 'I will show Codex when memory is ready.',
  6: 'A quick knock, to check I am home.',
  7: 'That is all. Carry on as you always do.',
  fail: 'Sorry, that failed. The line marked ! says why.',
};

export const TAGGERS = [
  { label: 'Jev through an OpenRouter key (cheapest, about $0.002 a chat)', model: 'typesafe/jev-router', decider: 'typesafe/jev-1.14', key: 'OPENROUTER_API_KEY', ask: 'OpenRouter API key for Jev:' },
  { label: 'Anthropic API key (Haiku 4.5)', model: 'anthropic/claude-haiku-4.5', key: 'ANTHROPIC_API_KEY', ask: 'Anthropic API key:' },
  { label: 'Your Codex subscription (the codex CLI, logged in)', model: 'codex', key: null },
];
export const taggerText = (t) => (t.via === 'codex' ? 'your Codex subscription (codex exec)'
  : `${t.model} through ${t.via === 'anthropic' ? 'the Anthropic API' : 'OpenRouter'}`) + (t.decider ? `, decisions by ${t.decider}` : '');

// through a shell: npm's codex on Windows is codex.cmd; it checks a login is saved, not that it still works
export function codexLogin(env = process.env) {
  const r = spawnSync('codex login status', { shell: true, env, encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const line = (r.stdout?.trim().split('\n')[0] || r.stderr?.trim().split('\n').at(-1) || r.error?.message || '').trim();
  return { ok: r.status === 0, line: line.replace(/sk-[\w-]+/g, 'sk-…') };
}

const ok = (s) => out(`   ${paint(C.MINT, '✓')} ${s}\n`);
const warn = (s) => out(`   ${paint(C.LILAC, '!')} ${s}\n`);
const info = (s) => out(`   ${paint(C.GREY, s)}\n`);
// a prompt, or its answer when init runs unattended (update): the default unless the caller chose
const yes = (ctx, q, def = true, auto = def) => (ctx.auto ? Promise.resolve(auto) : confirm(q, def));
const fail = (ctx, problem) => { ctx.problems.push(problem); return ctx.say(SAY.fail); };

async function step(ctx, n, line = SAY[n]) {
  if (ctx.auto) return out(`\n${paint(C.GHOST, `${n}/${STEPS.length}  ${STEPS[n - 1]}`, true)}\n`);
  const w = 28, fill = Math.round((w * n) / STEPS.length);
  out(`\n${paint(C.LILAC, '━'.repeat(fill))}${paint(C.GREY, '─'.repeat(w - fill))}  ${paint(C.GREY, `step ${n} of ${STEPS.length}`)}\n`);
  out(`${paint(C.GHOST, `${n}  ${STEPS[n - 1]}`, true)}\n`);
  if (line) { await ctx.say(line); await ctx.beat(3000); }
}

// keep label short: a wrapped line cannot be redrawn
async function progress(label, work, done = label) {
  const tty = process.stdout.isTTY && MODE !== 'none';
  let i = 0;
  const tick = () => process.stdout.write(`\r   ${paint(C.LILAC, ['•  ', '•• ', '•••', ' ••', '  •', '   '][i++ % 6])} ${label}\x1b[K`);
  const timer = tty ? setInterval(tick, 120) : null;
  if (tty) tick();
  try { return await work; } finally {
    clearInterval(timer);
    out(`${tty ? '\r' : ''}   ${paint(C.GREY, done)}${tty ? '\x1b[K' : ''}\n`);
  }
}

const run = (cmd, args, { cwd, timeout }) => new Promise((res) => {
  let text = '';
  const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill(), timeout);
  child.stdout.on('data', (d) => { text += d; });
  child.stderr.on('data', (d) => { text += d; });
  child.on('error', (error) => { clearTimeout(timer); res({ status: null, error, text }); });
  child.on('close', (status) => { clearTimeout(timer); res({ status, text }); });
});

export const hooksJson = (handlers) => ['{', '  "hooks": {', Object.entries(handlers).map(([ev, h]) => [
  `    ${JSON.stringify(ev)}: [{ "hooks": [{`,
  ...Object.entries(h).map(([k, v], i, all) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)}${i < all.length - 1 ? ',' : ''}`),
  '    }] }]',
].join('\n')).join(',\n'), '  }', '}'].join('\n');
export const mcpJson = (entry) => ['{', '  "mcpServers": {', `    ${JSON.stringify(MCP_NAME)}: {`,
  ...Object.entries(entry).map(([k, v], i, all) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)}${i < all.length - 1 ? ',' : ''}`),
  '    }', '  }', '}'].join('\n');

// the demo's script types into the same reader a user types into, so it walks the real prompts
function demoInput(fast) {
  const { stdin } = process;
  let skip = null;
  const beat = (ms) => (fast ? Promise.resolve() : new Promise((r) => {
    const t = setTimeout(go, ms);
    function go() { clearTimeout(t); skip = null; r(); }
    skip = go;
  }));
  const onKey = (k) => (String(k)[0] === '\x03' ? bail() : skip?.()); // raw mode: Ctrl-C arrives as a key
  if (stdin.isTTY) { setRaw(true); stdin.on('data', onKey); stdin.resume(); }
  const fake = (prefix) => [...`${prefix}${'x'.repeat(24 - prefix.length)}`];
  setFeed(async ({ kind, q }) => {
    const keys = kind === 'menu' && /tagger/.test(q) ? [DOWN, DOWN, UP, UP, '\r']
      : kind === 'menu' ? [DOWN, UP, '\r']
      : kind === 'hidden' ? [...fake(/OpenRouter/.test(q) ? 'sk-or-v1-' : 'sk-ant-api03-'), '\r']
      : kind === 'confirm' ? ['y', '\r'] : ['\r'];
    await beat(kind === 'confirm' ? 4000 : 1400);
    for (const k of keys) { press(k); if (k !== '\r') await beat(kind === 'hidden' ? 45 : 800); }
  });
  return { beat, stop() { setFeed(null); if (stdin.isTTY) { stdin.off('data', onKey); stdin.pause(); setRaw(false); } } };
}

const newCtx = (project, scope = 'project') => ({
  project, scope, mem: join(project, '.memory'), written: [], skipped: [], problems: [], keys: {},
  dry: false, say: async () => {}, beat: async () => {},
});
const rel = (ctx, p) => {
  const r = relative(ctx.project, p), h = relative(homedir(), p);
  return !r ? p : !r.startsWith('..') && !isAbsolute(r) ? r : !h.startsWith('..') && !isAbsolute(h) ? join('~', h) : p;
};
const pidFile = (project) => join(project, '.memory', 'server.pid');
const version = (cmd) => {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
};

// The desktop app's PATH is not a login shell. An absolute uv is what claude_desktop_config.json can spawn.
function commandPath(cmd) {
  const r = spawnSync(WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (r.status !== 0) return cmd;
  const found = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find((s) => s && isAbsolute(s));
  return found || cmd;
}

const stats = (timeout = 1500) => new Promise((res) => {
  const req = http.get(STATS, { timeout }, (r) => {
    let body = '';
    r.setEncoding('utf8');
    r.on('data', (d) => { body += d; });
    r.on('end', () => {
      if (r.statusCode !== 200) return res(null);
      try { res(JSON.parse(body)); } catch { res({ body: body.slice(0, 80) }); }
    });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => res(null));
});

function readPid(project) {
  try {
    const pid = Number(readFileSync(pidFile(project), 'utf8').trim());
    if (!pid) return null;
    try { process.kill(pid, 0); return { pid, alive: true }; } catch (e) { return { pid, alive: e.code === 'EPERM' }; }
  } catch { return null; }
}

// mode is POSIX only: on Windows chmod would change only the read-only flag
// copy a file aside before it is changed. Throws if the copy fails: nothing is written that is not saved first.
const homeOf = (ctx) => ctx.auto?.home || ctx.home || homedir();
function saveCopy(ctx, path) {
  if (ctx.dry || !existsSync(path)) return;
  const inMem = ctx.mem ? relative(ctx.mem, path) : '..';
  if (inMem === '' || (!inMem.startsWith('..') && !isAbsolute(inMem))) return; // .memory/ is the project's own data, keys included
  ctx.run ||= createRun(homeOf(ctx));
  ctx.run.add(path);
}

async function write(ctx, path, content, { what, preview = content, mode, redo } = {}) {
  const name = rel(ctx, path);
  if (WIN) mode = undefined;
  if (!ctx.auto) {
    out(`\n   ${paint(C.GHOST, 'write')} ${name}${mode ? paint(C.GREY, ` (mode ${mode.toString(8)})`) : ''}\n`);
    out(preview.trimEnd().split('\n').map((l) => `     ${paint(C.GREY, l)}`).join('\n') + '\n');
  }
  if (!(await yes(ctx, '   Write it?'))) {
    ctx.skipped.push(`${name} (${what})`);
    info('skipped');
    return false;
  }
  if (ctx.dry) { ctx.written.push([name, what]); return info('demo: not written'), true; }
  if (redo) {
    // the file may have changed while the question was open: read it again, and refuse it if it no longer parses
    try { content = redo(); } catch (e) { warn(e.message); await fail(ctx, `${name} left untouched: fix it by hand, then run again`); return false; }
  }
  try { saveCopy(ctx, path); } catch (e) {
    warn(`could not back up ${name} first (${e.code || e.message}); left it untouched`);
    await fail(ctx, `${name} left untouched: no backup could be made`);
    return false;
  }
  ctx.written.push([name, what]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, mode ? { mode } : undefined);
  if (mode) chmodSync(path, mode);
  ok(`wrote ${name}`);
  return true;
}

async function mergeFile(ctx, path, fn, { what, preview, same }) {
  let before, after;
  try { before = ctx.dry ? {} : readJson(path); after = fn(before); } catch (e) {
    warn(e.message);
    return fail(ctx, `${rel(ctx, path)} left untouched: fix it by hand, then run again`);
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return ok(same);
  await write(ctx, path, JSON.stringify(after, null, 2) + '\n', {
    what, preview, redo: () => JSON.stringify(fn(readJson(path)), null, 2) + '\n',
  });
}

// like mergeFile, for a text file (Codex's config.toml): the preview is what is added; nothing else in the file changes
async function mergeText(ctx, path, fn, { what, preview, same }) {
  let before, after;
  try {
    before = ctx.dry || !existsSync(path) ? '' : readFileSync(path, 'utf8');
    tomlOrThrow(path, before);
    after = fn(before);
  } catch (e) {
    warn(e.message);
    return fail(ctx, `${rel(ctx, path)} left untouched: fix it by hand, then run again`);
  }
  if (before === after) return ok(same);
  await write(ctx, path, after, {
    what, preview,
    redo: () => { const t = existsSync(path) ? readFileSync(path, 'utf8') : ''; tomlOrThrow(path, t); return fn(t); },
  });
}

function tomlOrThrow(path, text) {
  const bad = checkToml(text);
  if (bad) throw new Error(`${path} is not valid TOML (${bad}); left it untouched`);
}

const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
// Codex's user config is written by `codex mcp`, which keeps every other key. Project scope has no CLI: edit our table only.
// On Windows codex is codex.cmd, which spawn cannot run without a shell, so the file merge does it there.
export async function codexMcp(ctx, entry) {
  const cfg = codexConfigPath(ctx.project, ctx.scope), name = rel(ctx, cfg), toml = codexMcpToml(entry);
  const viaFile = () => mergeText(ctx, cfg, (t) => addCodexMcp(t, entry), {
    what: `MCP server ${MCP_NAME} for Codex`,
    preview: `${toml}\n  added to ${name}; nothing else in the file changes`,
    same: `${name} already has the MCP entry`,
  });
  if (ctx.scope === 'project') {
    await viaFile();
    info('Codex loads .codex/config.toml only for a trusted project. Trust this folder in Codex, or run init --scope user.');
    return;
  }
  if (WIN || (!ctx.dry && !version('codex'))) return viaFile();
  const have = ctx.dry ? null : codexMcpEntry(readText(cfg)), want = codexEntry(entry);
  if (have && JSON.stringify(have) === JSON.stringify(want)) return ok(`${name} already has the MCP entry`);
  const add = ['mcp', 'add', MCP_NAME, ...Object.entries(want.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--', want.command, ...want.args];
  if (!ctx.dry && readText(cfg).includes(MCP_NAME)) {
    const r = await runCmd(ctx, 'codex', ['mcp', 'remove', MCP_NAME], { what: `the old ${MCP_NAME} entry removed from Codex`, show: `codex mcp remove ${MCP_NAME}` });
    if (r?.status !== 0) return fail(ctx, `Codex MCP entry not replaced: run codex mcp remove ${MCP_NAME}, then init again`);
  }
  const r = await runCmd(ctx, 'codex', add, { what: `MCP server ${MCP_NAME} for Codex, user scope`, show: `codex ${add.map(shq).join(' ')}` });
  if (r && r.status !== 0) await fail(ctx, 'Codex MCP entry not added: run the codex mcp add line above in your shell');
}

// stdin closed: `claude mcp` waits on an open stdin
async function runCmd(ctx, cmd, args, { what, show }) {
  // `claude mcp` and `codex mcp` edit these files themselves: a copy first
  const touch = cmd === 'claude' ? [mcpPath(ctx.project, 'user')] : cmd === 'codex' ? [codexConfigPath(ctx.project, 'user')] : [];
  out(`\n   ${paint(C.GHOST, 'run')} ${show}\n`);
  if (!(await yes(ctx, '   Run it?'))) {
    ctx.skipped.push(what);
    info('skipped');
    return null;
  }
  if (ctx.dry) { ctx.written.push([cmd, what]); info('demo: not run'); return { status: 0 }; }
  try { touch.forEach((f) => saveCopy(ctx, f)); } catch (e) {
    warn(`could not back up first (${e.code || e.message}); not run`);
    ctx.problems.push(`${what}: no backup could be made`);
    return { status: 1 };
  }
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const l of `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').filter(Boolean)) info(l);
  if (r.status === 0) { ctx.written.push([cmd, what]); ok('done'); }
  else warn(r.error?.code === 'ENOENT' ? `${cmd} is not on your PATH` : r.error ? `${cmd}: ${r.error.code ?? r.error.message}` : `${cmd} exited ${r.status}`);
  return r;
}
const shq = (s) => (/^[\w./:@=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// the official installers; both put claude in ~/.local/bin, like uv's
export const CLAUDE_INSTALL = WIN
  ? 'powershell -ExecutionPolicy ByPass -c "irm https://claude.ai/install.ps1 | iex"'
  : 'curl -fsSL https://claude.ai/install.sh | bash';

// user scope needs `claude mcp` to add the MCP entry; project scope only writes files, so a missing claude is a warning there
export async function claudeCli(ctx, find = () => version('claude')) {
  let v = find();
  if (v) return ok(`claude ${v}`), v;
  if (ctx.dry) return info('claude is not on your PATH. demo: init would offer to install it here.'), null;
  warn(ctx.scope === 'user' ? 'claude is not on your PATH. Step 5 runs it to add the MCP entry.'
    : 'claude is not on your PATH. Claude Code is what loads these hooks.');
  info(`install it with: ${CLAUDE_INSTALL}`);
  if (await yes(ctx, '   Run that now?', false)) {
    spawnSync(CLAUDE_INSTALL, { shell: true, stdio: 'inherit' });
    process.env.PATH = `${join(homedir(), '.local', 'bin')}${delimiter}${process.env.PATH}`;
    v = find();
  }
  if (v) ok(`claude ${v}`);
  else info('Carrying on without it. Install Claude Code, then run init again.');
  return v;
}

// Claude Code writes ~/.claude.json itself, so only `claude mcp` changes it; add-json refuses a name that exists
const userEntry = (project) => { try { return readJson(mcpPath(project, 'user')).mcpServers?.[MCP_NAME]; } catch { return undefined; } };
async function userMcp(ctx, entry) {
  const have = ctx.dry ? undefined : userEntry(ctx.project), json = JSON.stringify(entry);
  if (JSON.stringify(have) === json) return ok(`${rel(ctx, mcpPath(ctx.project, 'user'))} already has the MCP entry`);
  const add = ['mcp', 'add-json', MCP_NAME, json, '--scope', 'user'];
  if (!ctx.dry && !ctx.claude) {
    out(`\n   ${paint(C.GHOST, 'run')} claude ${add.map(shq).join(' ')}\n`);
    warn('not run: claude is not on your PATH');
    return fail(ctx, 'MCP entry not added: install Claude Code, then run init again (or the claude mcp add-json line above)');
  }
  if (have) {
    const r = await runCmd(ctx, 'claude', ['mcp', 'remove', MCP_NAME, '--scope', 'user'],
      { what: `the old ${MCP_NAME} entry removed`, show: `claude mcp remove ${MCP_NAME} --scope user` });
    if (r?.status !== 0) return fail(ctx, `MCP entry not replaced: run claude mcp remove ${MCP_NAME} --scope user, then init again`);
  }
  const r = await runCmd(ctx, 'claude', add, { what: `MCP server ${MCP_NAME}, user scope`, show: `claude ${add.map(shq).join(' ')}` });
  if (r && r.status !== 0) await fail(ctx, 'MCP entry not added: run the claude mcp add-json line above in your shell');
}

// a clone's .venv and caches stay behind: a .venv belongs to the folder it was made in
const LEAVE = new Set(['.venv', '__pycache__', '.pytest_cache', '.memory', 'node_modules']);
// The hooks run from a copied folder, away from this package's "type": "module". Vendor the uploader there as its own module.
function vendorUploader(from, dir) {
  const src = join(from, 'cli', 'src');
  if (!existsSync(join(src, 'push.js'))) return;
  const lib = join(dir, 'hooks', 'lib');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, 'package.json'), '{ "type": "module" }\n');
  for (const f of ['cloud.js', 'credentials.js', 'push.js', 'team.js', 'share.js', 'team-invoke.js', 'mask.js', 'upload-state.js']) cpSync(join(src, f), join(lib, f));
}

export function install(from, dir) {
  for (const d of ['server', 'hooks']) cpSync(join(from, d), join(dir, d), { recursive: true, filter: (p) => !LEAVE.has(basename(p)) });
  if (existsSync(join(from, 'package.json'))) cpSync(join(from, 'package.json'), join(dir, 'package.json'));
  if (existsSync(join(from, 'bin'))) cpSync(join(from, 'bin'), join(dir, 'bin'), { recursive: true, filter: (p) => !LEAVE.has(basename(p)) });
  if (existsSync(join(from, 'cli', 'src'))) cpSync(join(from, 'cli', 'src'), join(dir, 'cli', 'src'), { recursive: true, filter: (p) => !LEAVE.has(basename(p)) });
  vendorUploader(from, dir);
}

// A command on PATH. The copy in INSTALL_DIR is what it runs, so login is `spookling login`.
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const cliLinkPath = (home = homedir()) => (WIN
  ? join(home, 'AppData', 'Local', 'spookling-memory', 'bin', 'spookling.cmd')
  : join(home, '.local', 'bin', 'spookling'));

export function linkCli(dir, home = homedir()) {
  const target = join(dir, 'bin', 'spookling-memory.js');
  if (!existsSync(target)) return null;
  const path = cliLinkPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const body = WIN
    ? `@echo off\r\nnode "${target}" %*\r\n`
    : `#!/bin/sh\nexec node ${shQuote(target)} "$@"\n`;
  writeFileSync(path, body, { mode: 0o755 });
  if (!WIN) chmodSync(path, 0o755);
  return path;
}

// true when the server is in place, copied now or by an earlier init
async function copyOut(ctx) {
  out(`\n   ${paint(C.GHOST, 'copy')} server/ and hooks/ to ${rel(ctx, INSTALL_DIR)}\n`);
  info(`  from ${ROOT}`);
  info('  a folder per version, so Claude Code never runs files from the npx cache; uninstall leaves it');
  if (!(await yes(ctx, '   Copy them?'))) {
    ctx.skipped.push(`copying the server to ${rel(ctx, INSTALL_DIR)}`);
    info('skipped');
    return ctx.dry || existsSync(join(SERVER_DIR, 'pyproject.toml'));
  }
  ctx.written.push([rel(ctx, INSTALL_DIR), 'the server and hooks']);
  if (ctx.dry) return info('demo: not copied'), true;
  try { install(ROOT, INSTALL_DIR); } catch (e) { warn(`copy failed: ${e.message}`); return false; }
  ok(`copied to ${rel(ctx, INSTALL_DIR)}`);
  try {
    const cmd = linkCli(INSTALL_DIR);
    if (cmd) {
      ctx.written.push([rel(ctx, cmd), 'the spookling command']);
      ok('spookling login');
      const binDir = dirname(cmd);
      const pathDirs = (process.env.PATH || '').split(delimiter);
      if (!pathDirs.includes(binDir)) info(`If spookling is not found, add ${rel(ctx, binDir)} to PATH and open a new terminal.`);
    }
  } catch (e) { warn(`could not add the spookling command: ${e.message}`); }
  return true;
}

function keysFile(text, keys) {
  const lines = text ? text.replace(/\n$/, '').split('\n') : [];
  for (const [k, v] of Object.entries(keys)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`; else lines.push(`${k}=${v}`);
  }
  return lines.join('\n') + '\n';
}
const envValue = (text, k) => text.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.trim();

function startServer(ctx) {
  const dir = ctx.serverHome || ctx.project; // update restarts a server in the folder it was running from
  mkdirSync(join(dir, '.memory'), { recursive: true });
  const log = openSync(join(dir, '.memory', 'server.log'), 'a');
  const args = ['run', '--project', SERVER_DIR, 'spookling-memory', 'serve', '--folder', '.memory', '--port', String(PORT)];
  if (ctx.model) args.push('--model', ctx.model);
  if (ctx.decider) args.push('--decider', ctx.decider);
  // detached, so it outlives the wizard; PYTHONUTF8, or Python on Windows reads files as cp1252
  const child = spawn('uv', args, {
    cwd: dir, detached: true, windowsHide: true, stdio: ['ignore', log, log],
    env: { ...process.env, PYTHONUTF8: '1', ...ctx.keys },
  });
  child.on('error', () => {});
  child.unref();
  closeSync(log);
  if (child.pid) writeFileSync(pidFile(dir), `${child.pid}\n`);
  return child.pid;
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// A server init started has a pid: when that process is gone, waiting is pointless. A server that was already running
// (from another scope or project) may just be busy serving hooks, so it gets the whole backoff, ~10 s, 1.5 s then 3 s a probe.
export async function waitForStats(ctx, { probe = stats, pause = sleep, alive = pidAlive } = {}) {
  let d = 250;
  for (let i = 0; i < 8; i++) {
    const r = await probe(i === 0 ? 1500 : 3000);
    if (r) return r;
    if (ctx.pid && !alive(ctx.pid)) return null;
    out(paint(C.GREY, '.'));
    await pause(d + Math.random() * d);
    d = Math.min(d * 2, 3000);
  }
  return null;
}

// Which log to read when the smoke test fails. Only paths that exist are named.
export function smokeFailure(ctx, home = homedir()) {
  if (SHARE) return `nothing answered on 127.0.0.1:${PORT}. Start the server in WSL (the command in step 4).`;
  const own = join(ctx.mem, 'server.log');
  if (ctx.pid) return `nothing answered on 127.0.0.1:${PORT}. Look in ${rel(ctx, existsSync(own) ? own : ctx.mem)}.`;
  const user = join(home, '.memory', 'server.log');
  const where = [own, user].find((f) => existsSync(f));
  return `nothing answered on 127.0.0.1:${PORT}, a server this run did not start${ctx.reused ? ' (it answered at step 4)' : ''}. `
    + `${where ? `Its log may be ${rel(ctx, where)}. ` : ''}Run spookling status.`;
}


// ---- update: the same steps, answered from what is wired and what the last init chose ----

const installsPath = (home) => join(home, '.spookling', 'install.json');
function readInstalls(home = homedir()) {
  try {
    const raw = JSON.parse(readFileSync(installsPath(home), 'utf8'));
    return Array.isArray(raw?.installs) ? raw.installs.filter((i) => i && ['claude', 'codex'].includes(i.harness) && ['project', 'user'].includes(i.scope)) : [];
  } catch { return []; }
}
const installKey = (i) => `${i.harness}|${i.scope}|${i.scope === 'project' ? resolve(i.project || '') : ''}`;

// after every successful init: what was chosen, so `update` can ask nothing. Never fails the init.
function recordInstall(ctx) {
  try {
    const home = ctx.auto?.home || homedir();
    const entry = {
      harness: ctx.harness, scope: ctx.scope, project: ctx.scope === 'project' ? resolve(ctx.project) : null,
      ghost: ctx.harness === 'claude' ? !!ctx.ghostOn : null,
      tagger: Math.max(0, TAGGERS.findIndex((t) => t.model === ctx.model)),
      start: !!(ctx.pid || ctx.reused || ctx.serverUp),
    };
    const rest = readInstalls(home).filter((i) => installKey(i) !== installKey(entry));
    writeFileSecure(installsPath(home), JSON.stringify({ version: VERSION, updatedAt: new Date().toISOString(), installs: [...rest, entry] }, null, 2) + '\n');
  } catch { /* the install itself worked */ }
}

/** The command line of a process, or null. Used to be sure a pid is our server before stopping it. */
function processCommand(pid, run = spawnSync) {
  const r = WIN
    ? run('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    : run('ps', ['-o', 'command=', '-p', String(Number(pid))], { encoding: 'utf8', timeout: 5000 });
  return r?.status === 0 ? String(r.stdout || '').trim() || null : null;
}

// ours: started by init from a version folder (…/spookling-memory/<version>/server) as `spookling-memory serve`
const OUR_SERVER = /spookling-memory[\\/]([^\\/\s"']+)[\\/]server\b[\s\S]*\bserve\b/;
export const serverVersion = (cmd) => OUR_SERVER.exec(String(cmd ?? ''))?.[1] ?? null;

// A server from an older version folder is stopped, like uninstall does, and the new one is started in the same folder.
// A pid file that points at anything else is left alone.
export async function stopOldServers(ctx) {
  const a = ctx.auto, home = a.home || homedir();
  const dirs = [...new Set([ctx.project, home, ...(a.knownProjects || [])].map((d) => resolve(d)))];
  for (const dir of dirs) {
    const p = readPid(dir);
    if (!p?.alive) continue;
    const v = serverVersion((a.ps || processCommand)(p.pid));
    if (!v) { info(`pid ${p.pid} in ${rel(ctx, pidFile(dir))} is not a Spookling server of ours; left alone`); continue; }
    if (v === VERSION) continue;
    info(`stopping the memory server from ${v} (pid ${p.pid})`);
    if (!(a.stop || stopServer)(p.pid)) { warn(`could not stop pid ${p.pid}`); await fail(ctx, `the old server (pid ${p.pid}) is still running`); continue; }
    const gone = () => !(a.alive || pidAlive)(p.pid);
    for (let i = 0; i < 50 && !gone(); i++) await (a.pause || sleep)(200);
    if (!gone()) { warn(`pid ${p.pid} is still shutting down`); await fail(ctx, `the old server (pid ${p.pid}) did not stop`); continue; }
    rmSync(pidFile(dir), { force: true });
    ctx.serverHome = dir;
    a.start = true;
    ok(`stopped pid ${p.pid}`);
  }
}

/**
 * What is wired, and the choices to repeat. Wired targets come from the same files status reads; the harness, ghost, tagger and
 * server choices come from install.json when it has them, else from what is on disk and answering.
 */
export async function detectInstall({ project = process.cwd(), home = homedir(), probe = stats } = {}) {
  const saved = readInstalls(home), live = await probe(1500).catch(() => null);
  const found = [];
  const ctx = newCtx(project);
  const fromKeys = (dir) => { try { const t = readFileSync(join(dir, '.memory', 'keys.env'), 'utf8'); return /^ANTHROPIC_API_KEY=./m.test(t) ? 1 : /^OPENROUTER_API_KEY=./m.test(t) ? 0 : null; } catch { return null; } };
  const same = resolve(project) === resolve(home);
  for (const scope of ['user', ...(same ? [] : ['project'])]) {
    const dir = scope === 'user' ? home : project;
    const add = (harness, ghost) => {
      const s = saved.find((i) => installKey(i) === installKey({ harness, scope, project: dir }));
      const liveTagger = TAGGERS.findIndex((t) => t.model === live?.tagger?.model);
      const tagger = s?.tagger ?? (liveTagger >= 0 ? liveTagger : null) ?? fromKeys(dir) ?? fromKeys(project) ?? fromKeys(home) ?? 0;
      found.push({
        harness, scope, project: dir, tagger,
        ghost: harness === 'claude' ? (s?.ghost ?? ghost) : null,
        start: s?.start ?? (!!live || !!readPid(dir)),
      });
    };
    try {
      const settings = readJson(settingsPath(dir, scope)), w = wiring(settings, readJson(mcpPath(dir, scope)));
      if (w.events.length || w.mcp) add('claude', isOurStatus(settings.statusLine));
    } catch { /* an unreadable file is status's to report */ }
    try {
      const w = wiring(readJson(codexHooksPath(dir, scope)), {});
      if (w.events.length || codexMcpEntry(readText(codexConfigPath(dir, scope)))) add('codex', null);
    } catch { /* same */ }
  }
  const elsewhere = [...new Set(saved.filter((i) => i.scope === 'project' && i.project && resolve(i.project) !== resolve(project)
    && existsSync(i.project)).map((i) => resolve(i.project)))];
  return { targets: found, elsewhere, live };
}

/** Do hooks, MCP entries or the spookling command still point at a version folder other than this one? Same references status reads. */
export function staleWiring(project = process.cwd(), home = homedir()) {
  if (SHARE) return false;
  const texts = [];
  const take = (f) => { try { return f(); } catch { return undefined; } };
  for (const scope of ['project', 'user']) {
    const settings = take(() => readJson(settingsPath(project, scope))), cfg = take(() => readJson(mcpPath(project, scope)));
    if (settings) texts.push(...ourHookCommands(settings));
    if (cfg) texts.push(mcpCommand(cfg));
    const codex = take(() => readJson(codexHooksPath(project, scope)));
    if (codex) texts.push(...ourHookCommands(codex));
    const have = codexMcpEntry(readText(codexConfigPath(project, scope)));
    if (have) texts.push([have.command, ...have.args].join(' '));
  }
  const desktop = take(() => readJson(claudeDesktopConfigPath()));
  if (desktop) texts.push(mcpCommand(desktop));
  texts.push(readText(cliLinkPath(home)));
  return texts.some((t) => installVersions(t).some((v) => v !== VERSION));
}

// `init --update`: no cutscene, no prompts, works without a TTY. Returns the exit code.
export async function initUpdate({ project = process.cwd(), home = homedir(), probe = stats, ps, stop, alive, pause, find = detectInstall, withStatus = true } = {}) {
  out(`${paint(C.GHOST, `Updating Spookling Memory to ${VERSION}`, true)}  ${paint(C.GREY, project)}\n`);
  const { targets, elsewhere, live } = await find({ project, home, probe });
  if (elsewhere.length) info(`Other projects with a project-scope install: ${elsewhere.join(', ')}. Run spookling update in each.`);
  const inProject = targets.some((t) => t.scope === 'project');
  if (!inProject && resolve(project) !== resolve(home)) info('This folder has no project-scope install, so only your user scope is updated.');
  if (!targets.length) {
    warn('No Spookling wiring found for this folder or your user files. Run npx spookling init to set it up.');
    return 1;
  }
  const run = createRun(home);
  const shared = { home, ps, stop, alive, pause, step4Done: false, knownProjects: elsewhere };
  let code = 0;
  for (const t of targets) {
    out(`\n   ${paint(C.GHOST, `${t.harness === 'claude' ? 'Claude Code' : 'Codex'}, ${t.scope} scope`)}${t.scope === 'project' ? paint(C.GREY, `  ${t.project}`) : ''}\n`);
    Object.assign(shared, { harness: t.harness, tagger: t.tagger, ghost: t.ghost !== false, start: t.start });
    const ctx = { ...newCtx(t.project, t.scope), ghost: true, auto: shared, run };
    const st = { live: false, close() {} };
    code = Math.max(code, await steps(ctx, { anim: false, st }));
    if (ctx.problems.length) break;
  }
  const base = dirname(INSTALL_DIR);
  if (run.label()) out(`   ${paint(C.GREY, run.label())}\n`);
  if (!SHARE && existsSync(base)) {
    for (const d of readdirSync(base).filter((n) => n !== VERSION && /^\d+\.\d+\.\d+/.test(n)).sort()) {
      out(`   ${paint(C.GREY, `Old version kept in ${join('~', relative(home, join(base, d)))} (safe to delete once you're happy).`)}\n`);
    }
  }
  if (withStatus) {
    out('\n');
    await status(project, probe, home, { noUpdate: true });
  }
  return code;
}

export async function init({ anim = true, project = process.cwd(), scope = 'project', dry = false, fast = false, ghost = true } = {}) {
  const label = dry ? DEMO_LABEL : '';
  await play({ anim: anim && !fast, keep: fits(anim), label });
  const ctx = { ...newCtx(project, scope), ghost };
  const demo = dry ? demoInput(fast) : null;
  const st = stage({ anim, label, hold: fast ? 0 : 1200 });
  Object.assign(ctx, { dry, say: st.say, beat: demo?.beat ?? ctx.beat });
  try {
    return await steps(ctx, { anim, st });
  } finally {
    st.close();
    demo?.stop();
  }
}

// Node, uv and git. False (after saying why) when init cannot go on.
async function stepChecks(ctx) {
  await step(ctx, 1);
  if (Number(process.versions.node.split('.')[0]) < 18) {
    warn(`Node ${process.version} is too old. Spookling Memory needs Node 18 or newer.`);
    await ctx.say(SAY.fail);
    return false;
  }
  ok(`node ${process.version}`);
  let uv = version('uv');
  if (!uv && ctx.dry) info('uv is not on your PATH. demo: init would offer to install it here.');
  else if (!uv) {
    const cmd = process.platform === 'win32'
      ? 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
      : 'curl -LsSf https://astral.sh/uv/install.sh | sh';
    warn('uv is not on your PATH. The memory server runs on it.');
    info(`install it with: ${cmd}`);
    if (await yes(ctx, '   Run that now?', false)) {
      spawnSync(cmd, { shell: true, stdio: 'inherit' });
      process.env.PATH = `${join(homedir(), '.local', 'bin')}${delimiter}${process.env.PATH}`;
      uv = version('uv');
    }
    if (!uv) { warn('Install uv, then run init again.'); await ctx.say(SAY.fail); return false; }
  }
  if (uv) ok(uv);
  const git = version('git');
  if (git) ok(git); else warn('git not found. That is fine; .memory/ is just easier to back up inside a repo.');
  await ctx.beat(1200);
  return true;
}

// Claude Code or Codex.
async function stepHarness(ctx) {
  await step(ctx, 2);
  ctx.harness = ctx.auto ? ctx.auto.harness : ['claude', 'codex'][await choose('   Which one?', ['Claude Code', 'Codex'])];
  ok(ctx.harness === 'claude' ? 'Claude Code' : 'Codex');
  if (ctx.harness === 'claude') ctx.claude = await claudeCli(ctx);
}

// How the tagger runs, its key, and .memory/.gitignore.
async function stepTagger(ctx) {
  // the demo reads neither the environment nor keys.env, so the key prompt shows
  await step(ctx, 3);
  const t = TAGGERS[ctx.auto ? ctx.auto.tagger : await choose('   How should the tagger run?', TAGGERS.map((x) => x.label))];
  ctx.decider = t.decider || null;
  ctx.model = t.model;
  ok(t.label);
  const envPath = join(ctx.mem, 'keys.env');
  if (t.key) {
    const envText = !ctx.dry && existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    const name = t.key, have = envValue(envText, name);
    let v = ctx.dry ? undefined : process.env[name];
    if (v) ok(`${name} found in your environment`);
    else if (have) { ok(`${name} already in .memory/keys.env`); v = have; }
    else if (!ctx.auto && (v = await askHidden(`   ${t.ask}`))) ok(`${name} received`);
    if (!v) {
      warn(`${name} not set. Put it in .memory/keys.env later; the server needs it to tag.`);
      await fail(ctx, `no ${name}`);
    } else {
      ctx.keys[name] = v;
      if (name === 'ANTHROPIC_API_KEY' && !v.startsWith('sk-ant-')) warn('That key does not start with sk-ant-. Kept as given.');
      if (v === have) ok('.memory/keys.env already up to date');
      else {
        await write(ctx, envPath, keysFile(envText, { [name]: v }), {
          what: WIN ? 'your key (kept out of git; mind who can read this folder)' : 'your key, readable only by you', mode: 0o600,
          preview: `${name}=********`,
        });
      }
    }
  } else {
    const c = codexLogin();
    out(`   ${paint(C.GREY, 'codex login status')}\n`);
    if (c.ok) {
      ok(c.line || 'logged in');
      if (/api key/i.test(c.line)) warn('That login is an API key, so tagging bills the API, not your plan. codex login switches it.');
      info('That checks a login is saved, not that it still works; the first tag does (errors go to .memory/server.log).');
      info('Each chat then takes several seconds to tag and uses a little of your plan (Plus or higher); its terms apply.');
    } else {
      warn(c.line || 'codex did not answer');
      info('Install the codex CLI (npm install -g @openai/codex), run codex login, then run init again.');
      await fail(ctx, 'codex is not installed or not logged in');
    }
  }
  const giPath = join(ctx.mem, '.gitignore');
  const gi = !ctx.dry && existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  const missing = IGNORE.filter((l) => !gi.split(/\r?\n/).includes(l));
  if (missing.length) {
    await write(ctx, giPath, gi + (gi && !gi.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n', {
      what: 'keeps your keys and the caches out of git',
    });
  }
}

// Copy the server out, uv sync, and start (or find) the server.
async function stepServer(ctx) {
  await step(ctx, 4);
  if (SHARE) {
    info(`The server folder is inside WSL (${SHARE.distro}), so the server runs there. In WSL, from your project:`);
    info(`  node '${SHARE.path.replace(/\/server$/, '')}/bin/spookling-memory.js' init`);
    info('No uv sync from Windows: it would build a Windows .venv over the one WSL uses.');
    ctx.skipped.push('the server install (it runs in WSL)');
  } else if (!existsSync(join(ROOT, 'server', 'pyproject.toml'))) {
    warn(`No memory server found at ${join(ROOT, 'server')}.`);
    await fail(ctx, 'memory server not found');
  } else if (ctx.auto?.step4Done) {
    ok('server already installed and checked in this run');
  } else if (!(await copyOut(ctx))) {
    await fail(ctx, `the server is not in ${rel(ctx, INSTALL_DIR)}: let init copy it there`);
  } else {
    const label = 'installing the server (uv sync)', done = `uv sync in ${rel(ctx, SERVER_DIR)}`;
    const r = ctx.dry ? (await progress(label, ctx.beat(3000), done), null)
      : await progress(label, run('uv', ['sync'], { cwd: SERVER_DIR, timeout: 10 * 60_000 }), done);
    if (ctx.dry) info('demo: skipped');
    else {
      // uv's own summary; the per-package lines only when it failed
      for (const l of r.text.split(/\r?\n/)) if (l.trim() && (r.status !== 0 || !/^\s*[-+~] /.test(l))) info(l.trim());
    }
    if (r && r.status !== 0) {
      warn(r.error ? `uv sync: ${r.error.code ?? r.error.message}` : 'uv sync failed (output above).');
      await fail(ctx, 'uv sync failed');
    } else {
      if (!ctx.dry) ok('server installed');
      if (ctx.auto) await stopOldServers(ctx);
      const up = !ctx.dry && (await stats() || await stats(3000)); // a busy server can miss one probe
      if (up?.tagger && up.tagger.model !== ctx.model) {
        const p = readPid(ctx.project);
        warn(`a server already answers on 127.0.0.1:${PORT}, tagging with ${taggerText(up.tagger)}.`);
        info(`Stop it${p?.alive ? ` (pid ${p.pid})` : ''}, then run init again to switch the tagger.`);
        await fail(ctx, 'the running server has another tagger');
      } else if (up) { ctx.reused = true; ok(`a server already answers on 127.0.0.1:${PORT}`); }
      else if (await yes(ctx, '   Start it in the background? (pid in .memory/server.pid, log in .memory/server.log)', true, ctx.auto?.start)) {
        if (ctx.dry) {
          info('demo: not started');
          ctx.written.push(['memory server', `127.0.0.1:${PORT}`]);
        } else {
          ctx.pid = startServer(ctx);
          if (ctx.pid) {
            ok(`started, pid ${ctx.pid}`);
            ctx.written.push(['memory server', `127.0.0.1:${PORT}, pid ${ctx.pid}`]);
          } else { warn('could not start uv'); await fail(ctx, 'server did not start'); }
        }
      } else ctx.skipped.push('starting the server');
    }
    if (ctx.auto && !ctx.problems.length) ctx.auto.step4Done = true;
  }
}

// Wire the hooks and MCP entries of the chosen harness.
async function stepWire(ctx) {
  const { project, scope } = ctx;
  await step(ctx, 5, ctx.harness === 'claude' ? SAY[5] : SAY.codex);
  if (ctx.harness === 'codex') {
    if (!existsSync(join(ctx.dry ? join(ROOT, 'hooks') : HOOKS_DIR, 'spookling-codex.cjs'))) await fail(ctx, 'Codex hook script missing');
    const handlers = codexHandlers(HOOKS_DIR), sp = codexHooksPath(project, scope);
    await mergeFile(ctx, sp, (s) => addHooks(s, handlers), {
      what: 'Codex hooks: SessionStart, UserPromptSubmit, PreCompact, Stop',
      preview: `${hooksJson(handlers)}\n  merged in; existing hooks stay`,
      same: `${rel(ctx, sp)} already has the hooks`,
    });
    await codexMcp(ctx, mcpEntry(SERVER_DIR, SERVER_URL));
    info('Open /hooks in Codex and review/trust the Spookling hooks before they can run.');
    info('The ghost appears in hook activity; ready/active messages follow successful server checks or recall.');
  }
  else {
    const handlers = hookHandlers(HOOKS_DIR), hooksAt = ctx.dry ? join(ROOT, 'hooks') : HOOKS_DIR; // the demo copies nothing
    for (const f of [...new Set(Object.values(HOOK_FILES)), 'pulse.js', STATUS_FILE]) {
      if (!existsSync(join(hooksAt, f))) {
        warn(`${join(hooksAt, f)} is missing; Claude Code will report it on each event.`);
        await fail(ctx, `hook script ${f} missing`);
      }
    }
    if (!version('node')) warn('`node` is not on your PATH here. The hooks run `node`, so Claude Code needs it on its PATH.');
    const sp = settingsPath(project, scope);
    const ghost = ctx.ghost && await yes(ctx, '   Show the ghost in your status line?', true, ctx.auto?.ghost);
    let line = '';
    try { line = ghost ? addStatusLine(ctx.dry ? {} : readJson(sp), HOOKS_DIR).statusLine : ''; } catch {} // mergeFile reports it
    await mergeFile(ctx, sp, (s) => (ghost ? addStatusLine(addHooks(s, handlers), HOOKS_DIR) : addHooks(s, handlers)), {
      what: `hooks: PreCompact, UserPromptSubmit, Stop, SessionEnd${ghost ? '; the ghost in the status line' : ''}`,
      preview: `${hooksJson(handlers)}${line ? `\n"statusLine": ${JSON.stringify(line, null, 2)}` : ''}\n  merged in; nothing else in the file changes`
        + (line && / --then /.test(line.command) ? '\n  your status line stays first; uninstall puts it back as it was' : ''),
      same: `${rel(ctx, sp)} already has the hooks${ghost ? ' and the ghost' : ''}`,
    });
    ctx.ghostOn = !!ghost;
    if (!ghost) info('No ghost in the status line. npx spookling init again adds it.');
    const entry = mcpEntry(SERVER_DIR, SERVER_URL);
    const desktopEntry = mcpEntry(SERVER_DIR, SERVER_URL, commandPath('uv'));
    if (scope === 'project') {
      await mergeFile(ctx, mcpPath(project), (c) => addMcp(c, entry), {
        what: `MCP server ${MCP_NAME}`,
        preview: `${mcpJson(entry)}\n  merged in; other servers stay`,
        same: '.mcp.json already has the MCP entry',
      });
    } else await userMcp(ctx, entry);
    const desktopPath = claudeDesktopConfigPath();
    await mergeFile(ctx, desktopPath, (c) => addMcp(c, desktopEntry), {
      what: `MCP server ${MCP_NAME} for the Claude desktop app`,
      preview: `${mcpJson(desktopEntry)}\n  merged into Claude's desktop config; other keys stay`,
      same: `${rel(ctx, desktopPath)} already has the MCP entry`,
    });
  }
}

// Ask the server for its stats.
async function stepSmoke(ctx) {
  await step(ctx, 6);
  out(`   ${paint(C.GREY, `GET ${STATS} `)}`);
  let res;
  if (ctx.dry) {
    for (let i = 0; i < 3; i++) { await ctx.beat(500); out(paint(C.GREY, '.')); }
    res = { n_events: 0, n_facts: 0, n_rows: 0, reset: null };
  } else res = await waitForStats(ctx);
  ctx.serverUp = !!res;
  out('\n');
  const short = (j) => (j.length > 50 ? `${j.slice(0, 49)}…` : j);
  if (res) {
    ok(`the server answered: ${short(JSON.stringify(res))}`);
    if (ctx.dry) info('demo: a sample reply');
  } else {
    warn(`${smokeFailure(ctx)}`);
    await fail(ctx, 'smoke test failed');
  }
}

// The last step: did the wiring take, the summary, and the exit code.
async function stepDone(ctx, { anim, st }) {
  const { project, scope } = ctx;
  await step(ctx, 7, null);
  await ctx.beat(1000);
  let wired = true;
  if (ctx.harness === 'claude' && !ctx.dry) {
    try {
      const w = wiring(readJson(settingsPath(project, scope)), readJson(mcpPath(project, scope)));
      const desktopMcp = wiring({}, readJson(claudeDesktopConfigPath())).mcp;
      wired = w.events.length === Object.keys(HOOK_FILES).length && w.mcp && desktopMcp;
    } catch { wired = false; }
  }
  if (ctx.harness === 'codex' && !ctx.dry) {
    try {
      wired = CODEX_EVENTS.every((ev) => wiring(readJson(codexHooksPath(project, scope)), {}).events.includes(ev))
        && !!codexMcpEntry(readText(codexConfigPath(project, scope)));
    } catch { wired = false; }
  }
  st.close();
  if (!ctx.auto) await flyOnce(wired && !ctx.problems.length ? SAY[7] : SAY.fail, { anim });
  if (wired && !ctx.problems.length && !ctx.dry) recordInstall(ctx);
  for (const [name, what] of ctx.written) out(`   ${paint(C.MINT, `✓ ${name.padEnd(24)}`)} ${paint(C.GREY, what)}\n`);
  for (const s of ctx.skipped) out(`   ${paint(C.GREY, `- skipped ${s}`)}\n`);
  for (const p of ctx.problems) out(`   ${paint(C.LILAC, '!')} ${p}\n`);
  if (!ctx.auto && ctx.run?.label()) out(`   ${paint(C.GREY, ctx.run.label())}\n`);
  if (wired && !ctx.problems.length) {
    out(`\n   ${paint(C.MINT, 'Spookling Memory is in.', true)}\n`);
    out(ctx.dry ? `   ${paint(C.GREY, 'demo: nothing was written, started or run.')}\n\n` : '\n');
    return 0;
  }
  out(`\n   Not quite in yet. Fix the lines marked ! (or the skipped writes) and run init again.\n\n`);
  return 1;
}

async function steps(ctx, { anim, st }) {
  const { project, scope } = ctx;
  if (ctx.dry && !st.live) info(DEMO_LABEL);
  out(`   Setting up Spookling Memory in ${paint(C.GHOST, project)}${scope === 'user' ? paint(C.GREY, ' (hooks and MCP for all your projects)') : ''}\n`);
  info('Every file is shown before it is written. Answer n to skip it.');

  if (!(await stepChecks(ctx))) return 1;
  await stepHarness(ctx);
  await stepTagger(ctx);
  await stepServer(ctx);
  await stepWire(ctx);
  await stepSmoke(ctx);
  return stepDone(ctx, { anim, st });
}

// Local files only: the saved login, the team feed cache and the upload queue. No network, so it never hangs.
function cloudLine(line, home) {
  try {
    const creds = readCredentials({ home });
    if (!creds.token) return line('cloud', 'not logged in (spookling login)', false);
    const who = creds.fromEnv && !creds.user ? 'SPOOKLING_TOKEN' : (creds.user?.email || creds.user?.name || creds.user?.id || 'saved login');
    const times = Object.values(readCache(home).orgs).map((o) => o.serverTime).filter((t) => t && !Number.isNaN(Date.parse(t))).sort();
    const sync = times.length ? times[times.length - 1] : null;
    const { turns, sessions } = pendingUploads(home);
    line('cloud', `logged in as ${who}; last sync ${sync || 'never'}; ${turns ? `${turns} turn${turns === 1 ? '' : 's'} in ${sessions} session${sessions === 1 ? '' : 's'} not uploaded yet` : 'no turns waiting to upload'}`, true);
  } catch (e) { line('cloud', `could not read local cloud state: ${e.message}`, false); }
}

// What version folders do hooks, MCP entries and the spookling command point at? [what, version] pairs; hook commands are kept per harness.
function refTracker() {
  const refs = [], hookRefs = { claude: [], codex: [] };
  const track = (what, text, hooks) => {
    const vs = installVersions(text);
    vs.forEach((v) => refs.push([what, v]));
    if (hooks) hookRefs[hooks].push(vs.length ? vs : [VERSION]); // no version in the path: not an old install
  };
  return { refs, hookRefs, track };
}

// Claude Code's hooks and MCP entries, in the project and user files and the desktop app's config.
function scanClaude({ project, home, ctx, line, track }) {
  const where = { events: [], mcp: [] }, got = new Set();
  for (const scope of ['project', 'user']) {
    try {
      const settings = readJson(settingsPath(project, scope)), cfg = readJson(mcpPath(project, scope));
      const w = wiring(settings, cfg);
      if (w.events.length) where.events.push(`${w.events.join(', ')} in ${rel(ctx, settingsPath(project, scope))}`);
      if (w.mcp) where.mcp.push(`${MCP_NAME} in ${rel(ctx, mcpPath(project, scope))}`);
      w.events.forEach((ev) => got.add(ev));
      ourHookCommands(settings).forEach((c) => track('hooks', c, 'claude'));
      track('MCP entries', mcpCommand(cfg));
    } catch (e) { line('config', e.message, false); }
  }
  try {
    const desktop = claudeDesktopConfigPath(), cfg = readJson(desktop);
    if (wiring({}, cfg).mcp) where.mcp.push(`${MCP_NAME} in ${rel(ctx, desktop)}`);
    track('MCP entries', mcpCommand(cfg));
  } catch (e) { line('config', e.message, false); }
  track('the spookling command', readText(cliLinkPath(home)));
  return { where, events: [...got] };
}

// Codex's hooks.json and config.toml, project and user.
function scanCodex({ project, ctx, line, track }) {
  const got = new Set(), where = [], mcpWhere = [];
  for (const scope of ['project', 'user']) {
    const cp = codexHooksPath(project, scope), cc = codexConfigPath(project, scope);
    try {
      const settings = readJson(cp), w = wiring(settings, {});
      if (w.events.length) where.push(`${w.events.join(', ')} in ${rel(ctx, cp)}`);
      w.events.forEach((ev) => got.add(ev));
      ourHookCommands(settings).forEach((c) => track('hooks', c, 'codex'));
    } catch (e) { line('config', e.message, false); }
    const have = codexMcpEntry(readText(cc));
    if (have) {
      mcpWhere.push(`${MCP_NAME} in ${rel(ctx, cc)}${scope === 'project' ? ' (Codex loads it only for a trusted project)' : ''}`);
      track('MCP entries', [have.command, ...have.args].join(' '));
    }
  }
  return { got, where, mcpWhere };
}

// Before 0.2.0 there is no `spookling update`, so a wiring that old is moved with npx; from 0.2.0 on the installed command can update itself.
export function upgradeAdvice(oldVersions) {
  const first = oldVersions.some((v) => { try { return compareVersions(v, '0.2.0') < 0; } catch { return true; } });
  return first ? 'Run npx spookling@latest init' : 'Run spookling update';
}

// An upgrade in progress: the hooks run from the old folder, which still works (see README, Upgrading). Not a missing-files problem.
function upgradeState({ refs, hookRefs }) {
  const old = new Map();
  if (!SHARE) for (const [what, v] of refs) if (v !== VERSION) old.set(v, [...new Set([...(old.get(v) ?? []), what])]);
  const onlyOld = (list) => list.length > 0 && list.every((vs) => vs.every((v) => v !== VERSION) && !SHARE);
  const list = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);
  return {
    upgrade: old.size > 0,
    claudeOld: onlyOld(hookRefs.claude),
    codexOld: onlyOld(hookRefs.codex),
    text: `${[...old].map(([v, what]) => `${list(what)} still use ${v}`).join('; ')}. ${upgradeAdvice([...old.keys()])} to finish upgrading to ${VERSION}.`,
  };
}

// .memory/keys.env: which keys, mode 600, and whether the running tagger has the key it needs.
function keysLine(line, project, tagger) {
  const need = { openrouter: 'OPENROUTER_API_KEY', anthropic: 'ANTHROPIC_API_KEY' }[tagger?.via];
  const envPath = join(project, '.memory', 'keys.env');
  if (!existsSync(envPath)) return line('keys', need ? `no .memory/keys.env (the tagger needs ${need})` : 'no .memory/keys.env', !need);
  const names = [...readFileSync(envPath, 'utf8').matchAll(/^([A-Z_][A-Z0-9_]*)=./gm)].map((m) => m[1]);
  const mode = WIN ? null : statSync(envPath).mode & 0o777;
  line('keys', `${names.join(', ') || 'none'} in .memory/keys.env${mode && mode !== 0o600 ? ` (mode ${mode.toString(8)}, should be 600)` : ''}`,
    (!need || names.includes(need)) && (!mode || mode === 0o600));
}

// The model key is failing: the server latched a 401/403/402 and asks no more. Turns are still saved (and upload); only the
// memory extraction waits. Also a model that does not answer without a key error, while turns wait for it.
const KEY_STATE = { limit: 'over its limit', credit: 'out of credit', key: 'refused (invalid or disabled)' };
function modelLine(line, m) {
  const st = m?.stopped;
  if (st) {
    const who = { openrouter: 'OpenRouter', anthropic: 'Anthropic' }[st.provider] ?? st.provider;
    const since = String(st.since ?? '').slice(0, 16).replace('T', ' ');
    return line('model', `${who} key ${KEY_STATE[st.kind] ?? 'failing'}${since ? ` since ${since} UTC` : ''}: turns are still saved and upload; memory extraction is paused. Top up the key or change it in .memory/keys.env, then restart (spookling init --update).`, false);
  }
  if (m?.error && m.owed) line('model', `not answering (${String(m.error).slice(0, 120)}): ${m.owed} item${m.owed === 1 ? '' : 's'} waiting for memory extraction; turns are still saved and upload. It is tried again.`, false);
}

// Sessions the uploader gave up on, and an expired login.
function uploadLines(line, home) {
  const held = skippedSessionIds(home);
  if (held.length) line('upload', `${held.join(', ')} skipped after seq_conflict`, false);
  const problems = uploadProblems(home);
  for (const x of problems.skipped) line('upload', `${x.sid} skipped for good: ${skipText(x.reason)}`, false);
  if (problems.loginExpired && readCredentials({ home }).token) line('login', 'expired, run spookling login (the last upload was refused with 401)', false);
}

export async function status(project = process.cwd(), get = stats, home = homedir(), { update = {}, noUpdate = false } = {}) {
  const line = (label, text, good) => out(`   ${good ? paint(C.MINT, '✓') : paint(C.LILAC, '!')} ${label.padEnd(8)} ${text}\n`);
  const ctx = newCtx(project);
  out(`${paint(C.GHOST, 'Spookling Memory', true)}  ${paint(C.GREY, project)}\n`);
  const s = await get() || await get(3000), p = readPid(project); // one slow probe is not "down"
  line('server', s ? `up on 127.0.0.1:${PORT}${p?.alive ? `, pid ${p.pid}` : ''}`
    : `down${p && !p.alive ? ` (stale .memory/server.pid: pid ${p.pid} is not running)` : ''}`, !!s);
  const { refs, hookRefs, track } = refTracker();
  const { where, events } = scanClaude({ project, home, ctx, line, track });
  line('hooks', where.events.join('; ') || 'none in .claude/settings.json or ~/.claude/settings.json', events.length === Object.keys(HOOK_FILES).length);
  const ghostIn = ['project', 'user'].filter((sc) => { try { return isOurStatus(readJson(settingsPath(project, sc)).statusLine); } catch { return false; } });
  line('ghost', ghostIn.length ? `in the status line (${ghostIn.map((sc) => rel(ctx, settingsPath(project, sc))).join(', ')})`
    : 'not in the status line (init asks; --no-ghost skips it)', true);
  line('mcp', where.mcp.join('; ') || 'no entry in .mcp.json or ~/.claude.json', where.mcp.length > 0);
  const missing = [...new Set(Object.values(HOOK_FILES))].filter((f) => !existsSync(join(HOOKS_DIR, f)));
  const cx = scanCodex({ project, ctx, line, track });
  const { upgrade, claudeOld, codexOld, text } = upgradeState({ refs, hookRefs });
  if (upgrade) line('upgrade', text, false);
  if (events.length && missing.length && !claudeOld) line('scripts', `missing in ${HOOKS_DIR}: ${missing.join(', ')}`, false);
  const codex = CODEX_EVENTS.every((ev) => cx.got.has(ev));
  line('codex', cx.where.join('; ') || 'no Spookling hooks in project/user hooks.json', codex);
  if (cx.got.size || cx.mcpWhere.length) {
    line('codex-mcp', cx.mcpWhere.join('; ') || `no ${MCP_NAME} entry in .codex/config.toml or ~/.codex/config.toml: Codex has no team tools (init adds it)`, cx.mcpWhere.length > 0);
  }
  if (cx.got.size) line('trust', 'review /hooks in Codex; configured hooks are not proof of trust or execution', false);
  const codexScript = existsSync(join(HOOKS_DIR, 'spookling-codex.cjs'));
  if (cx.got.size && !codexScript && !codexOld) line('scripts', `missing ${join(HOOKS_DIR, 'spookling-codex.cjs')}`, false);
  const claude = events.length === Object.keys(HOOK_FILES).length && where.mcp.length > 0;
  line('harness', [claude && 'Claude Code', codex && 'Codex (configured; trust checked in /hooks)'].filter(Boolean).join(', ') || 'none wired', claude || codex);
  line('tagger', s?.tagger ? taggerText(s.tagger) : 'unknown (the server is down, or older than this wizard)', !!s?.tagger);
  keysLine(line, project, s?.tagger);
  modelLine(line, s?.model);
  cloudLine(line, home);
  if (!noUpdate) {
    const v = await updateAvailable({ home, current: VERSION, ...update }).catch(() => null);
    if (v) line('update', `${v} is available. Run spookling update.`, false);
  }
  uploadLines(line, home);
  return s && !upgrade && ((claude && !missing.length) || (codex && codexScript)) ? 0 : 1;
}

// the whole tree: started detached, its pid leads a process group; on Windows taskkill /T
function stopServer(pid) {
  if (WIN) return spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).status === 0;
  try { process.kill(-pid, 'SIGTERM'); return true; } catch { try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; } }
}

export async function uninstall(project = process.cwd(), { scope = 'project', harness = 'claude' } = {}) {
  const ctx = newCtx(project, scope);
  const sp = harness === 'codex' ? codexHooksPath(project, scope) : settingsPath(project, scope);
  out(`${paint(C.GHOST, 'Removing Spookling Memory wiring', true)}  ${paint(C.GREY, scope === 'user' ? `${project} (user scope)` : project)}\n`);
  await mergeFile(ctx, sp, harness === 'codex' ? removeHooks : (s) => removeStatusLine(removeHooks(s)), {
    what: 'removed the Spookling hooks',
    preview: `drop only the Spookling hooks${harness === 'codex' ? '' : ' and the ghost (your own status line comes back)'}; everything else stays`,
    same: `no Spookling hooks in ${rel(ctx, sp)}`,
  });
  if (harness === 'codex') {
    const cfg = codexConfigPath(project, scope), name = rel(ctx, cfg);
    const viaFile = () => mergeText(ctx, cfg, removeCodexMcp, {
      what: `removed MCP server ${MCP_NAME} from Codex`,
      preview: `drop only [mcp_servers.${MCP_NAME}] and its env table; everything else in the file stays`,
      same: `no ${MCP_NAME} entry in ${name}`,
    });
    if (scope === 'user' && !WIN && version('codex') && readText(cfg).includes(MCP_NAME)) {
      const r = await runCmd(ctx, 'codex', ['mcp', 'remove', MCP_NAME], { what: `removed MCP server ${MCP_NAME} from Codex`, show: `codex mcp remove ${MCP_NAME}` });
      if (r && r.status !== 0) ctx.problems.push(`run codex mcp remove ${MCP_NAME} yourself`);
    } else await viaFile();
    info('Codex hooks and MCP entry removed; memory and unrelated configuration stay.');
  } else if (scope === 'project') {
    await mergeFile(ctx, mcpPath(project), removeMcp, {
      what: `removed MCP server ${MCP_NAME}`,
      preview: `drop mcpServers.${MCP_NAME}; other servers stay`,
      same: `no ${MCP_NAME} entry in .mcp.json`,
    });
  } else if (userEntry(project)) {
    const r = await runCmd(ctx, 'claude', ['mcp', 'remove', MCP_NAME, '--scope', 'user'],
      { what: `removed MCP server ${MCP_NAME}, user scope`, show: `claude mcp remove ${MCP_NAME} --scope user` });
    if (r && r.status !== 0) ctx.problems.push(`run claude mcp remove ${MCP_NAME} --scope user yourself`);
  } else ok(`no ${MCP_NAME} entry in ${rel(ctx, mcpPath(project, 'user'))}`);
  if (harness !== 'codex') {
    const desktopPath = claudeDesktopConfigPath();
    await mergeFile(ctx, desktopPath, removeMcp, {
      what: `removed MCP server ${MCP_NAME} from the Claude desktop app`,
      preview: `drop mcpServers.${MCP_NAME}; other desktop settings stay`,
      same: `no ${MCP_NAME} entry in ${rel(ctx, desktopPath)}`,
    });
  }
  const p = readPid(project);
  if (p?.alive && (await confirm(`   Stop the memory server (pid ${p.pid})?`))) {
    if (stopServer(p.pid)) {
      // SIGTERM is graceful (uvicorn closes the store first): wait up to 10 s
      const gone = () => { try { process.kill(p.pid, 0); return false; } catch (e) { return e.code !== 'EPERM'; } };
      for (let i = 0; i < 50 && !gone(); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      rmSync(pidFile(project), { force: true });
      if (gone()) ok(`stopped pid ${p.pid}`); else warn(`pid ${p.pid} is still shutting down; check with: status`);
    }
    else warn(`could not stop pid ${p.pid}`);
  } else if (p && !p.alive) rmSync(pidFile(project), { force: true });
  for (const prob of ctx.problems) warn(prob);
  if (ctx.run?.label()) info(ctx.run.label());
  if (!SHARE && existsSync(INSTALL_DIR)) info(`The server and hooks stay in ${rel(ctx, INSTALL_DIR)}; delete that folder to remove them too.`);
  out(`\n   Your memory stays in .memory/. Run ${paint(C.GHOST, `npx spookling init${scope === 'user' ? ' --scope user' : ''}`)} to wire it back.\n`);
  return ctx.problems.length ? 1 : 0;
}
