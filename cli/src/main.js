// Command routing.
import process from 'node:process';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { frames } from './cutscene.js';
import { init, initUpdate, status, uninstall } from './wizard.js';
import { update } from './update.js';
import { restore } from './restore.js';

const HELP = `Spookling Memory

  spookling init            intro, then the step-by-step install
  spookling update [--check] [--version x [--force]]   install the newest spookling and re-wire hooks and MCP entries (--check: exit 10 if one is available)
  spookling restore [<timestamp>] [--yes]   list the backups init, update and uninstall made, or restore one run (--yes without a terminal)
  spookling demo            the whole install as you would see it, answered for you; writes nothing
  spookling status          is the server up, which harness is wired (project and user files)
  spookling uninstall       remove the hooks and MCP entry, keep .memory/

  --scope project   init/uninstall: project harness files (.codex/hooks.json for Codex), the default
  --scope user      init/uninstall: user harness files ($CODEX_HOME/hooks.json for Codex)
  --harness codex   uninstall: remove Codex hooks (default: claude); init asks which harness to use
  --no-ghost        init: do not ask to put the ghost in the Claude Code status line
  --no-anim         skip the animation (also skipped when NO_COLOR is set or output is not a terminal)
  --fast            demo only: no pauses (any key also skips the current one)
  --frames N        demo only: print N frames from across the intro, one after another, and stop
`;

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
const operands = (args, valued = []) => args.slice(1).filter((a, i, all) => !a.startsWith('--') && !valued.some((n) => all[i - 1] === `--${n}`));

async function route(args, deps) {
  const fns = {
    init, status, update, restore, initUpdate, uninstall,
    ...Object.fromEntries(Object.entries(deps).filter(([, v]) => typeof v === 'function')),
  };
  const cmd = !args[0] || ['-h', '--help'].includes(args[0]) ? 'help' : args[0];
  const anim = !args.includes('--no-anim'), fast = args.includes('--fast'), ghost = !args.includes('--no-ghost');

  const scope = flag(args, 'scope', 'takes project or user') ?? 'project';
  if (!['project', 'user'].includes(scope)) usage(`--scope takes project or user, not ${scope}`);
  const harness = flag(args, 'harness', 'takes claude or codex') ?? 'claude';
  if (!['claude', 'codex'].includes(harness) || (args.some((a) => a.startsWith('--harness')) && cmd !== 'uninstall')) {
    usage('--harness takes claude or codex and is only used by uninstall; init asks which harness to use');
  }

  const home = deps.home || homedir(), cwd = deps.cwd || process.cwd();
  const folder = scope === 'user' ? home : cwd;

  switch (cmd) {
    case 'init': return args.includes('--update') ? fns.initUpdate({ project: cwd, home }) : fns.init({ anim, scope, project: folder, ghost });
    case 'demo': {
      const n = flag(args, 'frames', 'takes a number');
      return n !== undefined ? (frames(Math.max(1, Number(n) || 3)), 0) : fns.init({ anim, scope, dry: true, fast, ghost });
    }
    case 'restore': return fns.restore({ home, stamp: operands(args, [])[0], yes: args.includes('--yes') });
    case 'update': return fns.update({ home, cwd, check: args.includes('--check'), version: flag(args, 'version', 'needs a version, like 1.2.3'), force: args.includes('--force') });
    case 'status': return fns.status(existsSync(join(cwd, '.memory')) || !existsSync(join(home, '.memory')) ? cwd : home);
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
