// stdin-free argv bridge so the local MCP server can call the team tools without HTTP.
import { shareTarget, teamSession, teamSessions } from './team.js';
import { setProjectAutoShare, setSessionShare, shareStatus } from './share.js';

const name = process.argv[2];
let args = {};
try { args = JSON.parse(process.argv[3] || '{}'); } catch { args = {}; }
const tools = {
  sessions: teamSessions,
  session: teamSession,
  'share-status': shareStatus,
  'share-target': shareTarget,
  share: setSessionShare,
  autoshare: setProjectAutoShare,
};
// an unknown name is an error, not a quiet team_sessions
const out = Object.hasOwn(tools, name) ? await tools[name](args) : { error: `Unknown team tool: ${String(name).slice(0, 40)}` };
if (!Object.hasOwn(tools, name)) process.exitCode = 1;
process.stdout.write(JSON.stringify(out));
