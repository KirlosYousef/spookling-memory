// A session read straight from the agent's own transcript, for when the local log never got it (the local server was not running
// when the Stop hook fired). Claude Code: <config>/projects/<project>/<session>.jsonl. Codex: ~/.codex/sessions/Y/M/D/rollout-*-<session>.jsonl.
// Read-only. The result is shaped like log.jsonl lines, so the normal upload (pushFromLog with logText) takes it unchanged.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { projectLog } from './push.js';

const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

function readLines(path) {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a cut or non-JSON line */ }
  }
  return out;
}

const textOf = (content, kinds) => (typeof content === 'string'
  ? content
  : Array.isArray(content) ? content.filter((b) => b && kinds.includes(b.type) && typeof b.text === 'string').map((b) => b.text).join('\n') : '');

// text the harness injects as "user" lines: command echoes, reminders, caveats. Not something the person said.
const INJECTED = /^\s*<(?:command-name|command-message|command-args|local-command|system-reminder|user-prompt-submit-hook|task-notification)/;

function claudeFile(sessionId, env, home) {
  const root = join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects');
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return ''; }
  for (const d of dirs) {
    const path = join(root, d.name, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return '';
}

function claudeEvents(path, sessionId) {
  const events = [];
  let cwd = '';
  for (const e of readLines(path)) {
    if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
    if ((e.type !== 'user' && e.type !== 'assistant') || e.isSidechain || e.isMeta || typeof e.timestamp !== 'string') continue;
    const role = e.type;
    const text = textOf(e.message?.content, ['text']).trim();
    if (!text || (role === 'user' && INJECTED.test(text))) continue;
    const last = events[events.length - 1];
    // one reply is written as several lines (text, tool use, text): they are one turn
    if (role === 'assistant' && last?.role === 'assistant') last.text += `\n\n${text}`;
    else events.push({ role, text, ts: e.timestamp });
  }
  return { events, cwd, agent: 'claude-code', sessionId };
}

function codexFile(sessionId, home) {
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isFile() && ent.name.startsWith('rollout-') && ent.name.endsWith(`-${sessionId}.jsonl`)) return p;
      if (ent.isDirectory() && depth < 4) { const hit = walk(p, depth + 1); if (hit) return hit; }
    }
    return '';
  };
  return walk(join(home, '.codex', 'sessions'), 0);
}

function codexEvents(path, sessionId) {
  const events = [];
  let cwd = '';
  for (const e of readLines(path)) {
    const p = e.payload;
    if (e.type === 'session_meta' && !cwd && typeof p?.cwd === 'string') cwd = p.cwd;
    if (e.type !== 'response_item' || p?.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant') || typeof e.timestamp !== 'string') continue;
    const text = textOf(p.content, ['input_text', 'output_text', 'text']).trim();
    if (!text || (p.role === 'user' && /^\s*<(?:environment_context|permissions|user_instructions|INSTRUCTIONS)/i.test(text))) continue;
    const last = events[events.length - 1];
    if (p.role === 'assistant' && last?.role === 'assistant') last.text += `\n\n${text}`;
    else events.push({ role: p.role, text, ts: e.timestamp });
  }
  return { events, cwd, agent: 'codex', sessionId };
}

/**
 * The session as its agent's transcript has it: { title, turns, logText, cwd, agent } or null (no transcript, or nothing said in it).
 * logText is log.jsonl-shaped, for pushFromLog({ logText }).
 */
export function transcriptSession(sessionId, { env = process.env, home = homedir() } = {}) {
  if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) return null;
  let found = null;
  const claude = claudeFile(sessionId, env, home);
  if (claude) found = claudeEvents(claude, sessionId);
  else {
    const codex = codexFile(sessionId, home);
    if (codex) found = codexEvents(codex, sessionId);
  }
  if (!found || !found.events.length) return null;
  const logText = found.events
    .map((ev, i) => JSON.stringify({ agent: found.agent, session_id: sessionId, turn_index: i, role: ev.role, ts: ev.ts, text: ev.text }))
    .join('\n');
  const hit = projectLog(logText, { forks: {} }).find((x) => x.sid === sessionId);
  if (!hit) return null;
  return { title: hit.session.title, turns: hit.turns.length, logText, cwd: found.cwd, agent: found.agent };
}
