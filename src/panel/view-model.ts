/** Pure part of the Panel view (no `vscode` import): what the webview receives for a transcript and a session. */
import { ChatItem, SessionEntry, Snapshot } from '../api';
import { escapeHtml, renderMarkdown } from './markdown';
import { CodeLine, codeLines } from './code';

export const FIRST_BATCH = 200;
/** Longest tool result sent to the webview; the rest is counted in `more`. */
export const MAX_RESULT = 20_000;

export type ViewItem =
  | { i: number; kind: 'user' | 'assistant'; html: string }
  | { i: number; kind: 'tool'; name: string; summary: string; done?: boolean; detail?: string; more?: number }
  | { i: number; kind: 'toolResult'; text: string; error?: boolean; more?: number; code?: CodeLine[] }
  /** `ref` = the item's absolute index; the webview asks for the picture by it when it scrolls into view. */
  | { i: number; kind: 'image'; ref: number; mime: string }
  | { i: number; kind: 'note'; title: string; text: string };

/** Edits are shown as finished work (teal), the rest of the tool calls as plain ones (blue). */
const DONE: Record<string, string> = { Edit: '✓ edited', MultiEdit: '✓ edited', NotebookEdit: '✓ edited', Write: '✓ written' };

const PASTED = /<pasted_content[^>]*>([\s\S]*?)<\/pasted_content>/g;

/** A user bubble: the typed text as is, voice / pasted blocks without their wrapper tag, as a quote. */
function userHtml(text: string): string {
  const out: string[] = [];
  let at = 0;
  const typed = (s: string) => { if (s.trim()) out.push(`<div>${escapeHtml(s.trim())}</div>`); };
  for (const m of text.matchAll(PASTED)) {
    typed(text.slice(at, m.index));
    out.push(`<blockquote class="pasted">${escapeHtml(m[1].trim())}</blockquote>`);
    at = m.index! + m[0].length;
  }
  typed(text.slice(at));
  return out.join('');
}

/** `start` = the absolute index of items[0]. Images carry a ref only: their data travels when asked for. */
export function toView(items: ChatItem[], start: number): ViewItem[] {
  return items.map((it, k): ViewItem => {
    const i = start + k;
    switch (it.kind) {
      case 'user': return { i, kind: 'user', html: userHtml(it.text) };
      case 'assistant': return { i, kind: 'assistant', html: renderMarkdown(it.text) };
      case 'tool': return { i, kind: 'tool', name: DONE[it.name] ?? it.name, summary: it.summary,
        ...(DONE[it.name] ? { done: true } : {}), ...(it.detail ? { detail: it.detail.slice(0, MAX_RESULT) } : {}),
        ...(it.detail && it.detail.length > MAX_RESULT ? { more: it.detail.length - MAX_RESULT } : {}) };
      case 'toolResult': {
        const v: ViewItem = { i, kind: 'toolResult', text: it.text.slice(0, MAX_RESULT) };
        if (/^(Diff · |File · |Requested patch\n)/.test(v.text)) {
          v.code = codeLines(v.text.split('\n').slice(1).join('\n'), !v.text.startsWith('File · '));
        }
        if (it.error) v.error = true;
        if (it.text.length > MAX_RESULT) v.more = it.text.length - MAX_RESULT;
        return v;
      }
      case 'image': return { i, kind: 'image', ref: i, mime: it.mime };
      case 'note': return { i, kind: 'note', title: it.title, text: it.text };
    }
  });
}

export interface Meter { pct: number; stale?: boolean }

export interface ViewHeader {
  agent: string;
  title: string;
  repo?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  mode?: string;
  approvalPolicy?: string;
  sandbox?: string;
  ctx?: { pct: number; label?: string };
  five?: Meter;
  week?: Meter;
}

const tokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** "180,000 / 1,000,000 tokens · model" → "180k / 1M". */
function ctxLabel(detail?: string): string | undefined {
  const m = /([\d,]+)\s*\/\s*([\d,]+)\s*tokens/.exec(detail ?? '');
  return m ? `${tokens(+m[1].replace(/,/g, ''))} / ${tokens(+m[2].replace(/,/g, ''))}` : undefined;
}

/** Header data from what the extension already has. Missing values are left out, not shown as "—". */
export function headerOf(agent: string, s: SessionEntry | undefined, snap: Snapshot | undefined): ViewHeader {
  const h: ViewHeader = { agent, title: s?.title ?? '' };
  const repo = s?.cwd?.split(/[\\/]/).filter(Boolean).pop();
  if (repo) h.repo = repo;
  if (s?.cwd) h.cwd = s.cwd;
  if (s?.model) h.model = s.model;
  if (s?.effort) h.effort = s.effort;
  if (s?.mode) h.mode = s.mode;
  if (s?.approvalPolicy) h.approvalPolicy = s.approvalPolicy;
  if (s?.sandbox) h.sandbox = s.sandbox;
  if (s?.ctxUsed !== undefined) {
    h.ctx = { pct: Math.round(s.ctxUsed) };
    const label = ctxLabel(s.contextDetail);
    if (label) h.ctx.label = label;
  }
  // Providers report what is left; the panel, like the Usage view, shows what is used.
  const meter = (left?: number): Meter | undefined => {
    if (left === undefined) return undefined;
    const m: Meter = { pct: Math.round(100 - left) };
    if (snap?.limitsStale) m.stale = true;
    return m;
  };
  const five = meter(snap?.fiveLeft);
  const week = meter(snap?.weekLeft);
  if (five) h.five = five;
  if (week) h.week = week;
  return h;
}
