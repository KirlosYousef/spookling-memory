// Who can see my sessions: status, share, unshare, and the per-project auto-share rule.
// Called by the MCP tools (through team-invoke.js) and by `spookling sessions|share|unshare`.
// Only the owner's own sessions. Nothing here runs unless the user (or the model on the user's say-so) calls it.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { CloudError, apiBase, clean, createCloud, networkMessage } from './cloud.js';
import { readCredentials, setDefaultOrg } from './credentials.js';
import { pushFromLog, projectLog, sessionTitle } from './push.js';
import { accountScope, readState, takeShareFailures, updateState } from './upload-state.js';

const NOT_LOGGED_IN = 'Not logged in. Run `spookling login`, then try again.';

export function client(env, home, cloud) {
  if (cloud) return { cloud, error: null };
  if (!readCredentials({ env, home }).token) return { cloud: null, error: NOT_LOGGED_IN };
  try {
    apiBase(env, { home });
    return { cloud: createCloud({ env, home }), error: null };
  } catch (e) {
    return { cloud: null, error: clean(e?.message) || 'No usable API URL. Run `spookling login` to set one.' };
  }
}

export function explain(e, env, home) {
  const net = networkMessage(e, { env, home });
  if (net) return net;
  if (!(e instanceof CloudError)) return 'Could not reach the Spookling API. Check your connection and try again.';
  if (e.status === 401) return 'The saved login was rejected. Run `spookling login` to sign in again.';
  if (e.status === 403 && e.reason === 'org_owned') return 'That session is shared with an org and now belongs to it, so it cannot be deleted from here. Ask an org admin to remove it.';
  if (e.status === 410) return 'That session was deleted from the cloud, so it cannot be changed. Pick another session.';
  if (e.status === 403) return 'You are not an active member of that org. Run `spookling orgs` to see your orgs, then use one of them.';
  if (e.status === 404) return 'The server does not know that session or org yet. Run `spookling orgs` to check the org, or try again after the session saves.';
  if (e.status === 429) return 'Rate limited. Wait a minute, then try again.';
  return e.code ? `The API refused it (${clean(e.code)}). Try again; if it keeps failing, run \`spookling status\`.` : 'Could not reach the Spookling API. Check your connection and try again.';
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

const NO_ORG = 'You are not an active member of any org, so there is nobody to share with. Join or create an org in the Spookling web app, then try again.';
const names = (orgs) => orgs.map((o) => `'${clean(o.name)}'`).join(', ');

/**
 * Which org a share goes to. "wanted" is an id or a case-insensitive name. With no name: the saved default when it is still one of
 * yours, else your only org, else the caller must ask (needOrg, with the choices). Never guesses between several.
 * { org, note? } or { error, needOrg?, orgs? }. A note says something the user should know (a default that no longer applies).
 */
export function pickOrg(orgs, wanted, defaultId = null, { stale = '' } = {}) {
  let w = typeof wanted === 'string' ? wanted.trim().toLowerCase() : '';
  const gone = !!defaultId && !orgs.some((o) => o.id === defaultId);
  const was = stale || (gone ? defaultId : '');
  const note = !w && was ? `Your saved default org '${clean(was)}' is no longer one of your orgs, so it was ignored.` : '';
  if (!w && defaultId && !gone) w = defaultId.toLowerCase();
  if (w) {
    const hit = orgs.find((o) => o.id.toLowerCase() === w || o.name.toLowerCase() === w);
    return hit ? { org: hit } : { error: `No org matches "${clean(wanted)}". Your orgs: ${names(orgs) || 'none'}. Name one of those orgs.`, needOrg: orgs.length > 1, orgs };
  }
  if (orgs.length === 1) return { org: orgs[0], only: true, ...(note ? { note: `${note} Using '${clean(orgs[0].name)}', your only org.` } : {}) };
  if (!orgs.length) return { error: NO_ORG };
  return { error: `You are in several orgs: ${names(orgs)}. Run again with --org '<name>'.${note ? ` ${note}` : ''}`, needOrg: true, orgs, ...(note ? { note } : {}) };
}

/** The saved default org, checked against the live list. A default that no longer applies is cleared and reported. */
function checkedDefault(creds, orgs, home) {
  if (creds.defaultOrgId && orgs.some((o) => o.id === creds.defaultOrgId)) return { id: creds.defaultOrgId, stale: '' };
  const was = creds.defaultOrgId ? (creds.defaultOrgName || creds.defaultOrgId) : creds.staleDefaultOrg;
  if (!was) return { id: null, stale: '' };
  try { setDefaultOrg(null, { home }); } catch { /* a stale default is ignored either way */ }
  return { id: null, stale: clean(was) };
}

/** pickOrg against the live list, with the saved default checked first. */
export function pickLiveOrg(orgs, wanted, creds, home) {
  const d = checkedDefault(creds, orgs, home);
  return pickOrg(orgs, wanted, d.id, { stale: d.stale });
}

/** The orgs this login belongs to right now (asks the API), for `spookling orgs`, whoami, status and the team_orgs tool. */
export async function liveOrgs({ env = process.env, home = homedir(), cloud: injected } = {}) {
  const { cloud, error } = client(env, home, injected);
  if (error) return { error };
  const creds = readCredentials({ env, home });
  try {
    const orgs = await orgsOf(cloud, creds.token);
    const d = checkedDefault(creds, orgs, home);
    let api = ''; try { api = apiBase(env, { home }); } catch { /* none */ }
    return {
      api, user: creds.user?.name || creds.user?.email || creds.user?.id || '',
      orgs: orgs.map((o) => ({ id: o.id, name: clean(o.name), default: o.id === d.id })),
      defaultOrg: d.id ? clean(orgs.find((o) => o.id === d.id).name) : null,
      ...(d.stale ? { note: `Your saved default org '${d.stale}' is no longer one of your orgs, so it was cleared.` } : {}),
      message: orgs.length ? `You are an active member of ${orgs.length === 1 ? '1 org' : `${orgs.length} orgs`}, checked just now.` : NO_ORG,
    };
  } catch (e) {
    return { error: explain(e, env, home) };
  }
}

// ---- the session a share is about, when the caller did not name one ----

const WEB_BASE = 'https://app.spookling.com';

/**
 * Where a session is read in the web app, or '' when this API has no known web app or the user id is not saved. The web route takes the
 * session's read id, `<ownerId>:<clientId>` (the API answers a bare client id with 400). SPOOKLING_APP_URL overrides the app's origin.
 */
export function webUrl(sessionId, { env = process.env, home = homedir() } = {}) {
  let base = typeof env.SPOOKLING_APP_URL === 'string' ? env.SPOOKLING_APP_URL.trim().replace(/\/+$/, '') : '';
  if (!/^https:\/\/[^/\s]+$/.test(base)) {
    base = '';
    try { if (apiBase(env, { home }) === 'https://api.spookling.com') base = WEB_BASE; } catch { /* no known web app */ }
  }
  const owner = readCredentials({ env, home }).user?.id;
  return base && sessionId && owner ? `${base}/memory/${encodeURIComponent(`${owner}:${sessionId}`)}` : '';
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

// Where the Stop hook may have written the session: .memory/log.jsonl of the folder Claude Code started in (the hook's cwd, or
// CLAUDE_PROJECT_DIR), else ~/.memory. This command's own folder may have moved down since (Claude cd'd into a subfolder), so its parents count too.
function logPaths(projectDir, home, env = process.env) {
  const dirs = [];
  for (let d = projectDir, i = 0; d && i < 24; i += 1) {
    dirs.push(d);
    const up = dirname(d);
    if (up === d || d === home) break;
    d = up;
  }
  if (typeof env.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR) dirs.push(env.CLAUDE_PROJECT_DIR);
  return [...new Set([...dirs.map((d) => join(d, '.memory', 'log.jsonl')), join(home, '.memory', 'log.jsonl')])];
}

function readLog(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

/** What the local log knows about a session: { title, turns, logPath } or null. Local files only. */
export function localSession(sessionId, { projectDir = process.cwd(), home = homedir(), env = process.env } = {}) {
  for (const logPath of logPaths(projectDir, home, env)) {
    const text = readLog(logPath);
    if (!text.includes(sessionId)) continue;
    const hit = projectLog(text, { forks: {} }).find((x) => x.sid === sessionId);
    if (hit) return { title: hit.session.title, turns: hit.turns.length, logPath };
  }
  return null;
}

// The newest session in a local log, by its last turn's timestamp.
function newestLocal(projectDir, home, env = process.env) {
  for (const path of logPaths(projectDir, home, env)) {
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
  const local = newestLocal(projectDir, home, env);
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
  return { error: 'No session found here. Run this inside a project that has a Spookling session, or give a session id (`spookling sessions` lists them).' };
}

// ---- explicit shares queued until the session is on the server ----

function queuedShares(home, env, sid) {
  return readState(home, accountScope(home, env)).shares.filter((j) => j.orgId && j.sid === sid);
}

async function queueShare(home, env, job) {
  job = { ...job, at: new Date().toISOString() };
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
export async function shareStatus({ sessionId, project, env = process.env, home = homedir(), cloud: injected, notify = true } = {}) {
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
    // queued shares that were dropped at flush: said once, then forgotten (the caller prints `notices`)
    const notices = notify ? await takeShareFailures(home, env).catch(() => []) : [];
    const note = notices.length ? { notices } : {};
    const autoShare = (rules?.rules || []).map((r) => ({ project: r.project, orgId: r.orgId, org: names.get(r.orgId) || r.orgId }));
    if (sessionId) {
      const hit = mine.find((s) => s.clientId === sessionId);
      if (!hit) {
        const q = queuedShares(home, env, sessionId);
        if (q.length) {
          const where = q.map((j) => names.get(j.orgId) || j.orgId);
          return { sessionId, visibility: 'share pending', pendingOrgs: where, message: `Share pending: will be shared with ${where.join(', ')} after this session's next save.`, autoShare, ...note };
        }
      }
      if (!hit) return { sessionId, visibility: 'not uploaded', message: 'This session has not been uploaded yet (it uploads when it stops). Nothing is shared.', autoShare, ...note };
      const v = view(hit, names);
      return { ...v, autoShare: autoShare.filter((r) => r.project === v.project), ...note };
    }
    return { sessions: mine.map((s) => view(s, names)), autoShare: project ? autoShare.filter((r) => r.project === project) : autoShare, ...note };
  } catch (e) {
    return { error: explain(e, env, home) };
  }
}

// share: true or false. Undoes nothing else; a colleague who already read it is not un-told.
// A session not on the server yet is uploaded now from its local log (the Stop hook's path); if that cannot be done it is queued, and
// the next upload applies it. sessionId may be left out: it is then the current session (see currentSession).
export async function setSessionShare({ sessionId, share, org, projectDir = process.cwd(), env = process.env, home = homedir(), cloud: injected } = {}) {
  let explicitId = !!sessionId;
  if (!sessionId) {
    const cur = await currentSession({ env, home, projectDir, cloud: injected });
    if (cur.error) return { error: cur.error };
    sessionId = cur.sessionId;
  }
  // the session this terminal runs in may not have logged a turn yet: that one may wait in the queue
  if (['SPOOKLING_SESSION_ID', 'CLAUDE_SESSION_ID'].some((k) => typeof env[k] === 'string' && env[k].trim() === sessionId)) explicitId = false;
  const { cloud, error } = client(env, home, injected);
  if (error) return { error };
  const creds = readCredentials({ env, home });
  const token = creds.token;
  try {
    const orgs = await orgsOf(cloud, token);
    let targets;
    let note = '';
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
      const picked = share ? pickLiveOrg(orgs, org, creds, home) : pickOrg(orgs, org);
      if (picked.error) return { error: picked.error, ...(picked.needOrg ? { needOrg: true, orgs: picked.orgs } : {}) };
      targets = [picked.org];
      note = picked.note || '';
      if (!share) {
        const dropped = await dropQueued(home, env, sessionId, picked.org.id);
        if (dropped && !(await onServer())) return { ok: true, action: 'unshared', sessionId, visibility: 'not uploaded', message: 'Cancelled the pending share.' };
      }
    }
    if (share) {
      let mine = await onServer();
      let project = mine?.project || '';
      let uploadFailed = false;
      if (!mine) {
        const local = localSession(sessionId, { projectDir, home, env });
        project = projectOf(projectDir, home) || (local ? projectOf(dirname(dirname(local.logPath)), home) : ''); // as the Stop hook names it
        if (local && local.turns > 0) {
          const r = await pushFromLog({ logPath: local.logPath, home, env, cloud, project, sessionId, log: () => {} });
          // a refused upload for this session (offline, 5xx, 401, rate limit) leaves it half sent at best: queue the share, do not apply it
          uploadFailed = !!r?.failed?.some((f) => f.sid === sessionId);
          mine = uploadFailed ? undefined : await onServer().catch(() => undefined);
        }
      }
      // an id the user typed that is in no local log and not on the server is a typo: queueing it would wait forever
      if (!mine && explicitId && !localSession(sessionId, { projectDir, home, env })) return { error: `No session ${sessionId} found here or in the cloud. Check the id (it is printed as "Spookling session"), or share the current session without an id.` };
      if (!mine) {
        const o = targets[0];
        await queueShare(home, env, { sid: sessionId, project, orgId: o.id, org: o.name, title: localSession(sessionId, { projectDir, home, env })?.title || sessionId });
        // the Stop hook may have finished its upload (and its share flush) while this ran: look once more, so the job is not left waiting
        if (!uploadFailed && (mine = await onServer().catch(() => undefined))) await dropQueued(home, env, sessionId, o.id);
      }
      if (!mine) {
        const o = targets[0];
        return {
          ok: true, pending: true, action: 'share pending', sessionId, orgs: [o.name], visibility: 'share pending',
          message: `Will be shared with ${o.name} after this session's next save.`, ...(note ? { note } : {}),
        };
      }
    }
    for (const o of targets) {
      if (share) await cloud.shareSession({ sid: sessionId, orgId: o.id, token });
      else await cloud.unshareSession({ sid: sessionId, orgId: o.id, token });
    }
    const after = await shareStatus({ sessionId, env, home, cloud });
    return { ok: true, action: share ? 'shared' : 'unshared', orgs: targets.map((o) => o.name), ...(note ? { note } : {}), ...after };
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
    let note = '';
    if (!enabled && !org) {
      const rules = await cloud.listAutoShare({ token });
      targets = (rules?.rules || []).filter((r) => r.project === project).map((r) => orgs.find((o) => o.id === r.orgId) || { id: r.orgId, name: r.orgId });
      if (!targets.length) return { ok: true, project, autoShare: [], message: `No auto-share rule for ${project}.` };
    } else {
      const picked = enabled ? pickLiveOrg(orgs, org, creds, home) : pickOrg(orgs, org);
      if (picked.error) return { error: picked.error, ...(picked.needOrg ? { needOrg: true, orgs: picked.orgs } : {}) };
      targets = [picked.org];
      note = picked.note || '';
    }
    for (const o of targets) {
      if (enabled) await cloud.setAutoShare({ project, orgId: o.id, backfill: !!backfill, token });
      else await cloud.clearAutoShare({ project, orgId: o.id, token });
    }
    return { ok: true, project, action: enabled ? 'auto-share on' : 'auto-share off', orgs: targets.map((o) => o.name), backfill: enabled ? !!backfill : undefined, ...(note ? { note } : {}) };
  } catch (e) {
    return { error: explain(e, env, home) };
  }
}
