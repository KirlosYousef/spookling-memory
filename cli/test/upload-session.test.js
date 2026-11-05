import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { tmpHome } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { projectFromSession, projectName, sessionLineCount, waitForLog } = require('../../hooks/upload-session.cjs');

const LOG = '/mem/log.jsonl';

function row(sessionId, role) {
  return JSON.stringify({
    session_id: sessionId, role, ts: '2026-11-03T11:42:24Z', text: role,
  });
}

function clock({ text, mtime, appendAt = [] }) {
  let t = 1_000_000;
  const started = t;
  const file = { text, mtime };
  return {
    started,
    now: () => t,
    elapsed: () => t - started,
    text: () => file.text,
    async sleep(ms) {
      t += ms;
      for (const burst of appendAt) {
        if (!burst.done && t >= started + burst.at) {
          burst.done = true;
          file.text += burst.lines;
        }
      }
    },
    readFile: () => file.text,
    exists: () => true,
    mtime: () => file.mtime,
  };
}

function wait(file, opts = {}) {
  return waitForLog({
    paths: [LOG],
    sessionId: 'abc',
    readFile: file.readFile,
    exists: file.exists,
    mtime: file.mtime,
    now: file.now,
    sleep: file.sleep,
    settleMs: 1500,
    maxWaitMs: 30_000,
    pollMs: 200,
    freshMs: 3000,
    ...opts,
  });
}

test('project name: repo root, else the folder, never the home folder, filesystem root or a temp folder', () => {
  const root = tmpHome('spk-proj-');
  const home = join(root, 'alex');
  const parentOfRepos = join(home, 'Developer', 'Spookling'); // not a git repo, holds several
  const repo = join(parentOfRepos, 'spookling-memory');
  mkdirSync(join(repo, 'cli'), { recursive: true });
  mkdirSync(join(repo, '.git'), { recursive: true });
  const of = (cwd, env = {}) => projectFromSession({ cwd }, env, undefined, home);
  assert.equal(of(repo), 'spookling-memory');
  assert.equal(of(join(repo, 'cli')), 'spookling-memory', 'a subfolder names the repo root');
  assert.equal(of(repo, { CLAUDE_PROJECT_DIR: home }), 'spookling-memory');
  assert.equal(of(parentOfRepos), 'Spookling', 'not a repo: the folder name');
  assert.equal(of(join(home, 'Downloads')), 'Downloads');
  assert.equal(of(home), '', 'the home folder is not a project');
  assert.equal(projectFromSession({}, { CLAUDE_PROJECT_DIR: parentOfRepos }, undefined, home), 'Spookling', 'falls back to CLAUDE_PROJECT_DIR');
  // a dotfiles repo in the home folder falls through to the folder name
  mkdirSync(join(home, '.git'), { recursive: true });
  assert.equal(of(home), '');
  assert.equal(of(join(home, 'Downloads')), 'Downloads');
  assert.equal(of(parentOfRepos), 'Spookling');
  assert.equal(of(repo), 'spookling-memory');
  // filesystem root and temp folders
  assert.equal(of(parse(process.cwd()).root), '');
  assert.equal(of(tmpdir()), '');
  assert.equal(of(realpathSync(tmpdir())), '');
  for (const t of ['/tmp', '/private/tmp']) if (existsSync(t)) assert.equal(of(t), '', t);
  if (process.platform !== 'win32') assert.equal(of('/var/folders/ab/cdef123/T'), ''); // macOS's temp folder shape; no such path on Windows
  assert.equal(of(join(tmpdir(), 'my-scratch')), 'my-scratch', 'a folder inside a temp folder is still a folder');
  assert.equal(of(''), '');
});

test('project name compares realpaths: a symlinked home or temp folder is still not a project', { skip: process.platform === 'win32' && 'symlinks' }, () => {
  const root = realpathSync(tmpHome('spk-link-'));
  const home = join(root, 'home');
  mkdirSync(home);
  symlinkSync(home, join(root, 'homelink'));
  assert.equal(projectFromSession({ cwd: join(root, 'homelink') }, {}, undefined, home), '');
  assert.equal(projectFromSession({ cwd: home }, {}, undefined, join(root, 'homelink')), '');
});

test('project name on Windows ignores case', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const realpath = (p) => p; // no such drive here
    assert.equal(projectName('/USERS/ADA', () => false, '/users/ada', { realpath }), '');
    assert.equal(projectName('/Users/Ada/Work', () => false, '/users/ada', { realpath }), 'Work');
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('session line count strips part suffixes and ignores other sessions', () => {
  const text = [
    row('abc#0', 'user'),
    row('abc#0', 'assistant'),
    row('abc#2', 'user'),
    row('abcd', 'user'),
    row('zzz', 'assistant'),
  ].join('\n');
  assert.equal(sessionLineCount(text, 'abc'), 3);
  assert.equal(sessionLineCount(text, 'abcd'), 1);
  assert.equal(sessionLineCount(text, ''), 0);
});

test('an older log waits for the late append, then settles', async () => {
  const file = clock({
    text: `${row('abc#0', 'user')}\n${row('abc#0', 'assistant')}\n`,
    mtime: 1_000_000 - 10_000,
    appendAt: [{
      at: 5000,
      lines: `${row('abc#2', 'user')}\n${row('abc#2', 'assistant')}\n`,
    }],
  });
  const path = await wait(file);
  assert.equal(path, LOG);
  assert.equal(sessionLineCount(file.text(), 'abc'), 4);
  assert.ok(file.elapsed() >= 5000 + 1500);
  assert.ok(file.elapsed() < 30_000);
});

test('two bursts inside the settle window upload together', async () => {
  const file = clock({
    text: '',
    mtime: 1_000_000 - 10_000,
    appendAt: [
      {       at: 400, lines: `${row('abc#0', 'user')}\n${row('abc#0', 'assistant')}\n` },
      { at: 800, lines: `${row('abc#2', 'user')}\n${row('abc#2', 'assistant')}\n` },
    ],
  });
  await wait(file);
  assert.equal(sessionLineCount(file.text(), 'abc'), 4);
  assert.ok(file.elapsed() >= 800 + 1500);
  assert.ok(file.elapsed() < 800 + 1500 + 400);
});

test('a log written just before Stop settles without waiting out the cap', async () => {
  const file = clock({
    text: [row('abc#0', 'user'), row('abc#0', 'assistant'), row('abc#2', 'user'), row('abc#2', 'assistant')].join('\n') + '\n',
    mtime: 1_000_000 - 100,
  });
  await wait(file);
  assert.equal(sessionLineCount(file.text(), 'abc'), 4);
  assert.ok(file.elapsed() >= 1500);
  assert.ok(file.elapsed() < 1500 + 400);
});

test('the wait cap uploads what is already there when no new line arrives', async () => {
  const file = clock({
    text: `${row('abc#0', 'user')}\n${row('abc#0', 'assistant')}\n`,
    mtime: 1_000_000 - 10_000,
  });
  await wait(file, { maxWaitMs: 1000, settleMs: 5000 });
  assert.equal(sessionLineCount(file.text(), 'abc'), 2);
  assert.ok(file.elapsed() >= 1000);
  assert.ok(file.elapsed() < 1000 + 400);
});
