import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './helpers.mjs';
import { writeCredentials } from '../src/credentials.js';
import { pushFromLog } from '../src/push.js';
import { cleanRemote, findGitRoot, repoUrlFor } from '../src/repo-url.js';
import { accountScope, readState } from '../src/upload-state.js';

const home = () => {
  const h = tmpHome('spk-repo-');
  writeCredentials({ token: 'spk_t', user: { id: 'u1' }, apiUrl: 'http://x.test' }, { home: h });
  return h;
};

// a project folder with a .git marker, optionally nested: <root>/<sub>
function project(sub = '') {
  const root = tmpHome('spk-proj-');
  mkdirSync(join(root, '.git'));
  const dir = sub ? join(root, sub) : root;
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

const git = (urls) => {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    const out = urls[opts.cwd];
    return out === undefined ? { status: 2, stdout: '' } : { status: 0, stdout: `${out}\n` };
  };
  return { run, calls };
};

test('cleanRemote strips credentials and query, masks the rest, and leaves scp and plain urls alone', () => {
  const cases = [
    ['https://github.com/o/r.git', 'https://github.com/o/r.git'],
    ['https://me:hunter2@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r', 'https://github.com/o/r'],
    ['https://user@bitbucket.org/o/r.git', 'https://bitbucket.org/o/r.git'],
    ['ssh://git@github.com:2222/o/r.git', 'ssh://github.com:2222/o/r.git'],
    ['git@github.com:o/r.git', 'git@github.com:o/r.git'],
    ['https://github.com/o/r.git?token=abc#frag', 'https://github.com/o/r.git'],
    ['  https://github.com/o/r\n', 'https://github.com/o/r'],
    ['', ''],
    ['two words', ''],
    [`https://github.com/o/${'r'.repeat(400)}`, ''],
  ];
  for (const [input, want] of cases) assert.equal(cleanRemote(input), want, input);
  assert.equal(cleanRemote(null), '');
  assert.doesNotMatch(cleanRemote('https://github.com/o/r?api_key=sk-abcdefghijklmnopqrstuvwxyz'), /sk-/);
});

test('findGitRoot walks up to the folder with .git and gives up outside a repo', () => {
  const { root, dir } = project('a/b');
  assert.equal(findGitRoot(dir), root);
  assert.equal(findGitRoot(root), root);
  assert.equal(findGitRoot(tmpHome('spk-nogit-')), '');
  assert.equal(findGitRoot(''), '');
});

test('repoUrlFor runs git in the git root, cleans the answer, and caches it so git is not run again', async () => {
  const h = home();
  const { root, dir } = project('src/deep');
  const { run, calls } = git({ [root]: 'https://me:pw@github.com/o/r.git' });
  assert.equal(await repoUrlFor(dir, { home: h, run }), 'https://github.com/o/r.git');
  assert.deepEqual(calls.map((c) => [c.cmd, c.args.join(' '), c.cwd]), [['git', 'remote get-url origin', root]]);
  assert.equal(await repoUrlFor(dir, { home: h, run }), 'https://github.com/o/r.git');
  assert.equal(await repoUrlFor(root, { home: h, run }), 'https://github.com/o/r.git');
  assert.equal(calls.length, 1, 'cached per project in upload-state');
  assert.equal(readState(h, accountScope(h)).repoUrls[root].url, 'https://github.com/o/r.git');
});

test('repoUrlFor asks git again after a day, and caches "no remote" too', async () => {
  const h = home();
  const { root } = project();
  const { run, calls } = git({});
  let t = 1_000_000;
  const now = () => t;
  assert.equal(await repoUrlFor(root, { home: h, run, now }), '');
  assert.equal(await repoUrlFor(root, { home: h, run, now }), '');
  assert.equal(calls.length, 1);
  t += 25 * 3600 * 1000;
  const later = git({ [root]: 'git@github.com:o/r.git' });
  assert.equal(await repoUrlFor(root, { home: h, run: later.run, now }), 'git@github.com:o/r.git');
  assert.equal(later.calls.length, 1);
});

test('repoUrlFor is empty outside a repo, in the home folder, and when git throws', async () => {
  const h = home();
  const { run, calls } = git({});
  assert.equal(await repoUrlFor(tmpHome('spk-nogit-'), { home: h, run }), '');
  assert.equal(calls.length, 0);
  mkdirSync(join(h, '.git'));
  assert.equal(await repoUrlFor(h, { home: h, run }), '', 'a dotfiles repo in the home folder is not a project');
  const { root } = project();
  const boom = () => { throw new Error('no git'); };
  assert.equal(await repoUrlFor(root, { home: h, run: boom }), '');
});

const logOf = (sid) => ['user', 'assistant'].map((role, i) => JSON.stringify({ session_id: sid, seq: i, role, text: `t${i}`, ts: '2026-01-01T00:00:00Z' })).join('\n');
const recorder = () => {
  const puts = [];
  return { puts, upsertSession: async (a) => { puts.push(a); return {}; }, postTurns: async () => ({}) };
};

test('upload sends repoUrl in the PUT body from the project folder, once per project', async () => {
  const h = home();
  const { root } = project();
  const { run, calls } = git({ [root]: 'git@github.com:o/r.git' });
  const cloud = recorder();
  // repoUrlFor uses spawnSync by default; the real binary is not run here, so seed the cache the way a first call would
  await repoUrlFor(root, { home: h, run });
  await pushFromLog({ logText: `${logOf('a')}\n${logOf('b')}`, home: h, cloud, project: 'r', projectDir: root, log: () => {} });
  assert.deepEqual(cloud.puts.map((p) => [p.sid, p.session.repoUrl]), [['a', 'git@github.com:o/r.git'], ['b', 'git@github.com:o/r.git']]);
  assert.equal(calls.length, 1);
});

test('upload sends an explicit repoUrl as given and no repoUrl for a folder with no remote', async () => {
  const h = home();
  const cloud = recorder();
  await pushFromLog({ logText: logOf('a'), home: h, cloud, project: 'r', repoUrl: 'https://github.com/o/r.git', log: () => {} });
  assert.equal(cloud.puts[0].session.repoUrl, 'https://github.com/o/r.git');

  const none = recorder();
  const { root } = project();
  await repoUrlFor(root, { home: h, run: git({}).run }); // cached: no remote
  await pushFromLog({ logText: logOf('b'), home: h, cloud: none, project: 'r', projectDir: root, log: () => {} });
  assert.equal('repoUrl' in none.puts[0].session, false);
});

test('a queued session of another project does not take this project\'s repoUrl', async () => {
  const h = home();
  const down = { upsertSession: async () => { throw Object.assign(new Error('x'), { status: undefined }); }, postTurns: async () => ({}) };
  await pushFromLog({ logText: logOf('old'), home: h, cloud: down, project: 'other', log: () => {} });
  const cloud = recorder();
  await pushFromLog({ logText: logOf('new'), home: h, cloud, project: 'r', repoUrl: 'https://github.com/o/r.git', log: () => {} });
  const byId = Object.fromEntries(cloud.puts.map((p) => [p.sid, p.session]));
  assert.equal(byId.new.repoUrl, 'https://github.com/o/r.git');
  if (byId.old) assert.equal(byId.old.repoUrl, undefined);
});

test('with real git: the origin of a nested folder, credentials stripped; none without an origin', async (t) => {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git is not installed');
  const h = home();
  const root = tmpHome('spk-realgit-');
  const sh = (...args) => spawnSync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  assert.equal(sh('init', '-q').status, 0);
  mkdirSync(join(root, 'pkg'));
  writeFileSync(join(root, 'pkg', 'f.txt'), 'x');
  assert.equal(await repoUrlFor(join(root, 'pkg'), { home: h, ttlMs: 0 }), '');
  assert.equal(sh('remote', 'add', 'origin', 'https://me:pw@github.com/o/r.git').status, 0);
  assert.equal(await repoUrlFor(join(root, 'pkg'), { home: h, ttlMs: 0 }), 'https://github.com/o/r.git');
});
