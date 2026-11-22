// `spookling rules`: project rules from the cloud. A change is written only after a y at a real terminal; no terminal, no request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envelope, listen, readReq, tmpHome } from './helpers.mjs';
import { setDefaultOrg, writeCredentials } from '../src/credentials.js';
import { main } from '../src/main.js';
import { invoke, normalizeRule } from '../src/rules.js';

const ORG = (id, name) => ({ org: { id, name }, membership: { status: 'active' } });
const RULE = (id, text, version = 1, extra = {}) => ({
  id, text, version, status: 'active', createdAt: '2026-11-18T09:00:00.000Z', createdBy: { userId: 'u1', name: 'Ada' },
  updatedAt: '2026-11-18T10:00:00.000Z', updatedBy: { userId: 'u2', name: 'Lin' }, ...extra,
});

// A fake API with project rules. state.fail = { status, code, reason, rule } makes the next write fail that way.
async function fakeApi({ orgs = [ORG('o1', 'Acme')], rules = [RULE('r_1', 'Use MVVM for all UI code.')], removed = [] } = {}) {
  const state = { orgs, rules, removed, fail: null, failVia: false, seen: [] };
  const srv = await listen(async (req, res) => {
    const body = req.method === 'POST' ? await readReq(req) : null;
    const url = decodeURIComponent(req.url);
    state.seen.push({ method: req.method, url, rawUrl: req.url, body });
    if (url === '/cli/orgs') return envelope(res, 200, { success: true, data: { orgs: state.orgs } });
    const m = /^\/memory\/orgs\/([^/]+)\/projects\/(.+?)\/rules(?:\/([^/]+)\/(history|remove))?$/.exec(url);
    if (!m) return envelope(res, 404, { success: false, error: { code: 'NOT_FOUND' } });
    const [, , , id, what] = m;
    if (req.method === 'GET' && !id) return envelope(res, 200, { success: true, data: { rules: state.rules, removed: state.removed } });
    const rule = [...state.rules, ...state.removed].find((r) => r.id === (id || body?.replaces));
    if (what === 'history') {
      if (!rule) return envelope(res, 404, { success: false, error: { code: 'NOT_FOUND' } });
      return envelope(res, 200, { success: true, data: { rule, versions: [
        { version: 2, text: rule.text, action: 'replace', revertedFrom: null, by: { name: 'Lin' }, via: 'mcp', at: '2026-11-18T10:00:00.000Z' },
        { version: 1, text: 'Use MVVM.', action: 'set', revertedFrom: null, by: { name: 'Ada' }, via: 'cli', at: '2026-11-18T09:00:00.000Z' },
      ] } });
    }
    if (state.failVia && body?.via === 'slash') return envelope(res, 400, { success: false, error: { code: 'INVALID_VIA', details: {} } });
    if (state.fail) {
      const f = state.fail;
      return envelope(res, f.status, { success: false, error: { code: f.code, details: { reason: f.reason, ...(f.rule && { rule: f.rule }) } } });
    }
    if (what === 'remove') return envelope(res, 200, { success: true, data: { rule: { ...rule, status: 'removed', version: rule.version + 1 } } });
    if (body.replaces) return envelope(res, 200, { success: true, data: { rule: { ...rule, text: body.text, version: rule.version + 1 }, previous: rule } });
    return envelope(res, 201, { success: true, data: { rule: RULE('r_new', body.text), previous: null } });
  });
  const url = `http://127.0.0.1:${srv.address().port}`;
  return { state, url, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

function setup(api, { defaultOrg = null, login = true } = {}) {
  const home = tmpHome('spk-rules-home-'), cwd = tmpHome('spk-rules-proj-');
  if (login) writeCredentials({ token: 'spk_rules_token', user: { id: 'u1', name: 'Ada' }, apiUrl: api.url }, { home });
  if (defaultOrg) setDefaultOrg({ id: defaultOrg, name: defaultOrg }, { home }); // the saved default, as login writes it
  return { home, cwd, key: `dir:${basename(cwd)}` };
}

async function rules(t, args, deps = {}) {
  let out = '', err = '';
  const o = process.stdout.write, e = process.stderr.write;
  process.stdout.write = (s) => { out += s; return true; };
  process.stderr.write = (s) => { err += s; return true; };
  try {
    const code = await main(['node', 'spookling', 'rules', ...args], { home: t.home, cwd: t.cwd, env: {}, tty: true, exit: () => {}, ...deps });
    return { code, out, err };
  } finally { process.stdout.write = o; process.stderr.write = e; }
}
const writes = (api) => api.state.seen.filter((r) => r.method === 'POST');
const yes = async () => true, no = async () => false;

test('list: numbered rules with id, who and when, for the folder\'s project in the org', async () => {
  const api = await fakeApi({ rules: [RULE('r_1', 'Use MVVM for all UI code.'), RULE('r_2', 'No new dependencies without review.', 1)] });
  try {
    const t = setup(api);
    const r = await rules(t, []);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`Project rules for ${basename(t.cwd)} in Acme \\(your only org\\)`));
    assert.match(r.out, /1\. Use MVVM for all UI code\.\n\s+r_1 · set by Ada 2026-11-18 09:00; v1|1\. Use MVVM for all UI code\.\n\s+r_1 · set by Ada 2026-11-18 09:00/);
    assert.match(r.out, /2\. No new dependencies without review\./);
    const get = api.state.seen.find((s) => s.method === 'GET' && s.url.includes('/rules'));
    assert.equal(get.url, `/memory/orgs/o1/projects/${t.key}/rules`);
    assert.match(get.rawUrl, /projects\/dir%3Aspk-rules-proj-/, 'the project key is URL-encoded');
  } finally { await api.close(); }
});

test('list with no rules says so and how to add one', async () => {
  const api = await fakeApi({ rules: [] });
  try {
    const r = await rules(setup(api), []);
    assert.equal(r.code, 0);
    assert.match(r.out, /No project rules for .* in Acme yet\.\nAdd one: spookling rules set "<the rule>"/);
  } finally { await api.close(); }
});

test('set: shows project, org and the text, asks, and writes with via cli on y', async () => {
  const api = await fakeApi();
  try {
    const t = setup(api);
    let asked = '';
    const r = await rules(t, ['set', '  Write tests   for every\nbug fix. '], { confirm: async (q) => { asked = q; return true; } });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Set a project rule\n {2}project: spk-rules-proj-.*\n {2}org: {5}Acme \(your only org\)\n {2}rule: {4}Write tests for every bug fix\./);
    assert.equal(asked, 'Set this rule?');
    assert.match(r.out, /Rule set: r_new \(version 1\)/);
    const w = writes(api);
    assert.equal(w.length, 1);
    assert.equal(w[0].url, `/memory/orgs/o1/projects/${t.key}/rules`);
    assert.deepEqual(w[0].body, { text: 'Write tests for every bug fix.', via: 'cli' });
  } finally { await api.close(); }
});

test('set: N (or anything but yes) writes nothing', async () => {
  const api = await fakeApi();
  try {
    const r = await rules(setup(api), ['set', 'Use tabs.'], { confirm: no });
    assert.equal(r.code, 1);
    assert.match(r.out, /Nothing changed\./);
    assert.deepEqual(writes(api), []);
  } finally { await api.close(); }
});

test('set --replace shows the old text and the new text and sends replaces + expectedVersion', async () => {
  const api = await fakeApi({ rules: [RULE('r_1', 'Use MVVM for all UI code.', 2)] });
  try {
    const t = setup(api);
    const r = await rules(t, ['set', 'Use MVVM for UI code, MVC for admin pages.', '--replace', 'r_1'], { confirm: yes });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Replace project rule r_1\n.*\n.*\n {2}old: {5}Use MVVM for all UI code\.\n {2}new: {5}Use MVVM for UI code, MVC for admin pages\./);
    assert.match(r.out, /Rule r_1 replaced \(now version 3\)/);
    assert.deepEqual(writes(api)[0].body, { text: 'Use MVVM for UI code, MVC for admin pages.', via: 'cli', replaces: 'r_1', expectedVersion: 2 });
  } finally { await api.close(); }
});

test('set --replace with an unknown id asks nothing and writes nothing', async () => {
  const api = await fakeApi();
  try {
    let asked = false;
    const r = await rules(setup(api), ['set', 'x y z', '--replace', 'r_nope'], { confirm: async () => { asked = true; return true; } });
    assert.equal(r.code, 1);
    assert.match(r.out, /No rule r_nope/);
    assert.equal(asked, false);
    assert.deepEqual(writes(api), []);
  } finally { await api.close(); }
});

test('no terminal: set and remove refuse at once and send no request at all; there is no --yes', async () => {
  const api = await fakeApi();
  try {
    const t = setup(api);
    for (const args of [['set', 'Use tabs.'], ['remove', 'r_1'], ['set', 'Use tabs.', '--yes']]) {
      const r = await rules(t, args, { tty: false, confirm: yes });
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.out, /this is not a terminal, so nothing was changed/);
    }
    assert.deepEqual(api.state.seen, [], 'not even a read');
  } finally { await api.close(); }
});

test('remove: shows the rule, asks, then removes it with the version shown', async () => {
  const api = await fakeApi({ rules: [RULE('r_1', 'Use MVVM for all UI code.', 2)] });
  try {
    const t = setup(api);
    let asked = '';
    const r = await rules(t, ['remove', 'r_1'], { confirm: async (q) => { asked = q; return true; } });
    assert.equal(r.code, 0, r.out);
    assert.equal(asked, 'Remove this rule?');
    assert.match(r.out, /Remove project rule r_1\n.*\n.*\n {2}rule: {4}Use MVVM for all UI code\./);
    assert.match(r.out, /Rule r_1 removed/);
    const w = writes(api);
    assert.equal(w[0].url, `/memory/orgs/o1/projects/${t.key}/rules/r_1/remove`);
    assert.deepEqual(w[0].body, { expectedVersion: 2, via: 'cli' });
    const n = await rules(t, ['remove', 'r_1'], { confirm: no });
    assert.equal(n.code, 1);
    assert.equal(writes(api).length, 1, 'a no removes nothing');
  } finally { await api.close(); }
});

test('history: every version, newest first, with action, who and when', async () => {
  const api = await fakeApi({ rules: [RULE('r_1', 'Use MVVM for all UI code.', 2)] });
  try {
    const t = setup(api);
    const r = await rules(t, ['history', 'r_1']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /History of rule r_1 \(now active: Use MVVM for all UI code\.\), newest first:/);
    assert.ok(r.out.indexOf('v2  replace  Lin  2026-11-18 10:00  via mcp') < r.out.indexOf('v1  set  Ada  2026-11-18 09:00  via cli'));
    assert.match(r.out, /\n {6}Use MVVM\.\n/);
    const bad = await rules(t, ['history', 'r_x']);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /No rule with that id/);
  } finally { await api.close(); }
});

test('409 rule_changed: shows the current text and stops', async () => {
  const api = await fakeApi({ rules: [RULE('r_1', 'Use MVVM for all UI code.', 2)] });
  try {
    api.state.fail = { status: 409, code: 'CONFLICT', reason: 'rule_changed', rule: RULE('r_1', 'Use MVI for all UI code.', 3) };
    const r = await rules(setup(api), ['set', 'Use MVVM everywhere.', '--replace', 'r_1'], { confirm: yes });
    assert.equal(r.code, 1);
    assert.match(r.out, /Someone changed this rule since it was shown\. It now says: "Use MVI for all UI code\." \(version 3, active\)\. Nothing changed\./);
    assert.match(r.out, /run the command again if you still want the change/);
  } finally { await api.close(); }
});

test('409 rule_exists, rule_unchanged and rule_limit, and 400 rule_text, are plain messages', async () => {
  const api = await fakeApi();
  try {
    const t = setup(api);
    const cases = [
      [{ status: 409, code: 'CONFLICT', reason: 'rule_exists', rule: RULE('r_1', 'Use tabs.') }, /already exists in this project \(r_1\)/],
      [{ status: 409, code: 'CONFLICT', reason: 'rule_unchanged' }, /already says exactly that/],
      [{ status: 409, code: 'CONFLICT', reason: 'rule_limit' }, /20 active rules/],
      [{ status: 400, code: 'BAD_REQUEST', reason: 'rule_text' }, /1 to 300 characters/],
      [{ status: 403, code: 'FORBIDDEN' }, /not an active member of that org/],
    ];
    for (const [fail, re] of cases) {
      api.state.fail = fail;
      const r = await rules(t, ['set', 'Use tabs.'], { confirm: yes });
      assert.equal(r.code, 1);
      assert.match(r.out, re, fail.reason);
    }
  } finally { await api.close(); }
});

test('a rule over 300 characters is refused before anything is asked or sent', async () => {
  const api = await fakeApi();
  try {
    const r = await rules(setup(api), ['set', 'x'.repeat(301)], { confirm: yes });
    assert.equal(r.code, 1);
    assert.match(r.out, /at most 300 characters/);
    assert.deepEqual(api.state.seen, []);
  } finally { await api.close(); }
});

test('org: --org by name or id, else the saved default, else the only org', async () => {
  const api = await fakeApi({ orgs: [ORG('o1', 'Acme'), ORG('o2', 'Beta')] });
  try {
    const flagged = setup(api);
    await rules(flagged, ['--org', 'beta']);
    await rules(flagged, ['--org', 'o1']);
    const gets = api.state.seen.filter((s) => s.url.includes('/rules')).map((s) => s.url.split('/')[3]);
    assert.deepEqual(gets, ['o2', 'o1']);
    api.state.seen.length = 0;
    await rules(setup(api, { defaultOrg: 'o2' }), []);
    assert.equal(api.state.seen.find((s) => s.url.includes('/rules')).url.split('/')[3], 'o2', 'the saved default');
  } finally { await api.close(); }
  const single = await fakeApi();
  try {
    const r = await rules(setup(single), []);
    assert.match(r.out, /in Acme \(your only org\)/);
  } finally { await single.close(); }
});

test('org: several and none chosen asks at a terminal, and refuses naming --org without one', async () => {
  const api = await fakeApi({ orgs: [ORG('o1', 'Acme'), ORG('o2', 'Beta')] });
  try {
    const t = setup(api);
    let options = null;
    const r = await rules(t, [], { choose: async (q, opts) => { options = opts; return 1; } });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(options, ['Acme (o1)', 'Beta (o2)']);
    assert.match(r.out, /in Beta:/);
    const refused = await rules(t, [], { tty: false });
    assert.equal(refused.code, 1);
    assert.match(refused.out, /several orgs: 'Acme', 'Beta'\. Run again with --org <id or name>\./);
    const wrong = await rules(t, ['--org', 'Gamma']);
    assert.equal(wrong.code, 1);
    assert.match(wrong.out, /No org matches "Gamma"/);
  } finally { await api.close(); }
});

test('not logged in: the standard message and no request', async () => {
  const api = await fakeApi();
  try {
    const t = setup(api, { login: false });
    for (const args of [[], ['set', 'Use tabs.'], ['history', 'r_1']]) {
      const r = await rules(t, args, { confirm: yes });
      assert.equal(r.code, 1);
      assert.match(r.out, /Not logged in\. Run `spookling login`, then try again\./);
    }
    assert.deepEqual(api.state.seen, []);
  } finally { await api.close(); }
});

test('the home folder is not a project: refused politely, nothing written', async () => {
  const api = await fakeApi();
  try {
    const t = setup(api);
    const r = await rules({ ...t, cwd: t.home }, ['set', 'Use tabs.'], { confirm: yes });
    assert.equal(r.code, 1);
    assert.match(r.out, /not part of a project/);
    assert.deepEqual(writes(api), []);
  } finally { await api.close(); }
});

test('usage errors: set without text, remove without an id, an unknown subcommand, --replace elsewhere', async () => {
  const api = await fakeApi();
  try {
    const t = setup(api);
    for (const args of [['set'], ['remove'], ['frobnicate'], ['remove', 'r_1', '--replace', 'r_2']]) {
      const r = await rules(t, args, { confirm: yes });
      assert.equal(r.code, 2, args.join(' '));
    }
    assert.deepEqual(api.state.seen, []);
  } finally { await api.close(); }
});

test('help lists the rules commands; the internal MCP entry points are not in it', async () => {
  let out = '';
  const o = process.stdout.write;
  process.stdout.write = (s) => { out += s; return true; };
  try { await main(['node', 'spookling', 'help'], {}); } finally { process.stdout.write = o; }
  assert.match(out, /spookling rules set "<rule>" \[--replace <id>\]/);
  assert.match(out, /spookling rules remove <id>/);
  assert.match(out, /spookling rules history <id>/);
  assert.ok(!/rules-set|rules-get|rules-remove|--yes.*rules/.test(out));
});

test('the MCP side only reads: team-invoke has rules-get and no write entry, and invoke has only get', async () => {
  const api = await fakeApi({ rules: [RULE('r_1', 'Use MVVM for all UI code.', 2)] });
  try {
    const t = setup(api);
    const { rulesGet, invoke: inv } = await import('../src/rules.js');
    const g = await rulesGet({ cwd: t.cwd, home: t.home, env: {} });
    assert.equal(g.orgId, 'o1');
    assert.equal(g.projectKey, t.key);
    assert.equal(g.rules[0].id, 'r_1');
    assert.deepEqual(Object.keys(inv), ['get']);
    assert.deepEqual(writes(api), []);
    const script = fileURLToPath(new URL('../src/team-invoke.js', import.meta.url));
    const cp = await import('node:child_process');
    for (const name of ['rules-set', 'rules-remove']) {
      const r = cp.spawnSync(process.execPath, [script, name, '{}'], { encoding: 'utf8', env: { ...process.env, HOME: t.home, USERPROFILE: t.home } });
      assert.equal(r.status, 1, name);
      assert.match(r.stdout, /Unknown team tool/, name);
    }
    assert.deepEqual(writes(api), []);
  } finally { await api.close(); }
});

test('normalizeRule collapses whitespace like the API', () => {
  assert.equal(normalizeRule('  a\n\n b\t c  '), 'a b c');
});

// ---- /spookling-rules: `spookling rules slash` (the typed text on stdin). Typing the command is the yes: nothing asks.

// the answer is collected through the injected write, never by swapping stdout (the test runner writes to stdout too)
async function slash(t, input, deps = {}) {
  let out = '';
  const code = await main(['node', 'spookling', 'rules', 'slash', ...(deps.flags ?? [])], { home: t.home, cwd: t.cwd, env: {}, tty: false, exit: () => {}, readStdin: async () => input, write: (s) => { out += s; }, ...deps });
  return { code, out };
}
const lastWrite = (api) => writes(api).at(-1);

test('parseSlash: the forms the command takes, and what each one means', async () => {
  const { parseSlash } = await import('../src/rules.js');
  assert.deepEqual(parseSlash(''), { mode: 'list', org: '' });
  assert.deepEqual(parseSlash('  \n'), { mode: 'list', org: '' });
  assert.deepEqual(parseSlash('--org Acme'), { mode: 'list', org: 'Acme' });
  assert.deepEqual(parseSlash('--org Acme Use tabs.'), { mode: 'add', org: 'Acme', text: 'Use tabs.' });
  assert.deepEqual(parseSlash('--org o1\nUse  tabs\n\nevery time.'), { mode: 'add', org: 'o1', text: 'Use tabs every time.' });
  assert.deepEqual(parseSlash('remove r_1'), { mode: 'remove', org: '', id: 'r_1' });
  assert.deepEqual(parseSlash('replace r_1 Use MVI.'), { mode: 'replace', org: '', id: 'r_1', text: 'Use MVI.' });
  assert.deepEqual(parseSlash('replace r_1\nUse MVI\nfor all UI.'), { mode: 'replace', org: '', id: 'r_1', text: 'Use MVI for all UI.' });
  // "remove" with more words is a new rule, not a removal
  assert.deepEqual(parseSlash('Remove the console logs.'), { mode: 'add', org: '', text: 'Remove the console logs.' });
  assert.match(parseSlash('replace r_1').error, /Give the new text/);
  assert.match(parseSlash('x'.repeat(301)).error, /at most 300 characters \(this one has 301\)/);
});

test('add: the text arrives as typed, is sent with via slash, and the answer is one plain line', async () => {
  const api = await fakeApi();
  try {
    const t = setup(api);
    const r = await slash(t, 'Always use tabs.\n');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`^Rule set \\(version 1\\): "Always use tabs\\." · project ${basename(t.cwd)} · org Acme\\. New AI sessions on this project start with it\\.\\n$`));
    assert.deepEqual(lastWrite(api).body, { text: 'Always use tabs.', via: 'slash' });
    assert.equal(lastWrite(api).url, `/memory/orgs/o1/projects/${t.key}/rules`);
  } finally { await api.close(); }
});

test('replace: sends the id, the version shown and via slash; the new text on the next line or the same one', async () => {
  const api = await fakeApi({ rules: [RULE('r_1', 'Use MVVM for all UI code.', 2)] });
  try {
    const t = setup(api);
    const a = await slash(t, 'replace r_1\nUse MVI for all UI code.\n');
    assert.equal(a.code, 0, a.out);
    assert.match(a.out, /^Rule r_1 replaced \(now version 3\): "Use MVI for all UI code\."/);
    assert.deepEqual(lastWrite(api).body, { text: 'Use MVI for all UI code.', via: 'slash', replaces: 'r_1', expectedVersion: 2 });
    const b = await slash(t, 'replace r_1 Use MVI.');
    assert.equal(b.code, 0, b.out);
    assert.equal(lastWrite(api).body.text, 'Use MVI.');
  } finally { await api.close(); }
});

test('remove: posts the version shown with via slash, and says the history stays', async () => {
  const api = await fakeApi({ rules: [RULE('r_1', 'Use MVVM for all UI code.', 2)] });
  try {
    const t = setup(api);
    const r = await slash(t, 'remove r_1');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^Rule r_1 removed: "Use MVVM for all UI code\." · project .* · org Acme\. Its history stays: spookling rules history r_1/m);
    assert.equal(lastWrite(api).url, `/memory/orgs/o1/projects/${t.key}/rules/r_1/remove`);
    assert.deepEqual(lastWrite(api).body, { expectedVersion: 2, via: 'slash' });
  } finally { await api.close(); }
});

test('an unknown id, a removed rule, and a replace without text change nothing', async () => {
  const api = await fakeApi({ rules: [RULE('r_1', 'Use MVVM.', 2)], removed: [RULE('r_9', 'Old rule.', 1, { status: 'removed' })] });
  try {
    const t = setup(api);
    const a = await slash(t, 'remove r_nope');
    assert.equal(a.code, 1); assert.match(a.out, /No rule r_nope in .* Nothing changed\./);
    const b = await slash(t, 'remove r_9');
    assert.equal(b.code, 1); assert.match(b.out, /already removed/);
    const c = await slash(t, 'replace r_nope new text');
    assert.equal(c.code, 1); assert.match(c.out, /No rule r_nope/);
    assert.deepEqual(writes(api), []);
  } finally { await api.close(); }
});

test('empty input lists the rules and writes nothing', async () => {
  const api = await fakeApi({ rules: [RULE('r_1', 'Use MVVM for all UI code.'), RULE('r_2', 'No new dependencies.', 1)] });
  try {
    const t = setup(api);
    const r = await slash(t, '\n');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Project rules for .* in Acme \(your only org\):\n  1\. Use MVVM for all UI code\.\n     r_1 · set by Ada/);
    assert.match(r.out, /2\. No new dependencies\./);
    assert.deepEqual(writes(api), []);
  } finally { await api.close(); }
});

test('several orgs and no default: nothing is written, the orgs are named, and the retry hint is --org <name>', async () => {
  const api = await fakeApi({ orgs: [ORG('o1', 'Acme'), ORG('o2', 'Beta')] });
  try {
    const t = setup(api);
    const r = await slash(t, 'Use tabs.');
    assert.equal(r.code, 1);
    assert.match(r.out, /several orgs \(Acme, Beta\)/);
    assert.match(r.out, /--org <name>/);
    assert.deepEqual(writes(api), []);
    const ok = await slash(t, '--org Beta Use tabs.');
    assert.equal(ok.code, 0, ok.out);
    assert.equal(lastWrite(api).url, `/memory/orgs/o2/projects/${t.key}/rules`);
  } finally { await api.close(); }
});

test('the --org flag works as well as the first line', async () => {
  const api = await fakeApi({ orgs: [ORG('o1', 'Acme'), ORG('o2', 'Beta')] });
  try {
    const t = setup(api);
    const r = await slash(t, 'Use tabs.', { flags: ['--org', 'Beta'] });
    assert.equal(r.code, 0, r.out);
    assert.equal(lastWrite(api).url, `/memory/orgs/o2/projects/${t.key}/rules`);
  } finally { await api.close(); }
});

test('each refusal from the server is one plain line with its reason, and nothing else', async () => {
  const cases = [
    [{ status: 409, code: 'CONFLICT', reason: 'rule_changed', rule: RULE('r_1', 'Use MVI.', 3) }, /Someone changed this rule since it was shown\. It now says: "Use MVI\." \(version 3, active\)/],
    [{ status: 409, code: 'CONFLICT', reason: 'rule_exists' }, /already exists in this project/],
    [{ status: 409, code: 'CONFLICT', reason: 'rule_unchanged' }, /already removed/],
    [{ status: 409, code: 'CONFLICT', reason: 'rule_limit' }, /20 active rules/],
    [{ status: 400, code: 'BAD', reason: 'rule_text' }, /1 to 300 characters/],
    [{ status: 404, code: 'NOT_FOUND' }, /No rule with that id/],
    [{ status: 403, code: 'FORBIDDEN', reason: 'web_only' }, /Only the Spookling web app/],
    [{ status: 403, code: 'FORBIDDEN' }, /not an active member of that org/],
  ];
  const { rulesSlash } = await import('../src/rules.js');
  for (const [fail, want] of cases) {
    const api = await fakeApi({ rules: [RULE('r_1', 'Use MVVM.', 2)] });
    try {
      const t = setup(api);
      api.state.fail = fail;
      const r = await rulesSlash({ input: 'remove r_1', cwd: t.cwd, home: t.home, env: {} });
      assert.equal(r.code, 1, fail.code);
      assert.match(r.text, want, fail.code);
      assert.doesNotMatch(r.text, /undefined|\[object|\n/, fail.code);
    } finally { await api.close(); }
  }
});

test('not logged in: the standard message, and no request', async () => {
  const api = await fakeApi();
  try {
    const t = setup(api, { login: false });
    const r = await slash(t, 'Use tabs.');
    assert.equal(r.code, 1);
    assert.match(r.out, /Not logged in\. Run `spookling login`, then try again\./);
    assert.deepEqual(api.state.seen, []);
  } finally { await api.close(); }
});

test('the home folder is not a project: a plain message and nothing written', async () => {
  const api = await fakeApi();
  try {
    const t = setup(api);
    const r = await slash(t, 'Use tabs.', { cwd: t.home });
    assert.equal(r.code, 1);
    assert.match(r.out, /not part of a project/);
    assert.deepEqual(writes(api), []);
  } finally { await api.close(); }
});

test('a server that does not take via "slash" yet: retried once with via cli, and the output says so', async () => {
  const api = await fakeApi();
  try {
    const t = setup(api);
    api.state.failVia = true;
    const r = await slash(t, 'Use tabs.');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^The server does not take via "slash" yet, so this was saved as a terminal change \(via cli\)\./);
    assert.match(r.out, /Rule set \(version 1\): "Use tabs\."/);
    assert.deepEqual(writes(api).map((w) => w.body.via), ['slash', 'cli']);
  } finally { await api.close(); }
});

test('a 400 that is not about via is not retried', async () => {
  const api = await fakeApi();
  try {
    const t = setup(api);
    api.state.fail = { status: 400, code: 'BAD', reason: 'rule_text' };
    const r = await slash(t, 'Use tabs.');
    assert.equal(r.code, 1);
    assert.equal(writes(api).length, 1);
  } finally { await api.close(); }
});

// The command file runs `spookling rules slash` in a fenced shell block with a quoted heredoc. Run that block through sh with a
// stand-in `spookling` that echoes its stdin, and the text must come out byte for byte (then parse back to the same rule).
test('the /spookling-rules shell block delivers quotes, apostrophes, substitutions, backticks, newlines and operators intact', { skip: process.platform === 'win32' }, async () => {
  const { rulesCommand } = await import('../src/hooks.js');
  const { parseSlash, normalizeRule } = await import('../src/rules.js');
  const { spawnSync } = await import('node:child_process');
  const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs');
  const block = /```!\n([\s\S]*?)\n```/.exec(rulesCommand());
  assert.ok(block, 'the command has one fenced ! block');
  const bin = tmpHome('spk-rules-bin-');
  mkdirSync(bin, { recursive: true });
  writeFileSync(`${bin}/spookling`, '#!/bin/sh\nif [ "$1" = rules ] && [ "$2" = slash ]; then cat; else echo "bad args: $*" >&2; exit 9; fi\n');
  chmodSync(`${bin}/spookling`, 0o755);
  const inputs = [
    "Don't use 'quotes' or \"double\" quotes.",
    'Write tests for $(whoami) and `date` and $HOME.',
    'Use ; and | and && and * and < and > and # and !',
    'Line one\nLine two\n\nLine four',
    'Keep the "$ARGUMENTS" text literal.',
    'end with a question?',
  ];
  for (const input of inputs) {
    const script = block[1].split('$ARGUMENTS').join(input);
    const r = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.status, 0, `${JSON.stringify(input)}: ${r.stderr}`);
    assert.equal(r.stdout, `${input}\n`, JSON.stringify(input));
    const parsed = parseSlash(r.stdout);
    assert.equal(parsed.mode, 'add', JSON.stringify(input));
    assert.equal(parsed.text, normalizeRule(input), JSON.stringify(input));
  }
  const empty = spawnSync('/bin/sh', ['-c', block[1].split('$ARGUMENTS').join('')], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(parseSlash(empty.stdout).mode, 'list');
});
