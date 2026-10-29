import * as path from 'path';
import { execFile } from 'child_process';

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
  if (!o.shellPath || !/^codex(?:\.exe|\.cmd)?$/i.test(path.basename(o.shellPath))) return;
  if (!Array.isArray(o.shellArgs)) return;
  const args = o.shellArgs;
  const i = args[0] === '--no-daemon' ? 1 : 0;
  const id = args[i + 1];
  return args[i] === 'resume' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id ?? '') ? id : undefined;
}

/** Windows may omit shellPath/shellArgs when reviving a terminal. Use its actual process command instead. */
export function codexResumeCommand(command: string): string | undefined {
  const parts = command.trim().match(/"[^"]*"|\S+/g)?.map(s => s.replace(/^"|"$/g, ''));
  if (!parts?.length) return;
  return resumedCodex('', { shellPath: path.win32.basename(parts[0]), shellArgs: parts.slice(1) });
}

export function codexResumeProcesses(): Promise<Map<number, string>> {
  if (process.platform !== 'win32') return Promise.resolve(new Map());
  const command = 'Get-CimInstance Win32_Process -Filter "Name=\'codex.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, timeout: 15000 }, (err, out) => {
      const found = new Map<number, string>();
      try {
        const parsed = err ? [] : JSON.parse(out || '[]');
        for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
          const id = typeof row.CommandLine === 'string' ? codexResumeCommand(row.CommandLine) : undefined;
          if (id && Number.isInteger(row.ProcessId) && row.ProcessId > 0) found.set(row.ProcessId, id);
        }
      } catch { /* process enumeration is unavailable */ }
      resolve(found);
    }));
}
