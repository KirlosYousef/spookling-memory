// Masks secrets in a turn before it is uploaded. log.jsonl is never rewritten; only the copy that leaves the machine.
// server/spookling_memory/hooks.py (PATTERNS) holds the same list in the same order; both are tested against
// cli/test/fixtures/secret-vectors.json, so the two cannot drift. Change one, change the other.
const MASK = '[secret]';

// A turn is cut to 4000 characters before it leaves, so only that much plus a margin is ever masked. Some patterns
// rescan a long run from each start (quadratic in the worst case); this bound makes that a few million steps at most.
export const TURN_CAP = 4000;
export const MASK_INPUT_MAX = TURN_CAP + 256;

// the \b[\w.-]{0,40} prefix and suffix are bounded so a long "a.a.a." run cannot make the keyword search quadratic
const NAME = '(?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)';

const PATTERNS = [
  // a private key block; one cut off by the turn cap has no END line, so it runs to the end of the text
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|(?![\s\S]))/g, MASK],
  [/\bauthorization\s*[:=]\s*(?:bearer|basic|token)\s+\S+/gi, MASK],
  [/\b(?:set-)?cookie\s*:\s*[^\r\n]+/gi, MASK],
  [/\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, MASK], // JWT: header.payload.signature
  [/\b([a-z][a-z0-9+.-]{0,20}:\/\/)[^\s:/@]+:[^\s/]+@/gi, `$1${MASK}@`], // scheme://user:pass@host; pass runs to the last @
  [/([?&](?:token|access_token|api[_-]?key|key|password|secret|sig|signature)=)[^&\s#]+/gi, `$1${MASK}`],
  [/(\bcurl\b[^\n]*?\s-u\s+)\S+:\S+/gi, `$1${MASK}`], // curl -u user:pass
  [/\b(?:sk-[A-Za-z0-9_-]{20,}|A[KS]IA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{30,})\b/g, MASK], // OpenAI and Anthropic, AWS, GitHub
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bnpm_[A-Za-z0-9]{30,}/g, MASK],
  [/\bhf_[A-Za-z0-9]{30,}/g, MASK],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, MASK],
  [/\bxox[abeoprs]-[A-Za-z0-9-]{8,}/g, MASK], // Slack
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/g, MASK], // Stripe secret and restricted keys
  [/\bwhsec_[A-Za-z0-9]{16,}/g, MASK],
  [/\bspk_[A-Za-z0-9_-]{20,}/g, MASK], // our own tokens
  // NAME=value, name: value, "apiKey": "value"; the = or : must follow the name, so "the token is valid" is left alone;
  // a value an earlier pattern already masked (?token=[secret]&page=2) is not eaten again
  [new RegExp(`\\b[\\w.-]{0,40}${NAME}[\\w.-]{0,40}["']?\\s*[=:]\\s*(?!\\[secret\\])(?:"[^"]*"|'[^']*'|\\S+)`, 'gi'), MASK],
];

// Only the first MASK_INPUT_MAX characters are masked and returned: callers cut a turn to TURN_CAP afterwards,
// so nothing past the margin is ever used. Mask first and cut second, so no secret is cut in half and left readable.
export function maskSecrets(text) {
  let out = String(text ?? '');
  if (out.length > MASK_INPUT_MAX) out = out.slice(0, MASK_INPUT_MAX);
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out;
}

// mask, then cut to the turn cap: what a turn becomes before it is uploaded
export function maskTurn(text, cap = TURN_CAP) {
  const out = maskSecrets(text);
  return out.length > cap ? out.slice(0, cap) : out;
}
