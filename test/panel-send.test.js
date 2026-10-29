const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');
const file = path.resolve(__dirname, '../out/panel/panel.js');
const localRequire = createRequire(file);
let chooseMessage;
const notices = [];
const sandbox = {
  exports: {}, require: id => id === 'vscode' ? { window: { async showInformationMessage(...args) {
    notices.push(args);
    return chooseMessage?.(...args);
  } } } : localRequire(id),
  setTimeout, clearTimeout, setInterval, clearInterval,
};
vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nexports.SessionPanel = SessionPanel;', sandbox);
function fixture() {
  const s = { id: 'A', title: 'Title', file: 'f', mtime: 0, live: true };
  const writes = [], posts = [];
  const t = { sendText: (...args) => writes.push(args) };
  const host = { fresh: async () => s, session: () => s, terminal: () => t, terminalSessionId: () => 'A', ours: () => true };
  const panel = Object.assign(Object.create(sandbox.exports.SessionPanel.prototype), {
    host, p: { id: 'test', terminal() {} }, session: s, queue: [], pending: [], items: [], resumeAt: 0, resumeLiveAt: 0,
    post: m => posts.push(m), postState() {},
  });
  return { panel, host, s, t, writes, posts };
}
test('panel submits text and Enter separately without showing the terminal', async () => {
  const { panel, writes, t } = fixture();
  t.show = () => assert.fail('must not reveal terminal');
  const sending = panel.trySend('hello', true);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(writes, [['hello', false]]);
  assert.equal(await sending, 'sent');
  assert.deepEqual(writes, [['hello', false], ['\r', false]]);
});
test('resumed session holds first message until live input has settled', async () => {
  const { panel, writes } = fixture();
  panel.resumeAt = Date.now();
  assert.equal(await panel.trySend('hello', true), 'held');
  assert.equal(panel.queue[0], 'hello');
  assert.equal(writes.length, 0);
  panel.resumeLiveAt = Date.now() - 2000;
  assert.equal(await panel.trySend(panel.queue[0], false), 'sent');
});
test('no Enter reaches a terminal moved to another session during paste', async () => {
  const { panel, host, writes } = fixture();
  const sending = panel.trySend('hello', true);
  await new Promise(r => setTimeout(r, 20));
  host.terminalSessionId = () => 'B';
  assert.equal(await sending, 'refused');
  assert.deepEqual(writes, [['hello', false]]);
});
test('closed session is rechecked and resumed in background on first send', async () => {
  const { panel, host, posts } = fixture();
  host.fresh = async () => undefined;
  host.terminal = () => undefined;
  let resumed;
  host.resume = (...args) => { resumed = args; return false; };
  await panel.send('hello');
  assert.deepEqual(resumed, ['test', 'A', true]);
  assert.equal(posts[0].text, 'hello');
});
test('a failed listing never starts a second agent', async () => {
  const { panel, host, posts } = fixture();
  host.fresh = async () => { throw Error('unreadable'); };
  host.resume = () => assert.fail('must not resume');
  await panel.send('hello');
  assert.equal(posts[0].type, 'rejected');
});

test('panel forwards focus and blur with the exact provider and session', () => {
  const { panel, host } = fixture();
  const calls = [];
  host.focusSession = (...args) => calls.push(args);
  panel.onMessage({ type: 'focus', active: true });
  panel.onMessage({ type: 'focus', active: false });
  assert.deepEqual(calls, [['test', 'A', true], ['test', 'A', false]]);
});

test('appearance saves the requested theme, independent of the previous stored theme', async () => {
  const { panel } = fixture();
  const writes = [];
  panel.ctx = { globalState: { get: () => 'terminal', update: async (...args) => writes.push(args) } };
  panel.onMessage({ type: 'bg', theme: 'dark' });
  panel.onMessage({ type: 'bg', theme: 'editor' });
  panel.onMessage({ type: 'bg', theme: 'unknown' });
  await Promise.resolve();
  assert.deepEqual(writes, [['panelTheme', 'dark'], ['panelTheme', 'editor']]);
});

test('text size persists valid choices and rejects invalid values', async () => {
  const { panel } = fixture();
  const writes = [];
  panel.ctx = { globalState: { update: async (...args) => writes.push(args) } };
  for (const size of [11, 18, 22, 10, 23, 15.5, '18', null]) panel.onMessage({ type: 'fontSize', size });
  await Promise.resolve();
  assert.deepEqual(writes, [['panelFontSize', 11], ['panelFontSize', 18], ['panelFontSize', 22]]);
});

test('an explicitly connected live terminal sends the pending message on the first attempt', async () => {
  const { panel, host, t, writes } = fixture();
  let connected = false;
  host.terminal = () => connected ? t : undefined;
  host.connectTerminal = async (provider, id) => {
    assert.equal(provider, 'test');
    assert.equal(id, 'A');
    connected = true;
    return true;
  };
  chooseMessage = () => 'Connect terminal';
  try { await panel.send('dictated message'); } finally { chooseMessage = undefined; }
  assert.deepEqual(writes, [['dictated message', false], ['\r', false]]);
});
test('declining a terminal connection restores text without sending anything', async () => {
  const { panel, host, writes, posts } = fixture();
  host.terminal = () => undefined;
  host.connectTerminal = async () => assert.fail('choosing a terminal must be explicit');
  await panel.send('keep this text');
  assert.deepEqual(writes, []);
  assert.equal(posts[0].type, 'rejected');
  assert.equal(posts[0].text, 'keep this text');
});

test('a disconnected live panel exposes recovery beside an enabled composer', () => {
  const { panel, host, posts, s } = realState(fixture());
  host.terminal = () => undefined;
  host.connectTerminal = async () => false;
  panel.postState(false, s);
  const state = posts.at(-1);
  assert.equal(state.canSend, true);
  assert.equal(state.canResume, true);
  assert.equal(state.canConnect, true);
  assert.match(state.connectionReason, /No terminal is connected/);
  assert.doesNotMatch(state.connectionReason, /already open|another process|read.only/i);
});

test('live recovery preserves input and waits for the native resume confirmation', async () => {
  const { panel, host, s, t, writes, posts } = realState(fixture());
  let connected = false, starts = 0;
  host.terminal = () => connected ? t : undefined;
  host.resume = (provider, id, background) => {
    assert.deepEqual([provider, id, background], ['test', 'A', false]);
    connected = true;
    starts++;
    return true;
  };
  chooseMessage = () => 'Continue here';
  try {
    await panel.send('keep this during the native dialog');
    assert.equal(starts, 1);
    assert.equal(panel.resumeNeedsReady, true);
    assert.equal(panel.queue[0], 'keep this during the native dialog');
    assert.equal(panel.pending[0].status, 'held');
    s.busy = true; // The other process being busy does not prove this new terminal is ready.
    panel.postState(false, s);
    assert.equal(posts.at(-1).busy, false);
    assert.equal(posts.at(-1).resumeNeedsReady, true);
    await panel.flush();
    assert.deepEqual(writes, []);
    await panel.continueHere();
    assert.equal(starts, 1);
    panel.onMessage({ type: 'resumeReady' });
    s.busy = false;
    // Stop the automatic pass so the same checks can be advanced deterministically below.
    while (panel.flushing) await new Promise(r => setTimeout(r, 10));
    panel.resumeLiveAt = Date.now() - 2000;
    await panel.flush();
    assert.deepEqual(writes, [['keep this during the native dialog', false], ['\r', false]]);
    assert.equal(panel.queue.length, 0);
  } finally { chooseMessage = undefined; panel.disposed = true; }
});

test('Continue here reuses a terminal recovered by the fresh check', async () => {
  const { panel, host, t } = fixture();
  let found = false;
  const fresh = host.fresh;
  host.fresh = async () => { found = true; return fresh(); };
  host.terminal = () => found ? t : undefined;
  host.resume = () => assert.fail('must not start a duplicate terminal');
  await panel.continueHere();
});

test('closing a panel during the fresh check never starts another terminal', async () => {
  const { panel, host, s } = fixture();
  host.terminal = () => undefined;
  host.fresh = async () => { panel.disposed = true; return s; };
  host.resume = () => assert.fail('closed panel must not start a terminal');
  await panel.continueHere();
  await panel.send('do not reopen');
});

test('closing the resume-confirmation terminal restores held text and offers recovery again', async () => {
  const { panel, t, posts } = realState(fixture());
  panel.resumeAt = Date.now();
  panel.resumeNeedsReady = true;
  panel.queue.push('keep after close');
  panel.pending.push({ id: 'fedcba9876543210', text: 'keep after close', status: 'held', after: 0 });
  t.exitStatus = { code: 1 };
  panel.postState(false);
  assert.equal(panel.resumeNeedsReady, false);
  assert.equal(panel.queue.length, 0);
  assert.equal(posts.at(-1).canResume, true);
  assert.ok(posts.some(m => m.type === 'rejected' && m.text === 'keep after close'));
});

test('busy agents hold new messages inside the panel queue', async () => {
  const { panel, s, writes } = fixture();
  s.busy = true;
  assert.equal(await panel.trySend('next task', true), 'held');
  assert.equal(panel.queue[0], 'next task');
  assert.deepEqual(writes, []);
});

test('Codex hands ordinary prompts to its native queue even with an old busy flag after restart', async () => {
  const { panel, s, writes } = fixture();
  panel.p.queueInput = '\t';
  s.busy = true;
  await panel.send('first');
  await panel.send('second');
  assert.deepEqual(writes, [['\x1b[200~first\x1b[201~', false], ['\t', false], ['\x1b[200~second\x1b[201~', false], ['\t', false]]);
  assert.equal(panel.queue.length, 0);
  assert.equal(panel.pending.length, 2);
  assert.ok(panel.pending.every(d => d.status === 'agent'));
});

test('Claude sends through Enter while busy instead of waiting for idle in the panel', async () => {
  const { panel, s, writes } = fixture();
  panel.p.queueInput = '\r';
  s.busy = true;
  await panel.send('next instruction');
  assert.deepEqual(writes, [['\x1b[200~next instruction\x1b[201~', false], ['\r', false]]);
  assert.equal(panel.queue.length, 0);
});

test('native queues still hold input while a terminal dialog is open', async () => {
  const { panel, s, writes } = fixture();
  panel.p.queueInput = '\r';
  s.waitingFor = 'permission';
  await panel.send('do not answer the dialog');
  assert.deepEqual(writes, []);
  assert.equal(panel.queue.length, 1);
  assert.equal(panel.pending[0].status, 'held');
});

test('Codex slash commands use Enter instead of Tab completion', async () => {
  const { panel, writes } = fixture();
  panel.p.queueInput = '\t';
  await panel.send('/status');
  assert.deepEqual(writes, [['/status', false], ['\r', false]]);
});

test('a queued message is restored if its terminal disappears rather than waiting forever', async () => {
  const { panel, s, host, posts } = fixture();
  s.busy = true;
  await panel.send('keep this');
  host.terminalSessionId = () => undefined;
  await panel.flush();
  assert.equal(panel.queue.length, 0);
  assert.equal(panel.pending.length, 0);
  assert.equal(posts[0].type, 'rejected');
  assert.equal(posts[0].text, 'keep this');
});

test('a refused queue returns all messages together in their original order', async () => {
  const { panel, s, host, posts } = fixture();
  s.waitingFor = 'permission';
  await panel.send('first');
  await panel.send('second');
  host.terminalSessionId = () => undefined;
  await panel.flush();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, 'first\n\nsecond');
  assert.equal(panel.pending.length, 0);
});
test('rapid submissions wait for the previous turn and retain FIFO order', async () => {
  const { panel, s, writes } = fixture();
  s.busy = false;
  await panel.send('first');
  await panel.send('second');
  await panel.send('third');
  assert.deepEqual(writes, [['first', false], ['\r', false]]);
  assert.equal(panel.queue.join(','), 'second,third');
  s.busy = true;
  assert.equal(await panel.trySend(panel.queue[0], false), 'held');
  s.busy = false;
  s.mtime++;
  assert.equal(await panel.trySend(panel.queue[0], false), 'sent');
  assert.deepEqual(writes, [['first', false], ['\r', false], ['second', false], ['\r', false]]);
});
test('a short completed reply can advance the queue even if its busy state was between polls', async () => {
  const { panel, s } = fixture();
  s.busy = false;
  assert.equal(await panel.trySend('first', false), 'sent');
  assert.equal(await panel.trySend('second', false), 'held');
  s.mtime++;
  assert.equal(await panel.trySend('second', false), 'sent');
});

test('queue completion clears the pending indicator after a fresh idle update', async () => {
  const { panel, s } = fixture();
  s.busy = false;
  await panel.trySend('first', false);
  assert.ok(panel.awaitingReply);
  panel.waitingForReply({ ...s, busy: true });
  assert.equal(panel.waitingForReply({ ...s, busy: false, mtime: 1 }), false);
  assert.equal(panel.awaitingReply, undefined);
});

test('incoming webview messages keep submission order while session checks are asynchronous', async () => {
  const { panel, s, host, writes } = fixture();
  panel.submissions = Promise.resolve();
  s.busy = false;
  let checks = 0;
  host.fresh = async () => {
    if (++checks === 1) await new Promise(resolve => setTimeout(resolve, 40));
    return s;
  };
  panel.onMessage({ type: 'send', text: 'first' });
  panel.onMessage({ type: 'send', text: 'second' });
  await panel.submissions;
  assert.deepEqual(writes, [['first', false], ['\r', false]]);
  assert.equal(panel.queue[0], 'second');
});

test('continuous transcript changes still update before writing stops', async () => {
  const { panel } = fixture();
  let updates = 0;
  panel.pump = async () => { updates++; };
  panel.schedule();
  const writes = setInterval(() => panel.schedule(), 30);
  try {
    await new Promise(resolve => setTimeout(resolve, 370));
    assert.ok(updates >= 1);
  } finally {
    clearInterval(writes);
    clearTimeout(panel.debounce);
  }
});


function realState(f) {
  const { panel, host } = f;
  delete panel.postState;
  panel.panel = { title: '' };
  panel.ctx = { globalState: { get: (key, fallback) => fallback } };
  panel.theme = () => 'editor';
  panel.fontSize = () => 14;
  host.snapshot = () => undefined;
  return f;
}

test('unaccepted input does not turn on working or wait for an agent that never started', async () => {
  const { panel, posts, writes, s } = realState(fixture());
  panel.p.queueInput = '\t';
  s.busy = false;
  await panel.send('hello');
  const state = posts.at(-1);
  assert.equal(state.busy, false);
  assert.equal(state.activity, 'Confirming delivery\u2026');
  assert.equal(panel.awaitingReply, undefined);
  assert.deepEqual(writes, [['\x1b[200~hello\x1b[201~', false], ['\r', false]]);
  panel.pending[0].submittedAt = Date.now() - 11000;
  panel.postState(false);
  assert.equal(posts.at(-1).activity, undefined);
  assert.equal(posts.at(-1).pending[0].reason, 'timeout');
  assert.equal(writes.length, 2); // A missing confirmation must never trigger a second submission.
});

test('closing the terminal restores held input and marks written input unconfirmed', async () => {
  const { panel, host, posts, t } = realState(fixture());
  panel.p.queueInput = '\t';
  await panel.send('written');
  panel.queue.push('not written');
  panel.pending.push({ id: 'fedcba9876543210', text: 'not written', status: 'held', after: 0 });
  t.exitStatus = { code: 0 };
  panel.postState(false);
  assert.equal(panel.queue.length, 0);
  assert.equal(panel.pending.length, 1);
  assert.equal(panel.pending[0].reason, 'disconnected');
  assert.ok(posts.some(m => m.type === 'rejected' && m.text === 'not written'));
});

test('panel distinguishes recorded compaction from a requested command', async () => {
  const { panel, s, posts } = realState(fixture());
  panel.p.queueInput = '\t';
  await panel.send('/compact');
  assert.equal(posts.at(-1).activity, 'Context compaction requested\u2026');
  assert.equal(posts.at(-1).busy, false);
  s.busy = true;
  s.activity = 'compacting';
  s.activitySince = Date.now() - 21000;
  panel.postState(false, s);
  assert.equal(posts.at(-1).activity, 'Compacting context\u2026');
  assert.equal(posts.at(-1).busyLabel, 'compacting context');
  assert.equal(posts.at(-1).busySince, s.activitySince);
});

test('interrupt reaches only the exact live busy session without revealing its terminal', async () => {
  const { panel, s, t, writes } = fixture();
  panel.p.interruptInput = '\x1b';
  s.busy = true;
  t.show = () => assert.fail('interrupt must retain panel focus');
  await panel.interrupt();
  assert.deepEqual(writes, [['\x1b', false]]);
});

test('interrupt is refused for idle, disconnected, changed, dialog and still-starting sessions', async () => {
  for (const scenario of ['idle', 'gone', 'changed', 'dialog', 'resume', 'typing']) {
    const { panel, s, host, writes } = fixture();
    panel.p.interruptInput = '\x1b';
    s.busy = true;
    if (scenario === 'idle') s.busy = false;
    if (scenario === 'gone') host.fresh = async () => undefined;
    if (scenario === 'changed') host.terminalSessionId = () => 'B';
    if (scenario === 'dialog') s.waitingFor = 'permission';
    if (scenario === 'resume') panel.resumeNeedsReady = true;
    if (scenario === 'typing') panel.typing = true;
    await panel.interrupt();
    assert.deepEqual(writes, [], scenario);
  }
});

test('restored native-confirmation state waits for terminal recovery before clearing', () => {
  const { panel, host, posts, s } = realState(fixture());
  panel.restored = true;
  panel.resumeNeedsReady = true;
  host.terminal = () => undefined;
  panel.postState(false);
  assert.equal(panel.resumeNeedsReady, true);
  panel.postState(false, { ...s, live: false });
  assert.equal(panel.resumeNeedsReady, false);
  assert.equal(posts.at(-1).canResume, true);
});
