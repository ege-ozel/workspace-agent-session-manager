const test = require('node:test');
const assert = require('node:assert');
const { toView, headerOf, FIRST_BATCH, MAX_RESULT } = require('../out/panel/view-model');

const many = () => Array.from({ length: 500 }, (_, k) =>
  k % 50 === 0 ? { kind: 'image', mime: 'image/png', data: 'AAAA'.repeat(1000) } : { kind: 'assistant', text: 'item ' + k });

test('initial batch is capped and image data is not inlined', () => {
  const items = many();
  const view = toView(items.slice(-FIRST_BATCH), items.length - FIRST_BATCH);
  assert.strictEqual(view.length, 200);
  assert.strictEqual(view[0].i, 300);
  const images = view.filter(v => v.kind === 'image');
  assert.strictEqual(images.length, 4);
  for (const v of images) {
    assert.strictEqual(v.ref, v.i);
    assert.ok(v.i % 50 === 0 && v.i >= 300);
    assert.ok(!('data' in v));
  }
  assert.ok(JSON.stringify(view).length < 20_000);
});

test('assistant markdown rendered', () => {
  const [v] = toView([{ kind: 'assistant', text: '| A | B |\n|---|---|\n| 1 | 2 |' }], 0);
  assert.ok(v.html.includes('<table'));
});

test('pasted content shows without its wrapper', () => {
  const [v] = toView([{ kind: 'user', text: 'see this\n\n<pasted_content id="5c76">\nline <b>1</b>\n</pasted_content>' }], 0);
  assert.ok(!v.html.includes('pasted_content'));
  assert.ok(v.html.includes('<blockquote class="pasted">line &lt;b&gt;1&lt;/b&gt;</blockquote>'));
  assert.ok(v.html.includes('see this'));
});

test('user text is escaped', () => {
  const [v] = toView([{ kind: 'user', text: '<img src=x onerror=alert(1)>' }], 0);
  assert.ok(!v.html.includes('<img'));
});

test('finished edits are marked done', () => {
  const [a, b] = toView([{ kind: 'tool', name: 'Edit', summary: 'src/a.ts' }, { kind: 'tool', name: 'Read', summary: 'src/a.ts' }], 0);
  assert.deepStrictEqual([a.name, a.done], ['✓ edited', true]);
  assert.deepStrictEqual([b.name, b.done], ['Read', undefined]);
});

test('a huge tool result is cut', () => {
  const [v] = toView([{ kind: 'toolResult', text: 'x'.repeat(MAX_RESULT + 500), error: true }], 0);
  assert.strictEqual(v.text.length, MAX_RESULT);
  assert.strictEqual(v.more, 500);
  assert.strictEqual(v.error, true);
});

test('notes pass through', () => {
  const [v] = toView([{ kind: 'note', title: 'Conversation compacted', text: 'summary' }], 7);
  assert.deepStrictEqual(v, { i: 7, kind: 'note', title: 'Conversation compacted', text: 'summary' });
});

test('header shows used, not left, and leaves out what is missing', () => {
  const h = headerOf('Claude', { id: 'a', title: 'T', cwd: '/w/repo', mtime: 0, file: 'f', ctxUsed: 18, model: 'claude-opus-5-5', effort: 'high',
    contextDetail: '180,000 / 1,000,000 tokens · claude-opus-5-5' }, { available: true, fiveLeft: 94, weekLeft: 14, limitsStale: true });
  assert.deepStrictEqual(h, {
    agent: 'Claude', title: 'T', repo: 'repo', cwd: '/w/repo', model: 'claude-opus-5-5', effort: 'high',
    ctx: { pct: 18, label: '180k / 1M' }, five: { pct: 6, stale: true }, week: { pct: 86, stale: true },
  });
  const bare = headerOf('Codex', { id: 'b', title: 'U', mtime: 0, file: 'f' }, undefined);
  assert.deepStrictEqual(bare, { agent: 'Codex', title: 'U' });
});

test('header keeps recorded mode, permissions and full repository path without guessing missing settings', () => {
  const h = headerOf('Codex', { id: 'A', title: 'Title', cwd: 'D:\\repo\\project', file: 'f', mtime: 0,
    mode: 'plan', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  assert.equal(h.cwd, 'D:\\repo\\project');
  assert.equal(h.repo, 'project');
  assert.equal(h.mode, 'plan');
  assert.equal(h.approvalPolicy, 'on-request');
  assert.equal(h.sandbox, 'workspace-write');
  const [tool] = toView([{ kind: 'tool', name: 'exec', summary: 'script', detail: '<script>' + 'x'.repeat(MAX_RESULT) }], 9);
  assert.equal(tool.detail.length, MAX_RESULT);
  assert.equal(tool.more, 8);
  assert.equal(tool.i, 9);
});
