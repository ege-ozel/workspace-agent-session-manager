const test = require('node:test');
const assert = require('node:assert/strict');
const { resumedCodex } = require('../out/terminals');
const id = '12345678-1234-4234-8234-123456789abc';
test('renamed direct Codex resume terminals retain their exact thread after reload', () => {
  assert.equal(resumedCodex('My renamed terminal', { shellPath: 'codex.exe', shellArgs: ['--no-daemon', 'resume', id] }), id);
});
test('a shell or ambiguous Codex invocation is never treated as an exact resume', () => {
  assert.equal(resumedCodex('Codex', { shellPath: 'pwsh.exe', shellArgs: ['resume', id] }), undefined);
  assert.equal(resumedCodex('Codex', { shellPath: 'codex.exe', shellArgs: ['resume', '--last'] }), undefined);
  assert.equal(resumedCodex('Codex', { shellPath: 'codex.exe', shellArgs: [] }), undefined);
});

const { codexResumeCommand } = require('../out/terminals');
test('actual Codex process command recovers a resume id when terminal creation options are absent', () => {
  assert.equal(codexResumeCommand('"C:\\Program Files\\Codex\\codex.exe" --no-daemon resume "' + id + '"'), id);
  assert.equal(codexResumeCommand('codex.exe resume ' + id), id);
});
test('backend and shell commands never identify a terminal from a mentioned resume id', () => {
  assert.equal(codexResumeCommand('codex.exe app-server resume ' + id), undefined);
  assert.equal(codexResumeCommand('pwsh.exe -Command codex resume ' + id), undefined);
  assert.equal(codexResumeCommand('codex.exe resume --last'), undefined);
});
