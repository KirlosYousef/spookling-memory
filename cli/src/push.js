// Project log.jsonl and upload it. The file and its hashes are never rewritten.
// A down network is queued. One 409 seq_conflict is retried on a later Stop.
// The same conflict again is skipped, including turns appended after it, and
// `spookling status` lists that session. A 429 waits (bounded) and retries once. It is not logout.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CloudError, clean, createCloud } from './cloud.js';
import { readCredentials, writeFileSecure } from './credentials.js';
import { maskSecrets, maskTurn } from './mask.js';
import { StateBusy, accountScope, claimSession, readState, shareJobs, updateState } from './upload-state.js';

const LIST_PAGES = 20; // pages of your sessions searched for one when the server cannot be asked for it by id
const BATCH = 200; // turns per POST: the API's page size
const TITLE_MAX = 120; // the API cuts a longer title
const PROJECT_MAX = 100; // the API refuses a longer project
// whole blocks the tool or harness injected: nothing a person typed
const INJECTED = /<(system-reminder|command-name|command-message|local-command-[\w-]+|user-prompt-submit-hook|ide_\w+|task-notification)(?:\s[^<>]*)?>[\s\S]*?(?:<\/\1>|$)/gi;
const TAG = String.raw`<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*)?\/?>`;
const LEAD_TAG = new RegExp(String.raw`^\s*${TAG}`);
const TRAIL_TAG = new RegExp(String.raw`${TAG}\s*$`);
const BOILERPLATE = /^background\b.*\(from (?:the|this) session.*\):?$/i;
const base = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

// @"/a b/c.md" and @/a/c.md become c.md; @name (no slash) is left alone
function mentionsToNames(line) {
  return line
    .replace(/(^|\s)@"([^"]+)"/g, (_, sp, p) => sp + base(p))
    .replace(/(^|\s)@(?!")(\S+)/g, (m, sp, p) => (/[\\/]/.test(p) ? sp + base(p.replace(/[.,;:!?)]+$/, '')) : m));
}

function clip(s, max = TITLE_MAX) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const i = cut.lastIndexOf(' ');
  return `${(i > max / 2 ? cut.slice(0, i) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

// the first line a person wrote: no injected blocks, no wrapper tags, no boilerplate heading, @path as its file name; '' if none
export function deriveTitle(text) {
  for (let line of String(text ?? '').replace(INJECTED, '\n').split(/\r?\n/)) {
    for (let prev = null; prev !== line;) { prev = line; line = line.replace(LEAD_TAG, '').replace(TRAIL_TAG, ''); }
    line = mentionsToNames(line.trim()).replace(/\s+/g, ' ').trim();
    if (!line || !/[\p{L}\p{N}]/u.test(line) || BOILERPLATE.test(line)) continue;
    return clip(line);
  }
  return '';
}

// first meaningful user turn; else the old first line of the first turn; else a placeholder
export function sessionTitle(userTexts, fallbackText = '') {
  for (const t of userTexts) {
    const d = deriveTitle(t);
    if (d) return d;
  }
  return String(fallbackText ?? '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) || 'Untitled session';
}

function baseSessionId(sessionId) {
  const s = String(sessionId ?? '');
  const i = s.indexOf('#');
  return i < 0 ? s : s.slice(0, i);
}

// Tail parts are stored as "<id>#<from>" and their turn_index starts again at 0
// (see Store.ingest). The upload seq is the turn's place in the base session:
// within one part that is turn_index, and a later part continues after it.
const RELATIONS = new Set(['side_chat', 'continued']);

/** forks.json, written by the server beside log.jsonl: { <session id>: { parent, relation, branched_at, copied } }. Bad entries are ignored. */
export function readForks(dir) {
  const out = {};
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'forks.json'), 'utf8'));
    for (const [sid, f] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      if (typeof f?.parent !== 'string' || !f.parent || f.parent === sid) continue;
      if (!Number.isInteger(f.copied) || f.copied < 0 || !Number.isInteger(f.branched_at) || f.branched_at < 0) continue;
      out[sid] = { parent: f.parent, relation: RELATIONS.has(f.relation) ? f.relation : 'side_chat', branchedAtTurn: f.branched_at, copied: f.copied };
    }
  } catch { /* no forks recorded */ }
  return out;
}

const linkKey = (f) => `${f.parent}|${f.relation}|${f.branchedAtTurn}`;

// A fork's log holds the lines copied from its parent first (`copied` turns); its own turns follow. In 'own' mode only those are
// sent, numbered from 0. A session that was already uploaded with the copy keeps its numbering ('full'): its turns stay as they
// are (the server is append-only) and it is only linked to its parent.
export function projectLog(text, { forks = {}, modeOf = () => 'own' } = {}) {
  const groups = new Map();
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    const sid = baseSessionId(ev.session_id);
    if (!sid || sid.includes(':')) continue;
    if (ev.role !== 'user' && ev.role !== 'assistant') continue;
    if (typeof ev.text !== 'string' || !ev.text.trim() || typeof ev.ts !== 'string' || !ev.ts) continue;
    if (!groups.has(sid)) groups.set(sid, []);
    groups.get(sid).push(ev);
  }
  const sessions = [];
  for (const [sid, evs] of groups) {
    // mask before the cap, so a key cut in half by the cap cannot slip through
    const fork = forks[sid];
    const mode = fork ? modeOf(sid) : 'full';
    const own = fork ? evs.slice(fork.copied) : evs;
    if (fork && mode === 'own' && !own.length) continue; // just forked: nothing of its own to send yet
    const sent = mode === 'own' ? own : evs;
    const masked = sent.map((ev) => ({ ...ev, text: maskSecrets(ev.text) }));
    const ownMasked = own.map((ev) => ({ ...ev, text: maskSecrets(ev.text) }));
    const turns = masked.map((ev, seq) => ({
      seq,
      role: ev.role,
      text: maskTurn(ev.text),
      ts: ev.ts,
    }));
    const titled = fork && ownMasked.length ? ownMasked : masked; // a fork is named by what it adds, not by the copy
    const firstUser = titled.find((e) => e.role === 'user') || titled[0];
    const agent = evs.some((e) => e.agent === 'codex') ? 'codex' : 'claude-code';
    sessions.push({
      sid,
      session: {
        agent,
        project: '',
        title: sessionTitle(titled.filter((e) => e.role === 'user').map((e) => e.text), firstUser.text),
        startedAt: sent.find((e) => typeof e.ts === 'string')?.ts,
        ...(fork ? { parentSessionId: fork.parent, branchedAtTurn: fork.branchedAtTurn, relation: fork.relation } : {}),
      },
      turns,
      ...(fork ? { mode } : {}),
    });
  }
  return sessions;
}

function unsent(session, cursor) {
  const after = typeof cursor === 'number' ? cursor : -1;
  return session.turns.filter((t) => t.seq > after);
}

function turnKey(turns) {
  return turns.map((t) => `${t.seq}\u0000${t.text}`).join('\u0001');
}

function conflictRecord(raw) {
  if (raw === 'seq_conflict') return { reason: 'seq_conflict', key: null, seen: 2 };
  if (!raw || typeof raw !== 'object' || raw.reason !== 'seq_conflict') return null;
  const seen = Number(raw.seen) >= 2 ? 2 : 1;
  return { reason: 'seq_conflict', key: typeof raw.key === 'string' ? raw.key : null, seen };
}

function extendsKey(prev, key) {
  if (typeof prev !== 'string') return false;
  return key === prev || key.startsWith(`${prev}\u0001`);
}

// A second conflict on the same bytes stays skipped. Turns appended after that
// still start with the conflicting prefix, so they stay skipped too. A legacy
// string value is already a confirmed skip.
function repeatedConflict(raw, turns) {
  const record = conflictRecord(raw);
  if (!record || record.seen < 2) return false;
  if (record.key == null) return true;
  return extendsKey(record.key, turnKey(turns));
}

const PERMANENT = new Set(['org_owned', 'turn_limit', 'session_limit', 'session_deleted']);
const SKIP_TEXT = {
  org_owned: 'shared with an org you left',
  turn_limit: 'over the turn limit',
  session_limit: 'over the session limit',
  session_deleted: 'deleted from the cloud',
};
export const skipText = (reason) => SKIP_TEXT[reason] || reason;

function permanentSkip(raw) {
  return raw && typeof raw === 'object' && PERMANENT.has(raw.reason) ? raw.reason : null;
}

/** What the last uploads left behind: sessions skipped for good (and why), and whether the token was refused (401). Local only. */
export function uploadProblems(home = homedir(), env = process.env) {
  const state = readState(home, accountScope(home, env));
  const skipped = Object.entries(state.skipped)
    .map(([sid, raw]) => ({ sid, reason: permanentSkip(raw) }))
    .filter((x) => x.reason && x.reason !== 'session_deleted') // a deleted session is not a problem
    .sort((a, b) => a.sid.localeCompare(b.sid));
  return { skipped, loginExpired: !!state.auth?.expired };
}

/** After a new login the old 401 no longer applies. */
export async function clearLoginExpired(home = homedir(), env = process.env) {
  const scope = accountScope(home, env);
  if (!readState(home, scope).auth) return;
  await updateState(home, (st) => { st.auth = null; }, { scope });
}

/** Sessions the user deleted from the cloud (local state only): they must never upload again. */
export function deletedSessionIds(home = homedir(), env = process.env) {
  const state = readState(home, accountScope(home, env));
  return new Set(Object.entries(state.skipped).filter(([, raw]) => permanentSkip(raw) === 'session_deleted').map(([sid]) => sid));
}

export function skippedSessionIds(home = homedir(), env = process.env) {
  const state = readState(home, accountScope(home, env));
  return Object.entries(state.skipped)
    .filter(([, raw]) => {
      const record = conflictRecord(raw);
      return record && record.seen >= 2;
    })
    .map(([sid]) => sid)
    .sort();
}

/** Session id -> last uploaded seq, for the current account on the current server. Local state only. */
export function uploadedCursors(home = homedir(), env = process.env) {
  return { ...readState(home, accountScope(home, env)).cursors };
}

/** Turns queued for upload that the server has not accepted yet. Local state only; never touches the network. */
export function pendingUploads(home = homedir(), env = process.env) {
  const queue = readState(home, accountScope(home, env)).queue;
  let turns = 0;
  for (const item of queue) turns += Array.isArray(item?.turns) ? item.turns.length : 0;
  return { sessions: queue.length, turns };
}

function shareJob(item) {
  const project = item?.session?.project;
  if (!item?.sid || typeof project !== 'string' || !project) return null;
  return { sid: item.sid, project };
}

function giveUpShare(error) {
  return error instanceof CloudError && (error.status === 401 || error.status === 403 || error.status === 404);
}

// After a private upload, share the session when this project has an auto-share rule.
// A missing route means the server has no rules. A down network throws so the caller can queue it.
async function shareUploaded(client, token, job) {
  if (typeof client.listAutoShare !== 'function' || typeof client.shareSession !== 'function') return;
  let rules;
  try {
    rules = await client.listAutoShare({ token });
  } catch (error) {
    if (error instanceof CloudError && error.status === 404) return;
    throw error;
  }
  const list = Array.isArray(rules?.rules) ? rules.rules : [];
  const rule = list.find((item) => item && item.project === job.project && item.orgId);
  if (!rule) return;
  try {
    await client.shareSession({ sid: job.sid, orgId: rule.orgId, token });
  } catch (error) {
    if (giveUpShare(error)) return;
    throw error;
  }
}

async function sendSession(client, item, token) {
  await client.upsertSession({ sid: item.sid, session: item.session, token });
  let last = null;
  for (let i = 0; i < item.turns.length; i += BATCH) {
    last = await client.postTurns({ sid: item.sid, turns: item.turns.slice(i, i + BATCH), token });
  }
  return last;
}

function isConflict(e) {
  return e instanceof CloudError && e.status === 409 && e.reason === 'seq_conflict';
}

function isRateLimit(e) {
  return e instanceof CloudError && e.status === 429;
}

// One wait, then one retry. A hostile Retry-After cannot park the process all day.
async function deliver(client, item, token, sleep, maxWaitMs, log) {
  try {
    return await sendSession(client, item, token);
  } catch (e) {
    if (!isRateLimit(e)) throw e;
    const seconds = Number(e.retryAfter) > 0 ? Number(e.retryAfter) : 1;
    const cap = Number(maxWaitMs) > 0 ? Number(maxWaitMs) : 30000;
    log('upload waiting: rate limited');
    await sleep(Math.min(seconds * 1000, cap));
  }
  return sendSession(client, item, token);
}

// What went wrong with one session: a seq conflict (retried once, then skipped), a refusal for good, an expired login,
// or anything else (the network, a 5xx, rate limiting), which is retried later.
export function classifyError(e) {
  if (isConflict(e)) return { kind: 'conflict' };
  if (e instanceof CloudError && e.status === 400 && e.reason === 'seq_gap') return { kind: 'gap' };
  if (e instanceof CloudError) {
    const why = e.reason;
    if ((e.status === 403 && why === 'org_owned') || (e.status === 400 && (why === 'turn_limit' || why === 'session_limit'))) {
      return { kind: 'permanent', reason: why };
    }
    if (e.status === 410) return { kind: 'permanent', reason: 'session_deleted' }; // deleted on purpose: never re-upload
    if (e.status === 401) return { kind: 'auth' };
  }
  return { kind: 'retry' };
}

const linkOf = (item) => {
  const p = item.session.parentSessionId;
  return p ? linkKey({ parent: p, relation: item.session.relation, branchedAtTurn: item.session.branchedAtTurn }) : null;
};

// The sessions to send: what is queued, plus the turns of each projected session past its cursor.
function buildWork(state, projected) {
  const work = new Map();
  for (const item of state.queue) {
    if (!permanentSkip(state.skipped[item.sid]) && !repeatedConflict(state.skipped[item.sid], item.turns)) work.set(item.sid, item);
  }
  for (const item of projected) {
    const turns = unsent(item, state.cursors[item.sid]);
    const link = linkOf(item);
    // already uploaded, now known to be a fork: one PUT links it, even with no new turn
    if (!turns.length && !(link && state.links[item.sid] !== link)) continue;
    if (permanentSkip(state.skipped[item.sid])) continue;
    if (turns.length && repeatedConflict(state.skipped[item.sid], turns)) continue;
    const p = item.session.parentSessionId;
    work.set(item.sid, { sid: item.sid, session: item.session, turns, ...(p ? { mode: item.mode, link } : {}) });
  }
  return [...work.values()];
}

const queueItem = (st, item) => { st.queue = [...st.queue.filter((q) => q.sid !== item.sid), item]; };

// A locked change to the state file. A busy lock is reported, not fatal: the next Stop sends what is still unsent.
async function persist({ home, scope, log }, mutate) {
  try { return await updateState(home, mutate, { scope }); } catch (e) {
    if (!(e instanceof StateBusy)) throw e;
    log('upload state busy; will retry on the next Stop');
    return undefined;
  }
}

// Why a call failed, for upload.log: the code or status, and the server's reason when it gave one. Never the token or any turn text.
const why = (e) => [e?.code || e?.status || 'offline', e?.reason ? clean(e.reason) : null].filter(Boolean).join(' ');

/**
 * Where the server is for a session: the last seq it holds, -1 when it has none, null when that cannot be told. Asked after a seq_gap,
 * which means the saved cursor is ahead of the server (another server or account, or a deleted session).
 */
async function serverLastSeq({ client, creds, sid }) {
  try {
    let count = null;
    if (creds.user?.id && typeof client.getSession === 'function') {
      const data = await client.getSession({ sid: `${creds.user.id}:${sid}`, token: creds.token });
      count = Number(data?.session?.turnCount);
    } else if (typeof client.listSessions === 'function') {
      let cursor;
      count = 0;
      for (let page = 0; page < LIST_PAGES; page += 1) {
        const data = await client.listSessions({ cursor, token: creds.token });
        const hit = (data?.sessions || []).find((x) => x.clientId === sid);
        if (hit) { count = Number(hit.turnCount); break; }
        cursor = data?.nextCursor;
        if (!cursor) break;
      }
    }
    return Number.isInteger(count) && count >= 0 ? count - 1 : null;
  } catch (e) {
    return e instanceof CloudError && e.status === 404 ? -1 : null;
  }
}

// Progress is cosmetic: a callback that throws must never fail an upload.
function tick(onProgress, done, total) {
  if (typeof onProgress !== 'function') return;
  try { onProgress(done, total); } catch { /* ignore */ }
}

// Send `items` one session at a time. After each one the cursor (or the skip, or the queue entry) is saved on its own, merged into
// whatever other uploaders saved meanwhile; a session another uploader is sending right now is left to it. `full` maps a session id to
// its whole projected turns, for the one resend after a seq_gap.
async function deliverAll({ client, creds, items, ctx, sleep, maxWaitMs, full, onProgress }) {
  const { home, scope, log } = ctx;
  let pushed = 0, stop = false, noNewSessions = false;
  const waiting = [];
  for (const first of items) {
    if (stop) { waiting.push(first); continue; }
    const release = await claimSession(home, first.sid);
    if (!release) continue;
    let item = first, healed = false;
    try {
      for (;;) {
        let fresh = item;
        try {
          const now = readState(home, scope);
          const turns = item.turns.filter((t) => !(typeof now.cursors[item.sid] === 'number' && t.seq <= now.cursors[item.sid]));
          if (!turns.length && !(item.link && now.links[item.sid] !== item.link)) {
            await persist(ctx, (st) => { st.queue = st.queue.filter((q) => q.sid !== item.sid); });
            break; // someone else already sent it
          }
          fresh = { ...item, turns };
          // the account is full: sessions already on the server still grow, new ones wait for a later Stop
          if (noNewSessions && typeof now.cursors[item.sid] !== 'number') break;
          const data = await deliver(client, fresh, creds.token, sleep || delay, maxWaitMs, log);
          const last = fresh.turns[fresh.turns.length - 1];
          await persist(ctx, (st) => {
            if (last) {
              const seq = typeof data?.lastSeq === 'number' ? data.lastSeq : last.seq;
              st.cursors[item.sid] = Math.max(typeof st.cursors[item.sid] === 'number' ? st.cursors[item.sid] : -1, seq);
            }
            if (fresh.link) { st.links[item.sid] = fresh.link; st.forkModes[item.sid] = fresh.mode || (st.cursors[item.sid] !== undefined ? 'full' : 'own'); }
            delete st.skipped[item.sid];
            st.auth = null;
            st.queue = st.queue.filter((q) => q.sid !== item.sid);
          });
          pushed += 1;
          tick(onProgress, pushed, items.length);
          const job = shareJob(fresh);
          if (job) {
            try { await shareUploaded(client, creds.token, job); } catch (error) {
              await persist(ctx, (st) => { st.shares = shareJobs([...st.shares, job]); });
              log(`upload queued: ${why(error)}`);
              stop = true;
            }
          }
          break;
        } catch (e) {
          const c = classifyError(e);
          if (c.kind === 'gap' && !healed) {
            // the saved cursor is ahead of the server: ask where the server is, resend from there, once
            healed = true;
            if (permanentSkip(readState(home, scope).skipped[item.sid])) break; // deleted (or refused for good) meanwhile: never resend
            const at = await serverLastSeq({ client, creds, sid: item.sid });
            const all = full.get(item.sid);
            if (at !== null && all) {
              log(`session ${item.sid}: the server holds ${at + 1} turns, the saved position was ahead of it; resending from there`);
              await persist(ctx, (st) => {
                if (at < 0) delete st.cursors[item.sid]; else st.cursors[item.sid] = at;
                st.queue = st.queue.filter((q) => q.sid !== item.sid);
              });
              item = { sid: item.sid, session: all.session, turns: all.turns, ...(all.session.parentSessionId ? { mode: all.mode, link: linkOf(all) } : {}) };
              continue;
            }
          }
          if (c.kind === 'conflict') {
            const key = turnKey(fresh.turns);
            const known = conflictRecord(readState(home, scope).skipped[item.sid]);
            // the note first: anything that sees the state change can then rely on the note being there
            log(known && extendsKey(known.key, key) ? `session ${item.sid} skipped: seq_conflict` : `session ${item.sid} seq_conflict; retrying on the next Stop`);
            await persist(ctx, (st) => {
              const prev = conflictRecord(st.skipped[item.sid]);
              st.skipped[item.sid] = { reason: 'seq_conflict', key, seen: prev && extendsKey(prev.key, key) ? 2 : 1 };
              st.queue = st.queue.filter((q) => q.sid !== item.sid);
            });
          } else if (c.kind === 'permanent') {
            log(`session ${item.sid} skipped: ${c.reason}`);
            await persist(ctx, (st) => {
              st.skipped[item.sid] = { reason: c.reason, permanent: true };
              if (c.reason === 'session_deleted') delete st.cursors[item.sid];
              st.queue = st.queue.filter((q) => q.sid !== item.sid);
            });
            if (c.reason === 'session_limit') noNewSessions = true;
          } else if (c.kind === 'auth') {
            // expired or revoked: nothing after this can work. The login is kept; status says to log in again.
            log('upload queued: 401 (login expired; run spookling login)');
            await persist(ctx, (st) => { st.auth = { expired: true, at: new Date().toISOString() }; queueItem(st, item); });
            waiting.push(item);
            stop = true;
          } else {
            log(isRateLimit(e) ? 'upload waiting: rate limited' : `upload queued: ${why(e)}`);
            await persist(ctx, (st) => queueItem(st, item));
            waiting.push(item);
            stop = true;
          }
          break;
        }
      }
    } finally {
      release();
    }
  }
  if (waiting.length) {
    await persist(ctx, (st) => { for (const item of waiting) if (!st.queue.some((q) => q.sid === item.sid)) queueItem(st, item); });
  }
  return { pushed, queued: waiting.length };
}

// Pending shares are retried first. Only the ones that went through are removed, so a share another uploader added is kept.
async function flushShares({ client, creds, ctx }) {
  const jobs = readState(ctx.home, ctx.scope).shares;
  if (!jobs.length) return;
  const done = [];
  for (const job of jobs) {
    try { await shareUploaded(client, creds.token, job); done.push(job); } catch (error) {
      ctx.log(`upload queued: ${why(error)}`);
      break;
    }
  }
  if (done.length) {
    await persist(ctx, (st) => { st.shares = st.shares.filter((j) => !done.some((d) => d.sid === j.sid && d.project === j.project)); });
  }
}

export async function pushFromLog({
  logPath, logText, home = homedir(), env = process.env, cloud, project = '', sessionId = '', forks,
  sleep, maxWaitMs, timeoutMs, onProgress,
  log = (m) => process.stderr.write(`${m}\n`),
} = {}) {
  try {
    return await upload({ logPath, logText, home, env, cloud, project, sessionId, forks, sleep, maxWaitMs, timeoutMs, log, onProgress });
  } catch {
    return { ok: false, queued: true, pushed: 0 };
  }
}

async function upload({ logPath, logText, home, env, cloud, project, sessionId, forks, sleep, maxWaitMs, timeoutMs, log, onProgress }) {
  let raw = logText;
  if (raw == null && logPath) {
    try { raw = readFileSync(logPath, 'utf8'); } catch { return { ok: true, pushed: 0 }; }
  }
  if (typeof raw !== 'string') raw = '';
  const creds = readCredentials({ home, env });
  if (!creds.token) return { ok: true, pushed: 0, skipped: 'logged-out' };

  let client = cloud;
  if (!client) {
    try {
      client = createCloud({ env, home, token: creds.token, ...(timeoutMs ? { timeoutMs } : {}) });
    } catch (e) {
      log(`upload queued: ${e.code || 'NO_API'}`);
      client = null;
    }
  }

  const scope = accountScope(home, env);
  const ctx = { home, scope, log };
  const state = readState(home, scope);
  const only = typeof sessionId === 'string' ? sessionId : '';
  const known = forks ?? (logPath ? readForks(dirname(logPath)) : {});
  const modeOf = (sid) => state.forkModes[sid] ?? (state.cursors[sid] !== undefined ? 'full' : 'own');
  const projected = projectLog(raw, { forks: known, modeOf }).filter((s) => !only || s.sid === only).map((s) => ({
    ...s,
    session: { ...s.session, project: String(project || s.session.project || '').slice(0, PROJECT_MAX), title: String(s.session.title || '').slice(0, TITLE_MAX) },
  }));
  const items = buildWork(state, projected);
  if (!client) {
    if (items.length) await persist(ctx, (st) => { for (const item of items) queueItem(st, item); });
    return { ok: false, queued: items.length > 0, pushed: 0 };
  }

  await flushShares({ client, creds, ctx });
  const { pushed, queued } = await deliverAll({ client, creds, items, ctx, sleep, maxWaitMs, onProgress, full: new Map(projected.map((x) => [x.sid, x])) });
  const pendingShare = readState(home, scope).shares.length > 0;
  return { ok: queued === 0 && !pendingShare, queued: queued > 0 || pendingShare, pushed };
}

/** Stop-hook path. It does not throw when the network is down. */
export async function teamMemoryHook(opts = {}) {
  try {
    return await pushFromLog(opts);
  } catch {
    return { ok: false, queued: true, pushed: 0 };
  }
}
