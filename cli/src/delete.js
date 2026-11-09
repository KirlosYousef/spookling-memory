// Delete my uploaded sessions from the cloud: one, or all. Local memory (.memory/) is never touched.
// Called by `spookling delete` and, through team-invoke.js, by the memory_delete MCP tool. Confirmation is the caller's job.
// After a delete the session is marked skipped for good in upload-state.json, so no hook or backfill sends it again.
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { CloudError, clean } from './cloud.js';
import { client, explain } from './share.js';
import { accountScope, readState, updateState } from './upload-state.js';
import { readCredentials } from './credentials.js';

export const MAX_ROUNDS = 150; // batches per command (100 sessions each): room for 10,000 sessions and then some
const MAX_RATE_WAITS = 20; // consecutive 429s before giving up
const WAIT_DEFAULT_S = 20, WAIT_MAX_S = 60;

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

// a session this machine has uploaded from, queued, or linked
function knownSession(home, env, sid) {
  const st = readState(home, accountScope(home, env));
  return typeof st.cursors[sid] === 'number' || st.queue.some((q) => q.sid === sid) || sid in st.links;
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
  if (!alreadyGone || knownSession(home, env, sessionId)) await markDeleted(home, env, [sessionId]); // a typo must not leave a mark
  return { ok: true, action: 'deleted', sessionId, deleted: alreadyGone ? 0 : 1, alreadyGone, notFound: alreadyGone };
}

// local sessions that reached the cloud (they have an upload cursor). One that is only queued, offline, never did:
// it keeps its queue entry and uploads normally later.
function knownLocal(home, env) {
  return new Set(Object.keys(readState(home, accountScope(home, env)).cursors));
}

export async function deleteAllSessions({ env = process.env, home = homedir(), cloud: injected, maxRounds = MAX_ROUNDS, sleep = delay, log = () => {} } = {}) {
  const { cloud, error } = client(env, home, injected);
  if (error) return { error };
  const token = readCredentials({ env, home }).token;
  let deleted = 0, remaining = 0, rounds = 0, finished = false, waits = 0;
  const skipped = new Map();
  try {
    while (rounds < maxRounds) {
      let data;
      try {
        data = await cloud.deleteAllSessions({ token });
      } catch (e) {
        if (!(e instanceof CloudError && e.status === 429) || (waits += 1) > MAX_RATE_WAITS) throw e;
        const secs = Math.min(Number(e.retryAfter) > 0 ? Number(e.retryAfter) : WAIT_DEFAULT_S, WAIT_MAX_S);
        log(`Rate limited; waiting ${secs}s… (${deleted} deleted so far)`);
        await sleep(secs * 1000);
        continue;
      }
      waits = 0;
      rounds += 1;
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
    return `${o.alreadyGone ? `Session ${o.sessionId} was not found in the cloud (already deleted, or never uploaded).` : `Deleted session ${o.sessionId} from the cloud.`} It will not upload again. ${local}`;
  }
  const lines = [`Deleted ${o.deleted} ${o.deleted === 1 ? 'session' : 'sessions'} from the cloud.`];
  if (o.skipped?.length) lines.push(`Kept ${o.skipped.length} shared with an org (the org owns them): ${o.skipped.map((s) => s.id).join(', ')}`);
  if (o.incomplete) lines.push(`Stopped early with ${o.remaining} left; run spookling delete --all again to continue.`);
  else if (o.remaining > 0 && !o.skipped?.length) lines.push(`${o.remaining} could not be deleted.`);
  lines.push(`Sessions you start later upload as usual. ${local}`);
  return lines.join('\n');
})(out));
