// `npm test`: every cli/test/*.test.js under node --test, with the real-home safety net around it.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { changes, snapshot } from './guard-real-home.mjs';

const dir = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => join('cli', 'test', f));
const before = snapshot();
const code = await new Promise((resolve) => {
  const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: join(dir, '..', '..') });
  child.on('close', (c) => resolve(c ?? 1));
});
const bad = changes(before, snapshot());
if (bad.length) {
  console.error('\nREAL HOME TOUCHED BY THE TEST SUITE:');
  for (const line of bad) console.error(`  ${line}`);
  console.error('A test wrote outside its temp folder. Fix it before anything else: these are your real files.');
}
process.exit(code || (bad.length ? 1 : 0));
