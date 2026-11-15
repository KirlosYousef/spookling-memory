// argv bridge so the local MCP server (Python) can ask the cloud without ever holding the token:
//   node cloud-retrieve-invoke.js '{"question":"...","cwd":"..."}'  ->  one JSON line: the cloud answer, or null.
import { cloudRetrieve } from './cloud-retrieve.js';

let args = {};
try { args = JSON.parse(process.argv[2] || '{}'); } catch { args = {}; }
const out = await cloudRetrieve({ mode: 'ask', question: args.question, cwd: args.cwd, sessionId: args.sessionId });
process.stdout.write(JSON.stringify(out ?? null));
process.exit(0);
