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

const { readLines } = require('../out/transcript');
const tmpFile = (name, content) => {
  const f = path.join(process.env.CODEX_HOME, name);
  fs.writeFileSync(f, content);
  return f;
};
const png = (b64) => ({ type: 'input_image', image_url: 'data:image/png;base64,' + b64 });
const rline = (payload) => JSON.stringify({ type: 'response_item', payload }) + '\n';

test('images stay on disk: no data, a loader', async () => {
  const { items } = await codex.readTranscript(FIXTURE, 0);
  const images = items.filter(i => i.kind === 'image');
  assert.strictEqual(images.length, 2);
  for (const i of images) {
    assert.ok(!('data' in i));
    assert.strictEqual(typeof i.load, 'function');
  }
  assert.deepStrictEqual(await Promise.all(images.map(i => i.load())), ['iVBORw0KGgo=', 'iVBORw0KGgo=']);
});

test('load finds the n-th image of one output, and survives appended lines', async () => {
  const f = tmpFile('two.jsonl', rline({ type: 'function_call_output', call_id: 'c', output: [png('QUFB'), { type: 'input_text', text: 't' }, png('QkJC')] }));
  const first = await codex.readTranscript(f, 0);
  const images = first.items.filter(i => i.kind === 'image');
  assert.deepStrictEqual(await Promise.all(images.map(i => i.load())), ['QUFB', 'QkJC']);
  fs.appendFileSync(f, rline({ type: 'message', role: 'user', content: [png('Q0ND')] }));
  const more = await codex.readTranscript(f, first.next);
  assert.strictEqual(await images[1].load(), 'QkJC');
  assert.strictEqual(await more.items[0].load(), 'Q0ND');
  assert.ok(readLines(f, 0).offsets.length === 2);
});

test('a rollout that does not exist yet reads as empty, then fills in from `next` once it appears', async () => {
  const f = path.join(process.env.CODEX_HOME, 'later.jsonl');
  const none = await codex.readTranscript(f, 0);
  assert.deepStrictEqual(none, { items: [], next: 0 });
  const line = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } }) + '\n';
  fs.writeFileSync(f, line);
  const first = await codex.readTranscript(f, none.next);
  assert.deepStrictEqual(first.items.map(i => i.kind), ['user']);
  fs.appendFileSync(f, line.replace('hello', 'again'));
  assert.deepStrictEqual((await codex.readTranscript(f, first.next)).items.map(i => i.text), ['again']);
});
