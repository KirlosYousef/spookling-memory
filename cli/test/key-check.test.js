// Model key checks before wiring: the prefix picks the tagger, and each provider answer maps to one code. Never a key in a message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkKey, providerForKey } from '../src/key-check.js';

const reply = (status, body = {}) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const KEY = 'sk-or-v1-secret-value-123';

test('the key prefix says which tagger it is for', () => {
  assert.deepEqual(providerForKey(KEY), { name: 'OPENROUTER_API_KEY', tagger: 0 });
  assert.deepEqual(providerForKey('sk-ant-api03-x'), { name: 'ANTHROPIC_API_KEY', tagger: 1 });
  assert.equal(providerForKey('whatever'), null);
});

test('a good OpenRouter key is ok', async () => {
  assert.deepEqual(await checkKey('OPENROUTER_API_KEY', KEY, { fetchImpl: reply(200, { data: { limit_remaining: 5 } }) }), { ok: true });
});

test('401 and 403 are KEY_INVALID, 402 is KEY_NO_CREDIT', async () => {
  assert.equal((await checkKey('OPENROUTER_API_KEY', KEY, { fetchImpl: reply(401) })).code, 'KEY_INVALID');
  assert.equal((await checkKey('ANTHROPIC_API_KEY', KEY, { fetchImpl: reply(403) })).code, 'KEY_INVALID');
  assert.equal((await checkKey('OPENROUTER_API_KEY', KEY, { fetchImpl: reply(402) })).code, 'KEY_NO_CREDIT');
});

test('a spent OpenRouter limit is KEY_NO_CREDIT even on a 200', async () => {
  const r = await checkKey('OPENROUTER_API_KEY', KEY, { fetchImpl: reply(200, { data: { limit_remaining: 0 } }) });
  assert.equal(r.code, 'KEY_NO_CREDIT');
});

test('no network, or a 5xx, is KEY_CHECK_FAILED (retry, nothing written)', async () => {
  const down = async () => { throw new TypeError('fetch failed'); };
  assert.equal((await checkKey('OPENROUTER_API_KEY', KEY, { fetchImpl: down })).code, 'KEY_CHECK_FAILED');
  assert.equal((await checkKey('ANTHROPIC_API_KEY', KEY, { fetchImpl: reply(503) })).code, 'KEY_CHECK_FAILED');
});

test('no message ever contains the key', async () => {
  for (const f of [reply(401), reply(402), reply(500), async () => { throw new Error(KEY); }]) {
    const r = await checkKey('OPENROUTER_API_KEY', KEY, { fetchImpl: f });
    assert.equal(r.ok, false);
    assert.equal(r.message.includes('secret-value'), false);
  }
});
