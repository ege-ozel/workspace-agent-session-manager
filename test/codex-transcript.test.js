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
  assert.deepStrictEqual(items().map(i => i.kind), ['image', 'user', 'tool', 'toolResult', 'image', 'tool', 'toolResult', 'note', 'note', 'assistant', 'note']);
});

test('image markers stripped', () => {
  const users = items().filter(i => i.kind === 'user').map(i => i.text);
  assert.deepStrictEqual(users, ['fix this']);
});

test('function call summary', () => {
  const tools = items().filter(i => i.kind === 'tool');
  assert.deepStrictEqual(tools[0], { kind: 'tool', name: 'shell', summary: 'git status', detail: '{"command":["git","status"]}' });
  assert.deepStrictEqual(tools[1], { kind: 'tool', name: 'exec', summary: 'await tools.x()', detail: 'await tools.x()\nmore code' });
});

test('recorded errors and interrupted turns remain visible without leaking unrelated events', () => {
  const events = [{ type: 'error', message: 'Command failed <test>' }, { type: 'warning', message: 'Retrying' },
    { type: 'turn_aborted', reason: 'interrupted' }, { type: 'token_count', info: {} }];
  const parsed = codexItems(events.map(payload => JSON.stringify({ type: 'event_msg', payload })));
  assert.deepStrictEqual(parsed.map(i => i.title), ['Agent error', 'Agent warning', 'Turn interrupted']);
  assert.strictEqual(parsed[0].text, 'Command failed <test>');
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
  const notes = items().filter(i => i.kind === 'note' && !i.title.startsWith('Turn completed'));
  assert.deepStrictEqual(notes, [
    { kind: 'note', title: 'Conversation compacted', text: '' },
    { kind: 'note', title: 'Hook prompt', text: 'Task handoff: review it' },
  ]);
});

test('readTranscript reads a rollout file', async () => {
  const r = await codex.readTranscript(FIXTURE, 0);
  assert.strictEqual(r.items.length, 11);
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

const { codexBusy } = require('../out/providers/codex');
test('working follows lifecycle events, including completion and interruption', () => {
  const f = tmpFile('activity.jsonl', '');
  const event = type => JSON.stringify({ type: 'event_msg', payload: { type } }) + '\n';
  fs.appendFileSync(f, event('task_started'));
  assert.equal(codexBusy(f), true);
  fs.appendFileSync(f, JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'task_complete' } }) + '\n');
  assert.equal(codexBusy(f), true);
  fs.appendFileSync(f, event('task_complete'));
  assert.equal(codexBusy(f), false);
  fs.appendFileSync(f, event('task_started') + event('turn_aborted'));
  assert.equal(codexBusy(f), false);
  fs.appendFileSync(f, event('task_started'));
  assert.equal(codexBusy(f), true);
});
test('missing activity records do not invent a working state', () => {
  assert.equal(codexBusy(tmpFile('no-activity.jsonl', '{}\n')), false);
});
const patch = '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** Add File: added.ts\n+hello\n*** End Patch';
test('direct and exec-wrapped edits expose file names and full patch', () => {
  const calls = [
    { type: 'custom_tool_call', name: 'apply_patch', input: patch },
    { type: 'custom_tool_call', name: 'functions.exec', input: 'await tools.apply_patch(' + JSON.stringify(patch) + ');' },
    { type: 'function_call', name: 'functions.exec', arguments: JSON.stringify({ code: 'await tools.apply_patch(' + JSON.stringify(patch) + ');' }) },
  ];
  for (const payload of calls) {
    const result = codexItems([JSON.stringify({ type: 'response_item', payload })]);
    assert.equal(result[0].name, 'apply_patch');
    assert.equal(result[0].summary, 'src/example.ts · added.ts');
    assert.equal(result[1].text, 'Requested patch\n' + patch);
    assert.equal(result[0].done, undefined); // Request is not proof the edit succeeded.
  }
});
test('patch content is preserved and safely escaped by the view model', () => {
  const { toView } = require('../out/panel/view-model');
  const malicious = patch.replace('+new', '+<script>alert(1)</script>');
  const result = codexItems([JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: malicious } })]);
  assert.equal(toView(result, 0)[1].text, 'Requested patch\n' + malicious);
  // Tool results reach the browser as text, never HTML.
  assert.equal(toView(result, 0)[1].html, undefined);
});

test('final answer ends working even before task_complete is written', () => {
  const f = tmpFile('final-state.jsonl', [
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer' } },
  ].map(JSON.stringify).join('\n') + '\n');
  assert.equal(codexBusy(f), false);
});
test('completed commands retain full command, output and exit status', () => {
  const result = codexItems([JSON.stringify({ type: 'event_msg', payload: {
    type: 'item_completed', item: { type: 'CommandExecution', command: 'Get-Content CLAUDE.md', aggregated_output: '@AGENTS.md', exit_code: 0 }
  } })]);
  assert.equal(result.length, 1);
  assert.match(result[0].title, /^Ran Get-Content CLAUDE.md/);
  assert.match(result[0].title, /exit 0/);
  assert.equal(result[0].text, 'Get-Content CLAUDE.md\n\n@AGENTS.md');
});
test('turn completion uses recorded duration and also works in its own incremental batch', () => {
  const result = codexItems([JSON.stringify({ type: 'event_msg', timestamp: '2026-10-28T12:39:19Z',
    payload: { type: 'task_complete', duration_ms: 8000 } })]);
  assert.match(result[0].title, /^Worked for 8s/);
});

test('FileChange events expose recorded code, including failed edits', () => {
  const changes = { 'src/a.ts': { type: 'update', unified_diff: '@@\n-old\n+new' }, 'new.ts': { type: 'add', content: 'hello' } };
  const result = codexItems([JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed',
    item: { type: 'FileChange', status: 'failed', changes } } })]);
  assert.equal(result.length, 2);
  assert.equal(result[0].text, 'Diff · src/a.ts\n@@\n-old\n+new');
  assert.equal(result[0].error, true);
  assert.equal(result[1].text, 'Diff · new.ts\nhello');
});

test('agent questions retain the full prompt and choices as visible notes', () => {
  const result = codexItems([JSON.stringify({ type: 'response_item', payload: {
    type: 'function_call', name: 'request_user_input_async',
    arguments: JSON.stringify({ questions: [{ title: 'Which terminal?', options: ['First', 'Second'] }] })
  } })]);
  assert.deepEqual(result, [{ kind: 'note', title: 'Question from agent', text: 'Which terminal?\n1. First\n2. Second' }]);
});
test('structured question choices keep their labels and descriptions', () => {
  const result = codexItems([JSON.stringify({ type: 'response_item', payload: {
    type: 'function_call', name: 'functions.request_user_input',
    arguments: JSON.stringify({ questions: [{ question: 'Choose', options: [{ label: 'A', description: 'Details' }] }] })
  } })]);
  assert.match(result[0].text, /Choose\n1\. A/);
  assert.ok(result[0].text.includes('Details'));
});

test('working duration starts at the recorded turn start and clears on completion', () => {
  const { codexActivity } = require('../out/providers/codex');
  const start = '2026-10-28T15:00:00Z';
  const file = tmpFile('activity-since.jsonl', JSON.stringify({ timestamp: start, type: 'event_msg', payload: { type: 'task_started', started_at: start } }) + '\n');
  assert.deepEqual(codexActivity(file), { busy: true, busySince: Date.parse(start) });
  fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n');
  assert.deepEqual(codexActivity(file), { busy: false });
});


test('compaction phase needs an explicit start and ends at completion or abort', () => {
  const { codexActivity } = require('../out/providers/codex');
  const start = Date.parse('2026-10-29T12:00:00Z');
  const event = (type, extra = {}) => JSON.stringify({ timestamp: new Date(start).toISOString(), type: 'event_msg', payload: { type, ...extra } }) + '\n';
  const file = tmpFile('compacting-phase.jsonl', event('task_started'));
  assert.equal(codexActivity(file).activity, undefined);
  fs.appendFileSync(file, event('item_started', { started_at_ms: start + 500, item: { type: 'ContextCompaction' } }));
  assert.deepStrictEqual(codexActivity(file), { busy: true, busySince: start, activity: 'compacting', activitySince: start + 500 });
  fs.appendFileSync(file, event('item_completed', { item: { type: 'ContextCompaction' } }));
  assert.deepStrictEqual(codexActivity(file), { busy: true, busySince: start });
  fs.appendFileSync(file, event('item_started', { item: { type: 'ContextCompaction' } }) + event('turn_aborted'));
  assert.deepStrictEqual(codexActivity(file), { busy: false });
});

test('completion-only compaction logs do not invent a live phase', () => {
  const { codexActivity } = require('../out/providers/codex');
  const file = tmpFile('compacted-phase.jsonl', [
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'compacted', payload: {} },
    { type: 'event_msg', payload: { type: 'context_compacted' } },
  ].map(JSON.stringify).join('\n') + '\n');
  assert.equal(codexActivity(file).activity, undefined);
  assert.equal(codexActivity(file).busy, true);
});
