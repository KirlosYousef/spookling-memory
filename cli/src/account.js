// Optional sign-in. init never calls this. A 429 while polling waits; it does not log out.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { VERSION, apiBase, clean, createCloud, isNetworkError, networkMessage } from './cloud.js';
import { forgetTeamFeed, readCredentials, removeStoredToken, setDefaultOrg, writeCredentials } from './credentials.js';
import { noteUpload } from './upload-state.js';
import { clearLoginExpired, deletedSessionIds, pushFromLog, projectLog, uploadedCursors } from './push.js';
import { offerAllowShare } from './allow-share.js';
import { orgRecords } from './team.js';
import { cachedNotice } from './registry.js';

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const inSpookling = (h) => h === 'spookling.com' || h.endsWith('.spookling.com');

/**
 * The sign-in link comes from the server, so it is opened only when it is https (http on this machine) and its host is the
 * API's own host, a spookling.com host while the API is one too, or this machine while the API is. Else null.
 */
export function safeVerificationUri(uri, apiBaseUrl) {
  const t = linkTrust(uri, apiBaseUrl);
  return t.kind === 'trusted' ? t.href : null;
}

/**
 * { kind: 'trusted', href }: on the API's host, a spookling.com host, or this machine while the API is.
 * { kind: 'untrusted', href, host }: a well-formed https (or localhost http) link, with no login in it, on another host: the user may be asked.
 * { kind: 'invalid' }: anything else (a bad scheme, credentials, not a URL): never opened, never offered.
 */
export function linkTrust(uri, apiBaseUrl) {
  try {
    const u = new URL(String(uri));
    const api = new URL(apiBaseUrl);
    if (u.username || u.password) return { kind: 'invalid' };
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.has(u.hostname))) return { kind: 'invalid' };
    const same = u.hostname === api.hostname
      || (inSpookling(u.hostname) && inSpookling(api.hostname))
      || (LOCAL.has(u.hostname) && LOCAL.has(api.hostname));
    return same ? { kind: 'trusted', href: u.href } : { kind: 'untrusted', href: u.href, host: u.hostname };
  } catch { return { kind: 'invalid' }; }
}

/** The program and arguments that open a URL. Windows does not go through cmd, so the URL is never parsed as a command line. */
export function openerCommand(url, platform = process.platform) {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  return { cmd: 'xdg-open', args: [url] };
}

// Resolves true once the opener started, false when it could not (no opener, no display).
function openBrowser(url) {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return Promise.resolve(false);
  const { cmd, args } = openerCommand(url);
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
      child.on('error', () => resolve(false));
      child.on('spawn', () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}

const { projectName } = createRequire(import.meta.url)('../../hooks/upload-session.cjs');

const say = (write, line) => write(`${line}\n`);
const code = (e) => e?.code || e?.status || 'offline';
// the unreachable sentence, else what each caller says about its own failure
const unreachable = (e, env, home) => networkMessage(e, { env, home });

const BACKOFF_MAX_MS = 30_000;
const DEFAULT_POLL_S = 3; // seconds between polls when the server names none
const DEFAULT_EXPIRES_S = 600; // a device code's life when the server names none

// term.js installs signal and exit handlers, so it is loaded only when a prompt or colour is wanted
async function termHelpers() {
  const t = await import('./term.js');
  return { paint: t.paint, C: t.C, confirm: t.confirm, choose: t.choose };
}

/** The local logs `login` knows about: this project's and the home one, the two places Stop looks. */
function localLogs({ home = homedir(), cwd } = {}) {
  const found = [];
  for (const dir of [cwd, home]) {
    if (!dir) continue;
    const path = join(dir, '.memory', 'log.jsonl');
    if (existsSync(path) && !found.some((f) => f.path === path)) {
      found.push({ path, project: projectName(dir) });
    }
  }
  return found;
}

/** Sessions in these logs with turns the server has not been sent. Reads only. */
function pastSessions(logs, home) {
  const cursors = uploadedCursors(home); // this account's, on this server: another account's uploads do not count
  const seen = new Set(deletedSessionIds(home)); // sessions deleted from the cloud are never offered again
  const out = [];
  for (const log of logs) {
    let text = '';
    try { text = readFileSync(log.path, 'utf8'); } catch { continue; }
    for (const s of projectLog(text)) {
      const last = s.turns.length ? s.turns[s.turns.length - 1].seq : -1;
      const done = typeof cursors[s.sid] === 'number' && cursors[s.sid] >= last;
      if (done || seen.has(s.sid)) continue;
      seen.add(s.sid);
      out.push(s.sid);
    }
  }
  return out;
}

// Default org after approval. Never throws; login has already succeeded.
async function chooseDefaultOrg({ client, token, home, write, choose }) {
  let list;
  try { list = orgRecords(await client.listOrgs({ token })); } catch {
    say(write, 'Could not read your orgs. Run spookling orgs later.');
    return;
  }
  setDefaultOrg(null, { home });
  if (!list.length) {
    say(write, 'You are not in an org yet. Sessions upload privately; sharing needs an org.');
    return;
  }
  let org = list[0];
  if (list.length > 1) {
    try {
      const i = await choose('   Which org should be your default?', list.map((o) => clean(o.name)), 0);
      org = list[i] || list[0];
    } catch { org = list[0]; }
  }
  setDefaultOrg(org, { home });
  say(write, `Default org: ${clean(org.name)}`);
}

const PAST_PACE_MS = 150; // between sessions in the login backfill; Stop-hook uploads are not paced
const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

// One updating line (spinner and count) while `work` runs; only on a terminal, nothing at all otherwise.
// The line is cleared before this returns or throws, and the timer always stops so the process can exit.
export async function withProgress({ write, tty, label, total, interval = 90 }, work) {
  // progress(n) sets the count; progress.say(text) prints a line of its own; progress.status(text) sets a short note on the spinner
  if (!tty) {
    const quiet = (() => {});
    quiet.say = (m) => write(`${m}\n`);
    quiet.status = () => {};
    return work(quiet);
  }
  let done = 0, frame = 0, note = '';
  const draw = () => write(`\r\x1b[2K${FRAMES[frame++ % FRAMES.length]} ${label}… ${done}/${total}${note ? ` · ${note}` : ''}`);
  draw();
  const timer = setInterval(draw, interval);
  timer.unref?.();
  const progress = (n) => { done = Math.min(n, total); draw(); };
  progress.say = (m) => { write(`\r\x1b[2K${m}\n`); draw(); };
  progress.status = (t) => { note = String(t || ''); draw(); };
  try {
    return await work(progress);
  } finally {
    clearInterval(timer);
    write('\r\x1b[2K');
  }
}

// Offer to upload what is already logged. Never throws and never changes the login result.
async function backfill({ home, cwd, env, cloud, write, confirm, tty = false, sleep }) {
  try {
    const logs = localLogs({ home, cwd });
    const sids = pastSessions(logs, home);
    if (!sids.length) return;
    const n = sids.length;
    const noun = n === 1 ? 'session' : 'sessions';
    const yes = await confirm(`Upload your ${n} past ${noun} privately? Only you can see them until you share.`, true);
    if (!yes) {
      say(write, 'Skipped. They upload one by one when a session stops.');
      return;
    }
    let pushed = 0, queued = false, waiting = 0;
    const failed = [], skipped = [];
    const pace = { ms: PAST_PACE_MS, sent: false }; // shared across logs so the pause carries over
    await withProgress({ write, tty, label: 'Uploading past sessions', total: n }, async (progress) => {
      for (const log of logs) {
        const base = pushed;
        const r = await pushFromLog({ logPath: log.path, home, env, cloud, project: log.project, onProgress: (d) => progress(base + d),
          log: (m) => noteUpload(home, m), notify: progress.say, status: progress.status, pace, sleep });
        pushed += r.pushed || 0;
        progress(pushed);
        if (r.queued) queued = true;
        waiting += r.queuedCount || 0;
        failed.push(...(r.failed || []));
        skipped.push(...(r.skipped || []));
      }
    });
    const labels = [...new Set(skipped.map((k) => (k.reason === 'seq_conflict' ? 'conflict' : String(k.reason).replace(/_/g, ' '))))];
    const skipNote = skipped.length ? ` ${skipped.length} skipped (${labels.join(', ')}).` : '';
    say(write, `Uploaded ${pushed} ${pushed === 1 ? 'session' : 'sessions'} privately.${skipNote}`);
    if (queued) {
      // the uploader stops at the first refusal and leaves the rest queued, so count tried and untried apart, and name each distinct reason
      const reasons = [...new Set(failed.map((f) => f.why))];
      const untried = Math.max(0, waiting - failed.length);
      const n = failed.length;
      if (n) say(write, `${n} ${n === 1 ? 'session' : 'sessions'} could not be uploaded: ${reasons.join('; ')}${untried ? `; ${untried} more ${untried === 1 ? 'was' : 'were'} not tried` : ''}.`);
      else say(write, `${waiting || 'Some'} ${waiting === 1 ? 'session' : 'sessions'} did not go up.`);
      const server = failed.some((f) => /^5\d\d\b/.test(f.why));
      say(write, `${server ? 'The server had a problem, not your setup. ' : ''}They stay queued and retry at the next Stop, or run spookling refresh.`);
    }
    say(write, `Looked in ${logs.map((l) => l.path.replace(home, '~')).join(' and ')}. Other projects upload when their next session stops.`);
  } catch (e) {
    say(write, `Could not upload past sessions (${e?.code || e?.message || 'error'}). They upload at the next Stop; spookling refresh checks the connection.`);
  }
}

// The client for this login and the origin it talks to; null (after saying why) when there is none.
function loginClient({ cloud, env, home, apiUrl, write }) {
  let client = cloud;
  if (!client) {
    try { client = createCloud({ env, home, loginUrl: apiUrl }); } catch (e) {
      say(write, e.message);
      return null;
    }
  }
  try {
    const origin = typeof client.loginBase === 'function' ? client.loginBase() : typeof client.base === 'function' ? client.base() : apiBase(env, { home });
    return { client, origin };
  } catch (e) {
    say(write, clean(e.message));
    return null;
  }
}

// Print the link and the code, and open the link when it is safe to.
async function showLink({ started, origin, term, openUrl, write, tty, confirmOpen }) {
  const link = clean(started.verificationUri);
  const trust = linkTrust(link, origin);
  const apiHost = new URL(origin).hostname;
  const ask = trust.kind === 'untrusted' && tty;
  say(write, trust.kind === 'trusted' ? 'Opening your browser to sign in to Spookling…'
    : ask ? `This sign-in link is on ${clean(trust.host)}, not on ${apiHost} or spookling.com.`
      : `Warning: this sign-in link is not on ${apiHost} or spookling.com, so it was not opened. Check it before you visit it:`);
  say(write, `  ${term.paint(term.C.LILAC, link)}`);
  if (started.userCode) say(write, `Confirm this code matches: ${term.paint(term.C.GHOST, clean(started.userCode), true)}`);
  // another host: only an explicit yes at a terminal opens it. No terminal, no prompt, no open.
  const go = trust.kind === 'trusted' || (ask && await confirmOpen('Open it in your browser?', false));
  if (ask && !go) say(write, 'Not opened. Open the link above yourself if you trust it.');
  let opened = true;
  if (go) { try { opened = await openUrl(trust.href); } catch { opened = false; } }
  if (go && opened === false) say(write, 'Open the link above in a browser.');
  say(write, 'Waiting for approval… (Ctrl-C to cancel)');
}

// Poll until the code is approved, denied, invalid or expired. A 429 waits; a network error or 5xx backs off and tries again.
// Returns { status: 'approved', data } | { status: 'denied' | 'invalid' | 'expired' | 'error', error?, down? }.
async function pollApproval({ client, started, sleep, now }) {
  const interval = Number(started.interval) > 0 ? Number(started.interval) : DEFAULT_POLL_S;
  const deadline = now() + (Number(started.expiresIn) > 0 ? Number(started.expiresIn) : DEFAULT_EXPIRES_S) * 1000;
  let failures = 0, down = false;
  while (now() < deadline) {
    await sleep(interval * 1000);
    if (now() >= deadline) break;
    let data;
    try {
      data = await client.pollToken({ deviceCode: started.deviceCode });
      failures = 0;
    } catch (e) {
      if (e.status === 429) {
        await sleep((Number(e.retryAfter) > 0 ? Number(e.retryAfter) : interval) * 1000);
        continue;
      }
      if (e.status === 404) return { status: 'invalid' };
      if (isNetworkError(e) || e.status >= 500) {
        down = isNetworkError(e) || down;
        failures += 1;
        await sleep(Math.min(interval * 1000 * 2 ** failures, BACKOFF_MAX_MS));
        continue;
      }
      return { status: 'error', error: e };
    }
    if (data?.status === 'pending') { down = false; continue; }
    if (data?.status === 'approved' && data.token) return { status: 'approved', data };
    if (data?.status === 'denied') return { status: 'denied' };
    return { status: 'expired' };
  }
  return { status: 'expired', down };
}

// Approved: save the token with the origin it came from, then the default org and the offer to upload past sessions. None can fail the login.
async function finishLogin({ data, origin, client, label, home, env, cloud, cwd, term, confirm, choose, write, tty, sleep }) {
  // a different account or API leaves its cached team feed (and default org, see writeCredentials) behind
  const before = readCredentials({ env: {}, home });
  if (before.savedToken && ((before.apiUrl || '') !== (origin || '') || (before.user?.id || '') !== (data.user?.id || ''))) forgetTeamFeed(home);
  writeCredentials({ token: data.token, user: data.user ?? null, label: label || hostname(), apiUrl: origin }, { home });
  try { await clearLoginExpired(home); } catch { /* a stale flag is harmless */ }
  const name = clean(data.user?.name || data.user?.email || data.user?.id);
  say(write, name ? `Logged in as ${name}.` : 'Logged in.');
  await chooseDefaultOrg({ client, token: data.token, home, write, choose: choose || term.choose });
  await backfill({ home, cwd, env, cloud, write, confirm: confirm || term.confirm, tty, sleep });
  await offerAllowShare({ home, cwd: cwd || process.cwd(), env, write: (s) => write(s), confirm: confirm || term.confirm, tty });
}

export async function login({
  home, env = process.env, cloud, label, sleep = delay, openUrl = openBrowser, now = () => Date.now(),
  write = (s) => process.stdout.write(s), cwd, confirm, choose, apiUrl, tty = !!(process.stdin.isTTY && process.stdout.isTTY), confirmOpen,
} = {}) {
  const picked = loginClient({ cloud, env, home, apiUrl, write });
  if (!picked) return 1;
  const { client, origin } = picked;
  const term = await termHelpers();
  let started;
  try {
    started = await client.deviceStart({ label: label || hostname() });
  } catch (e) {
    // API Gateway answers a wrong address or stage with a bare {"message":"Forbidden"}: no error envelope, so no code
    if (e?.status === 403 && !e.code) say(write, "Couldn't start login: that address doesn't look like a Spookling API (got 403). Check the URL, including any stage path such as /v1.");
    else say(write, unreachable(e, env, home) || `Could not start login (${code(e)}).`);
    return 1;
  }
  if (!started?.verificationUri || !started.deviceCode) {
    say(write, 'The API did not return a verification page.');
    return 1;
  }
  await showLink({ started, origin, term, openUrl, write, tty, confirmOpen: confirmOpen || term.confirm });
  const outcome = await pollApproval({ client, started, sleep, now });
  switch (outcome.status) {
    case 'approved':
      await finishLogin({ data: outcome.data, origin, client, label, home, env, cloud, cwd, term, confirm, choose, write, tty, sleep });
      return 0;
    case 'invalid': say(write, 'This login code is no longer valid.'); return 1;
    case 'denied': say(write, 'Login denied.'); return 1;
    case 'error': say(write, `Could not reach the API (${code(outcome.error)}).`); return 1;
    default:
      say(write, outcome.down ? `Login expired, and ${origin || 'the API'} could not be reached. Check your connection and run spookling login again.` : 'Login expired.');
      return 1;
  }
}

export async function logout({
  home, env = process.env, cloud, log = (m) => process.stderr.write(`${m}\n`),
  write = (s) => process.stdout.write(s),
} = {}) {
  const creds = readCredentials({ home, env });
  if (creds.token) {
    let client = cloud;
    if (!client) {
      try { client = createCloud({ env, home, token: creds.token }); } catch { client = null; }
    }
    if (client) {
      try { await client.revokeCurrent({ token: creds.token }); } catch (e) {
        log(`${unreachable(e, env, home) || `The API was not reached (${code(e)}).`} The saved token was still removed.`);
      }
    }
  }
  removeStoredToken(home);
  if (creds.fromEnv) say(write, 'Logged out of the saved token. SPOOKLING_TOKEN is still set in this shell.');
  else say(write, 'Logged out.');
  return 0;
}

export function whoami({ home, env = process.env, write = (s) => process.stdout.write(s), orgsFollow = false } = {}) {
  const creds = readCredentials({ home, env });
  let base = null;
  try { base = apiBase(env, { home }); } catch { /* the saved user is enough when no URL is stored yet */ }
  if (!creds.token) {
    say(write, 'Not logged in.');
    return 1;
  }
  const u = creds.user || {};
  const who = creds.fromEnv ? 'Logged in with SPOOKLING_TOKEN.'
    : clean([u.name, u.email].filter(Boolean).join(' ') || u.id || 'Logged in.');
  say(write, who);
  if (base) say(write, `API ${base}`);
  if (!orgsFollow) say(write, `Default org ${clean(creds.defaultOrgName || creds.defaultOrgId || 'none')}${creds.defaultOrgId ? ' (saved; spookling orgs checks it live)' : ''}`);
  const newer = cachedNotice({ home: home ?? undefined, current: VERSION, env });
  if (newer) say(write, `! update   ${newer} is available. Run spookling update.`);
  return 0;
}

// The orgs this login is an active member of: GET /cli/orgs.
export async function orgs({
  home, env = process.env, cloud, write = (s) => process.stdout.write(s), heading = false,
} = {}) {
  const creds = readCredentials({ home, env });
  if (!creds.token) {
    say(write, 'Not logged in. Run spookling login.');
    return 1;
  }
  let listed;
  try {
    const client = cloud || createCloud({ env, home, token: creds.token });
    listed = await client.listOrgs({ token: creds.token });
  } catch (e) {
    say(write, e.status === 401 ? 'The saved login was rejected. Run spookling login.'
      : unreachable(e, env, home) || `Could not list orgs (${code(e)}).`);
    return 1;
  }
  const list = orgRecords(listed);
  if (heading) say(write, 'Orgs (checked just now):');
  // the saved default is only kept when it is still one of these
  const stale = creds.defaultOrgId && !list.some((o) => o.id === creds.defaultOrgId) ? (creds.defaultOrgName || creds.defaultOrgId) : creds.staleDefaultOrg;
  if (stale) {
    try { setDefaultOrg(null, { home }); } catch { /* the note is enough */ }
    say(write, `Your saved default org '${clean(stale)}' is no longer one of your orgs, so it was cleared.${list.length > 1 ? ' Pick one when you share, or run spookling login to choose a default.' : ''}`);
  }
  if (!list.length) {
    say(write, 'You are not in an org. Join or create one in the Spookling web app, then run spookling orgs again.');
    return 0;
  }
  const kept = stale ? null : creds.defaultOrgId;
  for (const o of list) say(write, `${clean(o.id)}  ${clean(o.name)}${o.id === kept ? '  (default)' : ''}`);
  return 0;
}

const day = (iso) => (typeof iso === 'string' && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') : 'never');

/**
 * `spookling tokens` lists this account's CLI tokens. `tokens revoke <id>` (a unique prefix of at least 6 characters is enough)
 * or `tokens revoke --all` revokes. Revoking the token this device uses, or all of them, also forgets the saved login.
 */
export async function tokens({
  home, env = process.env, cloud, revoke = false, id = '', all = false, write = (s) => process.stdout.write(s),
} = {}) {
  const creds = readCredentials({ home, env });
  if (!creds.token) {
    say(write, 'Not logged in. Run spookling login.');
    return 1;
  }
  const fail = (e) => {
    say(write, e.status === 401 ? 'The saved login was rejected. Run spookling login.'
      : e.status === 404 ? 'No token with that id.'
        : unreachable(e, env, home) || `Could not reach the token list (${clean(code(e))}).`);
    return 1;
  };
  let client = cloud;
  try { client ||= createCloud({ env, home, token: creds.token }); } catch (e) { say(write, clean(e.message)); return 1; }
  if (revoke && !all && !id) {
    say(write, 'usage: spookling tokens revoke <id> | --all');
    return 2;
  }
  try {
    if (revoke && all) {
      await client.revokeAllTokens({ token: creds.token });
      removeStoredToken(home);
      say(write, 'Revoked every token. This device is logged out too; run spookling login to sign in again.');
      return 0;
    }
    const listed = await client.listTokens({ token: creds.token });
    const rows = (Array.isArray(listed?.tokens) ? listed.tokens : []).filter((t) => t && typeof t.id === 'string');
    if (!revoke) {
      if (!rows.length) say(write, 'No tokens.');
      for (const t of rows) {
        say(write, `${clean(t.id)}  ${clean(t.label || '-')}  created ${day(t.createdAt)}  last used ${day(t.lastUsedAt)}${t.current ? '  (this device)' : ''}`);
      }
      return 0;
    }
    const hits = rows.filter((t) => t.id === id || (id.length >= 6 && t.id.startsWith(id)));
    if (hits.length !== 1) {
      say(write, hits.length ? 'That prefix matches more than one token. Use more of the id.' : 'No token with that id.');
      return 1;
    }
    await client.revokeToken({ id: hits[0].id, token: creds.token });
    if (hits[0].current) {
      removeStoredToken(home);
      say(write, 'Revoked this device\'s token and logged out. Run spookling login to sign in again.');
    } else {
      say(write, `Revoked ${clean(hits[0].label || hits[0].id)}.`);
    }
    return 0;
  } catch (e) {
    return fail(e);
  }
}
