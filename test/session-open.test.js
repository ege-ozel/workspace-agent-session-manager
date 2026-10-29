const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { preferredView } = require('../out/panel/preference');
const source = fs.readFileSync(require.resolve('../out/extension'), 'utf8');
const start = source.indexOf('async function openConversation('), end = source.indexOf('\nconst BAR =', start);
assert.ok(start >= 0 && end > start);

function fixture() {
  const calls = [], s = { id: 'A', title: 'Title', cwd: '/repo', live: true }, e = { p: { id: 'test', readTranscript() {}, terminal() {} } };
  let choice = 'panel', terminal;
  const scope = { preference_1: { preferredView }, sessionViews: { 'test:A': 'terminal' }, panelHost: {}, extCtx: {},
    vscode: { window: { async showQuickPick(items) { calls.push(['pick', items.map(i => i.view)]); return items.find(i => i.view === choice); } } },
    panel_1: { openPanel() { calls.push(['panel']); } }, windowTerminalFor: () => terminal,
    rememberView: (provider, id, view) => { scope.sessionViews[`${provider}:${id}`] = view; },
    launch() { calls.push(['launch']); }, showDetails() { calls.push(['details']); } };
  vm.runInNewContext(source.slice(start, end) + '\nthis.open = openConversation;', scope);
  return { scope, calls, s, e, choose: value => choice = value, terminal: value => terminal = value };
}

test('Projects asks on every open and lists the last choice first', async () => {
  const f = fixture();
  await f.scope.open(f.e, f.s, true);
  await f.scope.open(f.e, f.s, true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [['pick', ['terminal', 'panel']], ['panel'], ['pick', ['panel', 'terminal']], ['panel']]);
});

test('cancelling the view picker opens nothing and leaves the saved choice intact', async () => {
  const f = fixture(); f.choose(undefined);
  await f.scope.open(f.e, f.s, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.scope.sessionViews['test:A'], 'terminal');
});

test('an explicit terminal choice reuses a connected terminal, or resumes a live session here', async () => {
  const f = fixture(); f.choose('terminal');
  f.terminal({ show() { f.calls.push(['show']); } });
  await f.scope.open(f.e, f.s, true);
  assert.equal(f.calls.at(-1)[0], 'show');
  f.terminal(undefined);
  await f.scope.open(f.e, f.s, true);
  assert.equal(f.calls.at(-1)[0], 'launch');
});

test('other entry points retain the saved choice without an extra picker or duplicate live process', async () => {
  const f = fixture();
  await f.scope.open(f.e, f.s);
  assert.deepEqual(f.calls, [['details']]);
});
