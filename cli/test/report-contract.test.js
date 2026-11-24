// The reporter contract: NDJSON with v:1, one result per run, known error codes, and the human (TTY) reporter silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODES, JsonReporter, PROTOCOL_VERSION, TtyReporter } from '../src/report/reporter.js';

function sink() {
  const lines = [];
  return { lines, write: (s) => { lines.push(s); return true; } };
}

test('every JSON event is one line with the protocol version', () => {
  const out = sink();
  const r = new JsonReporter(out, sink());
  r.step('checks', 'start', 'Checks');
  r.info('hello');
  r.device({ userCode: 'ABCD-EFGH', verificationUri: 'https://app.example/cli?code=ABCD-EFGH', expiresIn: 600 });
  r.error('KEY_INVALID', 'refused', 'Paste it again');
  r.result(false, { healthy: false });
  assert.equal(out.lines.length, 5);
  for (const line of out.lines) {
    assert.ok(line.endsWith('\n') && !line.slice(0, -1).includes('\n'));
    assert.equal(JSON.parse(line).v, PROTOCOL_VERSION);
  }
  assert.equal(r.sent, true);
});

test('an unknown error code is reported as INIT_FAILED, never passed through', () => {
  const out = sink();
  new JsonReporter(out, sink()).error('NOT_A_CODE', 'x');
  assert.equal(JSON.parse(out.lines[0]).code, 'INIT_FAILED');
});

test('the codes the Mac app maps are all defined', () => {
  for (const code of ['MISSING_INPUT', 'NOT_LOGGED_IN', 'KEY_INVALID', 'KEY_NO_CREDIT', 'KEY_CHECK_FAILED', 'NODE_TOO_OLD',
    'UV_MISSING', 'UV_SYNC_FAILED', 'ENGINE_MISSING', 'SERVER_START_FAILED', 'SMOKE_FAILED', 'NO_HARNESS', 'LOGIN_FAILED', 'USAGE']) {
    assert.ok(CODES[code], code);
  }
});

test('the TTY reporter writes nothing', () => {
  const t = new TtyReporter();
  assert.equal(t.json, false);
  assert.equal(t.step('checks', 'start'), undefined);
  assert.equal(t.error('KEY_INVALID', 'x'), undefined);
});
