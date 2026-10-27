import * as path from 'path';
import { SessionEntry } from '../api';

/** A session with the agent it belongs to, as the "Open Panel..." quick pick lists it. */
export interface PickSession { providerId: string; agent: string; s: SessionEntry }

export type PickItem =
  | { separator: string }
  | { label: string; description: string; key: string; item: PickSession };

/** How many closed sessions the pick shows after the open ones. */
export const RECENT_MAX = 50;

export function ago(ms: number, now = Date.now()): string {
  const m = Math.round((now - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ${h % 24}h ago`;
}

export const sessionKey = (providerId: string, id: string) => `${providerId}:${id}`;

const icon = (s: SessionEntry) => (s.waitingFor ? '$(bell)' : s.live ? '$(circle-filled)' : '$(history)');

function row(x: PickSession, now: number): PickItem {
  const { s } = x;
  const repo = s.cwd ? path.basename(s.cwd.replace(/[\\/]+$/, '').replace(/\\/g, '/')) : '';
  return {
    label: `${icon(s)} ${s.title}`,
    description: [x.agent, repo, s.waitingFor ? `waiting: ${s.waitingFor}` : '', ago(s.mtime, now)].filter(Boolean).join(' · '),
    key: sessionKey(x.providerId, s.id), item: x,
  };
}

/**
 * Rows of "Open Panel...": the open sessions (a question on screen first, then newest), then the newest closed ones.
 * A session listed as open is not repeated among the recent ones.
 */
export function pickItems(open: PickSession[], all: PickSession[], now = Date.now(), max = RECENT_MAX): PickItem[] {
  const byTime = (a: PickSession, b: PickSession) => b.s.mtime - a.s.mtime;
  const shown = [...open].sort((a, b) => Number(!!b.s.waitingFor) - Number(!!a.s.waitingFor) || byTime(a, b));
  const seen = new Set(shown.map(x => sessionKey(x.providerId, x.s.id)));
  const recent = all.filter(x => !seen.has(sessionKey(x.providerId, x.s.id))).sort(byTime).slice(0, max);
  return [
    ...(shown.length ? [{ separator: 'Open' }, ...shown.map(x => row(x, now))] : []),
    ...(recent.length ? [{ separator: 'Recent' }, ...recent.map(x => row(x, now))] : []),
  ];
}

/**
 * Asks `probe` every `every` ms until it answers, `timeout` ms pass or `cancelled` says stop; the answer, or
 * undefined. A probe that throws just means "not yet".
 */
export async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>,
  o: { every: number; timeout: number; cancelled?: () => boolean }): Promise<T | undefined> {
  const end = Date.now() + o.timeout;
  for (;;) {
    if (o.cancelled?.()) return undefined;
    try {
      const r = await probe();
      if (r !== undefined) return r;
    } catch { /* not yet */ }
    if (Date.now() + o.every > end) return undefined;
    await new Promise(r => setTimeout(r, o.every));
  }
}
