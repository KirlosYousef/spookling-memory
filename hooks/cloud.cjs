// Cloud memory for the hooks: loads the shared client (cli/src/cloud-retrieve.js, vendored into hooks/lib at init) and never throws.
// Every function answers null / false when cloud memory is off, offline, slow or broken, so a hook falls through to the local server.
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const CONTEXT_MAX = 12000; // a safety cap; the API bounds its own answer

async function lib() {
  try {
    const f = [join(__dirname, 'lib', 'cloud-retrieve.js'), join(__dirname, '..', 'cli', 'src', 'cloud-retrieve.js')].find((p) => existsSync(p));
    return f ? await import(pathToFileURL(f).href) : null;
  } catch { return null; }
}
const cwdOf = (p) => (typeof p.cwd === 'string' && p.cwd ? p.cwd : process.env.CLAUDE_PROJECT_DIR || process.cwd());

// Is this folder wired in cloud mode (and logged in)? Local files only.
exports.on = async (p) => { try { const l = await lib(); return !!l && l.cloudMode({ cwd: cwdOf(p) }); } catch { return false; } };

// { context, items, ... } when the cloud answered, else null (then the local server is asked)
exports.retrieve = async (p) => {
  try {
    const l = await lib();
    const r = l && await l.cloudRetrieve({ mode: 'prompt', question: p.prompt, cwd: cwdOf(p), sessionId: typeof p.session_id === 'string' ? p.session_id : undefined });
    return r ? { ...r, context: String(r.context || '').slice(0, CONTEXT_MAX) } : null;
  } catch { return null; }
};

// What a session start adds, once per session, else null: { context, rules, brief }. context is the project rules
// first (never cut for the brief), then the brief, within START_MAX (Claude Code's 10,000-character cap for additionalContext).
const START_MAX = 10000;
exports.brief = async (p) => {
  try {
    const l = await lib();
    const b = l && await l.cloudBrief({ cwd: cwdOf(p), sessionId: typeof p.session_id === 'string' ? p.session_id : undefined });
    if (!b || typeof b !== 'object') return null;
    const context = l.startContext(b, START_MAX);
    return context ? { context, rules: !!b.rules, brief: !!b.brief } : null;
  } catch { return null; }
};

// The line the user sees: what was added, in words.
exports.startMessage = (b) => {
  if (!b.rules) return 'project brief';
  return b.brief ? 'project rules and brief' : 'project rules';
};
