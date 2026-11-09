// spookling backfill: put turns the log is missing (dropped while the model key was failing, a server that was down) back from the
// Claude Code transcripts. The server does the logging (POST /v1/backfill): it counts the turns it already holds per session, so a
// repeat adds nothing and a half-logged session gets only its missing tail. log.jsonl is only ever appended to; the uploader sends
// the new turns with the next session stop. Codex rollouts are not scanned: their session id is not read from the file here.
import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

const WIN = process.platform === 'win32';
const norm = (p) => { let r = resolve(p); try { r = realpathSync(r); } catch { /* a folder that is gone: as written */ } return WIN ? r.toLowerCase() : r; };
const within = (dir, root) => { const d = norm(dir), r = norm(root); return d === r || d.startsWith(r.endsWith(sep) ? r : r + sep); };

// the cwd a transcript was written in: the first line that has one (it is near the top; read 64 KB at most)
function cwdOf(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      try { const c = JSON.parse(line)?.cwd; if (typeof c === 'string' && c) return c; } catch { /* a cut or non-JSON line */ }
    }
  } catch { /* unreadable: no cwd */ } finally { if (fd !== undefined) closeSync(fd); }
  return '';
}

/** The transcripts under <config>/projects/<project>/<session>.jsonl that changed since `since` (a Date or null). */
export function transcripts({ env = process.env, home = homedir(), since = null } = {}) {
  const root = join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects');
  const out = [];
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    let files = [];
    try { files = readdirSync(join(root, d.name)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const path = join(root, d.name, f);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (!st.isFile() || (since && st.mtime < since)) continue;
      out.push({ path, sessionId: basename(f, '.jsonl'), mtime: st.mtime });
    }
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * project: the folder holding .memory. Only transcripts written in it (or below it) are logged, unless it is the home folder
 * (user-scope memory: every project) or `all` is set. Resolves { sessions, logged, failed, note, error }.
 */
export async function backfill({ project, home = homedir(), env = process.env, since = null, all = false, write = (s) => process.stdout.write(s), send = post } = {}) {
  const port = Number(env.SPOOKLING_INIT_PORT) || 7447;
  const url = `${(env.SPOOKLING_MEMORY_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '')}/v1/backfill`;
  const everything = all || norm(project) === norm(home);
  const mine = transcripts({ env, home, since }).filter((t) => everything || within(cwdOf(t.path) || '\0', project));
  let logged = 0, failed = 0, sessions = 0, note = '', error = '';
  for (const t of mine) {
    try {
      const r = await send(url, { session_id: t.sessionId, transcript_path: t.path });
      sessions += 1;
      logged += r.logged || 0;
      note = r.note || note;
      if (r.logged) write(`  ${t.sessionId}: ${r.logged} turn${r.logged === 1 ? '' : 's'} logged\n`);
    } catch (e) {
      failed += 1;
      error = error || (e.cause?.code === 'ECONNREFUSED' || e.name === 'TypeError' ? `no Spookling Memory server answered at ${url}; start it, then run this again` : String(e.message));
      if (/no Spookling Memory server/.test(error)) break;
    }
  }
  const text = `${logged} turn${logged === 1 ? '' : 's'} added from ${sessions} of ${mine.length} transcript${mine.length === 1 ? '' : 's'}`
    + `${since ? ` changed since ${since.toISOString().slice(0, 10)}` : ''}${failed ? `, ${failed} failed` : ''}.`;
  write(`${text}\n`);
  if (note) write(`${note}\n`);
  if (error) write(`${error}\n`);
  else if (logged) write('They upload with your next session stop (when you are logged in).\n');
  return { sessions, logged, failed, note, error };
}
