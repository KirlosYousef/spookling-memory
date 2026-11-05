import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpHome } from './helpers.mjs';
import { addCodexMcp, codexConfigPath, codexEntry, codexMcpEntry, codexMcpToml, mcpEntry, removeCodexMcp } from '../src/hooks.js';

const URL_ = 'http://127.0.0.1:7447';
const entry = (v = '0.2.0', dir = `/home/me/.spookling-memory/${v}/server`) => mcpEntry(dir, URL_);
const USER = [
  '# my codex config', 'model = "gpt-5"', '', '[projects."/work/app"]', 'trust_level = "trusted"', '',
  '[mcp_servers.other]', 'command = "npx"', 'args = ["-y", "thing"]', '',
].join('\n');

test('the entry is Claude\'s command in Codex\'s shape: command, args, env, no type', () => {
  assert.equal(codexMcpToml(entry()), [
    '[mcp_servers.spookling-memory]', 'command = "uv"',
    'args = ["run", "--project", "/home/me/.spookling-memory/0.2.0/server", "spookling-memory", "mcp"]', '',
    '[mcp_servers.spookling-memory.env]', 'SPOOKLING_MEMORY_URL = "http://127.0.0.1:7447"', '',
  ].join('\n'));
  assert.deepEqual(codexEntry(entry()).env, { SPOOKLING_MEMORY_URL: URL_ });
  assert.equal(codexConfigPath('/p', 'project', {}), join('/p', '.codex', 'config.toml'));
  assert.equal(codexConfigPath('/p', 'user', { CODEX_HOME: '/h' }), join('/h', 'config.toml'));
});

test('adding keeps every other byte, and removing restores the file exactly', () => {
  const added = addCodexMcp(USER, entry());
  assert.ok(added.startsWith(USER));
  assert.deepEqual(codexMcpEntry(added), codexEntry(entry()));
  assert.equal(removeCodexMcp(added), USER);
  assert.equal(removeCodexMcp(USER), USER);
  assert.equal(addCodexMcp('', entry()), codexMcpToml(entry()));
  assert.equal(removeCodexMcp(addCodexMcp('', entry())), '');
  // no trailing newline, and CRLF files get CRLF
  assert.equal(removeCodexMcp(addCodexMcp('model = "x"', entry())).trimEnd(), 'model = "x"');
  const crlf = addCodexMcp('model = "x"\r\n', entry());
  assert.ok(crlf.includes('\r\n[mcp_servers.spookling-memory]\r\n') && !/[^\r]\n/.test(crlf.replace(/^/, '')), JSON.stringify(crlf));
});

test('adding twice changes nothing', () => {
  const once = addCodexMcp(USER, entry());
  assert.equal(addCodexMcp(once, entry()), once);
});

test('a stale entry (older version folder) is replaced in place; neighbours and our other sub-tables stay', () => {
  const old = [
    'a = 1', '', '[mcp_servers.spookling-memory]', 'command = "uv"',
    'args = ["run", "--project", "/home/me/.spookling-memory/0.1.3/server", "spookling-memory", "mcp"]',
    'startup_timeout_sec = 30', '', '[mcp_servers.spookling-memory.env]', 'SPOOKLING_MEMORY_URL = "http://127.0.0.1:7447"', '',
    '[mcp_servers.spookling-memory.tools.team_sessions]', 'approval_mode = "approve"', '', '[tui]', 'x = 1', '',
  ].join('\n');
  const next = addCodexMcp(old, entry());
  assert.deepEqual(codexMcpEntry(next).args[2], '/home/me/.spookling-memory/0.2.0/server');
  assert.ok(!next.includes('0.1.3') && !next.includes('startup_timeout_sec'));
  assert.equal(next.match(/\[mcp_servers\.spookling-memory\]/g).length, 1);
  assert.equal(next.match(/\.env\]/g).length, 1);
  for (const keep of ['a = 1', '[mcp_servers.spookling-memory.tools.team_sessions]', 'approval_mode = "approve"', '[tui]', 'x = 1']) assert.ok(next.includes(keep), keep);
  assert.ok(next.indexOf('a = 1') < next.indexOf('[mcp_servers.spookling-memory]') && next.indexOf('[mcp_servers.spookling-memory]') < next.indexOf('[tui]'));
  // remove takes the whole server: main, env and its sub-tables
  const gone = removeCodexMcp(old);
  assert.equal(gone, 'a = 1\n\n[tui]\nx = 1\n');
});

test('reads what `codex mcp add` writes', () => {
  const written = [
    '[mcp_servers.spookling-memory]', 'command = "uv"', 'args = ["run", "--project", "/tmp/a b/server", "spookling-memory", "mcp"]', '',
    '[mcp_servers.spookling-memory.env]', 'SPOOKLING_MEMORY_URL = "http://127.0.0.1:8765"', '',
  ].join('\n');
  assert.deepEqual(codexMcpEntry(written), { command: 'uv', args: ['run', '--project', '/tmp/a b/server', 'spookling-memory', 'mcp'], env: { SPOOKLING_MEMORY_URL: 'http://127.0.0.1:8765' } });
  const multi = '[mcp_servers.spookling-memory]\ncommand = \'uv\'\nargs = [\n  "run", # go\n  "mcp",\n]\n';
  assert.deepEqual(codexMcpEntry(multi), { command: 'uv', args: ['run', 'mcp'], env: {} });
  assert.equal(codexMcpEntry(USER), null);
});

test('table-looking lines inside strings or arrays are not tables; hand-written layouts we cannot edit are refused', () => {
  const tricky = 'note = """\n[mcp_servers.spookling-memory]\ncommand = "evil"\n"""\nlist = [\n  ["a"]\n]\n';
  assert.equal(codexMcpEntry(tricky), null);
  assert.equal(removeCodexMcp(tricky), tricky);
  assert.ok(addCodexMcp(tricky, entry()).startsWith(tricky));
  assert.throws(() => addCodexMcp('[mcp_servers]\nspookling-memory = { command = "uv" }\n', entry()), /by hand/);
  assert.throws(() => removeCodexMcp('mcp_servers.spookling-memory.command = "uv"\n'), /by hand/);
  assert.equal(addCodexMcp('x = "a # b"\n', entry()).startsWith('x = "a # b"\n'), true);
});

test('Windows paths and odd characters survive the round trip', () => {
  const e = { command: 'uv', args: ['run', '--project', 'C:\\Users\\a b\\"q"\\server'], env: { SPOOKLING_MEMORY_URL: URL_ } };
  assert.deepEqual(codexMcpEntry(addCodexMcp(USER, e)), codexEntry(e));
});

// ---- the wizard, in a throw-away HOME and CODEX_HOME; PATH has no codex unless the test says so ----
const WIZARD = new URL('../src/wizard.js', import.meta.url).href;
function inSandbox(body, { path = '/nonexistent', files = {}, project = 'proj' } = {}) {
  const home = tmpHome('spk-cxmcp-');
  const proj = join(home, project);
  mkdirSync(proj, { recursive: true });
  for (const [f, text] of Object.entries(files)) { const p = join(home, f); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
  const script = `
    import { status, uninstall, codexMcp } from ${JSON.stringify(WIZARD)};
    import { setFeed, press } from ${JSON.stringify(new URL('../src/term.js', import.meta.url).href)};
    import { mcpEntry } from ${JSON.stringify(new URL('../src/hooks.js', import.meta.url).href)};
    const project = ${JSON.stringify(proj)};
    const get = async () => ({ tagger: { model: 'stub', via: 'openrouter' } });
    const yes = () => setFeed(() => { press('y'); press('\\r'); });
    const ctx = (scope) => ({ project, scope, dry: false, written: [], skipped: [], problems: [], say: async () => {}, beat: async () => {} });
    ${body}
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 60000, cwd: proj,
    env: { ...process.env, PATH: path, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude'), NO_COLOR: '1' },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { out: r.stdout, home, proj };
}
const NODE_DIR = dirname(process.execPath);

test('init writes the MCP entry to the project .codex/config.toml, once, and keeps the rest', { skip: process.platform === 'win32' }, () => {
  const before = 'model = "x"\n';
  const { out, proj } = inSandbox(`
    yes();
    const e = mcpEntry('/h/.spookling-memory/0.2.0/server', 'http://127.0.0.1:7447');
    const c = ctx('project');
    await codexMcp(c, e);
    await codexMcp(c, e);
    setFeed(null);
    console.log('PROBLEMS', c.problems.length, 'WRITTEN', c.written.length);
  `, { path: NODE_DIR, files: { 'proj/.codex/config.toml': before } });
  const cfg = readFileSync(join(proj, '.codex', 'config.toml'), 'utf8');
  assert.ok(cfg.startsWith(before) && cfg.includes('[mcp_servers.spookling-memory]'));
  assert.match(out, /PROBLEMS 0 WRITTEN 1/);
  assert.match(out, /already has the MCP entry/);
  assert.match(out, /only for a trusted project/);
});

test('user scope without the codex CLI edits $CODEX_HOME/config.toml; a stale entry is replaced', { skip: process.platform === 'win32' }, () => {
  const stale = addCodexMcp(USER, entry('0.1.3'));
  const { home } = inSandbox(`
    yes();
    await codexMcp(ctx('user'), mcpEntry('/h/.spookling-memory/0.2.0/server', 'http://127.0.0.1:7447'));
    setFeed(null);
  `, { path: NODE_DIR, files: { 'codex/config.toml': stale } });
  const cfg = readFileSync(join(home, 'codex', 'config.toml'), 'utf8');
  assert.ok(cfg.includes('/h/.spookling-memory/0.2.0/server') && !cfg.includes('0.1.3'));
  assert.ok(cfg.includes('[mcp_servers.other]') && cfg.includes('trust_level = "trusted"'));
});

const hasCodex = spawnSync('codex', ['--version']).status === 0;
test('user scope with the codex CLI: codex mcp add, then remove and add for a stale entry', { skip: !hasCodex || process.platform === 'win32' }, () => {
  const path = process.env.PATH;
  const { home } = inSandbox(`
    yes();
    await codexMcp(ctx('user'), mcpEntry('/h/.spookling-memory/0.1.3/server', 'http://127.0.0.1:7447'));
    await codexMcp(ctx('user'), mcpEntry('/h/.spookling-memory/0.2.0/server', 'http://127.0.0.1:7447'));
    setFeed(null);
  `, { path, files: { 'codex/config.toml': USER } });
  const cfg = readFileSync(join(home, 'codex', 'config.toml'), 'utf8');
  assert.ok(cfg.includes('/h/.spookling-memory/0.2.0/server') && !cfg.includes('0.1.3'), cfg);
  assert.equal(cfg.match(/\[mcp_servers\.spookling-memory\]/g).length, 1);
  assert.ok(cfg.includes('[mcp_servers.other]') && cfg.includes('model = "gpt-5"'));
  assert.deepEqual(codexMcpEntry(cfg), codexEntry(entry('0.2.0', '/h/.spookling-memory/0.2.0/server')));
});

test('status reports the Codex MCP entry next to the hooks, and uninstall removes it', { skip: process.platform === 'win32' }, () => {
  const hooksJson = JSON.stringify({ hooks: {} });
  const { out, home } = inSandbox(`
    await status(project, get);
    yes();
    console.log('UNINSTALL', await uninstall(project, { harness: 'codex', scope: 'project' }));
    setFeed(null);
    await status(project, get);
  `, {
    path: NODE_DIR,
    files: {
      'proj/.codex/hooks.json': hooksJson,
      'proj/.codex/config.toml': addCodexMcp('model = "x"\n', entry()),
    },
  });
  const first = out.split('UNINSTALL')[0], last = out.split('UNINSTALL')[1];
  assert.match(first, /✓ codex-mcp spookling-memory in .*\.codex[\\/]config\.toml \(Codex loads it only for a trusted project\)/);
  assert.doesNotMatch(last, /codex-mcp/);
  assert.equal(readFileSync(join(home, 'proj', '.codex', 'config.toml'), 'utf8'), 'model = "x"\n');
});

test('status: hooks without the MCP entry is flagged; no Codex at all prints no codex-mcp line', { skip: process.platform === 'win32' }, () => {
  const none = inSandbox('await status(project, get);', { path: NODE_DIR });
  assert.doesNotMatch(none.out, /codex-mcp/);
  const hooksOnly = inSandbox('await status(project, get);', {
    path: NODE_DIR,
    files: { 'proj/.codex/hooks.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: "node '/h/spookling-memory/hooks/spookling-codex.cjs'" }] }] } }) },
  });
  assert.match(hooksOnly.out, /! codex-mcp no spookling-memory entry/);
});

test('uninstall --scope user without the codex CLI edits $CODEX_HOME/config.toml and leaves the rest', { skip: process.platform === 'win32' }, () => {
  const { home } = inSandbox(`
    yes();
    await uninstall(project, { harness: 'codex', scope: 'user' });
    setFeed(null);
  `, { path: NODE_DIR, files: { 'codex/config.toml': addCodexMcp(USER, entry()) } });
  assert.equal(readFileSync(join(home, 'codex', 'config.toml'), 'utf8'), USER);
  assert.ok(existsSync(join(home, 'codex', 'config.toml')));
});
