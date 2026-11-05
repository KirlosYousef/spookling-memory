import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { changes, markerCount, snapshot, watched } from './guard-real-home.mjs';
import { tmpHome } from './helpers.mjs';

const home = () => tmpHome('spk-gd-');
const put = (p, body) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); };

test('the guard sees a changed, created or deleted config file', () => {
  const h = home(), env = {};
  const w = watched(h, env);
  put(w.exact[0], '{}');
  const before = snapshot(h, env);
  assert.deepEqual(changes(before, snapshot(h, env)), []);
  put(w.exact[0], '{"a":1}');
  assert.match(changes(before, snapshot(h, env))[0], /settings\.json was modified/);
  put(w.exact[1], '{}');
  assert.ok(changes(before, snapshot(h, env)).some((l) => /hooks\.json was created/.test(l)));
  const t = new Date(Date.now() - 60_000);
  utimesSync(w.exact[0], t, t); // same size, different mtime still counts
  const b2 = snapshot(h, env);
  utimesSync(w.exact[0], new Date(), new Date());
  assert.match(changes(b2, snapshot(h, env))[0], /settings\.json was modified/);
});

test('~/.claude.json may change by itself, but must not gain test paths', () => {
  const h = home(), env = {};
  const w = watched(h, env);
  put(w.drifting, JSON.stringify({ projects: { '/Users/me/app': {} } }));
  const before = snapshot(h, env);
  put(w.drifting, JSON.stringify({ projects: { '/Users/me/app': {}, '/Users/me/other': {} }, more: 1 }));
  assert.deepEqual(changes(before, snapshot(h, env)), [], 'ordinary drift is fine');
  put(w.drifting, JSON.stringify({ args: ['/var/folders/gd/xyz/T/spk-e2e-ZhmwHb/.spookling-memory/0.1.3/server'] }));
  assert.match(changes(before, snapshot(h, env))[0], /gained \d+ test path/);
  assert.equal(markerCount('/private/var/folders/a/b/T/x'), 1);
  assert.equal(markerCount('/Users/me/spookling-memory'), 0);
});

test('a test that makes real backups is caught', () => {
  const h = home(), env = {};
  const before = snapshot(h, env);
  mkdirSync(join(watched(h, env).backups, '20261104-183005'), { recursive: true });
  assert.match(changes(before, snapshot(h, env))[0], /real backup run/);
});
