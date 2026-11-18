// Project rules: team rules every AI tool follows on a project, kept in the Spookling cloud per org and project.
// A rule is written only after a person said yes: a y/N at a real terminal here, or the MCP dialog (team-invoke.js rules-set
// runs after the MCP tool's own confirmation). There is no --yes, and without a terminal `spookling rules set|remove` refuses.
import { homedir } from 'node:os';
import { CloudError, clean } from './cloud.js';
import { readCredentials } from './credentials.js';
import { identify } from './cloud-retrieve.js';
import { client, explain, pickLiveOrg } from './share.js';
import { orgRecords } from './team.js';

export const RULE_MAX = 300;
export const NO_PROJECT = 'This folder is not part of a project, so it has no project rules. Run this inside your project folder (a git repository, or any folder other than your home folder).';
const NOT_LOGGED_IN = 'Not logged in. Run `spookling login`, then try again.';

/** The text as the API stores it: trimmed, every run of whitespace (newlines too) one space. */
export const normalizeRule = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// one line of server text for a terminal or a model: no control characters, no newlines
const line = (v, max = 400) => {
  const t = clean(v).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
};
const when = (iso) => (typeof iso === 'string' && iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : '');
const who = (by) => line(by?.name || '', 80) || 'someone';

/** A rule as the tools pass it on: plain strings only. */
export function ruleView(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    id: line(r.id, 80), text: line(r.text, RULE_MAX + 20), version: Number.isInteger(r.version) ? r.version : null,
    status: r.status === 'removed' ? 'removed' : 'active',
    createdBy: who(r.createdBy), createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    updatedBy: who(r.updatedBy || r.createdBy), updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
  };
}
const versionView = (v) => ({
  version: Number.isInteger(v?.version) ? v.version : null, action: line(v?.action, 20), text: line(v?.text, RULE_MAX + 20),
  by: who(v?.by), via: line(v?.via, 10), at: typeof v?.at === 'string' ? v.at : '', revertedFrom: Number.isInteger(v?.revertedFrom) ? v.revertedFrom : null,
});

/** A refused rule call in plain words. { error, reason?, current? }; current is the rule as it is now (409 rule_changed / rule_exists). */
export function ruleError(e, { env = process.env, home = homedir(), action = 'set' } = {}) {
  const current = ruleView(e?.details?.rule);
  const out = (error) => ({ error, ...(e?.reason ? { reason: e.reason } : {}), ...(current ? { current } : {}) });
  if (e instanceof CloudError) {
    if (e.status === 409 && e.reason === 'rule_changed') {
      return out(`Someone changed this rule since it was shown. It now says: "${current?.text ?? '(unknown)'}" (version ${current?.version ?? '?'}, ${current?.status ?? 'active'}). Nothing changed.`);
    }
    if (e.status === 409 && e.reason === 'rule_exists') return out(`That rule already exists in this project${current ? ` (${current.id})` : ''}. Nothing changed.`);
    if (e.status === 409 && e.reason === 'rule_unchanged') return out(action === 'remove' ? 'That rule is already removed. Nothing changed.' : 'The rule already says exactly that. Nothing changed.');
    if (e.status === 409 && e.reason === 'rule_limit') return out('This project already has 20 active rules, the most allowed. Remove one first (spookling rules remove <id>). Nothing changed.');
    if (e.status === 400 && e.reason === 'rule_text') return out(`A rule must be 1 to ${RULE_MAX} characters. Nothing changed.`);
    if (e.status === 400) return out('The server did not accept that request (the project or the rule). Nothing changed.');
    if (e.status === 404) return out('No rule with that id in this project and org. Run `spookling rules` to see the ids.');
    if (e.status === 403 && e.reason === 'web_only') return out('Only the Spookling web app can do that.');
    if (e.status === 403) return out('You are not an active member of that org. Run `spookling orgs` to see your orgs, then use one of them.');
  }
  return out(explain(e, env, home));
}

/**
 * The project of a folder and the org its rules live in. org is an id or a name; without it the saved default (if still yours),
 * else your only org, else { error, needOrg, orgs } so the caller asks. Never guesses between several.
 */
async function target({ org = '', cwd, env, home, cloud: injected }) {
  const { cloud, error } = client(env, home, injected);
  if (error) return { error };
  const { project, projectKey } = await identify(cwd, { home, env });
  if (!projectKey) return { error: NO_PROJECT, noProject: true };
  const creds = readCredentials({ env, home });
  let orgs;
  try { orgs = orgRecords(await cloud.listOrgs({ token: creds.token })); } catch (e) { return { error: explain(e, env, home) }; }
  if (!orgs.length) return { error: 'You are not an active member of any org, so there are no project rules to show. Join or create an org in the Spookling web app.' };
  const picked = pickLiveOrg(orgs, org, creds, home);
  if (picked.error) {
    return { error: picked.error, ...(picked.needOrg ? { needOrg: true, orgs: picked.orgs.map((o) => ({ id: o.id, name: line(o.name, 80) })) } : {}) };
  }
  return {
    cloud, orgId: picked.org.id, orgName: line(picked.org.name, 80), project: line(project || projectKey, 120), projectKey,
    ...(picked.only ? { onlyOrg: true } : {}), ...(picked.note ? { note: picked.note } : {}),
  };
}
const plainTarget = ({ cloud: _c, ...t }) => t;

/** The active (and removed) rules of the folder's project, with the org and project they belong to. For the CLI and the MCP tools. */
export async function rulesGet({ org = '', cwd = process.cwd(), env = process.env, home = homedir(), cloud } = {}) {
  const t = await target({ org, cwd, env, home, cloud });
  if (t.error) return t;
  try {
    const data = await t.cloud.getRules({ orgId: t.orgId, projectKey: t.projectKey });
    const list = (v) => (Array.isArray(v) ? v.map(ruleView).filter(Boolean) : []);
    return { ...plainTarget(t), rules: list(data?.rules), removed: list(data?.removed) };
  } catch (e) {
    return { ...ruleError(e, { env, home }), orgId: t.orgId, orgName: t.orgName, project: t.project, projectKey: t.projectKey };
  }
}

/** Write a rule. The caller has the user's yes already. replaces + expectedVersion write a new version of that rule. */
export async function rulesSet({ orgId, projectKey, text, replaces = '', expectedVersion, via = 'cli', sessionId, env = process.env, home = homedir(), cloud: injected } = {}) {
  const t = normalizeRule(text);
  if (!t || t.length > RULE_MAX) return { error: `A rule must be 1 to ${RULE_MAX} characters. Nothing changed.`, reason: 'rule_text' };
  if (!orgId || !projectKey) return { error: 'An org and a project are required. Nothing changed.' };
  if (replaces && !Number.isInteger(expectedVersion)) return { error: 'Replacing a rule needs the version that was shown. Nothing changed.' };
  const { cloud, error } = client(env, home, injected);
  if (error) return { error };
  try {
    const data = await cloud.setRule({ orgId, projectKey, text: t, ...(replaces ? { replaces, expectedVersion } : {}), via, ...(sessionId ? { sessionId } : {}) });
    return { ok: true, action: replaces ? 'replaced' : 'set', rule: ruleView(data?.rule), previous: ruleView(data?.previous) };
  } catch (e) { return ruleError(e, { env, home }); }
}

/** Remove a rule (a new version; its history stays). The caller has the user's yes already. */
export async function rulesRemove({ orgId, projectKey, ruleId, expectedVersion, via = 'cli', sessionId, env = process.env, home = homedir(), cloud: injected } = {}) {
  if (!orgId || !projectKey || !ruleId) return { error: 'An org, a project and a rule id are required. Nothing changed.' };
  if (!Number.isInteger(expectedVersion)) return { error: 'Removing a rule needs the version that was shown. Nothing changed.' };
  const { cloud, error } = client(env, home, injected);
  if (error) return { error };
  try {
    const data = await cloud.removeRule({ orgId, projectKey, ruleId, expectedVersion, via, ...(sessionId ? { sessionId } : {}) });
    return { ok: true, action: 'removed', rule: ruleView(data?.rule) };
  } catch (e) { return ruleError(e, { env, home, action: 'remove' }); }
}

export async function rulesHistory({ orgId, projectKey, ruleId, env = process.env, home = homedir(), cloud: injected } = {}) {
  const { cloud, error } = client(env, home, injected);
  if (error) return { error };
  try {
    const data = await cloud.ruleHistory({ orgId, projectKey, ruleId });
    return { rule: ruleView(data?.rule), versions: (Array.isArray(data?.versions) ? data.versions : []).map(versionView) };
  } catch (e) { return ruleError(e, { env, home }); }
}

// ---- spookling rules [set|remove|history]

const sessionOf = (env) => ['SPOOKLING_SESSION_ID', 'CLAUDE_SESSION_ID'].map((k) => (typeof env[k] === 'string' ? env[k].trim() : '')).find((v) => v && !v.includes('#')) || '';

// the project's name, and its key when that says more (a git remote)
const projectLine = (g) => `${g.project}${g.projectKey !== g.project && g.projectKey !== `dir:${g.project}` ? ` (${g.projectKey})` : ''}`;

export function formatRules(g) {
  const head = `Project rules for ${projectLine(g)} in ${g.orgName}${g.onlyOrg ? ' (your only org)' : ''}:`;
  if (!g.rules.length) {
    return `No project rules for ${g.project} in ${g.orgName} yet.\nAdd one: spookling rules set "<the rule>"  (every AI session on this project then follows it)`;
  }
  const rows = g.rules.map((r, i) => {
    const changed = r.version > 1 ? `; v${r.version}, changed by ${r.updatedBy} ${when(r.updatedAt)}` : '';
    return `  ${i + 1}. ${r.text}\n     ${r.id} · set by ${r.createdBy} ${when(r.createdAt)}${changed}`;
  });
  return `${head}\n${rows.join('\n')}\n\nChange one: spookling rules set "<new text>" --replace <id> · remove one: spookling rules remove <id>`;
}

export function formatHistory(id, h) {
  const now = h.rule ? `${h.rule.status === 'removed' ? 'removed' : 'active'}: ${h.rule.text}` : '';
  const rows = h.versions.map((v) => `  v${v.version ?? '?'}  ${v.action}${v.revertedFrom ? ` (to v${v.revertedFrom})` : ''}  ${v.by}  ${when(v.at)}${v.via ? `  via ${v.via}` : ''}\n      ${v.text}`);
  return `History of rule ${line(id, 80)}${now ? ` (now ${now})` : ''}, newest first:\n${rows.join('\n') || '  (no versions)'}`;
}

const USAGE = 'usage: spookling rules [--org <id or name>]\n'
  + '       spookling rules set "<rule text>" [--replace <id>] [--org <id or name>]\n'
  + '       spookling rules remove <id> [--org <id or name>]\n'
  + '       spookling rules history <id> [--org <id or name>]';

/**
 * The command. sub: '' (list), 'set', 'remove' or 'history'. Returns the exit code.
 * confirm(question) and choose(question, options) are the terminal prompts; tty says whether there is a terminal to ask at.
 */
export async function rulesCommand({
  sub = '', words = [], org, replace, cwd = process.cwd(), env = process.env, home = homedir(), tty = false,
  confirm, choose, write = (s) => process.stdout.write(s), cloud,
} = {}) {
  const say = (s) => write(`${s}\n`);
  if (!['', 'list', 'set', 'remove', 'history'].includes(sub)) { say(USAGE); return 2; }
  if (sub === 'set' && (words.length !== 1 || !normalizeRule(words[0]))) { say('usage: spookling rules set "<rule text>" [--replace <id>] [--org <id or name>]  (put the rule in quotes)'); return 2; }
  if ((sub === 'remove' || sub === 'history') && words.length !== 1) { say(`usage: spookling rules ${sub} <id> [--org <id or name>]  (spookling rules lists the ids)`); return 2; }
  if (replace !== undefined && sub !== 'set') { say('--replace is only used by spookling rules set'); return 2; }
  if (!cloud && !readCredentials({ env, home }).token) { say(NOT_LOGGED_IN); return 1; }
  const writes = sub === 'set' || sub === 'remove';
  // a person must say yes at a real terminal: no --yes, and nothing is sent when nobody can be asked
  if (writes && !tty) {
    say(`spookling rules ${sub} asks you to confirm, and this is not a terminal, so nothing was changed. Run it yourself in a terminal.`);
    return 1;
  }
  const text = sub === 'set' ? normalizeRule(words[0]) : '';
  if (text.length > RULE_MAX) { say(`A rule must be at most ${RULE_MAX} characters (this one has ${text.length}). Nothing changed.`); return 1; }

  let g = await rulesGet({ org: org ?? '', cwd, env, home, cloud });
  if (g.needOrg && g.orgs?.length > 1 && !org) {
    if (!tty) { say(`${g.error.replace(/Run again with --org '<name>'\./, 'Run again with --org <id or name>.')}`); return 1; }
    const pick = choose || (await import('./term.js')).choose;
    let i = -1;
    try { i = await pick('   Which org are these project rules for?', g.orgs.map((o) => `${o.name} (${o.id})`), 0); } catch { i = -1; }
    const o = g.orgs[i];
    if (!o) { say('No org chosen. Nothing changed.'); return 1; }
    g = await rulesGet({ org: o.id, cwd, env, home, cloud });
  }
  if (g.error) {
    if (g.needOrg && !String(g.error).includes('--org')) say(`${g.error} Use --org <id or name>.`);
    else say(g.error);
    return 1;
  }
  if (g.note) say(g.note);

  if (sub === '' || sub === 'list') { say(formatRules(g)); return 0; }

  const all = [...g.rules, ...g.removed];
  const find = (id) => all.find((r) => r.id === id);
  if (sub === 'history') {
    const h = await rulesHistory({ orgId: g.orgId, projectKey: g.projectKey, ruleId: words[0], env, home, cloud });
    if (h.error) { say(h.error); return 1; }
    say(formatHistory(words[0], h));
    return 0;
  }

  const where = `  project: ${projectLine(g)}\n  org:     ${g.orgName}${g.onlyOrg ? ' (your only org)' : ''}`;
  const ask = confirm || (async (q) => (await import('./term.js')).confirm(q, false));
  const sessionId = sessionOf(env);
  let old = null;
  if (sub === 'remove' || replace !== undefined) {
    const id = sub === 'remove' ? words[0] : replace;
    old = find(id);
    if (!old) { say(`No rule ${line(id, 80)} in ${g.project} for ${g.orgName}. Run spookling rules to see the ids. Nothing changed.`); return 1; }
    if (sub === 'remove' && old.status === 'removed') { say('That rule is already removed. Nothing changed.'); return 1; }
  }
  if (sub === 'set') {
    say(old ? `Replace project rule ${old.id}\n${where}\n  old:     ${old.text}${old.status === 'removed' ? ' (removed; this makes it active again)' : ''}\n  new:     ${text}`
      : `Set a project rule\n${where}\n  rule:    ${text}`);
    say('Every AI session on this project will be told to follow it.');
  } else {
    say(`Remove project rule ${old.id}\n${where}\n  rule:    ${old.text}\nIts history is kept.`);
  }
  let yes = false;
  try { yes = !!(await ask(sub === 'set' ? 'Set this rule?' : 'Remove this rule?')); } catch { yes = false; }
  if (!yes) { say('Nothing changed.'); return 1; }

  const out = sub === 'set'
    ? await rulesSet({ orgId: g.orgId, projectKey: g.projectKey, text, ...(old ? { replaces: old.id, expectedVersion: old.version } : {}), via: 'cli', sessionId, env, home, cloud })
    : await rulesRemove({ orgId: g.orgId, projectKey: g.projectKey, ruleId: old.id, expectedVersion: old.version, via: 'cli', sessionId, env, home, cloud });
  if (out.error) {
    say(out.error);
    if (out.reason === 'rule_changed') say(`Run spookling rules to see it, then run the command again if you still want the change.`);
    return 1;
  }
  const r = out.rule || {};
  if (out.action === 'set') say(`Rule set: ${r.id} (version ${r.version}). New AI sessions on ${g.project} start with it.`);
  else if (out.action === 'replaced') say(`Rule ${r.id} replaced (now version ${r.version}). New AI sessions on ${g.project} start with the new text.`);
  else say(`Rule ${r.id || old.id} removed. Its history stays: spookling rules history ${r.id || old.id}`);
  return 0;
}

// for team-invoke.js: the MCP server asked the user already, so these write without a prompt (via "mcp")
export const invoke = {
  get: (a = {}) => rulesGet({ org: a.org || '', cwd: a.cwd || process.cwd() }),
  set: (a = {}) => rulesSet({ orgId: a.orgId, projectKey: a.projectKey, text: a.text, replaces: a.replaces || '', expectedVersion: a.expectedVersion, via: 'mcp', sessionId: a.sessionId }),
  remove: (a = {}) => rulesRemove({ orgId: a.orgId, projectKey: a.projectKey, ruleId: a.ruleId, expectedVersion: a.expectedVersion, via: 'mcp', sessionId: a.sessionId }),
};
