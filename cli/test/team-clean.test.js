import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpHome } from './helpers.mjs';
import { writeCredentials } from '../src/credentials.js';
import { refresh, teamSession, teamSessions, writeCache } from '../src/team.js';

const homeOf = () => tmpHome('spk-clean-');

test('team_sessions and team_session strip escape sequences and control characters from every server string', async () => {
  const dirty = {
    orgs: { o1: { name: 'Ac\u001b[31mme' } },
    sessions: {
      'o1\nu2:abc': {
        orgId: 'o1',
        orgName: 'Ac\u001b[31mme',
        session: { id: 'u2:abc', title: 'T\u001b]0;pwn\u0007itle', project: 'p‮x', owner: { id: 'u2', name: 'E\u001b[2Jve' }, agent: 'claude' },
        turns: [{ seq: 0, role: 'user', text: 'hello \u001b[31mred\u0000 world', ts: 't' }],
      },
    },
  };
  const out = await teamSessions({ home: homeOf(), cache: dirty, refreshFirst: false });
  assert.equal(/\u001b|\u0007|\u0000|‮/.test(JSON.stringify(out)), false);
  const body = await teamSession({ home: homeOf(), session_id: 'u2:abc', cache: dirty, refreshFirst: false });
  assert.equal(/\u001b|\u0000/.test(body), false);
  assert.match(body, /hello \[31mred world/);
});

test('refresh lists ambiguous orgs without control characters', async () => {
  const home = homeOf();
  writeCredentials({ token: 'spk_x', apiUrl: 'https://x.example' }, { home });
  // two orgs whose names differ only by case both match "same"; the first has an escape sequence in its id
  const cloud = { listOrgs: async () => ({ orgs: [{ org: { id: 'a\u001b[31m', name: 'Same' } }, { org: { id: 'b', name: 'SAME' } }] }) };
  let out = '';
  const code = await refresh({ home, cloud, orgId: 'same', write: (s) => { out += s; } });
  assert.equal(code, 1);
  assert.match(out, /More than one org matches/);
  assert.equal(/\u001b/.test(out), false);
});

test('the team cache is written atomically at 0600 and never through a symlink', { skip: process.platform === 'win32' && 'POSIX modes and symlinks' }, () => {
  const home = homeOf();
  const path = writeCache({ orgs: {}, sessions: {}, apiBase: null }, home);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dirname(path)).filter((f) => f.endsWith('.tmp')), []);
  const other = join(home, 'victim');
  writeFileSync(other, 'keep');
  unlinkSync(path);
  symlinkSync(other, path);
  assert.throws(() => writeCache({ orgs: {}, sessions: {}, apiBase: null }, home), /symlink/);
  assert.equal(readFileSync(other, 'utf8'), 'keep');
});
