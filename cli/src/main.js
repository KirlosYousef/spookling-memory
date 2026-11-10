// Command routing. init never logs in; login, logout and whoami are opt-in.
import process from 'node:process';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { frames } from './cutscene.js';
import { init, initUpdate, status, uninstall } from './wizard.js';
import { update } from './update.js';
import { restore } from './restore.js';
import { backfill } from './backfill.js';
import { login, logout, orgs, tokens, whoami } from './account.js';
import { VERSION, clean, originWarning } from './cloud.js';
import { updateAvailable } from './registry.js';
import { refresh } from './team.js';
import { flushQueued } from './push.js';
import { deleteAllSessions, deleteSession, formatDelete } from './delete.js';
import { currentSession, setProjectAutoShare, setSessionShare, shareStatus, webUrl } from './share.js';
import { shareTarget } from './team.js';

const HELP = `Spookling Memory

  spookling init            intro, then the step-by-step install
  spookling update [--check] [--version x [--force]]   install the newest spookling and re-wire hooks and MCP entries (--check: exit 10 if one is available)
  spookling restore [<timestamp>] [--yes]   list the backups init, update and uninstall made, or restore one run (--yes without a terminal)
  spookling demo            the whole install as you would see it, answered for you; writes nothing
  spookling backfill [--since <date>] [--all]   log turns the memory is missing from your Claude Code transcripts (idempotent; this project, or every project with --all)
  spookling status          is the server up, which harness is wired (project and user files)
  spookling uninstall       remove the hooks and MCP entry, keep .memory/
  spookling help            this list (also -h, --help)
  spookling login           sign in, pick a default org, offer to upload past sessions (init does not do this)
  spookling logout          forget the saved token
  spookling whoami          who the saved login is, its API and default org
  spookling orgs            the orgs you belong to (id and name; use either with --org)
  spookling tokens          your CLI tokens: label, created, last used, and this device
  spookling tokens revoke <id>   revoke one (this device's token also logs you out)
  spookling tokens revoke --all  revoke every token, this device included
  spookling refresh         pull every org feed into the local cache (needs a saved login)
  spookling refresh --org <id or name>
  spookling sessions [project] [--limit N | --all]   your uploaded sessions, newest 20 by default: private or shared, and the auto-share rules
  spookling share [<session id> | --last] [--org <id or name>] [--yes]   share a session with an org (no id: the current session, else this project's newest; asks first unless --yes)
  spookling unshare [<session id> | --last] [--org <id or name>]   stop sharing it (all orgs without --org); cancels a share still pending
  spookling autoshare <project> on|off [--org <id or name>] [--backfill]   share every new session of a project
  spookling delete <session id> [--yes]   delete one uploaded session from the cloud (local memory is kept; asks first)
  spookling delete --all [--yes]          delete all your uploaded sessions from the cloud (type DELETE to confirm)

  --org: share and autoshare on use your only org, or your saved default if it is still one of yours; with several orgs
         and no --org they ask which one at a terminal and need --org otherwise;
         unshare, autoshare off and refresh without --org cover every org

  --scope project   init/uninstall: project harness files (.codex/hooks.json for Codex), the default
  --scope user      init/uninstall: user harness files ($CODEX_HOME/hooks.json for Codex)
  --harness codex   uninstall: remove Codex hooks (default: claude); init asks which harness to use
  --no-ghost        init: do not ask to put the ghost in the Claude Code status line
  --allow-share     init: let Claude share sessions when you ask (adds the share tools to permissions.allow; each share is still confirmed)
  --no-allow-share  init: do not add them (without either flag, init asks at a terminal and skips it otherwise)
  --no-anim         skip the animation (also skipped when NO_COLOR is set or output is not a terminal)
  --fast            demo only: no pauses (any key also skips the current one)
  --frames N        demo only: print N frames from across the intro, one after another, and stop

Advanced (custom API, tokens for CI): see the README
`;

const clip = (t, n = 80) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

export function formatShare(out, opts = {}) {
  return clean(formatRaw(out, opts));
}

function formatRaw(out, opts = {}) {
  const body = formatBody(out, opts);
  return out.notices?.length ? `${out.notices.join('\n')}\n${body}` : body;
}

function formatBody(out, { limit = 20 } = {}) {
  if (out.error) return out.error;
  const tag = (s) => (s.visibility === 'shared' ? `shared → ${s.sharedWith.map((o) => o.name).join(', ')}` : 'private');
  const rules = (list) => (list?.length ? `\nauto-share: ${list.map((r) => `${r.project} → ${r.org}`).join('; ')}` : '');
  if (Array.isArray(out.sessions)) {
    if (!out.sessions.length) return `No uploaded sessions.${rules(out.autoShare)}`;
    const shown = limit > 0 ? out.sessions.slice(0, limit) : out.sessions;
    const more = shown.length < out.sessions.length ? `\nShowing ${shown.length} of ${out.sessions.length}. spookling sessions --all for all.` : '';
    const row = (s) => {
      const line = `${s.sessionId}  ${tag(s).padEnd(22)}  ${s.project || '-'}  ${clip(s.title || '')}`;
      if (!s.parent) return line;
      const of = s.parent.title ? `"${clip(s.parent.title, 40)}"` : s.parent.id;
      return `↳ ${line}  (${s.parent.relation === 'continued' ? 'continued from' : 'side chat of'} ${of})`;
    };
    return shown.map(row).join('\n') + more + rules(out.autoShare);
  }
  if (out.pending) return out.note ? `${out.note}\n${out.message}` : out.message;
  if (out.action) return `${out.note ? `${out.note}\n` : ''}${out.action}${out.orgs?.length ? ` · ${out.orgs.join(', ')}` : ''}${out.sessionId ? ` · now ${tag(out)}` : ''}`;
  return out.message || (out.visibility ? tag(out) : 'done');
}

class UsageError extends Error {}

/** The value of `--name value` or `--name=value`; undefined when the flag is absent. A missing value, or another flag in its place, is a UsageError. */
function flag(args, name, need = 'needs a value') {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const v = args[i].includes('=') ? args[i].slice(args[i].indexOf('=') + 1) : args[i + 1];
  if (!v || v.startsWith('--')) throw new UsageError(`--${name} ${need}`);
  return v;
}

const usage = (text) => { throw new UsageError(text); };
// the words of a command that are not flags or flag values
const operands = (args, valued = ['org', 'limit']) => args.slice(1).filter((a, i, all) => !a.startsWith('--') && !valued.some((n) => all[i - 1] === `--${n}`));
// commands that talk to the API with the saved login: a different SPOOKLING_API_URL is called out before they run
const AUTHENTICATED = new Set(['logout', 'whoami', 'orgs', 'tokens', 'refresh', 'sessions', 'share', 'unshare', 'autoshare', 'delete']);

// several orgs and none named: the user picks (never a saved default that may be stale); no terminal means --org is required
async function resolveOrg(resolve, orgArg, { ask, tty }, verb) {
  let t = await resolve(orgArg);
  if (t.needOrg && t.orgs?.length > 1 && !orgArg) {
    if (!tty) { process.stdout.write(`${formatShare(t)}\n`); return { stop: true }; }
    if (t.note) process.stdout.write(`${t.note}\n`);
    const list = t.orgs.map((o, i) => `  ${i + 1}) ${o.name}`).join('\n');
    const answer = String(await ask(`You are in several orgs. ${verb}\n${list}\nNumber or name: `)).trim();
    const pick = t.orgs[Number(answer) - 1] || t.orgs.find((o) => o.name.toLowerCase() === answer.toLowerCase());
    if (!pick) { process.stdout.write('No org chosen. Nothing changed. Run again and pick a number from the list.\n'); return { stop: true }; }
    orgArg = pick.id;
    t = await resolve(orgArg);
  }
  return { t, orgArg };
}

// sessions, share, unshare, autoshare: who can see your own sessions
async function sharing(cmd, args, { fns, home, org, cwd, env }, { ask, tty }) {
  const limitArg = flag(args, 'limit', 'takes a whole number of 1 or more');
  if (limitArg !== undefined && !(Number.isInteger(Number(limitArg)) && Number(limitArg) >= 1)) usage('--limit takes a whole number of 1 or more');
  const limit = args.includes('--all') ? 0 : limitArg === undefined ? 20 : Number(limitArg);
  const rest = operands(args);
  const target = fns.share;
  let out;
  if (cmd === 'sessions') out = await target.status({ project: rest[0], home });
  else if (cmd === 'autoshare') {
    if (!rest[0] || !['on', 'off'].includes(rest[1])) usage('usage: spookling autoshare <project> on|off [--org <id or name>] [--backfill]');
    let orgArg = org ?? '';
    const enabled = rest[1] === 'on';
    if (enabled) {
      const resolve = (o) => (target.target || shareTarget)({ kind: 'project', project: rest[0], org: o, home, env });
      const r = await resolveOrg(resolve, orgArg, { ask, tty }, 'Turn on auto-share for which one?');
      if (r.stop) return 1;
      if (r.t.error) { process.stdout.write(`${formatShare(r.t)}\n`); return 1; }
      if (r.t.note && !r.t.needOrg) process.stdout.write(`${r.t.note}\n`);
      process.stdout.write(`Auto-share ${rest[0]} with ${r.t.orgName}${r.t.onlyOrg ? ' (your only org)' : ''}\n`);
      orgArg = r.t.orgId || r.orgArg;
    }
    out = await target.project({ project: rest[0], enabled, org: orgArg, backfill: args.includes('--backfill'), home });
  } else {
    if (rest.length > 1 || (rest[0] && args.includes('--last'))) usage(`usage: spookling ${cmd} [<session id> | --last] [--org <id or name>]${cmd === 'share' ? ' [--yes]' : ''}`);
    let sessionId = rest[0] || '';
    const projectDir = cwd;
    if (!sessionId) {
      const cur = await currentSession({ home, env, projectDir, cloud: undefined });
      if (cur.error) { process.stdout.write(`${formatShare(cur)}\n`); return 1; }
      sessionId = cur.sessionId;
    }
    let orgArg = org ?? '';
    if (cmd === 'share') {
      const yes = args.includes('--yes');
      const resolve = (o) => (target.target || shareTarget)({ kind: 'session', sessionId, org: o, projectDir, home, env });
      const r = await resolveOrg(resolve, orgArg, { ask, tty }, 'Share with which one?');
      if (r.stop) return 1;
      let t = r.t;
      orgArg = r.orgArg;
      if (t.error) { process.stdout.write(`${formatShare(t)}\n`); return 1; }
      if (t.note && !t.needOrg) process.stdout.write(`${t.note}\n`);
      process.stdout.write(`Share session ${sessionId}\n  title:   ${t.title}\n  project: ${t.project || '-'}\n  org:     ${t.orgName}${t.onlyOrg ? ' (your only org)' : ''}\n`
        + `${t.pending ? 'It is not saved yet: it uploads now, or is shared after its next save.\n' : ''}`);
      if (t.orgId) orgArg = t.orgId;
      if (!yes) {
        if (!tty) usage('spookling share asks for confirmation and this is not a terminal. Run it in a terminal, or add --yes if the user has already said yes.');
        const answer = String(await ask('Share? (y/N) ')).trim().toLowerCase();
        if (answer !== 'y' && answer !== 'yes') { process.stdout.write('Not shared.\n'); return 1; }
      }
    }
    out = await target.session({ sessionId, share: cmd === 'share', org: cmd === 'share' ? orgArg : (org ?? ''), projectDir, home, env });
    if (out.ok && !out.pending && cmd === 'share') {
      const url = webUrl(sessionId, { env, home });
      if (url) out.url = url;
    }
  }
  process.stdout.write(`${formatShare(out, { limit })}\n`);
  if (out.url) process.stdout.write(`${out.url}\n`);
  return out.error ? 1 : 0;
}

async function readLine(question) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(question); } finally { rl.close(); }
}

// delete <id> | delete --all: from the cloud only. A terminal asks first (--all: type DELETE); no terminal needs --yes.
async function deleteCommand(args, { fns, home }, { ask, tty }) {
  const all = args.includes('--all'), yes = args.includes('--yes');
  const rest = operands(args, []);
  if (all && rest.length) usage('usage: spookling delete <session id> | spookling delete --all  (not both)');
  if (!all && !rest[0]) usage('usage: spookling delete <session id> [--yes] | spookling delete --all [--yes]');
  if (!yes) {
    if (!tty) usage('spookling delete asks for confirmation and this is not a terminal. Add --yes to delete without asking.');
    const what = all ? 'ALL your uploaded sessions' : `session ${rest[0]}`;
    process.stdout.write(`This deletes ${what} from the Spookling cloud. It cannot be undone. Local memory (.memory/) is not touched.\n`);
    const answer = String(await ask(all ? 'Type DELETE to confirm: ' : 'Delete it? [y/N] ')).trim();
    if (all ? answer !== 'DELETE' : !/^y(es)?$/i.test(answer)) {
      process.stdout.write('Nothing deleted.\n');
      return 0;
    }
  }
  const out = all ? await fns.delete.all({ home, log: (m) => process.stdout.write(`${m}\n`) }) : await fns.delete.one({ sessionId: rest[0], home });
  process.stdout.write(`${formatDelete(out)}\n`);
  return out.error ? 1 : 0;
}

function tokensCommand(args, { fns, home }) {
  const rest = operands(args, []);
  if (rest[0] && rest[0] !== 'revoke') usage('usage: spookling tokens | spookling tokens revoke <id> | spookling tokens revoke --all');
  return fns.tokens({ home, revoke: rest[0] === 'revoke', id: rest[1] || '', all: args.includes('--all') });
}

async function route(args, deps) {
  const fns = {
    init, refresh, flush: flushQueued, login, logout, whoami, orgs, tokens, status, update, restore, initUpdate, uninstall, backfill,
    delete: { one: deleteSession, all: deleteAllSessions },
    share: { status: shareStatus, session: setSessionShare, project: setProjectAutoShare },
    ...Object.fromEntries(Object.entries(deps).filter(([, v]) => typeof v === 'function' || (v && typeof v === 'object' && ('status' in v || 'one' in v)))),
  };
  const cmd = !args[0] || ['-h', '--help'].includes(args[0]) ? 'help' : args[0];
  const anim = !args.includes('--no-anim'), fast = args.includes('--fast'), ghost = !args.includes('--no-ghost');

  const scope = flag(args, 'scope', 'takes project or user') ?? 'project';
  if (!['project', 'user'].includes(scope)) usage(`--scope takes project or user, not ${scope}`);
  const harness = flag(args, 'harness', 'takes claude or codex') ?? 'claude';
  if (!['claude', 'codex'].includes(harness) || (args.some((a) => a.startsWith('--harness')) && cmd !== 'uninstall')) {
    usage('--harness takes claude or codex and is only used by uninstall; init asks which harness to use');
  }
  const apiUrl = flag(args, 'api-url', 'takes a URL');
  if (apiUrl !== undefined && cmd !== 'login') usage('--api-url is only used by login');
  const org = flag(args, 'org', 'needs an id or a name');

  const home = deps.home || homedir(), cwd = deps.cwd || process.cwd();
  const folder = scope === 'user' ? home : cwd;
  const env = deps.env || process.env;
  const ctx = { fns, home, org, cwd, env };

  if (AUTHENTICATED.has(cmd)) {
    const warning = originWarning(env, { home });
    if (warning) process.stderr.write(`${warning}\n`);
  }
  switch (cmd) {
    case 'init': {
      if (args.includes('--allow-share') && args.includes('--no-allow-share')) usage('use --allow-share or --no-allow-share, not both');
      const allowShare = args.includes('--allow-share') ? true : args.includes('--no-allow-share') ? false : undefined;
      return args.includes('--update') ? fns.initUpdate({ project: cwd, home, allowShare }) : fns.init({ anim, scope, project: folder, ghost, allowShare });
    }
    case 'demo': {
      const n = flag(args, 'frames', 'takes a number');
      return n !== undefined ? (frames(Math.max(1, Number(n) || 3)), 0) : fns.init({ anim, scope, dry: true, fast, ghost });
    }
    case 'restore': return fns.restore({ home, stamp: operands(args, [])[0], yes: args.includes('--yes') });
    case 'update': return fns.update({ home, cwd, check: args.includes('--check'), version: flag(args, 'version', 'needs a version, like 1.2.3'), force: args.includes('--force') });
    case 'refresh': {
      const code = await fns.refresh({ home, orgId: org });
      if (code === 0) await fns.flush({ home, env });
      return code;
    }
    case 'sessions': case 'share': case 'unshare': case 'autoshare': return sharing(cmd, args, ctx, { ask: deps.ask || readLine, tty: deps.tty ?? !!(process.stdin.isTTY && process.stdout.isTTY) });
    case 'delete': return deleteCommand(args, ctx, { ask: deps.ask || readLine, tty: deps.tty ?? !!(process.stdin.isTTY && process.stdout.isTTY) });
    case 'login': return fns.login({ home, cwd, apiUrl });
    case 'logout': return fns.logout({ home });
    case 'orgs': return fns.orgs({ home });
    case 'tokens': return tokensCommand(args, ctx);
    case 'whoami': {
      if (!deps.whoami) await updateAvailable({ home, current: VERSION, env }).catch(() => null); // refreshes the daily cache, at most 2 s
      const code = fns.whoami({ home, orgsFollow: true });
      if (code === 0) await fns.orgs({ home, heading: true }); // live: never what an old cache or default says
      return code;
    }
    case 'backfill': {
      const when = flag(args, 'since', 'takes a date, like 2026-11-01');
      const since = when === undefined ? null : new Date(when);
      if (since && Number.isNaN(since.getTime())) usage(`--since takes a date, like 2026-11-01, not ${when}`);
      const project = existsSync(join(cwd, '.memory')) || !existsSync(join(home, '.memory')) ? cwd : home;
      const r = await fns.backfill({ project, home, env, since, all: args.includes('--all') });
      return r.error ? 1 : 0;
    }
    case 'status': return fns.status(existsSync(join(cwd, '.memory')) || !existsSync(join(home, '.memory')) ? cwd : home, undefined, undefined, { liveOrgs: true });
    case 'uninstall': return fns.uninstall(folder, { scope, harness });
    case 'help': process.stdout.write(HELP); return 0;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n`);
      process.stdout.write(HELP);
      return 1;
  }
}

export async function main(argv = process.argv, deps = {}) {
  try {
    return await route(argv.slice(2), deps);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`${e.message}\n`);
    (deps.exit || ((code) => process.exit(code)))(2);
    return 2;
  }
}
