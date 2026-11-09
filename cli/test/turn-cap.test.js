import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectLog } from '../src/push.js';
import { TURN_CAP } from '../src/mask.js';

const line = (sid, role, text, i) => JSON.stringify({ session_id: sid, role, text, ts: `2026-11-04T10:00:${String(i).padStart(2, '0')}Z`, agent: 'claude-code' });

test('a 5,000-character turn uploads whole; one over the cap is cut and ends with …', () => {
  const plan = `${'plan step. '.repeat(500).trim()}`; // 4,999 characters
  const huge = 'long word '.repeat(3000).trim(); // 29,999 characters
  const [s] = projectLog([line('s1', 'user', 'Plan it.', 0), line('s1', 'assistant', plan, 1), line('s1', 'assistant', huge, 2)].join('\n'));
  assert.equal(s.turns[1].text, plan);
  assert.ok(s.turns[2].text.length <= TURN_CAP + 1 && s.turns[2].text.endsWith('…'));
  assert.ok(s.turns[2].text.length < 20000, 'under what the backend accepts');
});

test('upload numbering follows the log across old and entry parts, and a later reply is only appended', () => {
  const old = [line('s1#0', 'user', 'Plan it.', 0), line('s1#0', 'assistant', 'First reply.', 1)];
  const before = projectLog(old.join('\n'))[0].turns;
  const after = projectLog([...old, line('s1#e2-4', 'assistant', 'The plan.', 2), line('s1#e2-4', 'user', 'Thanks.', 3)].join('\n'))[0].turns;
  assert.deepEqual(after.slice(0, 2), before, 'what was uploaded keeps its seq and text');
  assert.deepEqual(after.map((t) => [t.seq, t.text]).slice(2), [[2, 'The plan.'], [3, 'Thanks.']]);
});
