// Who can see my sessions: status, share, unshare, and the per-project auto-share rule.
// Called by the MCP tools (through team-invoke.js) and by `spookling sessions|share|unshare`.
// Only the owner's own sessions. Nothing here runs unless the user (or the model on the user's say-so) calls it.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { CloudError, apiBase, clean, createCloud, networkMessage } from './cloud.js';
import { readCredentials } from './credentials.js';
import { pushFromLog, projectLog, sessionTitle } from './push.js';
import { accountScope, readState, updateState } from './upload-state.js';

const NOT_LOGGED_IN = 'Not logged in. Run spookling login first.';

export function client(env, home, cloud) {
  if (cloud) return { cloud, error: null };
  if (!readCredentials({ env, home }).token) return { cloud: null, error: NOT_LOGGED_IN };
  try {
    apiBase(env, { home });
    return { cloud: createCloud({ env, home }), error: null };
  } catch (e) {
    return { cloud: null, error: clean(e?.message) || 'No usable API URL.' };
  }
}

export function explain(e, env, home) {
  const net = networkMessage(e, { env, home });
  if (net) return net;
  if (!(e instanceof CloudError)) return 'Could not reach the Spookling API.';
  if (e.status === 401) return 'The saved login was rejected. Run spookling login again.';
  if (e.status === 403 && e.reason === 'org_owned') return 'That session is shared with an org and now belongs to it, so it cannot be deleted from here.';
  if (e.status === 410) return 'That session was already deleted; it cannot be changed.';
  if (e.status === 403) return 'Not allowed: you must be an active member of that org.';
  if (e.status === 404) return 'The server does not know that session or org yet.';
  if (e.status === 429) return 'Rate limited. Try again in a moment.';
  return e.code ? `The API refused it (${clean(e.code)}).` : 'Could not reach the Spookling API.';
}

async function orgsOf(cloud, token) {
  const data = await cloud.listOrgs({ token });
  // GET /cli/orgs rows are { org: { id, name }, membership }; a bare { id, name } is accepted too
  return (Array.isArray(data?.orgs) ? data.orgs : [])
    .filter((row) => !row?.membership?.status || row.membership.status === 'active')
    .map((row) => row?.org || row)
    .filter((o) => o && o.id)
    .map((o) => ({ id: o.id, name: o.name || o.id }));
}

// One org: the default. Several: the caller must name one. "org" is an id or a case-insensitive name.
// With no name, the saved default org wins when it is still one of yours; a stale default is ignored.
export function pickOrg(orgs, wanted, defaultId = null) {
  let w = typeof wanted === 'string' ? wanted.trim().toLowerCase() : '';
  if (!w && defaultId && orgs.some((o) => o.id === defaultId)) w = defaultId.toLowerCase();
  if (w) {
    const hit = orgs.find((o) => o.id.toLowerCase() === w || o.name.toLowerCase() === w);
    return hit ? { org: hit } : { error: `No org matches "${wanted}". Your orgs: ${orgs.map((o) => o.name).join(', ') || 'none'}.` };
  }
  if (orgs.length === 1) return { org: orgs[0] };
  if (!orgs.length) return { error: 'You are not an active member of any org.' };
  return { error: `Which org? ${orgs.map((o) => o.name).join(', ')}.` };
}

// ---- the session a share is about, when the caller did not name one ----

const WEB_BASE = 'https://app.spookling.com';

/** Where a session is read in the web app, or '' when this API has no known web app. SPOOKLING_APP_URL overrides. */
export function webUrl(sessionId, { env = process.env, home = homedir() } = {}) {
  let base = typeof env.SPOOKLING_APP_URL === 'string' ? env.SPOOKLING_APP_URL.trim().replace(/\/+$/, '') : '';
  if (!/^https:\/\/[^/\s]+$/.test(base)) {
    base = '';
    try { if (apiBase(env, { home }) === 'https://api.spookling.com') base = WEB_BASE; } catch { /* no known web app */ }
  }
  return base && sessionId ? `${base}/memory/${encodeURIComponent(sessionId)}` : '';
}

function gitRoot(dir) {
  let d = dir;
  for (let i = 0; i < 24 && d; i += 1) {
    if (existsSync(join(d, '.git'))) return d;
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return '';
}

// the project name the Stop hook would use: the git root's folder, else the folder; '' for the home folder
function projectOf(dir, home) {
  if (!dir) return '';
  const root = gitRoot(dir);
  if (root && root !== home) return basename(root);
  return dir === home ? '' : basename(dir);
}

const logPaths = (projectDir, home) => [...new Set([projectDir && join(projectDir, '.memory', 'log.jsonl'), join(home, '.memory', 'log.jsonl')].filter(Boolean))];

function readLog(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

/** What the local log knows about a session: { title, turns, logPath } or null. Local files only. */
export function localSession(sessionId, { projectDir = process.cwd(), home = homedir() } = {}) {
  for (const logPath of logPaths(projectDir, home)) {
    const text = readLog(logPath);
    if (!text.includes(sessionId)) continue;
    const hit = projectLog(text, { forks: {} }).find((x) => x.sid === sessionId);
    if (hit) return { title: hit.session.title, turns: hit.turns.length, logPath };
  }
  return null;
}

// The newest session in a local log, by its last turn's timestamp.
function newestLocal(projectDir, home) {
  for (const path of logPaths(projectDir, home)) {
    const last = new Map();
    for (const line of readLog(path).split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const sid = typeof ev?.session_id === 'string' ? ev.session_id.split('#')[0] : '';
      if (!sid || sid.includes(':') || (ev.role !== 'user' && ev.role !== 'assistant') || typeof ev.ts !== 'string') continue;
      if (!last.has(sid) || ev.ts >= last.get(sid)) last.set(sid, ev.ts);
    }
    const best = [...last].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))[0];
    if (best) return best[0];
  }
  return '';
}

/**
 * The session "this one" means when no id was given: the id in SPOOKLING_SESSION_ID / CLAUDE_SESSION_ID when set (a terminal inside
 * the session), else the newest session logged in this project, else this project's newest uploaded session. { sessionId, source } or { error }.
 */
export async function currentSession({ env = process.env, home = homedir(), projectDir = process.cwd(), cloud: injected } = {}) {
  for (const key of ['SPOOKLING_SESSION_ID', 'CLAUDE_SESSION_ID']) {
    const v = typeof env[key] === 'string' ? env[key].trim() : '';
    if (v && !v.includes('#')) return { sessionId: v, source: 'environment' };
  }
  const local = newestLocal(projectDir, home);
  if (local) return { sessionId: local, source: 'local log' };
  const { cloud, error } = client(env, home, injected);
  if (error) return { error };
  try {
    const token = readCredentials({ env, home }).token;
    const mine = await allMine(cloud, token, projectOf(projectDir, home) || undefined);
    const newest = mine.slice().sort((a, b) => String(b.lastTurnAt || '').localeCompare(String(a.lastTurnAt || '')))[0] || mine[0];
    if (newest?.clientId) return { sessionId: newest.clientId, source: 'newest uploaded' };
  } catch (e) {
    return { error: explain(e, env, home) };
  }
  return { error: 'No session found here. Run this inside a project with a Spookling session, or give a session id.' };
}

// ---- explicit shares queued until the session is on the server ----

function queuedShares(home, env, sid) {
  return readState(home, accountScope(home, env)).shares.filter((j) => j.orgId && j.sid === sid);
}

async function queueShare(home, env, job) {
  await updateState(home, (st) => {
    if (!st.shares.some((j) => j.sid === job.sid && (j.orgId || '') === job.orgId)) st.shares = [...st.shares, job];
  }, { scope: accountScope(home, env) });
}

/** Cancel queued shares of a session (all of them, or one org). How many were removed. */
async function dropQueued(home, env, sid, orgId) {
  const gone = queuedShares(home, env, sid).filter((j) => !orgId || j.orgId === orgId);
  if (!gone.length) return 0;
  await updateState(home, (st) => { st.shares = st.shares.filter((j) => !(j.orgId && j.sid === sid && (!orgId || j.orgId === orgId))); }, { scope: accountScope(home, env) });
  return gone.length;
}

async function allMine(cloud, token, project) {
  const out = [];
  let cursor;
  for (let i = 0; i < 20; i += 1) {
    const data = await cloud.listSessions({ project, cursor, token });
    out.push(...(Array.isArray(data?.sessions) ? data.sessions : []));
    cursor = data?.nextCursor;
    if (!cursor) break;
  }
  return out;
}

const view = (s, names) => ({
  sessionId: s.clientId,
  title: s.title,
  project: s.project,
  turns: s.turnCount,
  lastTurnAt: s.lastTurnAt,
  parent: s.parent && typeof s.parent === 'object' && s.parent.id ? {
    id: s.parent.id, relation: s.parent.relation === 'continued' ? 'continued' : 'side_chat',
    branchedAtTurn: s.parent.branchedAtTurn ?? null, title: typeof s.parent.title === 'string' ? s.parent.title : null,
  } : null,
  visibility: Array.isArray(s.sharedWith) && s.sharedWith.length ? 'shared' : 'private',
  sharedWith: (s.sharedWith || []).map((id) => ({ id, name: names.get(id) || id })),
});

// Without sessionId: this account's sessions (newest first), optionally for one project.
export async function shareStatus({ sessionId, project, env = process.env, home = homedir(), cloud: injected } = {}) {
  const { cloud, error } = client(env, home, injected);
  if (error) return { error };
  const token = readCredentials({ env, home }).token;
  try {
    const [mine, orgs, rules] = await Promise.all([
      allMine(cloud, token, sessionId ? undefined : project),
      orgsOf(cloud, token).catch(() => []),
      cloud.listAutoShare({ token }).catch(() => ({ rules: [] })),
    ]);
    const names = new Map(orgs.map((o) => [o.id, o.name]));
    const autoShare = (rules?.rules || []).map((r) => ({ project: r.project, orgId: r.orgId, org: names.get(r.orgId) || r.orgId }));
    if (sessionId) {
      const hit = mine.find((s) => s.clientId === sessionId);
      if (!hit) {
        const q = queuedShares(home, env, sessionId);
        if (q.length) {
          const where = q.map((j) => names.get(j.orgId) || j.orgId);
          return { sessionId, visibility: 'share pending', pendingOrgs: where, message: `Share pending: will be shared with ${where.join(', ')} after this session's next save.`, autoShare };
        }
      }
      if (!hit) return { sessionId, visibility: 'not uploaded', message: 'This session has not been uploaded yet (it uploads when it stops). Nothing is shared.', autoShare };
      const v = view(hit, names);
      return { ...v, autoShare: autoShare.filter((r) => r.project === v.project) };
    }
    return { sessions: mine.map((s) => view(s, names)), autoShare: project ? autoShare.filter((r) => r.project === project) : autoShare };
  } catch (e) {
    return { error: explain(e, env, home) };
  }
}

// share: true or false. Undoes nothing else; a colleague who already read it is not un-told.
// A session not on the server yet is uploaded now from its local log (the Stop hook's path); if that cannot be done it is queued, and
// the next upload applies it. sessionId may be left out: it is then the current session (see currentSession).
export async function setSessionShare({ sessionId, share, org, projectDir = process.cwd(), env = process.env, home = homedir(), cloud: injected } = {}) {
  if (!sessionId) {
    const cur = await currentSession({ env, home, projectDir, cloud: injected });
    if (cur.error) return { error: cur.error };
    sessionId = cur.sessionId;
  }
  const { cloud, error } = client(env, home, injected);
  if (error) return { error };
  const creds = readCredentials({ env, home });
  const token = creds.token;
  try {
    const orgs = await orgsOf(cloud, token);
    let targets;
    const onServer = async () => (await allMine(cloud, token)).find((s) => s.clientId === sessionId);
    if (!share && !org) {
      const mine = await onServer();
      const dropped = await dropQueued(home, env, sessionId);
      if (!mine) {
        if (dropped) return { ok: true, action: 'unshared', sessionId, visibility: 'not uploaded', message: 'Cancelled the pending share.' };
        return { sessionId, visibility: 'not uploaded', message: 'Nothing to unshare: this session has not been uploaded.' };
      }
      targets = (mine.sharedWith || []).map((id) => orgs.find((o) => o.id === id) || { id, name: id });
    } else {
      const picked = pickOrg(orgs, org, share ? creds.defaultOrgId : null);
      if (picked.error) return { error: picked.error };
      targets = [picked.org];
      if (!share) {
        const dropped = await dropQueued(home, env, sessionId, picked.org.id);
        if (dropped && !(await onServer())) return { ok: true, action: 'unshared', sessionId, visibility: 'not uploaded', message: 'Cancelled the pending share.' };
      }
    }
    if (share) {
      let mine = await onServer();
      let project = mine?.project || '';
      if (!mine) {
        const local = localSession(sessionId, { projectDir, home });
        project = projectOf(projectDir, home);
        if (local && local.turns > 0) {
          await pushFromLog({ logPath: local.logPath, home, env, cloud, project, sessionId, log: () => {} });
          mine = await onServer().catch(() => undefined);
        }
      }
      if (!mine) {
        const o = targets[0];
        await queueShare(home, env, { sid: sessionId, project, orgId: o.id });
        return {
          ok: true, pending: true, action: 'share pending', sessionId, orgs: [o.name], visibility: 'share pending',
          message: `Will be shared with ${o.name} after this session's next save.`,
        };
      }
    }
    for (const o of targets) {
      if (share) await cloud.shareSession({ sid: sessionId, orgId: o.id, token });
      else await cloud.unshareSession({ sid: sessionId, orgId: o.id, token });
    }
    const after = await shareStatus({ sessionId, env, home, cloud });
    return { ok: true, action: share ? 'shared' : 'unshared', orgs: targets.map((o) => o.name), ...after };
  } catch (e) {
    return { error: explain(e, env, home) };
  }
}

// enabled true: every new session of this project goes to the org (backfill: also the ones already uploaded).
// enabled false: removes the rule; nothing already shared is unshared.
export async function setProjectAutoShare({ project, enabled, org, backfill = false, env = process.env, home = homedir(), cloud: injected } = {}) {
  if (!project) return { error: 'A project name is required.' };
  const { cloud, error } = client(env, home, injected);
  if (error) return { error };
  const creds = readCredentials({ env, home });
  const token = creds.token;
  try {
    const orgs = await orgsOf(cloud, token);
    let targets;
    if (!enabled && !org) {
      const rules = await cloud.listAutoShare({ token });
      targets = (rules?.rules || []).filter((r) => r.project === project).map((r) => orgs.find((o) => o.id === r.orgId) || { id: r.orgId, name: r.orgId });
      if (!targets.length) return { ok: true, project, autoShare: [], message: `No auto-share rule for ${project}.` };
    } else {
      const picked = pickOrg(orgs, org, enabled ? creds.defaultOrgId : null);
      if (picked.error) return { error: picked.error };
      targets = [picked.org];
    }
    for (const o of targets) {
      if (enabled) await cloud.setAutoShare({ project, orgId: o.id, backfill: !!backfill, token });
      else await cloud.clearAutoShare({ project, orgId: o.id, token });
    }
    return { ok: true, project, action: enabled ? 'auto-share on' : 'auto-share off', orgs: targets.map((o) => o.name), backfill: enabled ? !!backfill : undefined };
  } catch (e) {
    return { error: explain(e, env, home) };
  }
}
