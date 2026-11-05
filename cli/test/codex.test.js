import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpHome } from './helpers.mjs';
import { addHooks, removeHooks, codexHandlers, codexHooksPath, CODEX_EVENTS } from '../src/hooks.js';
import { hooksJson } from '../src/wizard.js';

const plain = (m) => m.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim());
const hook = fileURLToPath(new URL('../../hooks/spookling-codex.cjs', import.meta.url));
const handlers = codexHandlers('/opt/spookling-memory/hooks', path.posix);
const run = (command, url, input, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, { shell: true, env: { ...process.env, SPOOKLING_MEMORY_URL: url, ...env } });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, out, err }));
  child.stdin.on('error', () => {});
  child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
});

test('Codex install/reinstall/uninstall preserves unrelated hooks, including shared groups', () => {
  const theirs = { type: 'command', command: 'echo existing' };
  const original = { note: 'keep', hooks: { Stop: [{ hooks: [theirs] }] } };
  const installed = addHooks(original, handlers);
  assert.deepEqual(addHooks(installed, handlers), installed);
  assert.deepEqual(removeHooks(installed), original);
  const old = addHooks(original, codexHandlers('/old/spookling-memory/hooks', path.posix));
  assert.deepEqual(addHooks(old, handlers), installed);
  assert.deepEqual(removeHooks({ hooks: { Stop: [{ hooks: [theirs, handlers.Stop] }] } }), { hooks: { Stop: [{ hooks: [theirs] }] } });
  assert.deepEqual(JSON.parse(hooksJson(handlers)), { hooks: Object.fromEntries(CODEX_EVENTS.map((ev) => [ev, [{ hooks: [handlers[ev]] }]])) });
  assert.equal(codexHooksPath('/project', 'project'), join('/project', '.codex', 'hooks.json'));
  assert.equal(codexHooksPath('/project', 'user', {}), join(homedir(), '.codex', 'hooks.json'));
  assert.equal(codexHooksPath('/project', 'user', { CODEX_HOME: '/custom' }), join('/custom', 'hooks.json'));
});

test('Codex shell commands quote paths; Windows uses a quoted native path', () => {
  assert.equal(codexHandlers('C:\\Users\\Jane O\'Neil\\spookling-memory\\hooks', path.win32).Stop.command,
    'node "C:\\Users\\Jane O\'Neil\\spookling-memory\\hooks\\spookling-codex.cjs"');
  assert.throws(() => codexHandlers('C:\\%PATH%\\hooks', path.win32), /Codex hook path/);
  for (const h of Object.values(handlers)) {
    assert.equal(h.statusMessage, '👻 Spookling memory');
    assert.equal(h.args, undefined, 'Codex must receive a shell command, not Claude exec form');
  }
  assert.equal(handlers.UserPromptSubmit.additionalContextLimit, 4000, 'recall must not spill to disk at the 2,500 token default');
  assert.equal(handlers.Stop.additionalContextLimit, undefined, 'only the event that returns context may set the limit');
});

test('real Codex command: health, recall, capture and compaction reuse the HTTP API with truthful ghost output', async () => {
  const dir = join(tmpHome('spk-codex-'), (process.platform === 'win32' ? "spookling's space" : "spookling's $pace `literal`"), 'hooks');
  mkdirSync(dir, { recursive: true });
  for (const f of ['spookling-codex.cjs', 'ghost.js', 'pulse.js']) copyFileSync(join(dirname(hook), f), join(dir, f));
  const hs = codexHandlers(dir), seen = [];
  let pulseHeader = JSON.stringify({ facts: 1, rules: 1, events: 0, chats: 0, chars: 22, cap: 10000 });
  let code = 200, response;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, body: body && JSON.parse(body) });
      res.writeHead(code, { 'content-type': 'application/json', ...(req.url.endsWith('user-prompt-submit') && pulseHeader ? { 'x-spookling-pulse': pulseHeader } : {}) });
      res.end(response ?? JSON.stringify(req.url === '/v1/stats'
        ? { n_events: 12, n_facts: 4, n_rules: 1, folder: '/project/.memory', tagger: { model: 'stub' } }
        : req.url.endsWith('user-prompt-submit') ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Remember metric units.' } } : {}));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const input = (ev) => ({ hook_event_name: ev, session_id: 's', prompt: 'What units?', transcript_path: '/chat.jsonl' });
  try {
    const start = await run(hs.SessionStart.command, url, input('SessionStart'));
    assert.equal(start.code, 0, start.err);
    const card = plain(JSON.parse(start.out).systemMessage);
    assert.equal(card[0], 'spookling ready · local server connected');
    for (const words of ['12 messages remembered', '4 facts in force · 1 standing rule', '/project/.memory']) {
      assert.ok(card.some((l) => l.endsWith(words)), `${words} in ${JSON.stringify(card)}`);
    }
    assert.ok(card.length > 8, 'the ghost under the words');
    const recall = JSON.parse((await run(hs.UserPromptSubmit.command, url, input('UserPromptSubmit'))).out);
    assert.equal(recall.hookSpecificOutput.additionalContext, 'Remember metric units.');
    const said = plain(recall.systemMessage);
    assert.equal(said[0], 'spookling active · 1 fact and 1 rule recalled', 'the counts the server sent');
    assert.ok(said.some((l) => l.endsWith('≈22 of the 10k characters of room')));
    for (const ev of ['Stop', 'PreCompact']) assert.deepEqual(await run(hs[ev].command, url, input(ev)), { code: 0, out: '', err: '' });
    assert.deepEqual(seen.map((r) => [r.method, r.url]), [
      ['GET', '/v1/stats'], ['POST', '/v1/hook/user-prompt-submit'], ['POST', '/v1/hook/stop'], ['POST', '/v1/hook/pre-compact'],
    ]);
    assert.ok(seen.slice(1).every((r) => r.body.harness === 'codex' && r.body.session_id === 's'));
    response = '{}';
    pulseHeader = null;
    const empty = JSON.parse((await run(hs.UserPromptSubmit.command, url, input('UserPromptSubmit'))).out).systemMessage;
    assert.deepEqual(plain(empty), ['spookling active · recall ran: nothing on record for this prompt'], 'one line, no ghost');
    assert.match(JSON.parse((await run(hs.SessionStart.command, url, input('SessionStart'))).out).systemMessage, /unavailable/);
    for (const failure of [503, 404]) {
      code = failure;
      const result = await run(hs.UserPromptSubmit.command, url, input('UserPromptSubmit'));
      assert.equal(result.code, 0);
      assert.match(JSON.parse(result.out).systemMessage, /unavailable/);
      assert.doesNotMatch(result.out, /ready|active|decision/);
      assert.equal((await run(hs.Stop.command, url, input('Stop'))).out, '');
    }
    code = 200;
    for (const bad of ['not json', '[]', 'null', '{"detail":"wrong response"}']) {
      response = bad;
      assert.match(JSON.parse((await run(hs.UserPromptSubmit.command, url, input('UserPromptSubmit'))).out).systemMessage, /unavailable/);
    }
    const count = seen.length;
    assert.equal((await run(hs.UserPromptSubmit.command, url, { hook_event_name: 'UserPromptSubmit', prompt: '' })).out, '');
    assert.equal((await run(hs.Stop.command, url, 'not json')).out, '');
    assert.equal((await run(hs.SessionStart.command, url, input('SessionStart'), { SPOOKLING_TAGGING: '1' })).out, '');
    assert.equal(seen.length, count, 'tagger calls and invalid input never contact the server');
  } finally { await new Promise((r) => srv.close(r)); }
  const offline = await run(hs.SessionStart.command, url, input('SessionStart'));
  assert.equal(offline.code, 0);
  assert.match(JSON.parse(offline.out).systemMessage, /unavailable/);
});

test('installed package: status and uninstall find Codex hooks in both scopes without granting trust', () => {
  const project = tmpHome('spk-codex-config-');
  const wizard = new URL('../src/wizard.js', import.meta.url).href;
  const hooks = new URL('../src/hooks.js', import.meta.url).href;
  const term = new URL('../src/term.js', import.meta.url).href;
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const script = `
    import assert from 'node:assert/strict';
    import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
    import { join, dirname } from 'node:path';
    import { status, uninstall, install, INSTALL_DIR, HOOKS_DIR } from ${JSON.stringify(wizard)};
    import { addHooks, codexHandlers, codexHooksPath } from ${JSON.stringify(hooks)};
    import { setFeed, press } from ${JSON.stringify(term)};
    const project = process.cwd();
    install(${JSON.stringify(root)}, INSTALL_DIR);
    assert.ok(existsSync(join(HOOKS_DIR, 'spookling-codex.cjs')));
    mkdirSync(join(project, '.memory'));
    writeFileSync(join(project, '.memory', 'CODEX-TODO.md'), 'not wired');
    const get = async () => ({ tagger: { model: 'stub', via: 'openrouter' } });
    assert.equal(await status(project, get), 1);
    for (const scope of ['project', 'user']) {
      const p = codexHooksPath(project, scope);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(addHooks({}, codexHandlers(HOOKS_DIR))));
      assert.equal(await status(project, get), 0);
      setFeed(() => { press('y'); press('\\r'); });
      assert.equal(await uninstall(project, { harness: 'codex', scope }), 0);
      assert.equal(await status(project, get), 1);
    }
    setFeed(null);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: project, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HOME: project, USERPROFILE: project, LOCALAPPDATA: project,
      CODEX_HOME: join(project, 'codex-home'), CLAUDE_CONFIG_DIR: join(project, 'claude-home'), NO_COLOR: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Codex \(configured/);
  assert.match(result.stdout, /not proof of trust or execution/);
});
