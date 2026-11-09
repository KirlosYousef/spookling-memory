// Small client for the team-memory control plane. SPOOKLING_API_URL, else apiUrl saved at login, else the shipped app.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { readCredentials } from './credentials.js';

// Production API origin
export const DEFAULT_API_URL = 'https://api.spookling.com';

export class CloudError extends Error {
  constructor(message, { status = null, code = null, reason = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.retryAfter = retryAfter;
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** An API origin worth sending a token to: https, or http on this machine. Returns it without a trailing slash, query or login. */
export function validateOrigin(raw, what = 'API URL') {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new CloudError(`The ${what} is not a URL.`, { code: 'BAD_API_URL' }); }
  if (u.username || u.password) throw new CloudError(`The ${what} must not hold a user name or password.`, { code: 'BAD_API_URL' });
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
    throw new CloudError(`The ${what} must be https (http only for localhost, 127.0.0.1 or [::1]).`, { code: 'BAD_API_URL' });
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

const envUrl = (env) => (typeof env?.SPOOKLING_API_URL === 'string' && env.SPOOKLING_API_URL.trim() ? env.SPOOKLING_API_URL.trim() : null);

/** Where `login` talks: --api-url, else SPOOKLING_API_URL, else the saved origin, else the shipped app. No token is sent yet. */
export function loginBase(env = process.env, { home = homedir(), apiUrl } = {}) {
  const raw = apiUrl || envUrl(env) || readCredentials({ env: {}, home }).apiUrl || DEFAULT_API_URL;
  return validateOrigin(raw);
}

/**
 * Where a request that carries `token` may go. The saved token is pinned to the origin saved with it
 * (the shipped app for an older file): SPOOKLING_API_URL cannot move it, so a repo's env block or an .envrc
 * cannot redirect it. Any other token (SPOOKLING_TOKEN) goes only to an explicit SPOOKLING_API_URL.
 * With no token at all this is the login origin.
 */
export function apiBase(env = process.env, { home = homedir(), token } = {}) {
  const creds = readCredentials({ env, home });
  const tok = token ?? creds.token;
  if (!tok) return loginBase(env, { home });
  if (tok === creds.savedToken) return validateOrigin(creds.apiUrl || DEFAULT_API_URL, 'saved API URL');
  const url = envUrl(env);
  if (!url) throw new CloudError('SPOOKLING_TOKEN is used only with an explicit SPOOKLING_API_URL (https).', { code: 'NO_API' });
  return validateOrigin(url, 'SPOOKLING_API_URL');
}

/** One line for interactive commands when SPOOKLING_API_URL is being ignored because the saved login is pinned. Else null. */
export function originWarning(env = process.env, { home = homedir() } = {}) {
  const creds = readCredentials({ env, home });
  const url = envUrl(env);
  if (!url || creds.fromEnv || !creds.savedToken) return null;
  let pinned, wanted;
  try { pinned = validateOrigin(creds.apiUrl || DEFAULT_API_URL, 'saved API URL'); } catch { return null; }
  try { wanted = validateOrigin(url); } catch { wanted = url; }
  if (wanted === pinned) return null;
  return `Ignoring SPOOKLING_API_URL (${clean(url)}): your login is pinned to ${pinned}. To use another API, run spookling login --api-url <url>.`;
}

/** Server text for a terminal: control characters (escape sequences included) go, newlines stay. */
export function clean(value) {
  return String(value ?? '').replace(/[^\P{C}\n]/gu, '');
}

export const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; } catch { return 'unknown'; }
})();
export const USER_AGENT = `spookling/${VERSION} (${process.platform}; node/${process.versions.node})`;

const NET_CODES = new Set(['TypeError', 'TimeoutError', 'AbortError', 'NETWORK', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT',
  'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

/** A fetch that never got an answer: refused, unresolved, reset or timed out. An HTTP status, even 5xx, is not this. */
export function isNetworkError(e) {
  if (!e) return false;
  if (e instanceof CloudError) return e.status == null && (e.code == null || NET_CODES.has(e.code));
  return NET_CODES.has(e.code) || NET_CODES.has(e.name) || NET_CODES.has(e.cause?.code);
}

/** The one sentence for an unreachable API, or null when the error is something else. */
export function networkMessage(e, { env = process.env, home = homedir() } = {}) {
  if (!isNetworkError(e)) return null;
  let base = DEFAULT_API_URL;
  try { base = apiBase(env, { home }); } catch { /* the default */ }
  return `Couldn't reach ${base}. Check your connection, or SPOOKLING_API_URL if you set it.`;
}

function retryAfter(header) {
  if (header == null || header === '') return null;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function request(base, path, { method, token, body, fetchImpl, timeoutMs }) {
  const headers = { accept: 'application/json', 'user-agent': USER_AGENT };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', // a redirect could carry the token to another host
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new CloudError('network error', { code: e?.cause?.code || e?.code || e?.name || 'NETWORK' });
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  const retry = retryAfter(typeof res.headers?.get === 'function' ? res.headers.get('retry-after') : null);
  if (!res.ok || json?.success === false) {
    const err = json?.error && typeof json.error === 'object' ? json.error : {};
    throw new CloudError(err.code || `HTTP ${res.status}`, {
      status: res.status,
      code: err.code || null,
      reason: err.details?.reason || null,
      retryAfter: retry,
    });
  }
  if (!json || json.success !== true || !('data' in json)) {
    throw new CloudError('response was not a success envelope', { status: res.status, code: 'BAD_ENVELOPE' });
  }
  return json.data;
}

export function createCloud({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15000, token, home = homedir(), loginUrl } = {}) {
  const auth = () => token || readCredentials({ env, home }).token;
  // authenticated calls go to the origin pinned to their token; the two login calls to the origin login chose
  const base = () => apiBase(env, { home, token: auth() || undefined });
  const loginOrigin = () => loginBase(env, { home, apiUrl: loginUrl });
  const call = (path, opts) => request(opts.token ? base() : loginOrigin(), path, { fetchImpl, timeoutMs, ...opts });
  return {
    base,
    loginBase: loginOrigin,
    deviceStart({ label } = {}) {
      return call('/cli/device/start', { method: 'POST', body: label ? { label } : {} });
    },
    pollToken({ deviceCode }) {
      return call('/cli/device/token', { method: 'POST', body: { deviceCode } });
    },
    upsertSession({ sid, session, token: t }) {
      return call(`/memory/sessions/${encodeURIComponent(sid)}`, { method: 'PUT', token: t || auth(), body: session });
    },
    postTurns({ sid, turns, token: t }) {
      return call(`/memory/sessions/${encodeURIComponent(sid)}/turns`, { method: 'POST', token: t || auth(), body: { turns } });
    },
    listAutoShare({ token: t } = {}) {
      return call('/memory/projects/autoshare', { method: 'GET', token: t || auth() });
    },
    shareSession({ sid, orgId, token: t }) {
      return call(`/memory/sessions/${encodeURIComponent(sid)}/shares/${encodeURIComponent(orgId)}`, {
        method: 'PUT',
        token: t || auth(),
      });
    },
    unshareSession({ sid, orgId, token: t }) {
      return call(`/memory/sessions/${encodeURIComponent(sid)}/shares/${encodeURIComponent(orgId)}`, {
        method: 'DELETE',
        token: t || auth(),
      });
    },
    listSessions({ project, cursor, token: t } = {}) {
      const q = new URLSearchParams({ scope: 'mine', limit: '100' });
      if (project) q.set('project', project);
      if (cursor) q.set('cursor', cursor);
      return call(`/memory/sessions?${q}`, { method: 'GET', token: t || auth() });
    },
    deleteSession({ sid, token: t }) {
      return call(`/memory/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE', token: t || auth() });
    },
    // one batch; the caller loops while `remaining` > 0
    deleteAllSessions({ token: t } = {}) {
      return call('/memory/sessions', { method: 'DELETE', token: t || auth() });
    },
    setAutoShare({ project, orgId, backfill, token: t }) {
      return call(`/memory/projects/${encodeURIComponent(project)}/autoshare/${encodeURIComponent(orgId)}`, {
        method: 'PUT',
        token: t || auth(),
        body: backfill ? { backfill: true } : {},
      });
    },
    clearAutoShare({ project, orgId, token: t }) {
      return call(`/memory/projects/${encodeURIComponent(project)}/autoshare/${encodeURIComponent(orgId)}`, {
        method: 'DELETE',
        token: t || auth(),
      });
    },
    revokeCurrent({ token: t } = {}) {
      return call('/cli/tokens/current', { method: 'DELETE', token: t || auth() });
    },
    listTokens({ token: t } = {}) {
      return call('/cli/tokens', { method: 'GET', token: t || auth() });
    },
    revokeToken({ id, token: t } = {}) {
      return call(`/cli/tokens/${encodeURIComponent(id)}`, { method: 'DELETE', token: t || auth() });
    },
    revokeAllTokens({ token: t } = {}) {
      return call('/cli/tokens', { method: 'DELETE', token: t || auth() });
    },
    listOrgs({ token: t } = {}) {
      return call('/cli/orgs', { method: 'GET', token: t || auth() });
    },
    feed({ orgId, since, cursor, token: t } = {}) {
      const q = new URLSearchParams();
      if (since) q.set('since', since);
      if (cursor) q.set('cursor', cursor);
      q.set('limit', '100');
      return call(`/memory/orgs/${encodeURIComponent(orgId)}/feed?${q}`, { method: 'GET', token: t || auth() });
    },
    getSession({ sid, after, token: t } = {}) {
      const q = new URLSearchParams();
      if (after !== undefined && after !== null) q.set('after', String(after));
      q.set('limit', '100'); // the API's maximum for a read page; callers page with `after`
      return call(`/memory/sessions/${encodeURIComponent(sid)}?${q}`, { method: 'GET', token: t || auth() });
    },
  };
}
