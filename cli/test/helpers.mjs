// Shared test helpers: temp folders that clean up after themselves, a tiny fake API server, and a hook runner.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const made = new Set();
let registered = false;

/** A fresh temp folder, removed when this test file's process exits (each file runs in its own process under `node --test`). */
export function tmpHome(prefix = 'spk-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.add(dir);
  if (!registered) {
    registered = true;
    process.on('exit', () => {
      for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
    });
  }
  return dir;
}

/** Start an HTTP server on a free loopback port; resolves to the listening server (port: server.address().port). */
export function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Answer with a JSON body and status, the shape the Spookling API uses. */
export function envelope(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json), ...headers });
  res.end(json);
}

/** Read a request body as JSON ({} when empty). */
export async function readReq(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/** Poll fn until it returns something truthy (resolves to it) or ms elapses (resolves to null). */
export async function waitFor(fn, ms = 4000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 40));
  }
  return null;
}

/** Run a hook script as Claude Code does: node, the hook JSON on stdin. Resolves { code, out, err, ms } once it exits. */
export function runHook(script, input, env) {
  const started = Date.now();
  const child = spawn(process.execPath, [script], { env });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, out, err, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(input));
  });
}

// Paths to the things the tests drive.
export const BIN = fileURLToPath(new URL('../../bin/spookling-memory.js', import.meta.url));
export const STOP = fileURLToPath(new URL('../../hooks/stop.js', import.meta.url));
export const CODEX = fileURLToPath(new URL('../../hooks/spookling-codex.cjs', import.meta.url));
export const UPLOADER = fileURLToPath(new URL('../../hooks/upload-session.cjs', import.meta.url));
export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const modeOf = (path) => statSync(path).mode & 0o777;

/** Run the detached uploader's own entry point in the foreground and wait for it to exit, so "nothing was sent" is checked after
 *  the upload really finished instead of after a fixed sleep. Same payload and env the Stop hook hands its detached child. */
export function runUploader(payload, env) {
  const child = spawn(process.execPath, [UPLOADER], { env: { ...env, SPOOKLING_UPLOAD_PAYLOAD: JSON.stringify(payload) }, stdio: 'ignore' });
  return new Promise((resolve) => child.on('close', resolve));
}

export const sampleLog = () => [
  JSON.stringify({
    seq: 50, hash: 'abc123hash', agent: 'claude-code', session_id: 'abc#0', turn_index: 0,
    role: 'user', ts: '2026-11-03T09:00:12Z', text: 'Make the sync idempotent',
  }),
  JSON.stringify({
    seq: 51, hash: 'abc123hash', agent: 'claude-code', session_id: 'abc#0', turn_index: 1,
    role: 'assistant', ts: '2026-11-03T09:00:40Z', text: 'Done.',
  }),
  JSON.stringify({
    seq: 52, hash: 'abc123hash', agent: 'claude-code', session_id: 'abc#2', turn_index: 0,
    role: 'user', ts: '2026-11-03T09:01:00Z', text: 'Ship it',
  }),
].join('\n') + '\n';

export function projectWithLog(home, raw = sampleLog()) {
  const project = join(home, 'spookling-memory');
  mkdirSync(join(project, '.memory'), { recursive: true });
  mkdirSync(join(project, '.git'), { recursive: true });
  const logPath = join(project, '.memory', 'log.jsonl');
  writeFileSync(logPath, raw);
  return { project, logPath, before: readFileSync(logPath) };
}

export function hookEnv(home, project, api) {
  return {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_PROJECT_DIR: project,
    SPOOKLING_API_URL: api,
    SPOOKLING_MEMORY_URL: 'http://127.0.0.1:9',
    PATH: process.env.PATH,
  };
}
