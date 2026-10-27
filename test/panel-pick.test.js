const test = require('node:test');
const assert = require('node:assert');
const { ago, pickItems, waitFor, RECENT_MAX } = require('../out/panel/pick');

const NOW = 1_000_000_000_000;
const MIN = 60_000;
const entry = (providerId, id, extra = {}) => ({
  providerId, agent: providerId === 'claude' ? 'Claude' : 'Codex',
  s: { id, title: 'T-' + id, cwd: 'D:\\code\\repo-' + id, mtime: NOW - 5 * MIN, file: 'f', ...extra },
});
const rows = items => items.filter(i => !i.separator);
const seps = items => items.filter(i => i.separator).map(i => i.separator);

test('ago: minutes, hours, days', () => {
  assert.strictEqual(ago(NOW - 10_000, NOW), 'just now');
  assert.strictEqual(ago(NOW - 5 * MIN, NOW), '5 min ago');
  assert.strictEqual(ago(NOW - 135 * MIN, NOW), '2h 15m ago');
  assert.strictEqual(ago(NOW - (50 * 60 + 3) * MIN, NOW), '2d 2h ago');
});

test('open sessions first, then the recent closed ones, each section headed', () => {
  const items = pickItems(
    [entry('claude', 'a', { live: true })],
    [entry('claude', 'a', { live: true }), entry('codex', 'b', { mtime: NOW - 60 * MIN })], NOW);
  assert.deepStrictEqual(seps(items), ['Open', 'Recent']);
  assert.deepStrictEqual(rows(items).map(r => r.key), ['claude:a', 'codex:b']);
});

test('a session in both lists shows once, in Open', () => {
  const a = entry('claude', 'a', { live: true });
  assert.strictEqual(rows(pickItems([a], [a], NOW)).length, 1);
});

test('label = title; description = agent · repo · age; icon tells open, waiting and closed apart', () => {
  const [waiting, open, closed] = rows(pickItems(
    [entry('claude', 'o', { live: true }), entry('claude', 'w', { live: true, waitingFor: 'dialog open' })],
    [entry('codex', 'c')], NOW));
  assert.strictEqual(open.label, '$(circle-filled) T-o');
  assert.strictEqual(open.description, 'Claude · repo-o · 5 min ago');
  assert.strictEqual(waiting.label, '$(bell) T-w');
  assert.match(waiting.description, /waiting: dialog open/);
  assert.strictEqual(closed.label, '$(history) T-c');
  assert.strictEqual(closed.description, 'Codex · repo-c · 5 min ago');
});

test('a listed-but-not-running session (Codex "open" without a lock) gets the closed icon', () => {
  const [r] = rows(pickItems([entry('codex', 'x', { live: false })], [], NOW));
  assert.strictEqual(r.label, '$(history) T-x');
});

test('waiting sessions come first among the open ones, then newest first', () => {
  const items = pickItems([
    entry('claude', 'old', { live: true, mtime: NOW - 30 * MIN }),
    entry('claude', 'new', { live: true, mtime: NOW - MIN }),
    entry('claude', 'ask', { live: true, mtime: NOW - 20 * MIN, waitingFor: 'input needed' }),
  ], [], NOW);
  assert.deepStrictEqual(rows(items).map(r => r.key), ['claude:ask', 'claude:new', 'claude:old']);
});

test('recent: newest first, capped', () => {
  const all = [];
  for (let i = 0; i < RECENT_MAX + 20; i++) all.push(entry('codex', 'r' + i, { mtime: NOW - i * MIN }));
  const r = rows(pickItems([], all.reverse(), NOW));
  assert.strictEqual(r.length, RECENT_MAX);
  assert.strictEqual(r[0].key, 'codex:r0');
  assert.strictEqual(r[RECENT_MAX - 1].key, 'codex:r' + (RECENT_MAX - 1));
});

test('no repo name when the session has no cwd; no empty section', () => {
  const items = pickItems([], [entry('claude', 'n', { cwd: undefined })], NOW);
  assert.deepStrictEqual(seps(items), ['Recent']);
  assert.strictEqual(rows(items)[0].description, 'Claude · 5 min ago');
});

test('nothing at all → no rows', () => {
  assert.deepStrictEqual(pickItems([], [], NOW), []);
});

test('waitFor: resolves with the first answer', async () => {
  let n = 0;
  const r = await waitFor(() => (++n === 3 ? 'found' : undefined), { every: 1, timeout: 1000 });
  assert.strictEqual(r, 'found');
  assert.strictEqual(n, 3);
});

test('waitFor: gives up quietly after the timeout', async () => {
  assert.strictEqual(await waitFor(() => undefined, { every: 5, timeout: 30 }), undefined);
});

test('waitFor: stops when cancelled, and a failing probe is just "not yet"', async () => {
  let n = 0, stop = false;
  const r = await waitFor(() => { if (++n === 2) stop = true; throw new Error('not yet'); }, { every: 1, timeout: 1000, cancelled: () => stop });
  assert.strictEqual(r, undefined);
  assert.ok(n <= 3);
});
