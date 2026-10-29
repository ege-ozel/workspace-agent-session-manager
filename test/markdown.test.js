const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdown } = require('../out/panel/markdown');

const count = (s, re) => (s.match(re) || []).length;

test('escapes html', () => {
  const h = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(h.includes('&lt;img'));
  assert.ok(!h.includes('<img'));
});

test('drops javascript links', () => {
  assert.ok(!renderMarkdown('[a](javascript:alert(1))').includes('href="javascript:'));
  assert.ok(renderMarkdown('[a](https://x.y)').includes('<a href="https://x.y"'));
});

test('table', () => {
  const h = renderMarkdown('| A | B |\n|---|--:|\n| 1 | 2 |');
  assert.strictEqual(count(h, /<table/g), 1);
  assert.ok(h.includes('<th>A</th>'));
  assert.ok(/<td[^>]*text-align:right[^>]*>2<\/td>/.test(h));
});

test('ragged table', () => {
  const h = renderMarkdown('| A | B | C |\n|---|---|---|\n| 1 | 2 |');
  assert.strictEqual(count(h, /<td/g), 3);
});

test('escaped pipe', () => {
  const a = renderMarkdown('| A |\n|---|\n| a \\| b |');
  assert.strictEqual(count(a, /<td/g), 1);
  assert.ok(a.includes('>a | b<'));
  const b = renderMarkdown('| A |\n|---|\n| `x|y` |');
  assert.strictEqual(count(b, /<td/g), 1);
  assert.ok(b.includes('<code>x|y</code>'));
});

test('fenced code', () => {
  const h = renderMarkdown('```ts\nconst a = 1 < 2\n```');
  assert.ok(h.includes('<pre class="source"><code class="lang-ts">'));
  assert.ok(h.replace(/<[^>]+>/g, '').includes('1 &lt; 2'));
});

test('inline', () => {
  assert.ok(renderMarkdown('**b** *i* `c`').includes('<strong>b</strong> <em>i</em> <code>c</code>'));
});

test('lists and headings', () => {
  const h = renderMarkdown('# H\n- a\n- b\n1. x');
  assert.ok(h.includes('<h1>'));
  assert.strictEqual(count(h, /<ul>/g), 1);
  assert.strictEqual(count(h, /<li>/g), 3);
  assert.strictEqual(count(h, /<ol>/g), 1);
});

test('crlf and turkish', () => {
  const h = renderMarkdown('Şu tablo\r\n\r\n| Ğ | ü |\r\n|---|---|\r\n| ı | ç |');
  assert.strictEqual(count(h, /<table/g), 1);
  for (const c of ['Şu tablo', 'Ğ', 'ü', 'ı', 'ç']) assert.ok(h.includes(c), c);
});

test('a fenced block inside a list item is a code block, not stray backticks', () => {
  const h = renderMarkdown('- **Fast:** run it\n  ```\n  ! code --install x\n\n  second\n  ```\n- **Next:** F5\n\nAfter.');
  assert.strictEqual(count(h, /<pre\b/g), 1);
  assert.strictEqual(count(h, /<li>/g), 2);
  assert.ok(h.replace(/<[^>]+>/g, '').includes('! code --install x\n\nsecond'), h);
  assert.ok(!h.includes('`'), h);
  assert.ok(h.includes('<p>After.</p>'));
});
