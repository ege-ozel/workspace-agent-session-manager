const test = require('node:test');
const assert = require('node:assert/strict');
const { codeLines, codeTokens } = require('../out/panel/code');
const { preferredView } = require('../out/panel/preference');

test('diff line numbers follow hunk offsets on both sides', () => {
  const rows = codeLines('@@ -10,2 +20,3 @@\n-old\n+const a = 1;\n+new\n kept', true);
  assert.deepEqual(rows.slice(1).map(r => [r.number, r.sign]), [[10, '-'], [20, '+'], [21, '+'], [22, ' ']]);
});
test('patches without real offsets never invent file line numbers', () => {
  const rows = codeLines('@@\n-old\n+new', true);
  assert.equal(rows[1].number, undefined);
  assert.equal(rows[2].number, undefined);
});
test('highlighter preserves all source text including untrusted markup', () => {
  const source = 'const value = "<script>alert(1)</script>"; // note';
  const tokens = codeTokens(source);
  assert.equal(tokens.map(t => t.text).join(''), source);
  assert.equal(tokens.find(t => t.text === 'const').tone, 'keyword');
  assert.equal(tokens.find(t => t.text.startsWith('"')).tone, 'string');
  assert.equal(tokens.at(-1).tone, 'comment');
});
test('session opening follows the saved view and available capabilities', () => {
  assert.equal(preferredView('terminal', true), 'terminal');
  assert.equal(preferredView('panel', true), 'panel');
  assert.equal(preferredView(undefined, true), 'panel');
  assert.equal(preferredView('panel', false), 'terminal');
});

test('vendored Highlight.js recognizes TypeScript and escapes HTML inside source', () => {
  const hljs = require('../media/vendor/highlight.min.js');
  assert.ok(hljs.getLanguage('typescript'));
  const result = hljs.highlight('const value: string = "<img onerror=alert(1)>";', { language: 'typescript' });
  assert.match(result.value, /hljs-keyword/);
  assert.match(result.value, /hljs-string/);
  assert.ok(!result.value.includes('<img'));
  assert.ok(result.value.includes('&lt;img'));
});
