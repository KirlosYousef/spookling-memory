import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTitle, projectLog, sessionTitle } from '../src/push.js';

test('a wrapper tag line is skipped and the human text inside or after it is the title', () => {
  assert.equal(deriveTitle('<project id="chan_01UC8eL5sNhTCM8ouxKmvTfG" type="project">\nFix the login redirect\n</project>'), 'Fix the login redirect');
  assert.equal(deriveTitle('<project id="chan_01UC8eL5sNhTCM8ouxKmvTfG" type="project">Fix the login redirect</project>'), 'Fix the login redirect');
  assert.equal(deriveTitle('<system-reminder>\nuse the tools\n</system-reminder>\nAdd dark mode'), 'Add dark mode');
  assert.equal(deriveTitle('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'), '');
  assert.equal(deriveTitle('<command-name>/review</command-name>\n<command-args>the auth module</command-args>'), 'the auth module');
  assert.equal(deriveTitle('<local-command-caveat>Caveat: ignore</local-command-caveat>\n<local-command-stdout>ok</local-command-stdout>\nrename the table'), 'rename the table');
});

test('file mentions become the file name', () => {
  assert.equal(deriveTitle('@"/Users/alex/Downloads/Q3 roadmap.md"'), 'Q3 roadmap.md');
  assert.equal(deriveTitle('@/Users/me/notes/plan.md'), 'plan.md');
  assert.equal(deriveTitle('summarise @docs/plan.md please'), 'summarise plan.md please');
  assert.equal(deriveTitle('ping @alice about it'), 'ping @alice about it');
});

test('boilerplate first lines are skipped', () => {
  assert.equal(deriveTitle('Background (from the session that started this one):\n\nMigrate the users table'), 'Migrate the users table');
});

test('normal prose: whitespace collapses and long text is cut on a word with an ellipsis', () => {
  assert.equal(deriveTitle('  Make   the sync\tidempotent \nsecond line'), 'Make the sync idempotent');
  const t = deriveTitle(`${'word '.repeat(60)}end`);
  assert.ok(t.length <= 120 && t.endsWith('…'), t);
  assert.ok(!/wor…$/.test(t));
  assert.equal(deriveTitle('x'.repeat(200)).length, 120);
});

test('sessionTitle: later turns, then the old first line, then a placeholder', () => {
  assert.equal(sessionTitle(['<system-reminder>x</system-reminder>', 'Real question'], 'x'), 'Real question');
  assert.equal(sessionTitle(['<command-name>/clear</command-name>'], '<command-name>/clear</command-name>'), '<command-name>/clear</command-name>');
  assert.equal(sessionTitle([], ''), 'Untitled session');
  assert.equal(sessionTitle(['   '], ''), 'Untitled session');
});

test('projectLog titles a session from its first meaningful user text', () => {
  const rows = [
    { session_id: 's1', role: 'user', text: '<project id="chan_1" type="project">', ts: '2026-11-01T00:00:00Z' },
    { session_id: 's1', role: 'assistant', text: 'hello', ts: '2026-11-01T00:00:01Z' },
  ];
  assert.equal(projectLog(rows.map((e) => JSON.stringify(e)).join('\n'))[0].session.title, '<project id="chan_1" type="project">');
  rows.push({ session_id: 's1', role: 'user', text: '@"/a/b/Plan v2.md"', ts: '2026-11-01T00:00:02Z' });
  assert.equal(projectLog(rows.map((e) => JSON.stringify(e)).join('\n'))[0].session.title, 'Plan v2.md');
});
