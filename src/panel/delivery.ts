import { ChatItem } from '../api';

export interface Delivery {
  id: string;
  text: string;
  status: 'held' | 'agent' | 'unconfirmed';
  /** First transcript item that can acknowledge this submission. */
  after: number;
  submittedAt?: number;
  reason?: 'reload' | 'timeout' | 'disconnected';
}

/** Restored messages are visible for recovery, never automatically submitted a second time. */
export function restoreDeliveries(value: unknown): Delivery[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-50).filter(d => typeof d?.id === 'string' && /^[a-f0-9]{16}$/.test(d.id)
    && typeof d.text === 'string' && d.text.length <= 200_000 && d.text.trim()
    && Number.isSafeInteger(d.after) && d.after >= 0)
    .map(d => ({ id: d.id, text: d.text, after: d.after, status: 'unconfirmed', reason: 'reload' }));
}

/** A write to the terminal is not proof the CLI consumed it. Never retry automatically: it could already be queued. */
export function checkDeliveries(deliveries: Delivery[], connected: boolean, now = Date.now()): Delivery[] {
  return deliveries.map(d => d.status === 'agent' && (!connected || now - (d.submittedAt ?? now) >= 10_000)
    ? { ...d, status: 'unconfirmed', reason: connected ? 'timeout' : 'disconnected' } : d);
}

const normalized = (s: string) => s.replace(/<\/?pasted_content\b[^>]*>/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();

/** Only a matching new user/command record confirms delivery; unrelated output and old prompts do not. */
export function acknowledge(deliveries: Delivery[], items: ChatItem[], start: number): Delivery[] {
  const pending = [...deliveries];
  items.forEach((item, i) => {
    if (item.kind === 'user') {
      const text = normalized(item.text);
      // A CLI can combine consecutive submissions into one user record. Match the complete record, never a substring.
      for (let from = 0; from < pending.length; from++) {
        let joined = '';
        for (let to = from; to < pending.length; to++) {
          const d = pending[to];
          if (d.status === 'held' || d.after > start + i) break;
          joined += (joined ? ' ' : '') + normalized(d.text);
          if (joined === text) { pending.splice(from, to - from + 1); return; }
          if (!text.startsWith(joined + ' ')) break;
        }
      }
      return;
    }
    const matches = (text: string) => item.kind === 'tool' && /^[\/!]/.test(item.name) ? normalized(text) === normalized(item.name + ' ' + item.summary)
      : item.kind === 'note' && item.title === 'Conversation compacted' && /^\/compact\s*$/.test(text);
    const at = pending.findIndex(d => d.status !== 'held' && d.after <= start + i && matches(d.text));
    if (at >= 0) pending.splice(at, 1);
  });
  return pending;
}
