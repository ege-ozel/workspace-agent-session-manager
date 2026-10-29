const test = require('node:test');
const assert = require('node:assert/strict');
const { acknowledge, checkDeliveries, restoreDeliveries } = require('../out/panel/delivery');
const { terminalText } = require('../out/panel/send');
const pending = (text, after = 10) => ({ id: '0123456789abcdef', text, status: 'agent', after });

test('only a new matching user transcript record confirms a message', () => {
  const messages = [pending('hello')];
  assert.equal(acknowledge(messages, [{ kind: 'user', text: 'hello' }], 0).length, 1);
  assert.equal(acknowledge(messages, [{ kind: 'assistant', text: 'hello' }], 10).length, 1);
  assert.equal(acknowledge(messages, [{ kind: 'user', text: 'hello' }], 10).length, 0);
  assert.equal(acknowledge([{ ...pending('hello'), status: 'held' }], [{ kind: 'user', text: 'hello' }], 10).length, 1);
  assert.equal(messages.length, 1);
});

test('repeated messages are acknowledged one at a time and pasted wrappers are ignored', () => {
  const messages = [pending('hello\nworld'), pending('hello\nworld')];
  const left = acknowledge(messages, [{ kind: 'user', text: '<pasted_content id="1">hello world</pasted_content>' }], 10);
  assert.equal(left.length, 1);
});

test('reload keeps unconfirmed text for recovery without creating a second submission', () => {
  const restored = restoreDeliveries([pending('keep this')]);
  assert.equal(restored[0].status, 'unconfirmed');
  assert.equal(restored[0].text, 'keep this');
  assert.equal(restoreDeliveries([{ text: 'invalid' }, { ...pending('huge'), text: 'x'.repeat(200001) }]).length, 0);
  assert.equal(restoreDeliveries(undefined).length, 0);
});

test('recorded slash commands and compaction acknowledge their pending notices', () => {
  assert.equal(acknowledge([pending('/usage')], [{ kind: 'tool', name: '/usage', summary: '' }], 10).length, 0);
  assert.equal(acknowledge([pending('/compact')], [{ kind: 'note', title: 'Conversation compacted', text: '' }], 10).length, 0);
  assert.equal(acknowledge([pending('/model')], [{ kind: 'note', title: 'Conversation compacted', text: '' }], 10).length, 1);
});

test('tabs in pasted text cannot submit the native Codex queue halfway through the message', () => {
  assert.equal(terminalText('one\ttwo'), '\x1b[200~one\ttwo\x1b[201~');
});

test('one combined user record confirms all consecutive submissions, including restored ones', () => {
  const messages = [pending('first\npart'), { ...pending('second part'), status: 'unconfirmed' }, pending('still waiting')];
  const left = acknowledge(messages, [{ kind: 'user', text: 'first part  second\npart' }], 10);
  assert.deepEqual(left.map(d => d.text), ['still waiting']);
  assert.equal(messages.length, 3);
});

test('combined confirmation requires the complete message and respects boundaries and held messages', () => {
  const combined = [{ kind: 'user', text: 'one two' }];
  assert.equal(acknowledge([pending('one'), pending('two')], combined, 0).length, 2);
  assert.equal(acknowledge([pending('one'), { ...pending('two'), status: 'held' }], combined, 10).length, 2);
  assert.equal(acknowledge([pending('one')], combined, 10).length, 1);
  assert.equal(acknowledge([pending('one'), pending('two')], [{ kind: 'user', text: 'someone two' }], 10).length, 2);
});

test('unconfirmed terminal delivery times out visibly without resubmission or loss', () => {
  const messages = [{ ...pending('keep my text'), submittedAt: 1000 }];
  assert.equal(checkDeliveries(messages, true, 10999)[0].status, 'agent');
  const timedOut = checkDeliveries(messages, true, 11000);
  assert.equal(timedOut[0].status, 'unconfirmed');
  assert.equal(timedOut[0].reason, 'timeout');
  assert.equal(timedOut[0].text, 'keep my text');
  assert.equal(acknowledge(timedOut, [{ kind: 'user', text: 'keep my text' }], 10).length, 0);
  assert.equal(checkDeliveries(messages, false, 1001)[0].reason, 'disconnected');
  assert.equal(checkDeliveries([{ ...messages[0], status: 'held' }], false, 11000)[0].status, 'held');
});

test('native prompts can use a single paste event even without newlines', () => {
  assert.equal(terminalText('long one-line prompt', true), '\x1b[200~long one-line prompt\x1b[201~');
});
