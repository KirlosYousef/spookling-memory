// After Stop: PUT the session and POST its turns. Detached from the hook so a down API cannot hold the user's session.
// Not logged in: do nothing. Never throws. Never writes stdout. log.jsonl is only read.
const { spawn } = require('node:child_process');
const { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { setTimeout: delay } = require('node:timers/promises');

function hasToken(env = process.env, home = homedir()) {
  if (typeof env.SPOOKLING_TOKEN === 'string' && env.SPOOKLING_TOKEN.length > 0) return true;
  try {
    const raw = JSON.parse(readFileSync(join(home, '.spookling', 'credentials.json'), 'utf8'));
    return typeof raw?.token === 'string' && raw.token.length > 0;
  } catch {
    return false;
  }
}

function libraryFile() {
  const candidates = [
    join(__dirname, 'lib', 'push.js'), // copied beside the hooks at init
    join(__dirname, '..', 'cli', 'src', 'push.js'), // this repo, before init copies it
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

// Project name for a folder. In a git repo: the repo root's name, unless that root is the home folder
// (a dotfiles repo), which falls through. Otherwise the folder's own name, except '' for the home
// folder, the filesystem root and a temp folder, which are not projects (no session named after the macOS user).
// Folders are compared by realpath, and case-insensitively on Windows.
function real(p, realpath = realpathSync) {
  let r = p;
  try { r = realpath(p); } catch { r = resolve(p); }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function notAProject(dir, { home = homedir(), tmp = tmpdir(), realpath = realpathSync } = {}) {
  const d = real(dir, realpath);
  if (dirname(d) === d) return true; // the filesystem root
  const temps = [tmp, '/tmp', '/private/tmp'].filter(Boolean);
  const candidates = [home, ...temps];
  for (const c of [...candidates]) { try { candidates.push(realpath(c)); } catch { /* not there */ } }
  if (candidates.some((c) => real(c, realpath) === d)) return true;
  return /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/[TC0]$/.test(d.replace(/\\/g, '/'));
}

const MAX_GIT_DEPTH = 24; // parent folders searched for .git: far deeper than any project, and it ends a symlink loop

function gitRoot(dir, exists = existsSync) {
  try {
    let d = dir;
    for (let i = 0; i < MAX_GIT_DEPTH && d; i += 1) {
      if (exists(join(d, '.git'))) return d;
      const parent = dirname(d);
      if (parent === d) break;
      d = parent;
    }
  } catch { /* no repo */ }
  return '';
}

function projectName(dir, exists = existsSync, home = homedir(), opts = {}) {
  if (!dir) return '';
  const root = gitRoot(dir, exists);
  const o = { home, ...opts };
  if (root && real(root, o.realpath) !== real(home, o.realpath)) return basename(root);
  return notAProject(dir, o) ? '' : basename(dir);
}

function projectFromSession(payload = {}, env = process.env, exists = existsSync, home = homedir(), opts = {}) {
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  const fromEnv = typeof env.CLAUDE_PROJECT_DIR === 'string' ? env.CLAUDE_PROJECT_DIR : '';
  return projectName(cwd, exists, home, opts) || projectName(fromEnv, exists, home, opts);
}

function note(home, message) {
  try {
    const dir = join(home, '.spookling');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, 'upload.log');
    appendFileSync(path, `${message}\n`);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  } catch { /* logging must not break the upload */ }
}

// Stop's HTTP reply returns before tagging appends log.jsonl. A session already on disk
// from an earlier Stop is not "done": wait until this Stop's lines go quiet, or the cap.
const POLL_MS = 200;
const SETTLE_MS = 1500;
const MAX_WAIT_MS = 30_000;
const FRESH_MS = 3000;

function num(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function sessionLineCount(text, sessionId) {
  if (!sessionId || !text) return 0;
  let n = 0;
  for (const line of String(text).split('\n')) {
    if (!line.includes(sessionId)) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const sid = typeof ev?.session_id === 'string' ? ev.session_id : '';
    const i = sid.indexOf('#');
    if ((i < 0 ? sid : sid.slice(0, i)) === sessionId) n += 1;
  }
  return n;
}

// Prefer the project log once it contains this session. Returns that path only after the
// session's line count has been still for settleMs, or when maxWaitMs runs out.
// A file just written (within freshMs) may settle immediately. An older file keeps waiting
// for a new append so a late tail is included. Past the cap, a later Stop uploads the rest.
async function waitForLog({
  paths,
  sessionId,
  readFile,
  exists,
  mtime,
  now = Date.now,
  sleep,
  settleMs = SETTLE_MS,
  maxWaitMs = MAX_WAIT_MS,
  pollMs = POLL_MS,
  freshMs = FRESH_MS,
} = {}) {
  if (!sessionId) return paths.find((p) => exists(p)) || null;
  const started = now();
  const deadline = started + maxWaitMs;
  let primed = false;
  let last = 0;
  let quietSince = null;
  let fallback = null;

  for (;;) {
    let hit = null;
    let count = 0;
    let hitMtime = 0;
    for (const p of paths) {
      if (!exists(p)) continue;
      if (!fallback) fallback = p;
      let text = '';
      try { text = readFile(p); } catch { continue; }
      const n = sessionLineCount(text, sessionId);
      if (n > 0) {
        hit = p;
        count = n;
        try { hitMtime = mtime(p); } catch { hitMtime = 0; }
        break;
      }
    }

    if (!primed) {
      primed = true;
      last = count;
      if (hit && hitMtime >= started - freshMs) quietSince = now();
    } else if (count !== last) {
      last = count;
      quietSince = count > 0 ? now() : null;
    } else if (hit && quietSince != null && now() - quietSince >= settleMs) {
      return hit;
    }

    if (now() >= deadline) return hit || fallback;
    const pause = Math.min(pollMs, Math.max(0, deadline - now()));
    await sleep(pause > 0 ? pause : pollMs);
  }
}

function resolveLog(projectDir, sessionId, env = process.env, deps = {}) {
  const ordered = [];
  if (projectDir) ordered.push(join(projectDir, '.memory', 'log.jsonl'));
  const homeLog = join(homedir(), '.memory', 'log.jsonl');
  if (!ordered.includes(homeLog)) ordered.push(homeLog);
  const readFile = deps.readFile || ((p) => readFileSync(p, 'utf8'));
  const exists = deps.exists || existsSync;
  const mtime = deps.mtime || ((p) => {
    try { return statSync(p).mtimeMs; } catch { return 0; }
  });
  return waitForLog({
    paths: ordered,
    sessionId,
    readFile,
    exists,
    mtime,
    now: deps.now,
    sleep: deps.sleep || delay,
    settleMs: num(env.SPOOKLING_UPLOAD_SETTLE_MS, SETTLE_MS),
    maxWaitMs: sessionId ? num(env.SPOOKLING_UPLOAD_MAX_WAIT_MS, MAX_WAIT_MS) : 0,
    pollMs: num(env.SPOOKLING_UPLOAD_POLL_MS, POLL_MS),
    freshMs: num(env.SPOOKLING_UPLOAD_FRESH_MS, FRESH_MS),
  });
}

async function uploadStoppedSession(payload = {}) {
  try {
    const env = process.env;
    const home = homedir();
    if (!hasToken(env, home)) return;
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
    const projectDir = cwd || env.CLAUDE_PROJECT_DIR || '';
    const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
    const logPath = await resolveLog(projectDir, sessionId, env);
    if (!logPath) return;
    const lib = libraryFile();
    if (!lib) return;
    const { teamMemoryHook } = await import(pathToFileURL(lib).href);
    const timeoutMs = Number(env.SPOOKLING_UPLOAD_TIMEOUT_MS);
    const fromLog = projectName(dirname(dirname(logPath)));
    await teamMemoryHook({
      logPath,
      home,
      env,
      sessionId,
      project: projectFromSession(payload, env) || fromLog,
      ...(timeoutMs > 0 ? { timeoutMs } : {}),
      log: (m) => note(home, m),
    });
  } catch { /* never throw out of the upload */ }
}

// SPOOKLING_UPLOAD_PAYLOAD holds only cwd and session_id: the detached uploader gets nothing else of the hook's input, no prompt text.
function startUpload(payload = {}) {
  try {
    if (!hasToken()) return;
    const body = JSON.stringify({
      cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
      session_id: typeof payload.session_id === 'string' ? payload.session_id : '',
    });
    const child = spawn(process.execPath, [__filename], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, SPOOKLING_UPLOAD_PAYLOAD: body },
    });
    child.on('error', () => {});
    child.unref();
  } catch { /* the session still ends */ }
}

if (require.main === module) {
  let payload = {};
  try { payload = JSON.parse(process.env.SPOOKLING_UPLOAD_PAYLOAD || '{}'); } catch { payload = {}; }
  uploadStoppedSession(payload).then(() => process.exit(0), () => process.exit(0));
}

module.exports = {
  hasToken, projectFromSession, projectName, resolveLog, sessionLineCount, startUpload, uploadStoppedSession, waitForLog,
};
