// --json: the machine mode the Mac app drives. stdout carries only NDJSON events (see report/reporter.js); every
// answer comes from flags or from stdin, and nothing is ever asked. Returns the exit code.
import { isAbsolute } from 'node:path';
import process from 'node:process';
import { JsonReporter, setReporter } from './report/reporter.js';
import { setHumanStream } from './term.js';
import { TAGGERS, initJson, prepare, statusJson, uninstall } from './wizard.js';
import { login } from './account.js';
import { update } from './update.js';
import { providerForKey } from './key-check.js';

export const JSON_COMMANDS = ['init', 'status', 'uninstall', 'update', 'prepare', 'login'];
const HARNESSES = ['auto', 'claude', 'claude-desktop', 'codex'];
// the tagger names the app and the CLI share; the index is into TAGGERS
const TAGGER_INDEX = { jev: 0, anthropic: 1, codex: 2 };

export class UsageError extends Error {}
const usage = (text) => { throw new UsageError(text); };

// the value of --name value or --name=value; undefined when absent
export function valueOf(args, name) {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const v = args[i].includes('=') ? args[i].slice(args[i].indexOf('=') + 1) : args[i + 1];
  if (!v || v.startsWith('--')) usage(`--${name} needs a value`);
  return v;
}

export function parseHarnesses(value) {
  const list = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length || list.some((h) => !HARNESSES.includes(h))) usage(`--harness takes auto, claude, claude-desktop or codex (comma list allowed), not ${value}`);
  if (list.includes('auto') && list.length > 1) usage('--harness auto cannot be combined with a named app');
  return list;
}

// all of stdin, or '' at a terminal (nothing piped means nothing to wait for)
async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

function initOptions(args, { home, cwd }) {
  if (args.includes('--cloud') && args.includes('--keys')) usage('use --cloud or --keys, not both');
  if (args.includes('--allow-share') && args.includes('--no-allow-share')) usage('use --allow-share or --no-allow-share, not both');
  const scope = valueOf(args, 'scope') ?? 'user';
  if (!['user', 'project'].includes(scope)) usage(`--scope takes user or project, not ${scope}`);
  const harnesses = parseHarnesses(valueOf(args, 'harness') ?? 'auto');
  const node = valueOf(args, 'node'), uv = valueOf(args, 'uv');
  if (node && !isAbsolute(node)) usage('--node takes an absolute path');
  if (uv && !isAbsolute(uv)) usage('--uv takes an absolute path');
  const allowShare = args.includes('--allow-share') ? true : args.includes('--no-allow-share') ? false : undefined;
  // the same folder rule as the human route: user scope keeps .memory/ in your home folder
  return { home, project: scope === 'user' ? home : cwd, scope, mode: args.includes('--cloud') ? 'cloud' : 'keys', harnesses, node, uv, allowShare, ghost: args.includes('--ghost') };
}

// the tagger: --tagger, else the key's own prefix, else Jev. A key that belongs to another tagger is refused before anything runs.
async function taggerAndKeys(args, mode) {
  if (mode === 'cloud') return { tagger: 0, keys: {} };
  const named = valueOf(args, 'tagger');
  if (named !== undefined && !(named in TAGGER_INDEX)) usage(`--tagger takes jev, anthropic or codex, not ${named}`);
  const key = args.includes('--key-stdin') ? (await readStdin()).trim() : '';
  const detected = key ? providerForKey(key) : null;
  const tagger = named !== undefined ? TAGGER_INDEX[named] : (detected?.tagger ?? 0);
  if (key && detected && detected.tagger !== tagger && tagger !== TAGGER_INDEX.codex) {
    usage(`the key on stdin is for ${TAGGERS[detected.tagger].key}, not ${TAGGERS[tagger].key}`);
  }
  const name = TAGGERS[tagger].key;
  return { tagger, keys: key && name ? { [name]: key } : {} };
}

async function dispatch(cmd, args, { home, cwd, deps, r }) {
  switch (cmd) {
    case 'init': {
      const opts = initOptions(args, { home, cwd });
      const { tagger, keys } = await taggerAndKeys(args, opts.mode);
      return initJson({ ...opts, tagger, keys });
    }
    case 'status': {
      const data = await statusJson({ project: cwd, home, ...(deps.get && { get: deps.get }) });
      r.result(data.healthy, data);
      return data.healthy ? 0 : 1;
    }
    case 'uninstall': {
      const scope = valueOf(args, 'scope') ?? 'user';
      if (!['user', 'project'].includes(scope)) usage(`--scope takes user or project, not ${scope}`);
      const code = await uninstall(scope === 'user' ? home : cwd, { scope, harness: 'claude' });
      r.result(code === 0, { scope });
      return code;
    }
    case 'update': {
      const code = await update({
        home, cwd, check: args.includes('--check'), version: valueOf(args, 'version'), force: args.includes('--force'),
        write: (s) => process.stderr.write(s),
      });
      r.result(code === 0, {});
      return code;
    }
    case 'prepare':
      return prepare({ home });
    case 'login': {
      if (!args.includes('--no-browser')) usage('login --json needs --no-browser: the link comes back as a device event, nothing is opened');
      const code = await login({
        home, cwd, apiUrl: valueOf(args, 'api-url'), label: valueOf(args, 'client'),
        write: (s) => process.stderr.write(s), tty: false,
        device: (d) => r.device(d),
        // no questions: the first org is the default, past sessions and the share rule are left for later
        choose: async (q, opts, def = 0) => def,
        confirm: async (q, def = false) => def,
        confirmOpen: async () => false,
        openUrl: async () => false,
      });
      if (code !== 0) r.error('LOGIN_FAILED', 'The login did not finish.', 'Run the login again.');
      r.result(code === 0, { loggedIn: code === 0 });
      return code;
    }
    default:
      usage(`--json works with ${JSON_COMMANDS.join(', ')}, not ${cmd}`);
  }
  return 1;
}

// Run one --json command. Every path ends with exactly one result event; errors are error events.
export async function runJson(cmd, args, { home, cwd, deps = {} }) {
  const r = new JsonReporter(process.stdout, process.stderr);
  setReporter(r);
  setHumanStream(process.stderr);
  try {
    const code = await dispatch(cmd, args, { home, cwd, deps, r });
    if (!r.sent) r.result(code === 0, {});
    return code;
  } catch (e) {
    if (e instanceof UsageError) {
      r.error('USAGE', e.message);
      if (!r.sent) r.result(false, {});
      return 2;
    }
    r.error('INIT_FAILED', e?.message || String(e));
    if (!r.sent) r.result(false, {});
    return 1;
  }
}
