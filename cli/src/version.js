// The version of the code that is running: the one source for the wizard, the cloud client, update and the update notice.
import { readFileSync } from 'node:fs';

export const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; } catch { return 'unknown'; }
})();
