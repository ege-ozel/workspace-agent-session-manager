export interface CodeToken { text: string; tone?: 'keyword' | 'string' | 'number' | 'comment' | 'call' }
export interface CodeLine { number?: number; sign?: string; tone?: 'add' | 'del' | 'meta'; tokens: CodeToken[] }

const WORDS = new Set('const let var function return if else for while class interface type import export from async await new throw try catch finally def with as pass in True False None true false null undefined public private readonly extends implements'.split(' '));
const TOKEN = /\/\/.*$|\/\*[\s\S]*?\*\/|#[^\n]*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b/g;

/** A small lexical highlighter. Tokens remain text, including untrusted HTML in strings and comments. */
export function codeTokens(source: string): CodeToken[] {
  const out: CodeToken[] = [];
  let at = 0;
  for (const m of source.matchAll(TOKEN)) {
    if (m.index! > at) out.push({ text: source.slice(at, m.index) });
    const text = m[0];
    const tone = /^(\/\/|\/\*|#)/.test(text) ? 'comment' : /^["'`]/.test(text) ? 'string'
      : /^\d/.test(text) ? 'number' : WORDS.has(text) ? 'keyword'
      : /^\s*\(/.test(source.slice(m.index! + text.length)) ? 'call' : undefined;
    out.push(tone ? { text, tone } : { text });
    at = m.index! + text.length;
  }
  if (at < source.length) out.push({ text: source.slice(at) });
  return out;
}

/** Only hunk headers supply real diff line numbers. A patch without one keeps the gutter blank. */
export function codeLines(source: string, diff = false): CodeLine[] {
  let before: number | undefined, after: number | undefined;
  return source.replace(/\r\n?/g, '\n').split('\n').map((line, i) => {
    if (!diff) return { number: i + 1, tokens: codeTokens(line) };
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { before = +hunk[1]; after = +hunk[2]; }
    if (hunk || /^(\*\*\*|--- |\+\+\+ |@@|\\ No newline)/.test(line)) return { tone: 'meta', tokens: [{ text: line }] };
    if (line.startsWith('+')) return { number: after === undefined ? undefined : after++, sign: '+', tone: 'add', tokens: codeTokens(line.slice(1)) };
    if (line.startsWith('-')) return { number: before === undefined ? undefined : before++, sign: '-', tone: 'del', tokens: codeTokens(line.slice(1)) };
    if (line.startsWith(' ')) {
      const number = after;
      if (before !== undefined) before++;
      if (after !== undefined) after++;
      return { number, sign: ' ', tokens: codeTokens(line.slice(1)) };
    }
    return { tokens: codeTokens(line) };
  });
}
