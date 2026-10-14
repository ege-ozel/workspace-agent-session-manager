import * as path from 'path';

export interface TerminalOptions {
  shellPath?: string;
  shellArgs?: string[] | string;
  cwd?: string | { fsPath: string };
}

export interface SavedTerminal {
  provider: string;
  pid: number;
  sessionId?: string;
  cwd?: string;
  at: number;
  key: string;
}

export const terminalKey = (o: TerminalOptions) => JSON.stringify([
  o.shellPath, o.shellArgs, typeof o.cwd === 'string' ? o.cwd : o.cwd?.fsPath,
]);

/** Older versions saved nothing. A direct resume terminal still carries the exact session id in its args. */
export function resumedCodex(name: string, o: TerminalOptions): string | undefined {
  if (!name.startsWith('Codex · ') || !o.shellPath || !/^codex(?:\.exe|\.cmd)?$/i.test(path.basename(o.shellPath))) return;
  if (!Array.isArray(o.shellArgs)) return;
  const args = o.shellArgs;
  const i = args[0] === '--no-daemon' ? 1 : 0;
  const id = args[i + 1];
  return args[i] === 'resume' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id ?? '') ? id : undefined;
}
