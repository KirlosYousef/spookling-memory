// Is this text plausibly TOML? There is no TOML library here, and only our own tables are ever edited, so this is a syntax screen:
// it refuses a file that is clearly broken (so it is never overwritten blind) and accepts everything well formed.
const KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const PAIR = new RegExp(String.raw`^(${KEY}(?:\s*\.\s*${KEY})*)\s*=\s*(.*)$`);

// walks a value, tracking brackets and multi-line strings across lines; returns an error text or null
function scan(s, st) {
  let i = 0;
  while (i < s.length) {
    if (st.multi) {
      const j = s.indexOf(st.multi, i);
      if (j < 0) return null;
      i = j + 3;
      st.multi = null;
      continue;
    }
    const c = s[i];
    if (c === '#') return null;
    if (s.startsWith('"""', i) || s.startsWith("'''", i)) { st.multi = s.slice(i, i + 3); i += 3; continue; }
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; }
      if (i >= s.length) return 'unterminated string';
      i++;
      continue;
    }
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return 'unterminated string';
      i = j + 1;
      continue;
    }
    if (c === '[' || c === '{') st.depth++;
    else if (c === ']' || c === '}') { st.depth--; if (st.depth < 0) return 'unbalanced bracket'; }
    i++;
  }
  return null;
}

/** null when it looks like TOML, else `line N: why`. */
export function checkToml(text) {
  const st = { depth: 0, multi: null };
  const lines = String(text ?? '').split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (st.depth > 0 || st.multi) {
      const e = scan(line, st);
      if (e) return `line ${n + 1}: ${e}`;
      continue;
    }
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (/^\[\[?.*\]\]?\s*(#.*)?$/.test(t)) continue;
    const m = PAIR.exec(t);
    if (!m || !m[2].trim()) return `line ${n + 1}: not a table header or key = value`;
    const e = scan(m[2], st);
    if (e) return `line ${n + 1}: ${e}`;
  }
  if (st.multi) return 'a multi-line string is never closed';
  if (st.depth > 0) return 'an array or inline table is never closed';
  return null;
}
