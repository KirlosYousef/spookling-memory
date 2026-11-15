// Cloud memory for the hooks and the MCP tool: one retrieval from the Spookling API inside a hard time budget.
// A thin client. The engine runs in the cloud; this only asks, caches a repeat for a minute and remembers which items a session saw.
// Every failure (offline, timeout, 401, an engine that is down or degraded) answers null so the caller falls back. Never throws,
// never logs the question, never blocks the agent for longer than the budget.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createCloud } from './cloud.js';
import { readCredentials, writeFileSecure } from './credentials.js';
import { findGitRoot, repoUrlFor } from './repo-url.js';

export const DEFAULT_BUDGET_MS = 1800;
export const ASK_BUDGET_MS = 4000; // a tool call the model chose to make: the user is already waiting for it
export const CACHE_TTL_MS = 60_000;
const SHOWN_SESSIONS_MAX = 50, SHOWN_IDS_MAX = 500, CACHE_MAX = 40;
// The API accepts at most 200 shownIds per request, each at most 200 characters (routes/memory.ts retrieveSchema): more is a 400
// and every later prompt of the session would silently fall back to the local engine.
const SEND_IDS_MAX = 200, SEND_ID_CHARS = 200;
const stateDir = (home) => join(home, '.spookling');

// ---- which mode: the install config says cloud (SPOOKLING_MODE=cloud|local overrides it), and there is a login

const within = (dir, root) => { const d = resolve(dir), r = resolve(root); return d === r || d.startsWith(r.endsWith(sep) ? r : r + sep); };

/** 'cloud' when the install config (or SPOOKLING_MODE) says this folder uses the cloud, else 'keys'. Login is not checked. */
export function installedMode({ cwd = process.cwd(), home = homedir(), env = process.env } = {}) {
  try {
    if (env.SPOOKLING_MODE === 'local') return 'keys';
    if (env.SPOOKLING_MODE === 'cloud') return 'cloud';
    const raw = JSON.parse(readFileSync(join(stateDir(home), 'install.json'), 'utf8'));
    return (Array.isArray(raw?.installs) ? raw.installs : []).some((i) => i?.mode === 'cloud'
      && (i.scope === 'user' || (typeof i.project === 'string' && i.project && within(cwd, i.project)))) ? 'cloud' : 'keys';
  } catch { return 'keys'; }
}

/** True when this folder is wired in cloud mode and a token exists. Reads local files only. */
export function cloudMode(opts = {}) {
  try {
    return installedMode(opts) === 'cloud' && !!readCredentials({ env: opts.env ?? process.env, home: opts.home ?? homedir() }).token;
  } catch { return false; }
}

// ---- skip prompts that cannot carry a memory

const FILLER = new Set(('a an the and or but so if then ok okay k yes yep yeah yup no nope nah sure fine good great nice cool thanks thank thx ty please pls '
  + 'continue go ahead proceed next done stop again more it this that these those them its is are was be do does did can could would should will '
  + 'just now to of in on at for with me my you your i we us lets let sounds right looks lgtm perfect awesome').split(/\s+/));

/** A small client-side filter: slash commands and acknowledgements ("ok thanks", "continue") are not worth a round trip. */
export function informative(prompt) {
  const text = String(prompt ?? '').trim();
  if (text.length < 8 || text.startsWith('/')) return false;
  const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_./-]*/gu) ?? [];
  if (words.length < 3 && !/[?]/.test(text) && !words.some((w) => /\d|[./_-]/.test(w))) return false;
  return words.some((w) => w.length > 2 && !FILLER.has(w));
}

// ---- project identity: the same key the API derives from the git remote, else the folder name

const SEGMENT = /^[a-z0-9][a-z0-9._~-]*$/;
/** `git:host/org/repo` from a (cleaned) remote, or null. Mirrors the API's normalisation; the API stays the authority on uploads. */
export function normalizeRemote(raw) {
  let v = String(raw ?? '').trim();
  if (!v || v.length > 300 || /\s/.test(v)) return null;
  v = v.replace(/[?#].*$/, '');
  let host, path;
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(v);
  if (m) {
    if (!['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git'].includes(m[1].toLowerCase())) return null;
    const slash = m[2].indexOf('/');
    if (slash <= 0) return null;
    host = m[2].slice(0, slash).replace(/^.*@/, '').replace(/:\d*$/, '');
    path = m[2].slice(slash + 1);
  } else {
    const scp = /^(?:[^@/:\s]+@)?([^@/:\s]+):(?!\/)(.+)$/.exec(v);
    if (!scp) return null;
    [, host, path] = scp;
  }
  host = host.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes('.')) return null;
  const parts = path.toLowerCase().split('/').filter(Boolean);
  if (parts.length < 2) return null;
  parts[parts.length - 1] = parts.at(-1).replace(/\.git$/, '');
  if (!parts.every((p) => SEGMENT.test(p))) return null;
  const key = `git:${host}/${parts.join('/')}`;
  return key.length > 200 ? null : key;
}

/** { project, repoUrl, projectKey } for a folder. A folder outside any repo that is the home folder has no project. */
export async function identify(cwd, { home = homedir(), env = process.env } = {}) {
  const dir = cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = findGitRoot(dir);
  const project = root && resolve(root) !== resolve(home) ? basename(root) : (resolve(dir) === resolve(home) ? '' : basename(resolve(dir)));
  const repoUrl = await repoUrlFor(dir, { home, env }).catch(() => '');
  const projectKey = normalizeRemote(repoUrl) || (project ? `dir:${project}`.slice(0, 200) : '');
  return { project, repoUrl, projectKey };
}

// ---- the small state files: a 60 s answer cache, and what each session has already been shown

function readJson(path) { try { const j = JSON.parse(readFileSync(path, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
function writeJson(path, value) { try { writeFileSecure(path, JSON.stringify(value)); } catch { /* a cache; losing it only costs a request */ } }

const cachePath = (home) => join(stateDir(home), 'cloud-cache.json');
const shownPath = (home) => join(stateDir(home), 'cloud-shown.json');
const hashOf = (q) => createHash('sha256').update(String(q).trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex').slice(0, 32);

function cacheGet(home, key, now) {
  const hit = readJson(cachePath(home)).entries?.[key];
  return hit && Number.isFinite(hit.at) && now - hit.at >= 0 && now - hit.at < CACHE_TTL_MS ? hit.data : null;
}
function cachePut(home, key, data, now) {
  const entries = Object.fromEntries(Object.entries(readJson(cachePath(home)).entries ?? {})
    .filter(([, v]) => Number.isFinite(v?.at) && now - v.at >= 0 && now - v.at < CACHE_TTL_MS).slice(-CACHE_MAX));
  entries[key] = { at: now, data };
  writeJson(cachePath(home), { entries });
}

/** The item ids this session has been shown, oldest first. */
export function shownIds(home, sessionId) {
  const ids = readJson(shownPath(home)).sessions?.[sessionId]?.ids;
  return Array.isArray(ids) ? ids.filter((i) => typeof i === 'string') : [];
}
function updateShown(home, sessionId, now, fn) {
  const sessions = readJson(shownPath(home)).sessions ?? {};
  const cur = sessions[sessionId] ?? { ids: [] };
  sessions[sessionId] = { ...cur, at: now, ...fn(cur) };
  const kept = Object.entries(sessions).sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0)).slice(-SHOWN_SESSIONS_MAX);
  writeJson(shownPath(home), { sessions: Object.fromEntries(kept) });
}

// ---- the call itself

/** Resolve to null when `work` has not answered within ms. The work keeps running but nothing waits for it. */
function withBudget(work, ms) {
  let timer;
  const cap = new Promise((res) => { timer = setTimeout(() => res(null), ms); timer.unref?.(); });
  return Promise.race([work.catch(() => null), cap]).finally(() => clearTimeout(timer));
}

const budgetFrom = (env, def) => { const n = Number(env.SPOOKLING_CLOUD_BUDGET_MS); return Number.isFinite(n) && n > 0 ? n : def; };
// Item ids are local to a space (every space has an f1 and an m1), so with two spaces asked a bare id would hide another space's item.
// The engine reads `<spaceId>|<id>` as "this space only".
const ids = (items) => (Array.isArray(items) ? items.map((i) => (typeof i?.id === 'string' && typeof i.spaceId === 'string' && i.spaceId && !i.spaceId.includes('|') ? `${i.spaceId}|${i.id}` : i?.id)).filter((i) => typeof i === 'string') : []);

/**
 * Ask the cloud what memory holds for a question. Returns { context, items, tier, status, spaces, paused, cached } when the cloud
 * answered "ok" or "empty", and null for everything else (nothing to ask, not in cloud mode, offline, timeout, 401, degraded,
 * unavailable): the caller then falls back to the local engine or says nothing.
 */
export async function cloudRetrieve({
  mode = 'prompt', question, cwd, sessionId, home = homedir(), env = process.env, fetchImpl, budgetMs, now = Date.now, cloud,
} = {}) {
  try {
    if (typeof question !== 'string' || !question.trim()) return null;
    if (mode === 'prompt' && !informative(question)) return null;
    if (!cloudMode({ cwd, home, env })) return null;
    const budget = budgetMs ?? budgetFrom(env, mode === 'ask' ? ASK_BUDGET_MS : DEFAULT_BUDGET_MS);
    const started = Date.now();
    return await withBudget((async () => {
      const id = await identify(cwd, { home, env });
      const key = `${mode}|${id.projectKey}|${hashOf(question)}`;
      const hit = cacheGet(home, key, now());
      if (hit) return { ...hit, cached: true };
      const client = cloud ?? createCloud({ env, home, ...(fetchImpl && { fetchImpl }) });
      const left = Math.max(50, budget - (Date.now() - started));
      const seen = (sessionId ? shownIds(home, sessionId) : []).filter((i) => i.length <= SEND_ID_CHARS).slice(-SEND_IDS_MAX);
      const body = { mode, question, ...(id.projectKey && { projectKey: id.projectKey }), ...(id.repoUrl && { repoUrl: id.repoUrl }),
        ...(id.project && { project: id.project }), ...(sessionId && { sessionId }), ...(seen.length && { shownIds: seen }), clientTs: new Date(now()).toISOString() };
      const data = await client.retrieve({ body, timeoutMs: left });
      if (!data || (data.status !== 'ok' && data.status !== 'empty')) return null;
      const out = { context: typeof data.context === 'string' ? data.context : '', items: Array.isArray(data.items) ? data.items : [],
        tier: data.tier ?? null, status: data.status, spaces: Array.isArray(data.spaces) ? data.spaces : [], ...(data.paused && { paused: true }), cached: false };
      cachePut(home, key, out, now());
      if (sessionId && out.items.length) {
        updateShown(home, sessionId, now(), (cur) => ({ ids: [...new Set([...(cur.ids ?? []), ...ids(out.items)])].slice(-SHOWN_IDS_MAX) }));
      }
      return out;
    })(), budget);
  } catch { return null; }
}

/**
 * The project brief for a session start, or null: not cloud mode, already given to this session, no project, status not "ok",
 * offline or past the budget. Marks the session as briefed only when a brief is returned.
 */
export async function cloudBrief({ cwd, sessionId, home = homedir(), env = process.env, budgetMs, now = Date.now, cloud, fetchImpl } = {}) {
  try {
    if (!cloudMode({ cwd, home, env })) return null;
    if (sessionId && readJson(shownPath(home)).sessions?.[sessionId]?.briefed) return null;
    const budget = budgetMs ?? budgetFrom(env, DEFAULT_BUDGET_MS);
    const started = Date.now();
    return await withBudget((async () => {
      const { projectKey } = await identify(cwd, { home, env });
      if (!projectKey) return null;
      const client = cloud ?? createCloud({ env, home, ...(fetchImpl && { fetchImpl }) });
      const data = await client.projectContext({ projectKey, timeoutMs: Math.max(50, budget - (Date.now() - started)) });
      const brief = data?.status === 'ok' && typeof data.brief === 'string' ? data.brief.trim() : '';
      if (!brief) return null;
      if (sessionId) updateShown(home, sessionId, now(), () => ({ briefed: true }));
      return brief;
    })(), budget);
  } catch { return null; }
}
