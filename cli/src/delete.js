// Delete my uploaded sessions from the cloud: one, or all. Local memory (.memory/) is never touched.
// Called by `spookling delete` and, through team-invoke.js, by the memory_delete MCP tool. Confirmation is the caller's job.
// After a delete the session is marked skipped for good in upload-state.json, so no hook or backfill sends it again.
import { homedir } from 'node:os';
import { CloudError, clean } from './cloud.js';
import { client, explain } from './share.js';
import { accountScope, readState, updateState } from './upload-state.js';
import { readCredentials } from './credentials.js';

export const MAX_ROUNDS = 50; // batches of "delete all" per command: the server deletes a batch per call

// Mark sessions deleted: skipped for good, no cursor, nothing queued. A later session with a new id is untouched.
async function markDeleted(home, env, sids) {
  if (!sids.length) return;
  const set = new Set(sids);
  await updateState(home, (st) => {
    for (const sid of set) {
      st.skipped[sid] = { reason: 'session_deleted', permanent: true };
      delete st.cursors[sid];
      delete st.links[sid];
      delete st.forkModes[sid];
    }
    st.queue = st.queue.filter((q) => !set.has(q.sid));
    st.shares = st.shares.filter((j) => !set.has(j.sid));
  }, { scope: accountScope(home, env) }).catch(() => { /* the server already refuses these with 410; the mark is a second lock */ });
}

export async function deleteSession({ sessionId, env = process.env, home = homedir(), cloud: injected } = {}) {
  if (!sessionId) return { error: 'A session id is required.' };
  const { cloud, error } = client(env, home, injected);
  if (error) return { error };
  const token = readCredentials({ env, home }).token;
  let alreadyGone = false;
  try {
    await cloud.deleteSession({ sid: sessionId, token });
  } catch (e) {
    if (e instanceof CloudError && e.status === 404) alreadyGone = true; // gone already: the goal is met
    else return { error: explain(e, env, home) };
  }
  await markDeleted(home, env, [sessionId]);
  return { ok: true, action: 'deleted', sessionId, deleted: alreadyGone ? 0 : 1, alreadyGone };
}

// every session id the local upload state knows for this account
function knownLocal(home, env) {
  const st = readState(home, accountScope(home, env));
  const ids = new Set([...Object.keys(st.cursors), ...st.queue.map((q) => q.sid), ...Object.keys(st.links), ...Object.keys(st.forkModes)]);
  for (const [sid, raw] of Object.entries(st.skipped)) if (raw?.reason !== 'org_owned') ids.add(sid);
  return ids;
}

export async function deleteAllSessions({ env = process.env, home = homedir(), cloud: injected, maxRounds = MAX_ROUNDS } = {}) {
  const { cloud, error } = client(env, home, injected);
  if (error) return { error };
  const token = readCredentials({ env, home }).token;
  let deleted = 0, remaining = 0, rounds = 0, finished = false;
  const skipped = new Map();
  try {
    while (rounds < maxRounds) {
      rounds += 1;
      const data = await cloud.deleteAllSessions({ token });
      const n = Number.isFinite(Number(data?.deleted)) ? Number(data.deleted) : 0;
      deleted += n;
      remaining = Number.isFinite(Number(data?.remaining)) ? Number(data.remaining) : 0;
      const ids = (Array.isArray(data?.deletedIds) ? data.deletedIds : []).filter((x) => typeof x === 'string' && x);
      await markDeleted(home, env, ids); // per batch: an error or the cap later still leaves these marked
      for (const s of Array.isArray(data?.skipped) ? data.skipped : []) if (s?.id) skipped.set(String(s.id), s.reason || 'org_owned');
      if (remaining <= 0) { finished = true; break; }
      if (n === 0) { finished = true; break; } // no progress: what is left cannot be deleted from here
    }
  } catch (e) {
    return { error: `${explain(e, env, home)}${deleted ? ` ${deleted} deleted before that; run it again to continue.` : ''}`, deleted };
  }
  // Only a finished run marks local sessions: with the cap hit we do not know which ones are still on the server.
  // Org-owned ones the server kept are not marked; they stay uploadable (and stay refused by the server).
  if (finished && deleted > 0) await markDeleted(home, env, [...knownLocal(home, env)].filter((sid) => !skipped.has(sid)));
  return {
    ok: true, action: 'deleted all', deleted, remaining,
    skipped: [...skipped].map(([id, reason]) => ({ id, reason })),
    incomplete: !finished,
  };
}

export const formatDelete = (out) => clean(((o) => {
  if (o.error) return o.error;
  const local = 'Local memory (.memory/) is untouched.';
  if (o.action === 'deleted') {
    return `${o.alreadyGone ? `Session ${o.sessionId} was already gone from the cloud.` : `Deleted session ${o.sessionId} from the cloud.`} It will not upload again. ${local}`;
  }
  const lines = [`Deleted ${o.deleted} ${o.deleted === 1 ? 'session' : 'sessions'} from the cloud.`];
  if (o.skipped?.length) lines.push(`Kept ${o.skipped.length} shared with an org (the org owns them): ${o.skipped.map((s) => s.id).join(', ')}`);
  if (o.incomplete) lines.push(`Stopped early with ${o.remaining} left; run spookling delete --all again to continue.`);
  else if (o.remaining > 0 && !o.skipped?.length) lines.push(`${o.remaining} could not be deleted.`);
  lines.push(`Sessions you start later upload as usual. ${local}`);
  return lines.join('\n');
})(out));
