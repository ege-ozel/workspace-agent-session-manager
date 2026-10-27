const test = require('node:test');
const assert = require('node:assert');
const { terminalText, sendState } = require('../out/panel/send');

const sess = extra => ({ id: 'A', title: 'T', mtime: 0, file: 'f', ...extra });

test('single line unchanged', () => {
  assert.strictEqual(terminalText('hi'), 'hi');
});

test('multi line bracketed', () => {
  assert.strictEqual(terminalText('a\nb'), '\x1b[200~a\nb\x1b[201~');
  assert.strictEqual(terminalText('a\r\nb\rc'), '\x1b[200~a\nb\nc\x1b[201~');
});

test('canSend false after the terminal moved', () => {
  const s = sendState(sess(), 'B');
  assert.strictEqual(s.canSend, false);
  assert.match(s.reason, /another session/);
});

test('no terminal → read only', () => {
  const s = sendState(sess(), undefined);
  assert.strictEqual(s.canSend, false);
  assert.ok(s.reason);
});

test('no session → read only', () => {
  assert.strictEqual(sendState(undefined, 'A').canSend, false);
});

test('hold while waiting', () => {
  assert.deepStrictEqual(sendState(sess({ waitingFor: 'dialog open' }), 'A'), { canSend: true, hold: true });
});

test('goes straight through otherwise, busy or not', () => {
  assert.deepStrictEqual(sendState(sess({ busy: true }), 'A'), { canSend: true, hold: false });
  assert.deepStrictEqual(sendState(sess(), 'A'), { canSend: true, hold: false });
});

test('a terminal escape in the text cannot end the paste early', () => {
  assert.ok(!terminalText('a\n\x1b[201~rm -rf\nb').slice(6, -6).includes('\x1b'));
});
