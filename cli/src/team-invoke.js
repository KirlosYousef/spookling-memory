// stdin-free argv bridge so the local MCP server can call the team tools without HTTP.
import { shareTarget, teamSession, teamSessions } from './team.js';
import { deleteAllSessions, deleteSession } from './delete.js';
import { liveOrgs, setProjectAutoShare, setSessionShare, shareStatus } from './share.js';
import { invoke as rules } from './rules.js';

const name = process.argv[2];
let args = {};
try { args = JSON.parse(process.argv[3] || '{}'); } catch { args = {}; }
const tools = {
  sessions: teamSessions,
  session: teamSession,
  orgs: liveOrgs,
  'share-status': shareStatus,
  'share-target': shareTarget,
  share: setSessionShare,
  autoshare: setProjectAutoShare,
  delete: deleteSession,
  'delete-all': deleteAllSessions,
  // project rules: rules-get is read-only (and resolves the project and org); rules-set and rules-remove write at once, because the
  // MCP tool has the user's yes from its own dialog by then. Not in the CLI's help: people use `spookling rules`, which asks.
  'rules-get': rules.get,
  'rules-set': rules.set,
  'rules-remove': rules.remove,
};
// an unknown name is an error, not a quiet team_sessions
const out = Object.hasOwn(tools, name) ? await tools[name](args) : { error: `Unknown team tool: ${String(name).slice(0, 40)}` };
if (!Object.hasOwn(tools, name)) process.exitCode = 1;
process.stdout.write(JSON.stringify(out));
