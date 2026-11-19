// Phase 4: cloud memory. The wizard's two paths, the shared cloud-retrieve client (budget, 401, offline, cache, shownIds),
// the hooks' fallback order, the session brief, status, and the MCP shell-out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envelope, listen, readReq, runHook, tmpHome } from './helpers.mjs';
import { ASK_BUDGET_MS, cloudBrief, cloudMode, cloudRetrieve, informative, installedMode, normalizeRemote, shownIds } from '../src/cloud-retrieve.js';
import { setFeed, press } from '../src/term.js';
import { MODES, detectInstall, newCtx, stepSmoke, stepTagger } from '../src/wizard.js';
import { CLOUD_HOOK_FILES, addHooks, hookHandlers, isOurs } from '../src/hooks.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PROMPT_HOOK = join(ROOT, 'hooks', 'user-prompt-submit.js');
const SESSION_HOOK = join(ROOT, 'hooks', 'session-start.js');
const CODEX_HOOK = join(ROOT, 'hooks', 'spookling-codex.cjs');
const INVOKE = join(ROOT, 'cli', 'src', 'cloud-retrieve-invoke.js');
const WIZARD = new URL('../src/wizard.js', import.meta.url).href;
// spawnSync would freeze this process, and the fake API with it
function run(cmd, args, { input: stdin, env, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(stdin ?? '');
  });
}
const QUESTION = 'Which database did we pick for the billing service?';

// A fake Spookling API. `answer(req)` decides each reply; every request is recorded (the body is parsed).
async function fakeApi(answer) {
  const seen = [];
  const srv = await listen(async (req, res) => {
    const body = req.method === 'POST' ? await readReq(req) : null;
    const r = { method: req.method, url: req.url, auth: req.headers.authorization, body };
    seen.push(r);
    const out = await answer(r);
    if (out === 'hang') return; // never answers
    envelope(res, out.status ?? 200, out.body ?? { success: true, data: out.data });
  });
  return { seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}
const ok = (extra = {}) => ({ data: { context: 'We chose Postgres for billing.', items: [{ id: 'm1', spaceId: 's', sid: 'x', seq: 3 }], tier: 'strong', status: 'ok', spaces: [{ id: 's', version: 2, kind: 'user' }], ...extra } });

// A logged-in home. mode: what install.json says ('cloud', 'keys' or null for no file).
function cloudHome({ api, mode = 'cloud', scope = 'user', project = null, user = { email: 'dev@acme.test' }, org = null } = {}) {
  const home = tmpHome('spk-cloud-');
  mkdirSync(join(home, '.spookling'), { recursive: true });
  writeFileSync(join(home, '.spookling', 'credentials.json'), JSON.stringify({ token: 'spk_testtoken', user, apiUrl: api, ...(org && { defaultOrgId: org.id, defaultOrgName: org.name, defaultOrgAt: { api, user: '' } }) }));
  if (mode) writeFileSync(join(home, '.spookling', 'install.json'), JSON.stringify({ installs: [{ harness: 'claude', scope, project, mode }] }));
  return home;
}
const workdir = () => { const d = tmpHome('spk-work-'); return d; };

// ---------------------------------------------------------------- the client-side filter and identity

test('informative: acknowledgements and slash commands are skipped, real questions are not', () => {
  for (const q of ['ok', 'thanks!', 'continue', 'yes do it', 'ok thanks', '/help', '', '   ', 'go ahead']) assert.equal(informative(q), false, q);
  for (const q of [QUESTION, 'what did we decide about auth?', 'fix the bug in src/api.js', 'refactor the payment retry logic']) assert.equal(informative(q), true, q);
});

test('normalizeRemote gives the API\'s git: key (host and path lowercased, no .git, no credentials)', () => {
  assert.equal(normalizeRemote('https://GitHub.com/Acme/Shop.git'), 'git:github.com/acme/shop');
  assert.equal(normalizeRemote('git@github.com:acme/shop.git'), 'git:github.com/acme/shop');
  assert.equal(normalizeRemote('ssh://git@host.io:2222/a/b/c'), 'git:host.io/a/b/c');
  assert.equal(normalizeRemote(''), null);
  assert.equal(normalizeRemote('/local/path'), null);
});

test('installedMode / cloudMode: install.json (user scope, or a project the folder is inside) plus a login', () => {
  const work = workdir();
  const user = cloudHome({ api: 'http://127.0.0.1:9' });
  assert.equal(installedMode({ home: user, cwd: work, env: {} }), 'cloud');
  assert.equal(cloudMode({ home: user, cwd: work, env: {} }), true);
  assert.equal(cloudMode({ home: user, cwd: work, env: { SPOOKLING_MODE: 'local' } }), false);
  const proj = cloudHome({ api: 'http://127.0.0.1:9', scope: 'project', project: work });
  assert.equal(cloudMode({ home: proj, cwd: join(work, 'sub'), env: {} }), true);
  assert.equal(cloudMode({ home: proj, cwd: tmpHome('spk-other-'), env: {} }), false, 'another folder');
  assert.equal(cloudMode({ home: cloudHome({ api: 'http://127.0.0.1:9', mode: 'keys' }), cwd: work, env: {} }), false);
  assert.equal(cloudMode({ home: cloudHome({ api: 'http://127.0.0.1:9', mode: null }), cwd: work, env: {} }), false);
  const out = tmpHome('spk-nologin-');
  mkdirSync(join(out, '.spookling'));
  writeFileSync(join(out, '.spookling', 'install.json'), JSON.stringify({ installs: [{ harness: 'claude', scope: 'user', mode: 'cloud' }] }));
  assert.equal(cloudMode({ home: out, cwd: work, env: {} }), false, 'no token');
  assert.equal(installedMode({ home: out, cwd: work, env: {} }), 'cloud');
});

// ---------------------------------------------------------------- cloudRetrieve

test('cloudRetrieve: sends the contract request with the pinned token, answers context and items, marks them shown', async () => {
  const api = await fakeApi(() => ok());
  try {
    const home = cloudHome({ api: api.url }), cwd = workdir();
    const r = await cloudRetrieve({ question: QUESTION, cwd, sessionId: 's1', home, env: {} });
    assert.equal(r.context, 'We chose Postgres for billing.');
    assert.deepEqual(r.items.map((i) => i.id), ['m1']);
    assert.equal(r.status, 'ok');
    assert.equal(api.seen.length, 1);
    const [req] = api.seen;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/memory/retrieve');
    assert.equal(req.auth, 'Bearer spk_testtoken');
    assert.equal(req.body.mode, 'prompt');
    assert.equal(req.body.question, QUESTION);
    assert.equal(req.body.sessionId, 's1');
    assert.match(req.body.projectKey, /^dir:spk-work-/);
    assert.ok(Number.isFinite(Date.parse(req.body.clientTs)));
    assert.deepEqual(shownIds(home, 's1'), ['s|m1']);
    // another question in the same session carries what was shown
    await cloudRetrieve({ question: 'And what about the invoice numbering scheme?', cwd, sessionId: 's1', home, env: {} });
    assert.deepEqual(api.seen[1].body.shownIds, ['s|m1']);
  } finally { await api.close(); }
});

test('cloudRetrieve: shown ids are scoped to their space and never exceed what the API accepts (200)', async () => {
  // two spaces both have an f1: seeing one must not hide the other, and more than 200 ids is a 400 for every later prompt
  let call = 0;
  const api = await fakeApi(() => { call++; return ok({ items: Array.from({ length: 120 }, (_, i) => ({ id: `f${i}`, spaceId: (i + call) % 2 ? 'org/o/dir:x' : 'user/u/dir:x', sid: 'x', seq: i })) }); });
  try {
    const home = cloudHome({ api: api.url }), cwd = workdir();
    await cloudRetrieve({ question: QUESTION, cwd, sessionId: 's9', home, env: {} });
    await cloudRetrieve({ question: 'A second, different question about invoices?', cwd, sessionId: 's9', home, env: {} });
    await cloudRetrieve({ question: 'A third, different question about refunds?', cwd, sessionId: 's9', home, env: {} });
    const sent = api.seen[2].body.shownIds;
    assert.ok(shownIds(home, 's9').length > 200, 'the local record keeps more than the API takes');
    assert.equal(sent.length, 200);
    assert.ok(sent.every((i) => /^(user|org)\/[uo]\/dir:x\|f\d+$/.test(i)));
    const both = shownIds(home, 's9').filter((i) => i.endsWith('|f1'));
    assert.deepEqual(both.sort(), ['org/o/dir:x|f1', 'user/u/dir:x|f1']); // the same bare id in two spaces stays two entries
  } finally { await api.close(); }
});

test('cloudRetrieve: a repeat of the same prompt within 60 s is answered from the cache, then asked again after it', async () => {
  const api = await fakeApi(() => ok());
  try {
    const home = cloudHome({ api: api.url }), cwd = workdir();
    let t = 1_000_000;
    const ask = (q = QUESTION) => cloudRetrieve({ question: q, cwd, home, env: {}, now: () => t });
    assert.equal((await ask()).cached, false);
    t += 30_000;
    const again = await ask(`  ${QUESTION.toUpperCase()}  `); // same words, other case and spacing
    assert.equal(again.cached, true);
    assert.equal(again.context, 'We chose Postgres for billing.');
    assert.equal(api.seen.length, 1);
    await ask('A different question about the retry policy?');
    assert.equal(api.seen.length, 2);
    t += 61_000;
    assert.equal((await ask()).cached, false);
    assert.equal(api.seen.length, 3);
    assert.doesNotMatch(readFileSync(join(home, '.spookling', 'cloud-cache.json'), 'utf8'), /billing service/, 'the question text is never stored, only its hash');
  } finally { await api.close(); }
});

test('cloudRetrieve: the cache is per session (an answer cut by one session\'s shown ids is not another session\'s)', async () => {
  const api = await fakeApi(() => ok());
  try {
    const home = cloudHome({ api: api.url }), cwd = workdir();
    await cloudRetrieve({ question: QUESTION, cwd, sessionId: 'a', home, env: {} });
    assert.equal((await cloudRetrieve({ question: QUESTION, cwd, sessionId: 'b', home, env: {} })).cached, false);
    assert.equal((await cloudRetrieve({ question: QUESTION, cwd, sessionId: 'a', home, env: {} })).cached, true);
    assert.equal(api.seen.length, 2);
  } finally { await api.close(); }
});

test('cloudRetrieve: null, and no request, for an uninformative prompt, a folder not in cloud mode, or a logged-out machine', async () => {
  const api = await fakeApi(() => ok());
  try {
    const cwd = workdir();
    assert.equal(await cloudRetrieve({ question: 'ok thanks', cwd, home: cloudHome({ api: api.url }), env: {} }), null);
    assert.equal(await cloudRetrieve({ question: QUESTION, cwd, home: cloudHome({ api: api.url, mode: 'keys' }), env: {} }), null);
    const out = tmpHome('spk-out-');
    assert.equal(await cloudRetrieve({ question: QUESTION, cwd, home: out, env: {} }), null);
    assert.equal(api.seen.length, 0);
    // "ask" mode (the MCP tool) is an explicit question: no word filter
    assert.ok(await cloudRetrieve({ mode: 'ask', question: 'ok', cwd, home: cloudHome({ api: api.url }), env: {} }));
  } finally { await api.close(); }
});

test('cloudRetrieve: 401, 5xx, a degraded or unavailable engine, and an engine with a bad body all answer null', async () => {
  const cwd = workdir();
  for (const reply of [{ status: 401, body: { success: false, error: { code: 'UNAUTHORIZED' } } }, { status: 503, body: { success: false, error: { code: 'DOWN' } } },
    ok({ status: 'degraded' }), ok({ status: 'unavailable' }), { status: 200, body: 'nope' }]) {
    const api = await fakeApi(() => reply);
    try { assert.equal(await cloudRetrieve({ question: QUESTION, cwd, home: cloudHome({ api: api.url }), env: {} }), null, JSON.stringify(reply).slice(0, 60)); } finally { await api.close(); }
  }
});

test('cloudRetrieve: offline (nothing listening) is null, quickly', async () => {
  const dead = await fakeApi(() => ok());
  const url = dead.url;
  await dead.close();
  const started = Date.now();
  assert.equal(await cloudRetrieve({ question: QUESTION, cwd: workdir(), home: cloudHome({ api: url }), env: {} }), null);
  assert.ok(Date.now() - started < 1800);
});

test('cloudRetrieve: a hard total budget, from the argument or SPOOKLING_CLOUD_BUDGET_MS, then null', async () => {
  const api = await fakeApi(() => 'hang');
  try {
    const home = cloudHome({ api: api.url }), cwd = workdir();
    let started = Date.now();
    assert.equal(await cloudRetrieve({ question: QUESTION, cwd, home, env: {}, budgetMs: 300 }), null);
    let took = Date.now() - started;
    assert.ok(took >= 250 && took < 1200, `budget argument: ${took} ms`);
    started = Date.now();
    assert.equal(await cloudRetrieve({ question: QUESTION, cwd, home, env: { SPOOKLING_CLOUD_BUDGET_MS: '250' } }), null);
    took = Date.now() - started;
    assert.ok(took >= 200 && took < 1200, `env budget: ${took} ms`);
    assert.ok(ASK_BUDGET_MS > 1800);
  } finally { await api.close(); }
});

test('cloudRetrieve: a refused redirect (the token must not follow it) is null', async () => {
  const other = await fakeApi(() => ok());
  const api = await listen((req, res) => { res.writeHead(307, { location: `${other.url}/memory/retrieve` }); res.end(); });
  try {
    const url = `http://127.0.0.1:${api.address().port}`;
    assert.equal(await cloudRetrieve({ question: QUESTION, cwd: workdir(), home: cloudHome({ api: url }), env: {} }), null);
    assert.equal(other.seen.length, 0);
  } finally { api.closeAllConnections?.(); await new Promise((r) => api.close(r)); await other.close(); }
});

// ---------------------------------------------------------------- the session brief

test('cloudBrief: GET /memory/context with the project key, only for status ok, once per session', async () => {
  let reply = { data: { brief: 'Building the billing service. Postgres chosen.', status: 'ok' } };
  const api = await fakeApi(() => reply);
  try {
    const home = cloudHome({ api: api.url }), cwd = workdir();
    assert.equal(await cloudBrief({ cwd, sessionId: 'a', home, env: {} }), 'Building the billing service. Postgres chosen.');
    assert.equal(api.seen[0].method, 'GET');
    assert.match(api.seen[0].url, /^\/memory\/context\?projectKey=dir%3Aspk-work-/);
    assert.equal(api.seen[0].auth, 'Bearer spk_testtoken');
    assert.equal(await cloudBrief({ cwd, sessionId: 'a', home, env: {} }), null, 'the same session is briefed once');
    assert.equal(api.seen.length, 1);
    assert.ok(await cloudBrief({ cwd, sessionId: 'b', home, env: {} }), 'another session');
    reply = { data: { brief: 'x', status: 'unavailable' } };
    assert.equal(await cloudBrief({ cwd, sessionId: 'c', home, env: {} }), null);
    reply = { status: 500, body: { success: false } };
    assert.equal(await cloudBrief({ cwd, sessionId: 'd', home, env: {} }), null);
    assert.equal(await cloudBrief({ cwd, sessionId: 'e', home: cloudHome({ api: api.url, mode: 'keys' }), env: {} }), null);
  } finally { await api.close(); }
});

// ---------------------------------------------------------------- the hooks: cloud first, then the local server, then nothing

// A fake local memory server (the engine's hook endpoint)
async function fakeLocal() {
  const seen = [];
  const srv = await listen(async (req, res) => {
    await readReq(req);
    seen.push(req.url);
    envelope(res, 200, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'LOCAL: metric units.' } });
  });
  return { seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}
const hookEnv = (home, work, api, local) => ({ HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: work, SPOOKLING_API_URL: api, SPOOKLING_MEMORY_URL: local, PATH: process.env.PATH });
const input = (extra = {}) => ({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: undefined, prompt: QUESTION, ...extra });

test('UserPromptSubmit in cloud mode: the cloud answers and the local server is never asked', async () => {
  const api = await fakeApi(() => ok()), local = await fakeLocal();
  try {
    const home = cloudHome({ api: api.url }), work = workdir();
    const r = await runHook(PROMPT_HOOK, input({ cwd: work }), hookEnv(home, work, api.url, local.url));
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(out.hookSpecificOutput.additionalContext, /^We chose Postgres for billing\./);
    assert.match(out.hookSpecificOutput.additionalContext, /Spookling session: sess-1/);
    assert.match(out.systemMessage, /1 item from your cloud memory/);
    assert.deepEqual(local.seen, []);
    assert.equal(api.seen.length, 1);
  } finally { await api.close(); await local.close(); }
});

test('UserPromptSubmit in cloud mode: a 401, an unavailable engine, a timeout or an uninformative prompt fall through to the local server', async () => {
  const local = await fakeLocal();
  try {
    const work = workdir();
    const cases = [
      ['401', { status: 401, body: { success: false, error: { code: 'UNAUTHORIZED' } } }, QUESTION, 1],
      ['unavailable', ok({ status: 'unavailable' }), QUESTION, 1],
      ['hang', 'hang', QUESTION, 1],
      ['uninformative', ok(), 'ok thanks', 0],
    ];
    for (const [name, reply, prompt, calls] of cases) {
      const api = await fakeApi(() => reply);
      try {
        local.seen.length = 0;
        const started = Date.now();
        const r = await runHook(PROMPT_HOOK, input({ cwd: work, prompt }), { ...hookEnv(cloudHome({ api: api.url }), work, api.url, local.url), SPOOKLING_CLOUD_BUDGET_MS: '400' });
        assert.equal(r.code, 0, name);
        assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /LOCAL: metric units\./, name);
        assert.deepEqual(local.seen, ['/v1/hook/user-prompt-submit'], name);
        assert.equal(api.seen.length, calls, name);
        assert.ok(Date.now() - started < 4000, `${name}: not blocked`);
      } finally { await api.close(); }
    }
  } finally { await local.close(); }
});

test('UserPromptSubmit in cloud mode with the cloud down and no local server: no error, only the session line', async () => {
  const dead = await fakeApi(() => ok());
  const url = dead.url;
  await dead.close();
  const work = workdir();
  const r = await runHook(PROMPT_HOOK, input({ cwd: work }), hookEnv(cloudHome({ api: url }), work, url, 'http://127.0.0.1:9'));
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.deepEqual(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Spookling session: sess-1' } });
});

test('UserPromptSubmit outside cloud mode never contacts the cloud', async () => {
  const api = await fakeApi(() => ok()), local = await fakeLocal();
  try {
    const work = workdir();
    const r = await runHook(PROMPT_HOOK, input({ cwd: work }), hookEnv(cloudHome({ api: api.url, mode: 'keys' }), work, api.url, local.url));
    assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /LOCAL/);
    assert.equal(api.seen.length, 0);
  } finally { await api.close(); await local.close(); }
});

test('the .sh variant hands a cloud-mode install to the node hook', { skip: process.platform === 'win32' }, async () => {
  const api = await fakeApi(() => ok());
  try {
    const home = cloudHome({ api: api.url }), work = workdir();
    const r = await run('bash', [join(ROOT, 'hooks', 'user-prompt-submit.sh')], { input: JSON.stringify(input({ cwd: work })), env: hookEnv(home, work, api.url, 'http://127.0.0.1:9') });
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /^We chose Postgres/);
  } finally { await api.close(); }
});

test('Claude Code SessionStart hook: the brief once per session, nothing otherwise', async () => {
  let reply = { data: { brief: 'Building billing. Decided: Postgres.', status: 'ok' } };
  const api = await fakeApi(() => reply);
  try {
    const home = cloudHome({ api: api.url }), work = workdir();
    const env = hookEnv(home, work, api.url, 'http://127.0.0.1:9');
    const start = (id) => runHook(SESSION_HOOK, { hook_event_name: 'SessionStart', session_id: id, cwd: work, source: 'startup' }, env);
    const first = await start('s1');
    assert.equal(first.code, 0, first.err);
    assert.deepEqual(JSON.parse(first.out).hookSpecificOutput, { hookEventName: 'SessionStart', additionalContext: 'Building billing. Decided: Postgres.' });
    assert.equal((await start('s1')).out, '', 'the same session again');
    reply = { data: { status: 'unavailable' } };
    assert.equal((await start('s2')).out, '', 'a brief that is not ready');
  } finally { await api.close(); }
});

test('Codex hook in cloud mode: prompt from the cloud, brief at SessionStart, local server last, silence when none', async () => {
  let reply = ok();
  const api = await fakeApi((r) => (r.url.startsWith('/memory/context') ? { data: { brief: 'Brief for Codex.', status: 'ok' } } : reply));
  const local = await fakeLocal();
  try {
    const home = cloudHome({ api: api.url }), work = workdir();
    const env = hookEnv(home, work, api.url, local.url);
    const codexInput = (ev, extra = {}) => ({ hook_event_name: ev, session_id: 'cx1', cwd: work, prompt: QUESTION, transcript_path: '/chat.jsonl', ...extra });
    const start = await runHook(CODEX_HOOK, codexInput('SessionStart'), env);
    const s = JSON.parse(start.out);
    assert.deepEqual(s.hookSpecificOutput, { hookEventName: 'SessionStart', additionalContext: 'Brief for Codex.' });
    const prompt = JSON.parse((await runHook(CODEX_HOOK, codexInput('UserPromptSubmit'), env)).out);
    assert.equal(prompt.hookSpecificOutput.additionalContext, 'We chose Postgres for billing.');
    assert.match(prompt.systemMessage, /recalled from your cloud memory/);
    assert.deepEqual(local.seen, [], 'the local server is not asked while the cloud answers');
    // cloud unavailable: the local server answers
    reply = ok({ status: 'unavailable' });
    const fall = JSON.parse((await runHook(CODEX_HOOK, codexInput('UserPromptSubmit', { prompt: 'How do we deploy the worker to staging?' }), env)).out);
    assert.equal(fall.hookSpecificOutput.additionalContext, 'LOCAL: metric units.');
    // both down: nothing, no error
    const bothDown = await runHook(CODEX_HOOK, codexInput('UserPromptSubmit', { prompt: 'Explain the retry policy for webhooks please' }), { ...env, SPOOKLING_MEMORY_URL: 'http://127.0.0.1:9', SPOOKLING_API_URL: 'http://127.0.0.1:9' });
    assert.deepEqual([bothDown.code, bothDown.out, bothDown.err], [0, '', '']);
  } finally { await api.close(); await local.close(); }
});

// ---------------------------------------------------------------- the wizard's first question, with fake prompts

const answer = (map) => setFeed(({ kind, q }) => {
  const hit = Object.entries(map).find(([re]) => new RegExp(re).test(q));
  const keys = hit ? hit[1] : kind === 'confirm' ? 'y' : '';
  press(`${keys}\r`);
});
const quiet = async (fn) => { const w = process.stdout.write.bind(process.stdout); process.stdout.write = (c, ...rest) => (typeof c === 'string' ? true : w(c, ...rest)); try { return await fn(); } finally { process.stdout.write = w; } };

test('the first question offers the plan login first and the API keys second', () => {
  assert.deepEqual(MODES, ['Log in to Spookling and use your plan (recommended)', 'Enter API keys (as today)']);
});

test('wizard, cloud path: runs the device login, asks for no key, writes no keys.env, no local tagger', async () => {
  const home = tmpHome('spk-wiz-'), project = join(home, 'proj');
  mkdirSync(project, { recursive: true });
  const ctx = { ...newCtx(project), home };
  const calls = [];
  ctx.login = async (opts) => {
    calls.push(opts);
    mkdirSync(join(home, '.spookling'), { recursive: true });
    writeFileSync(join(home, '.spookling', 'credentials.json'), JSON.stringify({ token: 'spk_new', user: { email: 'dev@acme.test' } }));
    return 0;
  };
  answer({ 'build memory': '1' });
  try { await quiet(() => stepTagger(ctx)); } finally { setFeed(null); }
  assert.equal(ctx.mode, 'cloud');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].home, home);
  assert.deepEqual(ctx.problems, []);
  assert.equal(ctx.model, null);
  assert.equal(ctx.decider, null);
  assert.deepEqual(ctx.keys, {});
  assert.equal(existsSync(join(project, '.memory')), false, 'no .memory, so no keys.env and no .gitignore');
});

test('wizard, cloud path: already logged in means no second login; a login that fails is a problem', async () => {
  const home = cloudHome({ api: 'http://127.0.0.1:9', mode: null }), project = join(home, 'proj');
  mkdirSync(project, { recursive: true });
  const ctx = { ...newCtx(project), home, login: async () => { throw new Error('must not log in again'); } };
  answer({ 'build memory': '1' });
  try { await quiet(() => stepTagger(ctx)); } finally { setFeed(null); }
  assert.deepEqual([ctx.mode, ctx.problems], ['cloud', []]);

  const bare = tmpHome('spk-wiz-'), proj2 = join(bare, 'proj');
  mkdirSync(proj2, { recursive: true });
  const failing = { ...newCtx(proj2), home: bare, login: async () => 1 };
  answer({ 'build memory': '1' });
  try { await quiet(() => stepTagger(failing)); } finally { setFeed(null); }
  assert.equal(failing.mode, 'cloud');
  assert.deepEqual(failing.problems, ['cloud login did not finish']);
});

test('wizard, API-key path: unchanged. The tagger menu, the key prompt, keys.env, and no login', async () => {
  const home = tmpHome('spk-wiz-'), project = join(home, 'proj');
  mkdirSync(project, { recursive: true });
  const ctx = { ...newCtx(project), home, login: async () => { throw new Error('the key path never logs in'); } };
  const keep = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  setFeed(({ kind, q }) => {
    if (/build memory/.test(q)) return press('2\r');
    if (/tagger/.test(q)) return press('1\r');
    if (kind === 'hidden') return [...'sk-or-v1-testkey000000000000', '\r'].forEach(press);
    return press('y\r');
  });
  try { await quiet(() => stepTagger(ctx)); } finally { setFeed(null); if (keep !== undefined) process.env.OPENROUTER_API_KEY = keep; }
  assert.equal(ctx.mode, 'keys');
  assert.deepEqual(ctx.problems, []);
  assert.equal(ctx.model, 'typesafe/jev-router');
  assert.match(readFileSync(join(project, '.memory', 'keys.env'), 'utf8'), /^OPENROUTER_API_KEY=sk-or-v1-testkey/);
});

test('wizard, unattended (update): the saved mode decides; cloud without a login is a problem, never a prompt', async () => {
  const bare = tmpHome('spk-wiz-'), project = join(bare, 'proj');
  mkdirSync(project, { recursive: true });
  const ctx = { ...newCtx(project), home: bare, auto: { home: bare, tagger: 0, mode: 'cloud' }, login: async () => { throw new Error('no prompt, no login'); } };
  await quiet(() => stepTagger(ctx));
  assert.deepEqual([ctx.mode, ctx.problems], ['cloud', ['not logged in']]);
  const loggedIn = cloudHome({ api: 'http://127.0.0.1:9', mode: null });
  const ok2 = { ...newCtx(project), home: loggedIn, auto: { home: loggedIn, tagger: 0, mode: 'cloud' } };
  await quiet(() => stepTagger(ok2));
  assert.deepEqual([ok2.mode, ok2.problems], ['cloud', []]);
});

test('wizard smoke test in cloud mode asks the API with the token, not a local server', async () => {
  const api = await fakeApi(() => ({ data: { orgs: [{ id: 'o1', name: 'Acme' }] } }));
  try {
    const home = cloudHome({ api: api.url, mode: 'cloud', org: { id: 'o1', name: 'Acme' } });
    const good = { ...newCtx(workdir()), home, mode: 'cloud' };
    await quiet(() => stepSmoke(good));
    assert.deepEqual(good.problems, []);
    assert.deepEqual(api.seen.map((r) => [r.method, r.url, r.auth]), [['GET', '/cli/orgs', 'Bearer spk_testtoken']]);
  } finally { await api.close(); }
  const rejecting = await fakeApi(() => ({ status: 401, body: { success: false, error: { code: 'UNAUTHORIZED' } } }));
  try {
    const bad = { ...newCtx(workdir()), home: cloudHome({ api: rejecting.url }), mode: 'cloud' };
    await quiet(() => stepSmoke(bad));
    assert.deepEqual(bad.problems, ['cloud smoke test failed']);
  } finally { await rejecting.close(); }
});

test('Claude Code gets a SessionStart hook in cloud mode only, and uninstall recognises it as ours', () => {
  const dir = '/opt/spookling-memory/0.2.3/hooks';
  const local = hookHandlers(dir), cloud = hookHandlers(dir, undefined, { cloud: true });
  assert.equal('SessionStart' in local, false);
  assert.deepEqual(Object.keys(cloud).sort(), [...Object.keys(local), ...Object.keys(CLOUD_HOOK_FILES)].sort());
  assert.deepEqual(cloud.SessionStart.args, [join(dir, 'session-start.js')]);
  assert.ok(isOurs(cloud.SessionStart));
  assert.deepEqual(Object.keys(addHooks({}, cloud).hooks).sort(), Object.keys(cloud).sort());
});

// ---------------------------------------------------------------- status and update detection

function statusIn(home, project) {
  const script = `import { status } from ${JSON.stringify(WIZARD)};
    process.exitCode = await status(${JSON.stringify(project)}, async () => null, ${JSON.stringify(home)}, { noUpdate: true });`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 30000, cwd: project,
    env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), NO_COLOR: '1' },
  });
}

test('status in cloud mode: "mode: cloud, logged in as X, org Y", and no tagger or keys complaints', () => {
  const home = cloudHome({ api: 'https://api.example.test', org: { id: 'o1', name: 'Acme' }, user: { email: 'dev@acme.test', id: 'u1' } });
  // credentials carry the org only for this api and user, so write it the way setDefaultOrg does
  const file = join(home, '.spookling', 'credentials.json');
  const creds = JSON.parse(readFileSync(file, 'utf8'));
  creds.defaultOrgAt = { api: 'https://api.example.test', user: 'u1' };
  creds.user = { email: 'dev@acme.test', id: 'u1' };
  writeFileSync(file, JSON.stringify(creds));
  const project = join(home, 'proj');
  mkdirSync(project);
  const r = statusIn(home, project);
  assert.match(r.stdout, /✓ mode\s+cloud, logged in as dev@acme\.test, org Acme/, r.stdout + r.stderr);
  assert.match(r.stdout, /server\s+not running \(cloud mode does not need it\)/);
  assert.doesNotMatch(r.stdout, /tagger|keys/);
});

test('status in cloud mode while logged out says so', () => {
  const home = cloudHome({ api: 'https://api.example.test' });
  writeFileSync(join(home, '.spookling', 'credentials.json'), JSON.stringify({}));
  const project = join(home, 'proj');
  mkdirSync(project);
  assert.match(statusIn(home, project).stdout, /! mode\s+cloud, not logged in/);
});

test('status in key mode is unchanged: no mode line', () => {
  const home = cloudHome({ api: 'https://api.example.test', mode: 'keys' });
  const project = join(home, 'proj');
  mkdirSync(project);
  const out = statusIn(home, project).stdout;
  assert.doesNotMatch(out, /\bmode\b/);
  assert.match(out, /tagger/);
});

test('detectInstall carries the saved mode, so update repeats it', async () => {
  const home = tmpHome('spk-detect-'), project = tmpHome('spk-proj-');
  const keep = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.CLAUDE_CONFIG_DIR;
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(addHooks({}, hookHandlers(join(home, '.spookling-memory', '0.2.2', 'hooks')))));
    mkdirSync(join(home, '.spookling'), { recursive: true });
    writeFileSync(join(home, '.spookling', 'install.json'), JSON.stringify({ installs: [{ harness: 'claude', scope: 'user', project: null, ghost: false, mode: 'cloud', tagger: 0, start: false }] }));
    const d = await detectInstall({ project, home, probe: async () => null });
    assert.deepEqual(d.targets.map((t) => [t.harness, t.scope, t.mode]), [['claude', 'user', 'cloud']]);
    writeFileSync(join(home, '.spookling', 'install.json'), JSON.stringify({ installs: [{ harness: 'claude', scope: 'user', project: null, ghost: false, tagger: 0, start: false }] }));
    assert.equal((await detectInstall({ project, home, probe: async () => null })).targets[0].mode, 'keys', 'an install from before cloud mode');
  } finally { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

// ---------------------------------------------------------------- the MCP shell-out

test('cloud-retrieve-invoke.js: one JSON line the Python MCP server reads; null when the cloud has nothing', async () => {
  let reply = ok();
  const api = await fakeApi(() => reply);
  try {
    const home = cloudHome({ api: api.url }), work = workdir();
    const invoke = (arg = JSON.stringify({ question: 'ok', cwd: work }), h = home) => run(process.execPath, [INVOKE, arg], { env: { PATH: process.env.PATH, HOME: h, USERPROFILE: h } });
    const first = await invoke();
    assert.equal(first.status, 0, first.stderr);
    const out = JSON.parse(first.stdout);
    assert.equal(out.context, 'We chose Postgres for billing.');
    assert.equal(api.seen[0].body.mode, 'ask');
    assert.equal(api.seen[0].auth, 'Bearer spk_testtoken');
    reply = ok({ status: 'unavailable' });
    assert.equal(JSON.parse((await invoke()).stdout).cached, true, 'the same question again: the 60 s cache');
    assert.equal((await invoke(JSON.stringify({ question: 'a different question', cwd: work }))).stdout, 'null');
    assert.equal((await invoke('not json', tmpHome('spk-x-'))).stdout, 'null');
  } finally { await api.close(); }
});
