// Who can see my sessions: status, share, unshare, and the per-project auto-share rule.
// Called by the MCP tools (through team-invoke.js) and by `spookling sessions|share|unshare`.
// Only the owner's own sessions. Nothing here runs unless the user (or the model on the user's say-so) calls it.
import { homedir } from 'node:os';
import { CloudError, apiBase, clean, createCloud, networkMessage } from './cloud.js';
import { readCredentials } from './credentials.js';

const NOT_LOGGED_IN = 'Not logged in. Run spookling login first.';

function client(env, home, cloud) {
  if (cloud) return { cloud, error: null };
  if (!readCredentials({ env, home }).token) return { cloud: null, error: NOT_LOGGED_IN };
  try {
    apiBase(env, { home });
    return { cloud: createCloud({ env, home }), error: null };
  } catch (e) {
    return { cloud: null, error: clean(e?.message) || 'No usable API URL.' };
  }
}

function explain(e, env, home) {
  const net = networkMessage(e, { env, home });
  if (net) return net;
  if (!(e instanceof CloudError)) return 'Could not reach the Spookling API.';
  if (e.status === 401) return 'The saved login was rejected. Run spookling login again.';
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
export async function setSessionShare({ sessionId, share, org, env = process.env, home = homedir(), cloud: injected } = {}) {
  if (!sessionId) return { error: 'A session id is required.' };
  const { cloud, error } = client(env, home, injected);
  if (error) return { error };
  const creds = readCredentials({ env, home });
  const token = creds.token;
  try {
    const orgs = await orgsOf(cloud, token);
    let targets;
    if (!share && !org) {
      const mine = (await allMine(cloud, token)).find((s) => s.clientId === sessionId);
      if (!mine) return { sessionId, visibility: 'not uploaded', message: 'Nothing to unshare: this session has not been uploaded.' };
      targets = (mine.sharedWith || []).map((id) => orgs.find((o) => o.id === id) || { id, name: id });
    } else {
      const picked = pickOrg(orgs, org, share ? creds.defaultOrgId : null);
      if (picked.error) return { error: picked.error };
      targets = [picked.org];
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
