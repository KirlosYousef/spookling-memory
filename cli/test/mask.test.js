import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MASK_INPUT_MAX, TURN_CAP, maskSecrets, maskTurn } from '../src/mask.js';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/secret-vectors.json', import.meta.url), 'utf8'));

// the Python test (server/tests/test_mask.py) reads the same file, so the two maskers agree on every vector
for (const v of vectors) {
  test(`mask vector: ${v.name}`, () => {
    assert.equal(maskSecrets(v.in), v.out);
    assert.equal(maskSecrets(v.out), v.out, 'masking is idempotent');
  });
}

test('every pattern has a positive vector', () => {
  assert.ok(vectors.length >= 50);
  assert.ok(vectors.filter((v) => v.out.includes('[secret]')).length >= 40);
  assert.ok(vectors.filter((v) => v.out === v.in).length >= 8, 'and negatives');
});

const ADVERSARIAL = {
  'a. repeated': 'a.'.repeat(50_000),
  'a: repeated': 'a:'.repeat(50_000),
  'at signs': '@'.repeat(100_000),
  'url then at signs': `x://a:${'@'.repeat(100_000)}`,
  'jwt starts': 'eyJ-'.repeat(25_000),
  'curl words': 'curl '.repeat(20_000),
  'sk starts': 'sk-'.repeat(33_000),
  'token words': 'token '.repeat(16_000),
  'token= quotes': 'token="'.repeat(14_000),
  'authorization words': 'authorization '.repeat(7_000),
  'unterminated pem starts': '\u002d----BEGIN PRIVATE KEY-----'.repeat(3_700),
  'cookie words': 'cookie '.repeat(14_000),
  'key chars': 'password.'.repeat(11_000),
  'spaces': ' '.repeat(100_000),
};

for (const [name, input] of Object.entries(ADVERSARIAL)) {
  test(`mask is fast on 100k of ${name}`, () => {
    maskSecrets(input); // warm up the regex compiler
    const t = process.hrtime.bigint();
    const out = maskSecrets(input);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
    assert.ok(out.length <= MASK_INPUT_MAX + 16);
  });
}

test('mask caps its input, and maskTurn cuts to the turn cap after masking', () => {
  const key = `sk-${'a'.repeat(30)}`;
  const text = `${'x'.repeat(TURN_CAP - 10)} ${key} ${'y'.repeat(500)}`;
  const out = maskTurn(text);
  assert.equal(out.length, TURN_CAP);
  assert.equal(out.includes('sk-'), false, 'a key that straddles the cap is masked, not cut in half');
  assert.ok(maskSecrets('z'.repeat(1_000_000)).length <= MASK_INPUT_MAX);
});
