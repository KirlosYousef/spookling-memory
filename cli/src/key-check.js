// Check a model key before anything is wired. Only used by --json (the Mac app), so a typo is caught before any file changes.
// Never includes the key in a message. A network failure is KEY_CHECK_FAILED: the caller stops and can be retried.

const PROVIDERS = {
  OPENROUTER_API_KEY: { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1/key', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  ANTHROPIC_API_KEY: { label: 'Anthropic', url: 'https://api.anthropic.com/v1/models', headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }) },
};

// the key's own prefix says which tagger it is for (sk-or- is OpenRouter, sk-ant- is Anthropic); null when neither
export function providerForKey(key = '') {
  if (/^sk-or-/.test(key)) return { name: 'OPENROUTER_API_KEY', tagger: 0 };
  if (/^sk-ant-/.test(key)) return { name: 'ANTHROPIC_API_KEY', tagger: 1 };
  return null;
}

// { ok: true } or { ok: false, code, message }
export async function checkKey(name, key, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const p = PROVIDERS[name];
  if (!p) return { ok: true };
  let res;
  try {
    res = await fetchImpl(p.url, { headers: p.headers(key), signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { ok: false, code: 'KEY_CHECK_FAILED', message: `Could not reach ${p.label} to check the key. Check your connection and try again.` };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, code: 'KEY_INVALID', message: `${p.label} refused this key. Check it and paste it again.` };
  if (res.status === 402) return { ok: false, code: 'KEY_NO_CREDIT', message: `This ${p.label} key has no credit left. Add credit, or use another key.` };
  if (res.ok) {
    if (name === 'OPENROUTER_API_KEY') {
      const body = await res.json().catch(() => null);
      // OpenRouter reports a spent limit in the same reply
      if (body?.data?.limit_remaining !== undefined && body.data.limit_remaining !== null && Number(body.data.limit_remaining) <= 0) {
        return { ok: false, code: 'KEY_NO_CREDIT', message: `This ${p.label} key has no credit left. Add credit, or use another key.` };
      }
    }
    return { ok: true };
  }
  return { ok: false, code: 'KEY_CHECK_FAILED', message: `${p.label} answered ${res.status} when checking the key. Try again.` };
}
