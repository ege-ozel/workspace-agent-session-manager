export type SessionView = 'panel' | 'terminal';

/** Providers without transcripts always use their terminal, even if an old preference says panel. */
export const preferredView = (saved: unknown, hasPanel: boolean): SessionView =>
  hasPanel && saved !== 'terminal' ? 'panel' : 'terminal';
