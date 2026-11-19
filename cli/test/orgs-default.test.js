// `spookling orgs default`: view and change the default org. The live API answer wins; the saved copy is a cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './helpers.mjs';
import { CloudError } from '../src/cloud.js';
import { readCredentials, setDefaultOrg, writeCredentials } from '../src/credentials.js';
import { orgs, orgsDefault } from '../src/account.js';
import { main } from '../src/main.js';

const TOKEN = 'spk_secret_token_value';
const ORG = (id, name) => ({ org: { id, name }, membership: { status: 'active' } });
const LIST = [ORG('org_a1', 'Acme'), ORG('org_b2', 'Beta'), ORG('org_c3', 'Spookling'), ORG('org_d4', 'spookling')];

const home = (cached) => {
  const h = tmpHome('spk-od-');
  writeCredentials({ token: TOKEN, user: { id: 'u1' }, apiUrl: 'http://api.one' }, { home: h });
  if (cached) setDefaultOrg(cached, { home: h });
  return h;
};
function fake({ list = LIST, current = { orgId: 'org_a1', source: 'chosen', chosenOrgId: 'org_a1' }, putError, getError } = {}) {
  const calls = [];
  const state = { current };
  return {
    calls, state,
    listOrgs: async () => ({ orgs: list }),
    getDefaultOrg: async () => { calls.push(['get']); if (getError) throw getError; return state.current; },
    setDefaultOrg: async ({ orgId }) => {
      calls.push(['put', orgId]);
      if (putError) throw putError;
      state.current = { orgId, source: 'chosen', chosenOrgId: orgId };
      return state.current;
    },
  };
}
const run = async (h, opts) => {
  let out = '';
  const code = await orgsDefault({ home: h, env: {}, write: (s) => { out += s; }, ...opts });
  return { code, out };
};
const cached = (h) => readCredentials({ home: h, env: {} }).defaultOrgId;

test('no argument: shows the live default with name and id, and marks it in the list', async () => {
  const h = home({ id: 'org_b2', name: 'Beta' }); // the cache is behind the server
  const { code, out } = await run(h, { cloud: fake() });
  assert.equal(code, 0);
  assert.match(out, /^Default org: Acme \(org_a1\)\n/);
  assert.match(out, /org_a1  Acme  \(default\)\n/);
  assert.match(out, /org_b2  Beta\n/);
  assert.match(out, /private memory/);
  assert.match(out, /To change it: spookling orgs default <org name or id>/);
  assert.equal(cached(h), 'org_a1', 'the cache followed the server');
  assert.ok(!out.includes(TOKEN));
});

test('set by id and by unique name: PUT, then the saved copy follows', async () => {
  const h = home({ id: 'org_a1', name: 'Acme' });
  const cloud = fake();
  const byId = await run(h, { cloud, query: 'org_b2' });
  assert.equal(byId.code, 0);
  assert.match(byId.out, /Default org: Beta \(org_b2\)/);
  assert.deepEqual(cloud.calls.at(-1), ['put', 'org_b2']);
  assert.equal(cached(h), 'org_b2');
  assert.equal(readCredentials({ home: h, env: {} }).defaultOrgName, 'Beta');
  const byName = await run(h, { cloud, query: 'ACME' });
  assert.equal(byName.code, 0);
  assert.deepEqual(cloud.calls.at(-1), ['put', 'org_a1']);
  assert.equal(cached(h), 'org_a1');
});

test('an ambiguous name refuses, lists the ids and sends nothing', async () => {
  const h = home({ id: 'org_a1', name: 'Acme' });
  const cloud = fake();
  const { code, out } = await run(h, { cloud, query: 'Spookling' });
  assert.equal(code, 1);
  assert.match(out, /More than one org is named 'Spookling'.*id/);
  assert.match(out, /org_c3  Spookling/);
  assert.match(out, /org_d4  spookling/);
  assert.ok(!cloud.calls.some((c) => c[0] === 'put'));
  assert.equal(cached(h), 'org_a1');
  // the id still works
  assert.equal((await run(h, { cloud, query: 'org_d4' })).code, 0);
});

test('an unknown org lists the valid ones and changes nothing', async () => {
  const h = home({ id: 'org_a1', name: 'Acme' });
  const cloud = fake();
  const { code, out } = await run(h, { cloud, query: 'nope' });
  assert.equal(code, 1);
  assert.match(out, /No org matches 'nope'. Your orgs:/);
  assert.match(out, /org_b2  Beta/);
  assert.ok(!cloud.calls.some((c) => c[0] === 'put'));
});

test('not logged in points at login', async () => {
  const h = tmpHome('spk-od-none-');
  const { code, out } = await run(h, { cloud: fake() });
  assert.equal(code, 1);
  assert.equal(out, 'Not logged in. Run spookling login.\n');
});

test('API errors are one clear line and the saved copy is not touched', async () => {
  const cases = [
    [403, /not one of yours/], [404, /not one of yours/], [400, /did not accept/],
    [503, /^The default org is not enabled on this server\.\n$/], [401, /Run spookling login/],
  ];
  for (const [status, re] of cases) {
    const h = home({ id: 'org_a1', name: 'Acme' });
    const cloud = fake({ putError: new CloudError(`HTTP ${status}`, { status }) });
    const { code, out } = await run(h, { cloud, query: 'org_b2' });
    assert.equal(code, 1, String(status));
    assert.match(out, re);
    assert.equal(cached(h), 'org_a1', `cache kept on ${status}`);
    assert.ok(!out.includes(TOKEN));
  }
  const h = home({ id: 'org_a1', name: 'Acme' });
  const off = await run(h, { cloud: fake({ putError: new CloudError('network error', { code: 'ECONNREFUSED' }) }), query: 'org_b2' });
  assert.match(off.out, /Couldn't reach/);
  assert.equal(cached(h), 'org_a1');
});

test('without a terminal it prints the list and the command, and never asks', async () => {
  const h = home();
  let asked = 0;
  const cloud = fake();
  const { code, out } = await run(h, { cloud, tty: false, choose: async () => { asked++; return 0; } });
  assert.equal(code, 0);
  assert.equal(asked, 0);
  assert.match(out, /spookling orgs default <org name or id>/);
});

test('at a terminal the pick sets the default; keeping it changes nothing', async () => {
  const h = home({ id: 'org_a1', name: 'Acme' });
  const cloud = fake();
  let seen;
  const pick = await run(h, { cloud, tty: true, choose: async (q, opts, def) => { seen = { opts, def }; return 1; } });
  assert.equal(pick.code, 0);
  assert.equal(seen.def, 0, 'the current default is preselected');
  assert.equal(seen.opts.at(-1), 'Keep it as it is');
  assert.deepEqual(cloud.calls.at(-1), ['put', 'org_b2']);
  assert.equal(cached(h), 'org_b2');
  const calls = cloud.calls.length;
  const keep = await run(h, { cloud, tty: true, choose: async (q, opts) => opts.length - 1 });
  assert.match(keep.out, /Default org unchanged/);
  assert.ok(!cloud.calls.slice(calls).some((c) => c[0] === 'put'));
});

test('orgs marks the server default (live), and falls back to the saved one offline', async () => {
  const h = home({ id: 'org_b2', name: 'Beta' });
  let out = '';
  await orgs({ home: h, env: {}, cloud: fake(), write: (s) => { out += s; } });
  assert.match(out, /org_a1  Acme  \(default\)/);
  assert.doesNotMatch(out, /Beta  \(default\)/);
  assert.equal(cached(h), 'org_a1');
  // offline default call: the saved copy is marked
  const h2 = home({ id: 'org_b2', name: 'Beta' });
  out = '';
  await orgs({ home: h2, env: {}, cloud: fake({ getError: new CloudError('network error', { code: 'ECONNREFUSED' }) }), write: (s) => { out += s; } });
  assert.match(out, /org_b2  Beta  \(default\)/);
  assert.equal(cached(h2), 'org_b2');
});

test('orgs does not save an implicit default that the user never chose', async () => {
  const h = home();
  await orgs({ home: h, env: {}, cloud: fake({ current: { orgId: 'org_a1', source: 'oldest', chosenOrgId: null } }), write: () => {} });
  assert.equal(cached(h), null);
});

test('main routes `orgs default <name words>` and rejects other words', async () => {
  const h = home();
  let got;
  const code = await main(['node', 'spookling', 'orgs', 'default', 'My', 'Team'], { home: h, tty: false, orgsDefault: async (a) => { got = a; return 0; } });
  assert.equal(code, 0);
  assert.equal(got.query, 'My Team');
  assert.equal(got.tty, false);
  let exited;
  await main(['node', 'spookling', 'orgs', 'bogus'], { home: h, exit: (c) => { exited = c; } });
  assert.equal(exited, 2);
});
