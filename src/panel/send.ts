import { SessionEntry } from '../api';

/**
 * What to type: lines/tabs (or an explicit paste) wrapped in bracketed paste, so the agent takes them as one pasted
 * block, not one submit per line. The caller adds the submission key. Control characters are dropped: an Esc in the text could
 * end the paste early (`ESC[201~`) or interrupt the agent.
 */
export function terminalText(text: string, paste = false): string {
  const t = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  return paste || /[\n\t]/.test(t) ? `\x1b[200~${t}\x1b[201~` : t;
}

export type SendState = { canSend: boolean; hold: boolean; reason?: string };

/**
 * canSend: our terminal is on this session now (`terminalSessionId` is the session the terminal is on, as the host
 * knows it: /clear moves a terminal to another session). hold: Claude shows a question, where Enter would answer it.
 */
export function sendState(s: SessionEntry | undefined, terminalSessionId: string | undefined): SendState {
  if (!s) return { canSend: false, hold: false, reason: 'This session no longer exists.' };
  if (!terminalSessionId) return { canSend: false, hold: false, reason: 'Read-only: no terminal in this window is connected to this session.' };
  if (terminalSessionId !== s.id) return { canSend: false, hold: false, reason: 'Read-only: the terminal moved on to another session (/clear or /resume).' };
  return { canSend: true, hold: !!s.waitingFor };
}
