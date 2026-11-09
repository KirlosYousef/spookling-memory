import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpHome } from './helpers.mjs';
import { FRAMES, PALETTE, SMALL } from '../src/ghost-sprite.js';
import { TAGLINE } from '../src/cutscene.js';
import { LITTLE, wrap } from '../src/ghost.js';
import {
  CLAUDE_INSTALL, DEMO_LABEL, HOOKS_DIR, INSTALL_DIR, SAY, SERVER_DIR, TAGGERS, VERSION, codexLogin, hooksJson, install, mcpJson, status, taggerText,
} from '../src/wizard.js';
import { hookHandlers, mcpEntry, MCP_NAME } from '../src/hooks.js';

const BIN = fileURLToPath(new URL('../../bin/spookling-memory.js', import.meta.url));
const HYPE = /\b(seamless(ly)?|robust|leverag\w*|supercharg\w*|unlock\w*|empower\w*|revolutionary|effortless(ly)?|game.?chang\w*|magic(al)?)\b/i;

test('the ghost says one plain line per step, and one for trouble', () => {
  for (const k of [1, 2, 3, 4, 5, 6, 7, 'codex', 'fail']) assert.ok(SAY[k], `no line for ${k}`);
  for (const [k, line] of Object.entries(SAY)) {
    assert.ok(line.length <= 52, `${k}: ${line.length} chars, the bubble fits 52 at 80 columns`);
    assert.doesNotMatch(line, /[\u2014\u2013]/, `${k}: dash`);
    assert.doesNotMatch(line, /!!|!\s*$/, `${k}: exclamation`);
    assert.doesNotMatch(line, HYPE, `${k}: hype word`);
    // beside the little ghost at 80 columns: at most two rows, none too wide, every word kept
    const rows = wrap(line, 80 - LITTLE.w - 9);
    assert.ok(rows.length <= 2 && rows.every((r) => r.length <= 80 - LITTLE.w - 9), `${k}: ${JSON.stringify(rows)}`);
    assert.equal(rows.join(' '), line);
  }
});

test('sprite: every frame keeps the hat, eyes and smile; only the tail streaks move', () => {
  for (const frames of [FRAMES, SMALL]) {
    assert.ok(frames.length >= 3);
    const [rest] = frames;
    for (const f of frames) {
      assert.equal(f.length, rest.length);
      f.forEach((row, y) => {
        assert.equal(row.length, rest[y].length);
        [...row].forEach((p) => assert.ok(PALETTE[p] !== undefined, `colour ${p} is not in PALETTE`));
        // only 3 and 4 swap, where the streaks move; every other colour stays put
        [...row].forEach((p, x) => { if (!'34'.includes(rest[y][x]) || !'34'.includes(p)) assert.equal(p, rest[y][x], `(${x}, ${y})`); });
      });
    }
    assert.ok(frames.some((f) => f.join() !== rest.join()), 'the tail never moves');
  }
});

test('the JSON shown before a merge parses to exactly what is merged', () => {
  const hs = hookHandlers('/opt/my spookling/hooks');
  assert.deepEqual(JSON.parse(hooksJson(hs)), { hooks: Object.fromEntries(Object.entries(hs).map(([ev, h]) => [ev, [{ hooks: [h] }]])) });
  const e = mcpEntry('/opt/my spookling/server', 'http://127.0.0.1:7447');
  assert.deepEqual(JSON.parse(mcpJson(e)), { mcpServers: { [MCP_NAME]: e } });
});

test('demo walks every step, writes nothing, and shows the tagline once', () => {
  const dir = tmpHome('spk-demo-');
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: join(dir, 'cfg'), NO_COLOR: '1' };
  delete env.ANTHROPIC_API_KEY;
  const r = spawnSync(process.execPath, [BIN, 'demo', '--fast', '--no-anim'], { cwd: dir, env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(dir), [], 'demo wrote into the folder');
  const o = r.stdout;
  for (let n = 1; n <= 7; n++) assert.match(o, new RegExp(`step ${n} of 7`));
  for (const k of [1, 2, 3, 4, 5, 6, 7]) assert.ok(o.includes(`spookling: ${SAY[k]}`), `line ${k}`);
  assert.equal(o.split(TAGLINE).length - 1, 1, 'the tagline once');
  assert.equal(o.match(/demo: not written/g)?.length, 7); // keys.env, .gitignore, settings.json, .mcp.json, desktop config, share permissions, /spookling-share
  assert.match(o, /Let Claude share sessions to your team when you ask\? Spookling still asks you to confirm each share\./);
  for (const [i, t] of TAGGERS.entries()) assert.ok(o.includes(`${i + 1}  ${t.label}`), t.label);
  assert.match(o, /How should the tagger run\? \[1\]/);
  assert.match(o, /OpenRouter API key for Jev: •+/);
  assert.doesNotMatch(o, /Anthropic API key:/);
  assert.match(o, /OPENROUTER_API_KEY=\*{8}/);
  // a \\wsl.localhost clone runs its server in WSL: nothing to install
  if (/so the server runs there/.test(o)) assert.doesNotMatch(o, /uv sync in/);
  else { assert.match(o, /copy server\/ and hooks\/ to .*spookling-memory/); assert.match(o, /demo: not copied/); assert.match(o, /uv sync in .*\n.*demo: skipped/); assert.match(o, /demo: not started/); }
  assert.match(o, /"hooks": \{/);
  assert.match(o, /Show the ghost in your status line\? \[Y\/n\] y/);
  assert.match(o, /"statusLine": \{\n.*"type": "command",\n.*"command": "node (?:'|\\").*status-line\.js(?:'|\\")",\n.*"refreshInterval": 5/);
  assert.match(o, /"mcpServers": \{/);
  assert.match(o, /demo: a sample reply/);
  assert.ok(o.includes(DEMO_LABEL));
  assert.match(o, /Spookling Memory is in\./);
});

test('init wires a folder per version, and copies the package into it without a clone\'s .venv or caches', () => {
  assert.equal(INSTALL_DIR, process.platform === 'win32' ? join(process.env.LOCALAPPDATA, 'spookling-memory', VERSION)
    : join(homedir(), '.spookling-memory', VERSION));
  assert.deepEqual([SERVER_DIR, HOOKS_DIR], [join(INSTALL_DIR, 'server'), join(INSTALL_DIR, 'hooks')]);
  const from = tmpHome('spk-pkg-'), to = join(tmpHome('spk-home-'), VERSION);
  const files = ['server/pyproject.toml', 'server/spookling_memory/core/classes.json', 'hooks/stop.js',
    'server/.venv/bin/python', 'server/spookling_memory/__pycache__/x.pyc', 'server/.pytest_cache/x', 'server/.memory/log.jsonl'];
  for (const f of files) { mkdirSync(join(from, f, '..'), { recursive: true }); writeFileSync(join(from, f), f); }
  mkdirSync(join(to, 'server', '.venv'), { recursive: true });
  writeFileSync(join(to, 'server', '.venv', 'made-by-uv-sync'), '');
  install(from, to);
  assert.deepEqual(files.map((f) => existsSync(join(to, f))), [true, true, true, false, false, false, false]);
  assert.ok(existsSync(join(to, 'server', '.venv', 'made-by-uv-sync')), 'an earlier uv sync is kept');
});

test('the tagger menu: Jev, Haiku or Codex, each started with its --model and asking only its own key', () => {
  assert.deepEqual(TAGGERS.map((t) => [t.model, t.key]), [
    ['typesafe/jev-router', 'OPENROUTER_API_KEY'], ['anthropic/claude-haiku-4.5', 'ANTHROPIC_API_KEY'], ['codex', null]]);
  assert.match(TAGGERS[0].label, /\$0\.002 a chat/);
  for (const t of TAGGERS) assert.ok(`   › ${t.label}`.length <= 80, `${t.label}: wraps at 80 columns`);
});

test('codex login status: its line when logged in, a failure when not, or when codex is missing', { skip: process.platform === 'win32' && 'a POSIX fake codex' }, () => {
  const bin = tmpHome('spk-codex-');
  const fake = (body) => { writeFileSync(join(bin, 'codex'), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, 'codex'), 0o755); };
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
  fake('[ "$1 $2" = "login status" ] && echo "Logged in using ChatGPT" && exit 0; exit 9');
  assert.deepEqual(codexLogin(env), { ok: true, line: 'Logged in using ChatGPT' });
  fake('echo "Logged in using an API key - \u0073k-proj-abc123XYZ"');
  assert.deepEqual(codexLogin(env), { ok: true, line: 'Logged in using an API key - sk-…' });
  fake('echo "Not logged in" >&2; exit 1');
  assert.deepEqual(codexLogin(env), { ok: false, line: 'Not logged in' });
  const none = codexLogin({ ...process.env, PATH: tmpHome('spk-empty-') });
  assert.equal(none.ok, false);
  assert.match(none.line, /not found/);
});

test('status names the wired tagger, and the key it needs', async () => {
  const dir = tmpHome('spk-status-');
  const said = [], write = process.stdout.write, cfg = process.env.CLAUDE_CONFIG_DIR;
  const run = async (tagger) => {
    said.length = 0;
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'cfg');
    process.stdout.write = (s) => { said.push(String(s)); return true; };
    try { await status(dir, async () => (tagger ? { n_events: 0, tagger } : null)); } finally {
      process.stdout.write = write;
      if (cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = cfg;
    }
    const text = said.join('').replace(/\x1b\[[0-9;]*m/g, '');
    return (label) => text.split('\n').find((l) => l.includes(` ${label.padEnd(8)} `))?.trim();
  };
  let line = await run({ model: 'codex', via: 'codex' });
  assert.equal(line('tagger'), '✓ tagger   your Codex subscription (codex exec)');
  assert.equal(line('keys'), '✓ keys     no .memory/keys.env');
  line = await run({ model: 'typesafe/jev-router', via: 'openrouter' });
  assert.equal(line('tagger'), '✓ tagger   typesafe/jev-router through OpenRouter');
  assert.equal(line('keys'), '! keys     no .memory/keys.env (the tagger needs OPENROUTER_API_KEY)');
  mkdirSync(join(dir, '.memory'));
  writeFileSync(join(dir, '.memory', 'keys.env'), 'OPENROUTER_API_KEY=sk-or-v1-x\n', { mode: 0o600 });
  assert.equal((await run({ model: 'typesafe/jev-router', via: 'openrouter' }))('keys'), '✓ keys     OPENROUTER_API_KEY in .memory/keys.env');
  assert.match((await run({ model: 'anthropic/claude-haiku-4.5', via: 'anthropic' }))('keys'), /^! keys/);
  assert.equal(taggerText({ model: 'anthropic/claude-haiku-4.5', via: 'anthropic' }), 'anthropic/claude-haiku-4.5 through the Anthropic API');
  assert.equal((await run(null))('tagger'), '! tagger   unknown (the server is down, or older than this wizard)');
});

test('status shows a failing model key, and says the turns are still saved', async () => {
  const dir = tmpHome('spk-status-');
  const said = [], write = process.stdout.write, cfg = process.env.CLAUDE_CONFIG_DIR;
  const run = async (model) => {
    said.length = 0;
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'cfg');
    process.stdout.write = (s) => { said.push(String(s)); return true; };
    try { await status(dir, async () => ({ n_events: 0, tagger: { model: 'typesafe/jev-router', via: 'openrouter' }, model })); } finally {
      process.stdout.write = write;
      if (cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = cfg;
    }
    const text = said.join('').replace(/\x1b\[[0-9;]*m/g, '');
    return text.split('\n').find((l) => l.includes(` ${'model'.padEnd(8)} `))?.trim();
  };
  assert.equal(await run({ stopped: null, error: null, untagged: 0, owed: 0 }), undefined);
  assert.equal(await run(undefined), undefined); // a server older than this wizard
  assert.equal(await run({ stopped: { kind: 'limit', provider: 'openrouter', since: '2026-11-09T14:03:21Z', reason: 'x' }, owed: 4 }),
    '! model    OpenRouter key over its limit since 2026-11-09 14:03 UTC: turns are still saved and upload; memory extraction is paused. '
    + 'Top up the key or change it in .memory/keys.env, then restart (spookling init --update).');
  assert.match(await run({ stopped: { kind: 'key', provider: 'anthropic', since: '2026-11-09T14:03:21Z' } }), /^! model\s+Anthropic key refused \(invalid or disabled\) since/);
  assert.match(await run({ stopped: null, error: 'ConnectionError: down', owed: 1 }), /^! model\s+not answering \(ConnectionError: down\): 1 item waiting/);
});

test('init offers to install claude when it is not on the PATH, and says so when it stays missing', () => {
  const src = fileURLToPath(new URL('../src/wizard.js', import.meta.url));
  const code = `const { claudeCli } = await import(${JSON.stringify(new URL(`file://${src}`).href)});
    const v = await claudeCli({ scope: 'user', dry: false, problems: [] }, () => null);
    process.stdout.write('\\nresult=' + v);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code],
    { input: 'n\n', env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8', timeout: 15_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /claude is not on your PATH\. Step 5 runs it to add the MCP entry\./);
  assert.ok(r.stdout.includes(`install it with: ${CLAUDE_INSTALL}`));
  assert.match(r.stdout, /Run that now\? \[y\/N\] n/);
  assert.match(r.stdout, /result=null/);
});
