import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpHome } from './helpers.mjs';
import {
  addHooks, removeHooks, addMcp, removeMcp, claudeDesktopConfigPath, hookHandlers, mcpEntry, mcpPath, settingsPath, wiring, readJson,
  isOurs, wslShare, HOOK_FILES, MCP_NAME,
} from '../src/hooks.js';

const URL = 'http://127.0.0.1:7447';
const cmds = hookHandlers('/opt/spookling-memory/hooks', path.posix);
const theirs = { type: 'command', command: 'npm run lint' };
const user = {
  model: 'opus',
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: {
    Stop: [{ hooks: [theirs] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
  },
};

test('hooks run in exec form: node, then the script path as one argument; the ghost names the spinner', () => {
  const h = (f, statusMessage) => ({ type: 'command', command: 'node', args: [`/opt/spookling-memory/hooks/${f}`], ...(statusMessage && { statusMessage }) });
  assert.deepEqual(cmds, {
    PreCompact: h('pre-compact.js', '👻 keeping your rules'), UserPromptSubmit: h('user-prompt-submit.js', '👻 remembering'), Stop: h('stop.js'),
  });
  assert.deepEqual(hookHandlers("/my spookling's $dir/hooks", path.posix).Stop.args, ["/my spookling's $dir/hooks/stop.js"]);
});

test('win32: a path with spaces, quotes, $ or a WSL share goes into args verbatim, no quoting', () => {
  for (const dir of ['C:\\Users\\Jane O\'Neil\\My $pace\\spookling-memory\\hooks',
    '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jane\\spookling-memory\\hooks']) {
    const hs = hookHandlers(dir, path.win32);
    for (const [ev, f] of Object.entries(HOOK_FILES)) {
      assert.deepEqual(hs[ev].args, [`${dir}\\${f}`]);
      assert.equal(hs[ev].command, 'node');
      assert.ok(isOurs(hs[ev]));
    }
    const settings = JSON.parse(JSON.stringify(addHooks({}, hs))); // as settings.json holds it
    assert.deepEqual(settings.hooks.Stop[0].hooks[0].args, [`${dir}\\stop.js`]);
    assert.deepEqual(removeHooks(settings), {});
  }
});

test('addHooks swaps an older shell-form .sh install for the exec form', () => {
  const old = { hooks: { Stop: [{ hooks: [theirs, { type: 'command', command: `SPOOKLING_MEMORY_URL=${URL} /old/spookling-memory/hooks/stop.sh` }] }] } };
  const out = addHooks(old, cmds);
  assert.deepEqual(out.hooks.Stop, [{ hooks: [theirs] }, { hooks: [cmds.Stop] }]);
});

test('scope: project files, or the user files (CLAUDE_CONFIG_DIR moves them)', () => {
  const p = join('/work', 'app');
  assert.equal(settingsPath(p), join(p, '.claude', 'settings.json'));
  assert.equal(mcpPath(p), join(p, '.mcp.json'));
  assert.equal(settingsPath(p, 'user', {}), join(homedir(), '.claude', 'settings.json'));
  assert.equal(mcpPath(p, 'user', {}), join(homedir(), '.claude.json'));
  assert.equal(settingsPath(p, 'user', { CLAUDE_CONFIG_DIR: '/cfg' }), join('/cfg', 'settings.json'));
  assert.equal(mcpPath(p, 'user', { CLAUDE_CONFIG_DIR: '/cfg' }), join('/cfg', '.claude.json'));
  assert.equal(claudeDesktopConfigPath('/Users/alex', 'darwin'),
    join('/Users/alex', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  assert.equal(claudeDesktopConfigPath('/Users/alex', 'win32', { APPDATA: 'C:\\Users\\alex\\AppData\\Roaming' }),
    join('C:\\Users\\alex\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));
});

// the real hook scripts as exec form runs them: node and the path as one argument, no shell
const HOOKS = fileURLToPath(new globalThis.URL('../../hooks/', import.meta.url)); // URL is shadowed above
const spaced = () => {
  const d = join(tmpHome('spk-'), "Jane O'Neil $pace", 'spookling-memory', 'hooks');
  mkdirSync(d, { recursive: true });
  for (const f of [...new Set(Object.values(HOOK_FILES)), 'pulse.js']) copyFileSync(join(HOOKS, f), join(d, f));
  return hookHandlers(d);
};
// a home and project of their own: a hook writes .memory/pulse.json, never into the real ~/.memory
const sandbox = () => { const d = tmpHome('spk-home-'); return { HOME: d, USERPROFILE: d, CLAUDE_PROJECT_DIR: d }; };
const run = (h, url, input, env = sandbox()) => new Promise((res) => {
  const c = spawn(h.command, h.args, { env: { ...process.env, SPOOKLING_MEMORY_URL: url, ...env } });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.on('close', (code) => res({ code, out }));
  c.stdin.end(input);
});

test('exec form: with no server the hooks print nothing and exit 0, within seconds even if the connect hangs', async () => {
  const hs = spaced(), t = Date.now();
  // 10.255.255.1 is not routed: the connect hangs, as a dead port on WSL's mirrored network does
  for (const h of Object.values(hs)) assert.deepEqual(await run(h, 'http://10.255.255.1:7447', '{"prompt":"hi"}'), { code: 0, out: '' });
  assert.ok(Date.now() - t < 10000);
  const env = { ...process.env, ...sandbox(), SPOOKLING_MEMORY_URL: 'http://127.0.0.1:9' };
  assert.equal(spawnSync(hs.Stop.command, hs.Stop.args, { input: 'not json', timeout: 20000, env }).status, 0);
});

test('in place, under the package\'s ESM package.json, the hooks still run as CommonJS (hooks/package.json)', async () => {
  for (const h of Object.values(hookHandlers(HOOKS))) assert.deepEqual(await run(h, 'http://127.0.0.1:9', '{}'), { code: 0, out: '' });
});

test('exec form: UserPromptSubmit prints the server reply whole; Stop and PreCompact print nothing', async () => {
  const reply = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'x'.repeat(9990) } });
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push([req.url, req.headers['content-type'], body]);
      res.setHeader('content-type', 'application/json');
      res.end(req.url.endsWith('user-prompt-submit') ? reply : '{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`, hs = spaced(), input = '{"session_id":"s","prompt":"caf\u00e9"}';
  try {
    assert.deepEqual(await run(hs.UserPromptSubmit, url, input), { code: 0, out: reply });
    assert.deepEqual(await run(hs.Stop, url, input), { code: 0, out: '' });
    assert.deepEqual(await run(hs.PreCompact, url, input), { code: 0, out: '' });
  } finally { srv.close(); }
  assert.deepEqual(seen.map((s) => s[0]), ['/v1/hook/user-prompt-submit', '/v1/hook/stop', '/v1/hook/pre-compact']);
  assert.ok(seen.every((s) => s[1] === 'application/json' && s[2] === input));
});

test('addHooks on an empty file adds the three events', () => {
  const out = addHooks({}, cmds);
  assert.deepEqual(Object.keys(out.hooks), ['PreCompact', 'UserPromptSubmit', 'Stop']);
  assert.deepEqual(out.hooks.Stop, [{ hooks: [cmds.Stop] }]);
});

test('addHooks keeps every existing key and hook', () => {
  const out = addHooks(user, cmds);
  assert.equal(out.model, 'opus');
  assert.deepEqual(out.permissions, user.permissions);
  assert.deepEqual(out.hooks.PreToolUse, user.hooks.PreToolUse);
  assert.deepEqual(out.hooks.Stop[0], { hooks: [theirs] });
  assert.equal(out.hooks.Stop.length, 2);
  assert.equal(user.hooks.Stop.length, 1, 'input not mutated');
});

test('addHooks twice is a no-op', () => {
  const once = addHooks(user, cmds);
  assert.deepEqual(addHooks(once, cmds), once);
});

test('addHooks replaces a Spookling hook from an older install path', () => {
  const old = addHooks(user, hookHandlers('/old/npx/spookling/hooks', path.posix));
  const out = addHooks(old, cmds);
  const all = Object.values(out.hooks).flat().flatMap((g) => g.hooks);
  assert.ok(!all.some((h) => JSON.stringify(h).includes('/old/')));
  assert.ok(all.some((h) => JSON.stringify(h) === JSON.stringify(cmds.Stop)) && all.some((h) => h.command === 'npm run lint'));
});

test('removeHooks restores the original settings exactly', () => {
  assert.deepEqual(removeHooks(addHooks(user, cmds)), user);
  assert.deepEqual(removeHooks(addHooks({}, cmds)), {});
});

test('removeHooks keeps a foreign hook that shares a group with ours', () => {
  const s = { hooks: { Stop: [{ hooks: [theirs, cmds.Stop] }] } };
  assert.deepEqual(removeHooks(s), { hooks: { Stop: [{ hooks: [theirs] }] } });
});

test('malformed settings throw instead of being overwritten', () => {
  assert.throws(() => addHooks([], cmds));
  assert.throws(() => addHooks({ hooks: [] }, cmds));
  assert.throws(() => addHooks({ hooks: { Stop: {} } }, cmds));
  assert.throws(() => removeHooks({ hooks: { Stop: 'x' } }));
});

test('isOurs only matches our scripts under a spookling path', () => {
  assert.ok(isOurs(cmds.Stop));
  assert.ok(isOurs('C:\\Users\\a\\spookling-memory\\hooks\\stop.sh')); // an older shell-form install
  assert.ok(!isOurs({ type: 'command', command: 'node', args: ['/home/a/other/hooks/stop.js'] }));
  assert.ok(!isOurs('/home/a/other/hooks/stop.sh'));
  assert.ok(!isOurs('npm run lint'));
  assert.ok(!isOurs(undefined));
});

test('MCP entry is added, kept beside others, and removed cleanly', () => {
  const cfg = { mcpServers: { github: { command: 'gh-mcp' } } };
  const entry = mcpEntry('/opt/spookling-memory/server', URL);
  const out = addMcp(cfg, entry);
  assert.deepEqual(out.mcpServers.github, cfg.mcpServers.github);
  assert.deepEqual(out.mcpServers[MCP_NAME], {
    type: 'stdio', command: 'uv',
    args: ['run', '--project', '/opt/spookling-memory/server', 'spookling-memory', 'mcp'],
    env: { SPOOKLING_MEMORY_URL: URL },
  });
  assert.deepEqual(removeMcp(out), cfg);
  const desktop = { preferences: { sidebarMode: 'chat' }, coworkUserFilesPath: '/Users/alex/Claude' };
  const absolute = mcpEntry('/opt/spookling-memory/0.1.3/server', URL, '/opt/homebrew/bin/uv');
  const merged = addMcp(desktop, absolute);
  assert.equal(merged.preferences.sidebarMode, 'chat');
  assert.equal(merged.coworkUserFilesPath, desktop.coworkUserFilesPath);
  assert.equal(merged.mcpServers[MCP_NAME].command, '/opt/homebrew/bin/uv');
  assert.equal(merged.mcpServers[MCP_NAME].args[2], '/opt/spookling-memory/0.1.3/server');
  assert.deepEqual(removeMcp(merged).preferences, desktop.preferences);
  assert.deepEqual(addMcp({}, entry), { mcpServers: { [MCP_NAME]: entry } });
  assert.throws(() => addMcp({ mcpServers: [] }, entry));
  assert.deepEqual(removeMcp({}), {});
});

test('wiring reports what is in place', () => {
  assert.deepEqual(wiring({}, {}), { events: [], mcp: false });
  const s = addHooks(user, cmds), m = addMcp({}, mcpEntry('/x', URL));
  const w = wiring(s, m);
  assert.deepEqual([w.events.sort(), w.mcp], [['PreCompact', 'Stop', 'UserPromptSubmit'], true]);
});

test('readJson: missing or empty is {}, broken JSON throws', () => {
  const d = tmpHome('spk-');
  assert.deepEqual(readJson(join(d, 'nope.json')), {});
  writeFileSync(join(d, 'empty.json'), '\n');
  assert.deepEqual(readJson(join(d, 'empty.json')), {});
  writeFileSync(join(d, 'bad.json'), '{ "a": ');
  assert.throws(() => readJson(join(d, 'bad.json')), /left it untouched/);
});

test('a server folder inside WSL, seen from Windows, runs through wsl.exe, never a Windows uv', () => {
  const dir = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\jane o'neil\\spookling-memory\\server";
  assert.deepEqual(wslShare(dir), { distro: 'Ubuntu-24.04', path: "/home/jane o'neil/spookling-memory/server" });
  assert.deepEqual(wslShare('\\\\wsl$\\Debian\\srv\\'), { distro: 'Debian', path: '/srv' });
  assert.equal(wslShare('C:\\src\\server'), null);
  assert.equal(wslShare('/home/jane/server'), null);
  assert.deepEqual(mcpEntry(dir, URL), {
    type: 'stdio', command: 'wsl.exe',
    args: ['-d', 'Ubuntu-24.04', '--', 'bash', '-lc', "exec uv run --project '/home/jane o'\\''neil/spookling-memory/server' spookling-memory mcp"],
    env: { SPOOKLING_MEMORY_URL: URL, WSLENV: 'SPOOKLING_MEMORY_URL' },
  });
  // the quoted path survives bash
  const r = spawnSync('bash', ['-c', mcpEntry(dir, URL).args[5].replace('exec uv run --project', 'printf %s')], { encoding: 'utf8' });
  if (!r.error) assert.equal(r.stdout, "/home/jane o'neil/spookling-memory/serverspookling-memorymcp");
});
