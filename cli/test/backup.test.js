import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpHome } from './helpers.mjs';
import { MIN_RUNS, KEEP_RUNS, createRun, encodeName, listRuns, pruneBackups, readManifest } from '../src/backup.js';
import { checkToml } from '../src/toml-check.js';
import { TAGGERS } from '../src/wizard.js';

const BIN = fileURLToPath(new URL('../../bin/spookling-memory.js', import.meta.url));
const tmp = (p = 'spk-bk-') => tmpHome(p);
const posix = { skip: process.platform === 'win32' && 'POSIX modes and fake binaries' };

test('a backup run copies each file once, mode 0600 in a 0700 folder, with a manifest', posix, () => {
  const home = tmp(), a = join(home, 'a', 'settings.json'), b = join(home, 'b.json');
  mkdirSync(dirname(a), { recursive: true });
  writeFileSync(a, '{"theme":"dark"}', { mode: 0o644 });
  writeFileSync(b, '{}');
  const run = createRun(home, () => new Date(Date.UTC(2026, 10, 4, 18, 30, 5)));
  assert.equal(run.label(), null, 'nothing backed up, nothing created');
  assert.equal(existsSync(join(home, '.spookling', 'backups')), false);
  assert.equal(run.add(a), true);
  assert.equal(run.add(a), false, 'once per run');
  assert.equal(run.add(join(home, 'missing.json')), false, 'a file that is not there needs no copy');
  assert.equal(run.add(b), true);
  assert.equal(run.stamp, '20261104-183005');
  assert.equal(run.label().replace(home, '~'), 'Backups of the files I changed: ~/.spookling/backups/20261104-183005/');
  const dir = join(home, '.spookling', 'backups', run.stamp);
  assert.equal(readFileSync(join(dir, encodeName(a)), 'utf8'), '{"theme":"dark"}');
  assert.equal(statSync(join(dir, encodeName(a))).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, '.spookling', 'backups')).mode & 0o777, 0o700);
  assert.deepEqual(readManifest(home, run.stamp).map((f) => [f.path, f.mode]), [[a, 0o644], [b, statSync(b).mode & 0o777]]);
  assert.deepEqual(listRuns(home), ['20261104-183005']);
  const again = createRun(home, () => new Date(Date.UTC(2026, 10, 4, 18, 30, 5)));
  again.add(b);
  assert.equal(again.stamp, '20261104-183005-2', 'two runs in one second do not collide');
});

test('backups: the newest 20 stay, older ones go only after 7 days, never fewer than 5', () => {
  const home = tmp();
  const root = join(home, '.spookling', 'backups');
  const stamp = (day, i) => `202610${String(day).padStart(2, '0')}-0000${String(i).padStart(2, '0')}`;
  const NOW = Date.UTC(2026, 9, 31, 12);
  // 25 runs on 1 Oct: all older than 7 days at NOW
  for (let i = 0; i < 25; i++) mkdirSync(join(root, stamp(1, i)), { recursive: true });
  pruneBackups(home, NOW);
  assert.equal(listRuns(home).length, KEEP_RUNS);
  assert.equal(listRuns(home)[0], stamp(1, 24), 'the newest are kept');
  // 25 runs but the oldest five are young (within 7 days of "now"): nothing is removed
  const home2 = tmp();
  for (let i = 0; i < 25; i++) mkdirSync(join(home2, '.spookling', 'backups', stamp(30, i)), { recursive: true });
  pruneBackups(home2, NOW);
  assert.equal(listRuns(home2).length, 25, 'younger than 7 days: kept even beyond 20');
  // fewer than the minimum: untouched
  const home3 = tmp();
  for (let i = 0; i < 3; i++) mkdirSync(join(home3, '.spookling', 'backups', stamp(1, i)), { recursive: true });
  pruneBackups(home3, NOW);
  assert.equal(listRuns(home3).length, 3);
  assert.ok(MIN_RUNS <= KEEP_RUNS);
  void utimesSync;
});

test('toml check: accepts well-formed files, refuses broken ones', () => {
  const good = `# c
model = "gpt-5"
[projects."/work/app"]
trust_level = "trusted"
[mcp_servers.spookling-memory]
command = "uv"
args = [
  "run", "--project",  # note
  "/x",
]
env = { A = "1", B = '2' }
note = """
multi [ line
"""
[[tools]]
name = 'x'
`;
  assert.equal(checkToml(good), null);
  assert.equal(checkToml(''), null);
  assert.match(checkToml('model = "x\n'), /line 1: unterminated string/);
  assert.match(checkToml('this is not toml\n'), /line 1: not a table header or key = value/);
  assert.match(checkToml('a = [1, 2\n'), /never closed/);
  assert.match(checkToml('a = 1]\n'), /unbalanced/);
  assert.match(checkToml('a = """x\n'), /never closed/);
  assert.match(checkToml('[ok]\nkey =\n'), /line 2/);
});

// ---- init, update and uninstall in a sandbox: backups made, unrelated keys kept, unparsable files refused

const fakeBin = (dir) => {
  mkdirSync(dir, { recursive: true });
  const script = (name, body) => { const p = join(dir, name); writeFileSync(p, `#!${process.execPath}\n${body}\n`); chmodSync(p, 0o755); };
  script('uv', 'process.exit(process.argv[2] === "--version" ? (console.log("uv 0.9.0"), 0) : 0);');
  script('claude', `
const fs = require('fs'), path = require('path'), a = process.argv.slice(2);
if (a[0] === '--version') { console.log('2.1.200 (Claude Code)'); process.exit(0); }
const f = path.join(process.env.HOME, '.claude.json');
const j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
if (a[0] === 'mcp' && a[1] === 'add-json') { j.mcpServers = { ...(j.mcpServers || {}), [a[2]]: JSON.parse(a[3]) }; fs.writeFileSync(f, JSON.stringify(j)); }
if (a[0] === 'mcp' && a[1] === 'remove') { delete (j.mcpServers || {})[a[2]]; fs.writeFileSync(f, JSON.stringify(j)); }
`);
};

async function sandbox(args, { home = tmp('spk-sb-'), project = tmp('spk-sbp-'), files = {}, input = '' } = {}) {
  fakeBin(join(home, 'bin'));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(home, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ n_events: 0, tagger: { model: TAGGERS[0].model, via: 'openrouter' } })); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, ...args], {
        cwd: project,
        env: { PATH: `${join(home, 'bin')}:${process.env.PATH}`, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), NO_COLOR: '1',
          SPOOKLING_INIT_PORT: String(server.address().port), OPENROUTER_API_KEY: 'sk-or-test', SPOOKLING_NO_UPDATE_CHECK: '1' },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => resolve({ status, stdout, stderr, home, project }));
      child.stdin.end(input);
    });
  } finally { server.close(); }
}

const THEIRS = {
  enabledPlugins: { 'a@market': true, 'b@market': false },
  extraKnownMarketplaces: { market: { source: { source: 'github', repo: 'o/r' } } },
  theme: 'dark',
  model: 'opus',
  permissions: { allow: ['Bash(git status)'], deny: ['Read(./.env)'], defaultMode: 'acceptEdits' },
};
const theirs = (o) => Object.fromEntries(Object.keys(THEIRS).map((k) => [k, o[k]]));
const claudeSettings = (home) => join(home, '.claude', 'settings.json');
const backups = (home) => listRuns(home);

test('init, init --update and uninstall keep every unrelated key, and back up the file they change first', posix, async () => {
  const original = JSON.stringify(THEIRS, null, 2) + '\n';
  const home = tmp('spk-sb-'), project = tmp('spk-sbp-');
  const files = { '.claude/settings.json': original };
  // init (all defaults, no terminal): Claude Code, user scope
  let r = await sandbox(['init', '--scope', 'user', '--no-ghost', '--no-anim'], { home, project, files });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  let s = JSON.parse(readFileSync(claudeSettings(home), 'utf8'));
  assert.deepEqual(theirs(s), THEIRS, 'init kept their keys');
  assert.ok(s.hooks?.Stop, 'and added ours');
  assert.match(r.stdout, /Backups of the files I changed: ~\/\.spookling\/backups\/\d{8}-\d{6}\//);
  let runs = backups(home);
  assert.equal(runs.length, 1);
  const copy = join(home, '.spookling', 'backups', runs[0], encodeName(claudeSettings(home)));
  assert.equal(readFileSync(copy, 'utf8'), original, 'the backup is the file as it was, byte for byte');
  assert.equal(statSync(copy).mode & 0o777, 0o600);

  // init --update
  const before = readFileSync(claudeSettings(home), 'utf8');
  r = await sandbox(['init', '--update'], { home, project });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  s = JSON.parse(readFileSync(claudeSettings(home), 'utf8'));
  assert.deepEqual(theirs(s), THEIRS, 'update kept their keys');
  assert.ok(backups(home).length >= 1);
  if (before !== readFileSync(claudeSettings(home), 'utf8')) assert.match(r.stdout, /Backups of the files I changed/);

  // uninstall
  const wired = readFileSync(claudeSettings(home), 'utf8');
  r = await sandbox(['uninstall', '--scope', 'user'], { home, project });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  s = JSON.parse(readFileSync(claudeSettings(home), 'utf8'));
  assert.deepEqual(theirs(s), THEIRS, 'uninstall kept their keys');
  assert.equal(s.hooks, undefined, 'and removed ours');
  runs = backups(home);
  const last = join(home, '.spookling', 'backups', runs[0], encodeName(claudeSettings(home)));
  assert.equal(readFileSync(last, 'utf8'), wired, 'uninstall saved the wired file before editing it');
  assert.match(r.stdout, /Backups of the files I changed: ~\/\.spookling\/backups\//);
});

test('a settings file that is not valid JSON is refused, named, and left byte for byte as it was', posix, async () => {
  const broken = '{ "theme": "dark", // comment\n  "model": ';
  const r = await sandbox(['init', '--scope', 'user', '--no-ghost', '--no-anim'], { files: { '.claude/settings.json': broken } });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /settings\.json is not valid JSON/);
  assert.match(r.stdout, /left untouched/);
  assert.equal(readFileSync(claudeSettings(r.home), 'utf8'), broken);
  assert.deepEqual(backups(r.home), [], 'nothing was changed, so nothing was copied');
});

test('a Codex config.toml that is not valid TOML is refused and left as it was; a valid one is backed up first', posix, async () => {
  const { spawnSync } = await import('node:child_process');
  const run = (config) => {
    const home = tmp('spk-toml-');
    mkdirSync(join(home, 'codex'), { recursive: true });
    writeFileSync(join(home, 'codex', 'config.toml'), config);
    const wizard = new URL('../src/wizard.js', import.meta.url).href, hooks = new URL('../src/hooks.js', import.meta.url).href;
    const script = `
      import { codexMcp } from ${JSON.stringify(wizard)};
      import { mcpEntry } from ${JSON.stringify(hooks)};
      const ctx = { project: ${JSON.stringify(home)}, scope: 'user', dry: false, written: [], skipped: [], problems: [], say: async () => {}, beat: async () => {}, auto: { home: ${JSON.stringify(home)} } };
      await codexMcp(ctx, mcpEntry('/h/.spookling-memory/0.2.0/server', 'http://127.0.0.1:7447'));
      console.log('PROBLEMS ' + JSON.stringify(ctx.problems));
      console.log(ctx.run?.label() ?? 'no backup');
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 60000, cwd: home,
      env: { PATH: dirname(process.execPath), HOME: home, USERPROFILE: home, CODEX_HOME: join(home, 'codex'), NO_COLOR: '1' },
    });
    return { r, home, file: join(home, 'codex', 'config.toml') };
  };
  const broken = 'model = "gpt-5\n[projects.x\n';
  let t = run(broken);
  assert.match(t.r.stdout, /config\.toml is not valid TOML \(line 1: unterminated string\); left it untouched/, t.r.stdout + t.r.stderr);
  assert.match(t.r.stdout, /PROBLEMS \[.*left untouched/);
  assert.equal(readFileSync(t.file, 'utf8'), broken);
  assert.match(t.r.stdout, /no backup/);
  const fine = '# mine\nmodel = "gpt-5"\n[projects."/w"]\ntrust_level = "trusted"\n';
  t = run(fine);
  assert.match(t.r.stdout, /PROBLEMS \[\]/, t.r.stdout + t.r.stderr);
  assert.ok(readFileSync(t.file, 'utf8').startsWith(fine), 'their lines stay');
  assert.match(t.r.stdout, /Backups of the files I changed: ~\/\.spookling\/backups\//);
  const [stamp] = listRuns(t.home);
  assert.equal(readFileSync(join(t.home, '.spookling', 'backups', stamp, encodeName(t.file)), 'utf8'), fine);
});
