const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const file = path.resolve(__dirname, '../out/panel/panel.js');
const localRequire = createRequire(file);
function setup() {
  let serializer;
  const stub = {
    window: {
      registerWebviewPanelSerializer(type, value) { serializer = value; return { dispose() {} }; },
      createWebviewPanel() { assert.fail('restoration must reuse the native panel'); },
    },
    workspace: { getConfiguration: () => ({ get() {} }) },
    extensions: { getExtension() {} },
    Uri: { joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
  };
  const sandbox = { exports: {}, require: id => id === 'vscode' ? stub : localRequire(id),
    setInterval: () => 1, clearInterval, clearTimeout, setTimeout };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
  const ctx = { extensionUri: { fsPath: path.resolve(__dirname, '..') }, globalState: { get: () => 'editor' } };
  const panel = { title: '', active: false, reveal() { assert.fail('must preserve terminal focus'); },
    webview: { asWebviewUri: uri => uri.fsPath, onDidReceiveMessage() {}, postMessage() {}, cspSource: 'local' },
    onDidDispose() {}, dispose() {} };
  return { api: sandbox.exports, ctx, panel, serializer: () => serializer };
}
test('reload restores a provider-verified session into its existing panel without taking focus', async () => {
  const { api, ctx, panel, serializer } = setup();
  const session = { id: 'A', title: 'Restored', file: path.resolve(__dirname, 'missing-folder', 'session.jsonl'), mtime: 0 };
  const scopes = [];
  const provider = { id: 'test', name: 'Test', readTranscript() {}, async listSessions(ctx, scope) { scopes.push(scope); return scope === 'all' ? [session] : []; } };
  api.registerPanelRestore(ctx, {}, id => id === 'test' ? provider : undefined);
  await serializer().deserializeWebviewPanel(panel, { session: { providerId: 'test', id: 'A', file: 'untrusted-path' } });
  assert.equal(panel.title, 'Restored');
  assert.equal(panel.webview.options.enableScripts, true);
  assert.match(panel.webview.html, /panel.js/);
  assert.deepEqual(scopes, ['open', 'all']);
  api.disposePanels();
});
test('invalid or missing restored session data is not read as a transcript path', async () => {
  const { api, ctx, panel, serializer } = setup();
  api.registerPanelRestore(ctx, {}, () => undefined);
  await serializer().deserializeWebviewPanel(panel, { session: { providerId: 'missing', id: 'A', file: 'untrusted-path' } });
  assert.match(panel.webview.html, /could not be restored/);
});
