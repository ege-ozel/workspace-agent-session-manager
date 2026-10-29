const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Before the providers are loaded, so they never look at the real folders.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'list-cache-'));
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
process.env.CODEX_HOME = path.join(root, 'codex');
const { listClaudeSessions, claudeListCache } = require('../out/providers/claude');
const { listCodexSessions, codexListCache } = require('../out/providers/codex');

const j = o => JSON.stringify(o) + '\n';
const ID = n => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;

// ---- Claude ---------------------------------------------------------------
const proj = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'p');
const live = path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions');
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(live, { recursive: true });
const cfile = n => path.join(proj, ID(n) + '.jsonl');
const reply = tokens => j({ type: 'assistant', message: { model: 'claude-x', usage: { input_tokens: tokens } } });
const WINDOWS = { 'claude-x': 1000 };
const list = (scope = 'all', w = WINDOWS) => listClaudeSessions(scope, w);
const byId = (l, n) => l.find(s => s.id === ID(n));

test('claude: an unchanged file is not read again', () => {
  fs.writeFileSync(cfile(1), j({ type: 'ai-title', aiTitle: 'First' }) + reply(100));
  fs.writeFileSync(cfile(2), j({ type: 'ai-title', aiTitle: 'Second' }) + reply(200));
  const a = list();
  const reads = claudeListCache.computes;
  assert.strictEqual(reads, 2);
  const b = list();
  assert.strictEqual(claudeListCache.computes, reads);
  assert.deepStrictEqual(b.map(s => [s.id, s.title, s.ctxUsed]), a.map(s => [s.id, s.title, s.ctxUsed]));
  assert.strictEqual(byId(a, 1).title, 'First');
  assert.strictEqual(byId(a, 1).ctxUsed, 10);
});

test('claude: a changed size or mtime reads that file again, and only that one', () => {
  const before = claudeListCache.computes;
  fs.appendFileSync(cfile(1), j({ type: 'custom-title', customTitle: 'Renamed' }) + reply(500));
  const l = list();
  assert.strictEqual(claudeListCache.computes, before + 1);
  assert.strictEqual(byId(l, 1).title, 'Renamed');
  assert.strictEqual(byId(l, 1).ctxUsed, 50);
  // same size, new mtime (a writer that rewrote the file in place)
  const now = Date.now() / 1000 + 100;
  fs.utimesSync(cfile(2), now, now);
  list();
  assert.strictEqual(claudeListCache.computes, before + 2);
});

test('claude: a changed setting that feeds the result reads again', () => {
  const before = claudeListCache.computes;
  const l = list('all', { 'claude-x': 2000 });
  assert.strictEqual(claudeListCache.computes, before + 2);
  assert.strictEqual(byId(l, 1).ctxUsed, 25);
});

test('claude: live, busy and waiting stay fresh although the file is cached', () => {
  const rec = (status, extra) => fs.writeFileSync(path.join(live, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: ID(1), cwd: root, status, ...extra }));
  list();
  const before = claudeListCache.computes;
  rec('busy');
  let s = byId(list(), 1);
  assert.deepStrictEqual([s.live, s.busy, s.waitingFor], [true, true, undefined]);
  rec('waiting', { waitingFor: 'dialog open' });
  s = byId(list(), 1);
  assert.deepStrictEqual([s.live, !!s.busy, s.waitingFor], [true, false, 'dialog open']);
  fs.rmSync(path.join(live, process.pid + '.json'));
  assert.strictEqual(byId(list(), 1).live, false);
  assert.strictEqual(claudeListCache.computes, before);
});

test('claude: a cheap "open" listing neither reads the others nor forgets them', () => {
  fs.writeFileSync(path.join(live, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: ID(1), cwd: root, status: 'idle' }));
  const before = claudeListCache.computes;
  assert.deepStrictEqual(list('open').map(s => s.id), [ID(1)]);
  assert.strictEqual(claudeListCache.computes, before);
  assert.strictEqual(claudeListCache.size, 2);
  fs.rmSync(path.join(live, process.pid + '.json'));
});

test('claude: the entry of a deleted file is dropped', () => {
  fs.rmSync(cfile(2));
  list();
  assert.strictEqual(claudeListCache.size, 1);
});

// ---- Codex ----------------------------------------------------------------
const day = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '27');
fs.mkdirSync(day, { recursive: true });
const xfile = n => path.join(day, `rollout-2026-10-27T09-0${n}-00-${ID(n)}.jsonl`);
const meta = n => j({ type: 'session_meta', payload: { id: ID(n), cwd: root } });
const tokens = (used, win) => j({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: used }, model_context_window: win } } });
const xlist = (scope = 'all') => listCodexSessions(scope);

test('codex: an unchanged rollout is not read again; a changed one is', () => {
  fs.writeFileSync(xfile(1), meta(1) + tokens(100, 1000));
  fs.writeFileSync(xfile(2), meta(2) + tokens(200, 1000));
  const a = xlist();
  assert.strictEqual(codexListCache.computes, 2);
  xlist();
  assert.strictEqual(codexListCache.computes, 2);
  assert.strictEqual(a.find(s => s.id === ID(1)).ctxUsed, 10);
  fs.appendFileSync(xfile(1), tokens(300, 1000));
  assert.strictEqual(xlist().find(s => s.id === ID(1)).ctxUsed, 30);
  assert.strictEqual(codexListCache.computes, 3);
});

test('codex: a rename shows at once, without reading the rollout', () => {
  const before = codexListCache.computes;
  fs.appendFileSync(path.join(process.env.CODEX_HOME, 'session_index.jsonl'), j({ id: ID(1), thread_name: 'Renamed' }));
  assert.strictEqual(xlist().find(s => s.id === ID(1)).title, 'Renamed');
  assert.strictEqual(codexListCache.computes, before);
});

test('codex: the entry of a deleted rollout is dropped; an "open" listing keeps the rest', () => {
  assert.strictEqual(codexListCache.size, 2);
  xlist('open');
  assert.strictEqual(codexListCache.size, 2);
  fs.rmSync(xfile(2));
  xlist();
  assert.strictEqual(codexListCache.size, 1);
});

test('codex: the latest turn supplies repository, mode and permissions without reading credentials', () => {
  fs.writeFileSync(xfile(3), meta(3) + j({ type: 'turn_context', payload: { model: 'test-model', effort: 'high', cwd: '/new/repo',
    collaboration_mode: { mode: 'plan' }, approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' } } }));
  const s = xlist().find(s => s.id === ID(3));
  assert.deepStrictEqual([s.cwd, s.model, s.effort, s.mode, s.approvalPolicy, s.sandbox],
    ['/new/repo', 'test-model', 'high', 'plan', 'on-request', 'workspace-write']);
});
