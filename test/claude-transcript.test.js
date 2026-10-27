const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Before the provider is loaded, so it never looks at the real ~/.claude.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-'));
process.env.CLAUDE_CONFIG_DIR = home;
const { claude, claudeItems, listClaudeSessions } = require('../out/providers/claude');
const { readLines } = require('../out/transcript');

const FIXTURE = path.join(__dirname, 'fixtures', 'claude.jsonl');
const tmp = (name, content) => {
  const f = path.join(home, name);
  fs.writeFileSync(f, content);
  return f;
};
const fixtureLines = () => fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/).filter(Boolean);

test('items in order', () => {
  const kinds = claudeItems(fixtureLines()).map(i => i.kind);
  assert.deepStrictEqual(kinds, ['user', 'assistant', 'tool', 'image', 'toolResult', 'user', 'image', 'tool', 'toolResult', 'assistant']);
});

test('tool summary', () => {
  const tools = claudeItems(fixtureLines()).filter(i => i.kind === 'tool');
  assert.deepStrictEqual(tools[0], { kind: 'tool', name: 'Read', summary: 'src/a.ts' });
  assert.strictEqual(tools[1].summary, 'npm test --all');
});

test('tool result text, image and error flag', () => {
  const items = claudeItems(fixtureLines());
  assert.deepStrictEqual(items[3], { kind: 'image', mime: 'image/png', data: 'iVBORw0KGgo=' });
  assert.strictEqual(items[4].text, 'Screenshot size: 1x1');
  assert.ok(!items[4].error);
  assert.deepStrictEqual(items[8], { kind: 'toolResult', text: 'exit 1', error: true });
});

test('bookkeeping skipped', () => {
  const texts = JSON.stringify(claudeItems(fixtureLines()));
  for (const s of ['Reading a file', 'mine', 'noise', 'local-command-caveat', 'hmm']) assert.ok(!texts.includes(s), s);
});

test('partial last line', async () => {
  const content = fs.readFileSync(FIXTURE, 'utf8').replace(/\r?\n$/, '');
  const f = tmp('partial.jsonl', content);
  const first = await claude.readTranscript(f, 0);
  assert.strictEqual(first.items.length, 9);
  assert.strictEqual(first.items.at(-1).kind, 'toolResult');
  assert.strictEqual(first.next, Buffer.byteLength(content.slice(0, content.lastIndexOf('\n') + 1)));
  fs.appendFileSync(f, '\n');
  const rest = await claude.readTranscript(f, first.next);
  assert.strictEqual(rest.items.length, 1);
  assert.strictEqual(rest.items[0].kind, 'assistant');
  assert.strictEqual(rest.next, fs.statSync(f).size);
});

test('shrunk file restarts', () => {
  const f = tmp('shrunk.jsonl', fs.readFileSync(FIXTURE));
  const r = readLines(f, 10_000_000);
  assert.ok(r.next <= fs.statSync(f).size);
  assert.strictEqual(r.lines.length, fixtureLines().length);
});

test('waiting is its own state, not busy', () => {
  const sid = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-2222-4222-8222-222222222222`;
  const live = path.join(home, 'sessions');
  fs.mkdirSync(live, { recursive: true });
  const rec = (pid, sessionId, extra) => fs.writeFileSync(path.join(live, pid + '.json'), JSON.stringify({ pid, sessionId, cwd: home, ...extra }));
  // process.pid has a transcript (first listing branch); its parent has none (second branch)
  const proj = path.join(home, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(proj, sid('a') + '.jsonl'));
  rec(process.pid, sid('a'), { status: 'waiting', waitingFor: 'dialog open' });
  rec(process.ppid, sid('b'), { status: 'waiting' });
  const by = id => listClaudeSessions('open', {}).find(s => s.id === id);
  for (const [id, why] of [[sid('a'), 'dialog open'], [sid('b'), 'input']]) {
    assert.strictEqual(by(id).waitingFor, why);
    assert.ok(!by(id).busy);
    assert.ok(by(id).live);
  }
  rec(process.pid, sid('a'), { status: 'busy' });
  assert.strictEqual(by(sid('a')).busy, true);
  assert.strictEqual(by(sid('a')).waitingFor, undefined);
});

const injected = () => claudeItems(fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-injected.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean));

test('lines the user did not write: kinds', () => {
  assert.deepStrictEqual(injected().map(i => i.kind), ['tool', 'toolResult', 'note', 'user', 'user', 'tool', 'toolResult', 'note', 'user', 'user', 'note', 'note']);
});

test('slash command becomes a chip, its output a result without ansi', () => {
  const [cmd, out] = injected();
  assert.deepStrictEqual(cmd, { kind: 'tool', name: '/model', summary: 'opus' });
  assert.deepStrictEqual(out, { kind: 'toolResult', text: 'Set model to opus <5>' });
});

test('compact summary is a note', () => {
  const n = injected()[2];
  assert.strictEqual(n.title, 'Conversation compacted');
  assert.ok(n.text.startsWith('This session is being continued'));
});

test('system-reminder blocks are dropped, the rest stays', () => {
  const users = injected().filter(i => i.kind === 'user').map(i => i.text);
  assert.deepStrictEqual(users, ['fix this', 'look at it', '<pasted_content id="1">\nhello\n</pasted_content>', 'hello']);
});

test('bash mode and background tasks', () => {
  const items = injected();
  assert.deepStrictEqual(items[5], { kind: 'tool', name: '!', summary: 'ls -la' });
  assert.deepStrictEqual(items[6], { kind: 'toolResult', text: 'a > b' });
  assert.deepStrictEqual(items[7], { kind: 'note', title: 'Background task', text: 'Background command "build" failed' });
});

test('an interrupted request is a note, not a bubble', () => {
  const items = injected();
  assert.deepStrictEqual(items.slice(-2), [
    { kind: 'note', title: 'Interrupted by user', text: '' },
    { kind: 'note', title: 'Interrupted by user', text: '' },
  ]);
  assert.ok(!items.some(i => i.kind === 'user' && i.text.includes('interrupted')));
});

const img = (b64) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } });
const jline = (o) => JSON.stringify(o) + '\n';

test('readLines gives each line its byte offset', () => {
  const f = tmp('offsets.jsonl', '{"a":"é"}\n\n{"b":2}\r\n{"c":3}');
  const r = readLines(f, 0);
  const bytes = fs.readFileSync(f);
  assert.deepStrictEqual(r.lines, ['{"a":"é"}', '{"b":2}']);
  assert.deepStrictEqual(r.offsets, [0, bytes.indexOf('{"b"')]);
  assert.strictEqual(r.next, bytes.indexOf('{"c"'));
  assert.strictEqual(readLines(f, r.next).offsets.length, 0);
});

test('images stay on disk: no data, a loader', async () => {
  const { items } = await claude.readTranscript(FIXTURE, 0);
  const images = items.filter(i => i.kind === 'image');
  assert.strictEqual(images.length, 2);
  for (const i of images) {
    assert.ok(!('data' in i));
    assert.strictEqual(typeof i.load, 'function');
  }
});

test('load returns the base64, also for the n-th image of one line', async () => {
  const f = tmp('two.jsonl', jline({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [img('QUFB'), { type: 'text', text: 'x' }, img('QkJC')] }] } }));
  const { items } = await claude.readTranscript(f, 0);
  const images = items.filter(i => i.kind === 'image');
  assert.deepStrictEqual(await Promise.all(images.map(i => i.load())), ['QUFB', 'QkJC']);
  const fixture = (await claude.readTranscript(FIXTURE, 0)).items.filter(i => i.kind === 'image');
  assert.deepStrictEqual(await Promise.all(fixture.map(i => i.load())), ['iVBORw0KGgo=', 'iVBORw0KGgo=']);
});

test('an old item still loads the right image after lines were appended', async () => {
  const f = tmp('grow.jsonl', jline({ type: 'user', message: { role: 'user', content: [img('QUFB')] } }));
  const first = await claude.readTranscript(f, 0);
  fs.appendFileSync(f, jline({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
    + jline({ type: 'user', message: { role: 'user', content: [img('Q0ND')] } }));
  const more = await claude.readTranscript(f, first.next);
  assert.strictEqual(await first.items[0].load(), 'QUFB');
  assert.strictEqual(await more.items.find(i => i.kind === 'image').load(), 'Q0ND');
});

test('a transcript that does not exist yet reads as empty, then fills in from `next` once it appears', async () => {
  const f = path.join(home, 'later', 'new.jsonl');
  const none = await claude.readTranscript(f, 0);
  assert.deepStrictEqual(none, { items: [], next: 0 });
  fs.mkdirSync(path.dirname(f));
  fs.writeFileSync(f, jline({ type: 'user', message: { role: 'user', content: 'hello' } }));
  const first = await claude.readTranscript(f, none.next);
  assert.deepStrictEqual(first.items.map(i => i.kind), ['user']);
  fs.appendFileSync(f, jline({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }));
  assert.deepStrictEqual((await claude.readTranscript(f, first.next)).items.map(i => i.kind), ['assistant']);
});
