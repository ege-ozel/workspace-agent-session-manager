const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Before the provider is loaded, so it never looks at the real ~/.codex.
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
const { codex, codexItems } = require('../out/providers/codex');

const FIXTURE = path.join(__dirname, 'fixtures', 'codex.jsonl');
const items = () => codexItems(fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/).filter(Boolean));

test('items in order', () => {
  assert.deepStrictEqual(items().map(i => i.kind), ['image', 'user', 'tool', 'toolResult', 'image', 'tool', 'toolResult', 'note', 'note', 'assistant']);
});

test('image markers stripped', () => {
  const users = items().filter(i => i.kind === 'user').map(i => i.text);
  assert.deepStrictEqual(users, ['fix this']);
});

test('function call summary', () => {
  const tools = items().filter(i => i.kind === 'tool');
  assert.deepStrictEqual(tools[0], { kind: 'tool', name: 'shell', summary: 'git status' });
  assert.deepStrictEqual(tools[1], { kind: 'tool', name: 'exec', summary: 'await tools.x()' });
});

test('output images found', () => {
  const all = items();
  assert.deepStrictEqual(all[0], { kind: 'image', mime: 'image/png', data: 'iVBORw0KGgo=' });
  assert.deepStrictEqual(all[3], { kind: 'toolResult', text: 'on branch main' });
  assert.deepStrictEqual(all[4], { kind: 'image', mime: 'image/png', data: 'iVBORw0KGgo=' });
});

test('injected context skipped', () => {
  const text = JSON.stringify(items());
  for (const s of ['AGENTS.md', 'environment_context', 'permissions', 'OLD HISTORY COPY', 'abc', 'quoted text', 'ROOT CONVERSATION']) assert.ok(!text.includes(s), s);
});

test('string output', () => {
  assert.deepStrictEqual(items()[6], { kind: 'toolResult', text: 'done' });
});

test('compaction and hook prompts are notes', () => {
  const notes = items().filter(i => i.kind === 'note');
  assert.deepStrictEqual(notes, [
    { kind: 'note', title: 'Conversation compacted', text: '' },
    { kind: 'note', title: 'Hook prompt', text: 'Task handoff: review it' },
  ]);
});

test('readTranscript reads a rollout file', async () => {
  const r = await codex.readTranscript(FIXTURE, 0);
  assert.strictEqual(r.items.length, 10);
  assert.strictEqual(r.next, fs.statSync(FIXTURE).size);
});
