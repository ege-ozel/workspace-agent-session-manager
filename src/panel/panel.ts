import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatItem, Provider, SessionEntry, Snapshot } from '../api';
import { terminalText, sendState } from './send';
import { FIRST_BATCH, headerOf, toView } from './view-model';
import { escapeHtml } from './markdown';
import { acknowledge, checkDeliveries, Delivery, restoreDeliveries } from './delivery';

export { FIRST_BATCH, toView } from './view-model';

export interface PanelHost {
  viewOpened?(providerId: string, id: string, view: 'panel' | 'terminal'): void;
  focusSession?(providerId: string, id: string, active: boolean): void;
  /** Fresh entry for this session (live, busy, waitingFor), or undefined if gone. */
  session(providerId: string, id: string): SessionEntry | undefined;
  /** Our terminal currently on this session, if any (launched + terminalFor). */
  terminal(providerId: string, id: string): vscode.Terminal | undefined;
  /** Shows the session's terminal in this window, ours or the user's own shell; false when there is none. */
  showTerminal(providerId: string, id: string): boolean;
  /** Opens the session in a new terminal; false when that is not possible (nothing to resume, no terminal capability). */
  resume(providerId: string, id: string, background?: boolean): boolean;
  /** The provider's last Snapshot, for the header's 5h / wk bars. */
  snapshot(providerId: string): Snapshot | undefined;
  /** The session re-read right now (not the cached entry); undefined when it is not among the open ones. */
  fresh(providerId: string, id: string): Promise<SessionEntry | undefined>;
  /** The session a terminal of ours is on now (it moves on after /clear), or undefined once it is not ours any more. */
  terminalSessionId(t: vscode.Terminal): string | undefined;
  /** Started by this extension (the others are a shell the user typed the agent into). */
  ours(t: vscode.Terminal): boolean;
  /** Explicitly pair an unrecognized direct agent terminal; never guess from the repo alone. */
  connectTerminal?(providerId: string, id: string): Promise<boolean>;
  canConnectTerminal?(providerId: string): boolean;
}

const panels = new Map<string, SessionPanel>();
const THEME_KEY = 'panelTheme';
const THEMES = ['editor', 'dark', 'terminal'] as const;
const FONT_KEY = 'panelFontSize';

/** VS Code restores the editor groups and terminal visibility; reuse its panel without revealing it. */
export function registerPanelRestore(ctx: vscode.ExtensionContext, host: PanelHost, provider: (id: string) => Provider | undefined): vscode.Disposable {
  return vscode.window.registerWebviewPanelSerializer('workspaceAgentSessions.sessionPanel', {
    async deserializeWebviewPanel(panel, state: { session?: { providerId?: unknown; id?: unknown }; pending?: unknown; resumeNeedsReady?: unknown } | undefined) {
      const ref = state?.session;
      const p = typeof ref?.providerId === 'string' ? provider(ref.providerId) : undefined;
      if (p?.readTranscript && p.listSessions && typeof ref?.id === 'string') {
        try {
          // Resolve through the provider, never read a file path supplied by persisted webview state.
          for (const scope of ['open', 'all', 'archived'] as const) {
            const s = (await p.listSessions({ folders: [], setting: key => vscode.workspace.getConfiguration('workspaceAgentSessions').get(key),
              extensionPath: id => vscode.extensions.getExtension(id)?.extensionPath }, scope)).find(s => s.id === ref.id);
            if (!s) continue;
            const key = `${p.id}:${s.id}`;
            panels.set(key, new SessionPanel(key, host, p, s, ctx, panel, state?.pending, state?.resumeNeedsReady === true));
            return;
          }
        } catch { /* unavailable provider: keep an explanatory restored tab */ }
      }
      panel.webview.html = '<!DOCTYPE html><html><body>This session could not be restored. Open it again from Agent Sessions.</body></html>';
    },
  });
}

/** One panel per session: opening it again brings the open one forward. */
export function openPanel(host: PanelHost, p: Provider, s: SessionEntry, ctx: vscode.ExtensionContext): void {
  host.viewOpened?.(p.id, s.id, 'panel');
  const key = `${p.id}:${s.id}`;
  const open = panels.get(key);
  if (open) return open.reveal();
  panels.set(key, new SessionPanel(key, host, p, s, ctx));
}

/** Header and busy state follow the extension's own refresh events: no polling of its own. */
export function updatePanels(): void {
  panels.forEach(x => x.postState());
}

export const hasPanel = (providerId: string) => [...panels.keys()].some(k => k.startsWith(providerId + ':'));

export function disposePanels(): void {
  [...panels.values()].forEach(x => x.dispose());
}

class SessionPanel {
  private readonly panel: vscode.WebviewPanel;
  private items: ChatItem[] = [];
  private next = 0;
  /** Absolute index of the first item the webview has. */
  private shownFrom = 0;
  private ready = false;
  private reading = false;
  private again = false;
  private disposed = false;
  private session: SessionEntry;
  /** The last terminal of ours seen on this session; after /clear the host says it is on another one. */
  private bound?: vscode.Terminal;
  /** Messages sent while the terminal shows a question, typed once it is answered. */
  private queue: string[] = [];
  private pending: Delivery[] = [];
  private flushing = false;
  private typing = false;
  private awaitingReply?: { mtime: number; seenBusy: boolean };
  private submissions = Promise.resolve();
  /** When this panel resumed its session to send a message; the first keystrokes wait for the agent to be live. */
  private resumeAt = 0;
  private resumeLiveAt = 0;
  /** A second process can open a native "resume anyway" dialog; only the user can confirm it is ready. */
  private resumeNeedsReady = false;
  private debounce?: NodeJS.Timeout;
  private readonly poll: NodeJS.Timeout;
  private watcher?: fs.FSWatcher;
  private watchedDir?: string;
  private readonly restored: boolean;
  private busyAt?: number;
  private compactRequest?: { at: number; after: number };

  constructor(private readonly key: string, private readonly host: PanelHost, private readonly p: Provider, s: SessionEntry, private readonly ctx: vscode.ExtensionContext, restored?: vscode.WebviewPanel, pending?: unknown, resumeNeedsReady = false) {
    this.restored = !!restored;
    this.resumeNeedsReady = resumeNeedsReady;
    this.pending = restoreDeliveries(pending);
    this.session = s;
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    this.panel = restored ?? vscode.window.createWebviewPanel('workspaceAgentSessions.sessionPanel', s.title, vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    this.panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    this.panel.title = s.title;
    this.panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'images', 'icon.png');
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m));
    this.panel.webview.html = this.html(media);
    this.panel.onDidDispose(() => this.dispose());
    this.watch();
    this.poll = setInterval(() => this.schedule(), 5000);
  }

  /**
   * The directory is watched, not the file: a new Claude session has no transcript until its first message, and
   * not even its project folder when the repo is new. Every pass tries again until there is a watcher.
   */
  private watch() {
    const dir = path.dirname(this.session.file);
    if (this.watcher && this.watchedDir === dir) return;
    this.watcher?.close();
    this.watcher = undefined;
    try {
      const w = fs.watch(dir, (_, name) => { if (!name || name === path.basename(this.session.file)) this.schedule(); });
      w.on('error', () => { w.close(); if (this.watcher === w) this.watcher = undefined; });
      this.watcher = w;
      this.watchedDir = dir;
    } catch { /* folder not there yet: the next poll looks again */ }
  }

  reveal() { this.panel.reveal(); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.host.focusSession?.(this.p.id, this.session.id, false);
    panels.delete(this.key);
    clearTimeout(this.debounce);
    clearInterval(this.poll);
    this.watcher?.close();
    this.panel.dispose();
  }

  private html(media: vscode.Uri): string {
    const wv = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('hex');
    const uri = (f: string) => wv.asWebviewUri(vscode.Uri.joinPath(media, f));
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${wv.cspSource}; style-src ${wv.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'">
<link rel="stylesheet" href="${uri('panel.css')}"></head>
<body${this.theme() === 'editor' ? '' : ` class="${this.theme() === 'terminal' ? 'term' : 'dark'}"`}><header id="hd"><div class="sub">${escapeHtml(this.p.name)} · ${escapeHtml(this.session.title)}</div></header>
<main id="chat"><div id="loading" role="status"><span>Loading conversation…</span> <button id="reload">Reload panel</button></div><button id="earlier" hidden>Show earlier</button><div id="items"></div><div id="pending"></div><div id="live"><div id="activity" role="status" aria-live="polite" hidden></div><button id="interrupt" hidden>Esc to interrupt</button></div></main>
<footer id="ft">
<div id="wait" class="waitbar" hidden><span><b>Waiting in terminal:</b> <span id="why"></span></span><button id="answer">Answer in terminal</button></div>
<div id="compose"><textarea id="msg" rows="1" placeholder="Message ${escapeHtml(this.p.name)}…"></textarea><button id="send">Send</button></div>
<div id="ro" class="ro" hidden><span id="rowhy"></span><button id="resume" hidden>Continue here</button><button id="connect" hidden>Connect terminal</button><button id="resumeReady" hidden>Continue in panel</button><button id="resumeTerminal" hidden>Open terminal</button></div>
</footer>
<div id="ov" hidden><div id="ovbox"></div></div>
<script nonce="${nonce}">
const panelBridge = acquireVsCodeApi();
document.getElementById('reload').onclick = () => {
  panelBridge.setState({ ...(panelBridge.getState() || {}), draft: document.getElementById('msg').value });
  panelBridge.postMessage({ type: 'reload' });
};
window.addEventListener('error', e => {
  const loading = document.getElementById('loading'); loading.hidden = false;
  loading.querySelector('span').textContent = 'The panel could not finish loading. Reload it to retry.';
  panelBridge.postMessage({ type: 'webviewError', message: String(e.message).slice(0, 300) });
});
const readyRetry = setInterval(() => {
  if (document.getElementById('loading').hidden) return clearInterval(readyRetry);
  panelBridge.postMessage({ type: 'ready' });
}, 1500);
</script>
<script nonce="${nonce}" src="${uri('vendor/highlight.min.js')}"></script>
<script nonce="${nonce}" src="${uri('vendor/powershell.min.js')}"></script>
<script nonce="${nonce}" src="${uri('scroll.js')}"></script>
<script nonce="${nonce}" src="${uri('panel.js')}"></script></body></html>`;
  }

  /** The panel's look: the editor's colours (default), a fixed dark design, or the terminal's background. One choice for all panels. */
  private theme = () => this.ctx.globalState.get<string>(THEME_KEY, 'editor');
  private fontSize = () => Math.max(11, Math.min(22, this.ctx.globalState.get<number>(FONT_KEY, 14)));

  private post(m: unknown) { if (!this.disposed) void this.panel.webview.postMessage(m); }

  /** Our terminal on this session, or the one that was until the host reports it moved on or closed. */
  private terminal(): vscode.Terminal | undefined {
    const t = this.host.terminal(this.p.id, this.session.id) ?? this.bound;
    this.bound = t && !t.exitStatus && this.host.terminalSessionId(t) !== undefined ? t : undefined;
    return this.bound;
  }

  private sendStateOf(s: SessionEntry | undefined) {
    const t = this.terminal();
    return { t, st: sendState(s, t && this.host.terminalSessionId(t)) };
  }

  postState(flushQueue = true, freshSession?: SessionEntry) {
    if (freshSession) this.waitingForReply(freshSession);
    this.session = freshSession ?? this.host.session(this.p.id, this.session.id) ?? this.session;
    const s = this.session;
    this.busyAt = s.busy ? s.busySince ?? this.busyAt ?? Date.now() : undefined;
    const { t, st } = this.sendStateOf(s);
    if (this.resumeNeedsReady && !t && (!this.restored || freshSession)) { this.resumeNeedsReady = false; this.resumeAt = 0; }
    if (this.queue.length && !st.canSend && !this.resumeAt && !this.typing && !this.flushing) this.rejectQueued();
    this.pending = checkDeliveries(this.pending, !!t && st.canSend);
    if (!t || !s.live) { this.awaitingReply = undefined; this.compactRequest = undefined; }
    const compacting = s.activity === 'compacting';
    const requestingCompact = !!this.compactRequest && (!!s.busy || Date.now() - this.compactRequest.at < 10_000);
    const resumable = !t && !!this.p.terminal;
    const connectionReason = this.resumeNeedsReady
      ? 'Finish any resume or permission prompt in the terminal, then continue in the panel. Your messages stay here.'
      : !t ? s.live
        ? 'No terminal is connected to this panel. Connect an existing terminal or continue this conversation here.'
        : this.p.terminal ? 'Sending a message will reopen this conversation here.' : 'No terminal is connected to this panel.'
        : !st.canSend ? 'The terminal switched to another conversation. Continue this conversation here.' : undefined;
    const title = (s.waitingFor ? '● ' : '') + s.title;
    if (this.panel.title !== title) this.panel.title = title;
    this.post({
      type: 'state', header: headerOf(this.p.name, s, this.host.snapshot(this.p.id)), busy: !this.resumeNeedsReady && !s.waitingFor && !!s.live && (!!s.busy || compacting),
      activity: this.resumeNeedsReady ? 'Finish setup in terminal…' : s.waitingFor ? 'Waiting for input…' : this.resumeAt ? 'Starting agent…' : compacting ? 'Compacting context…'
        : requestingCompact ? 'Context compaction requested…' : s.live && s.busy ? 'Working…'
        : this.pending.some(d => d.status === 'agent') ? 'Confirming delivery…' : this.queue.length ? 'Waiting to send…' : undefined,
      busyLabel: compacting ? 'compacting context' : requestingCompact ? 'compaction requested' : 'working',
      busySince: compacting ? s.activitySince : requestingCompact ? this.compactRequest?.at : this.busyAt,
      session: { providerId: this.p.id, id: s.id },
      waitingFor: s.waitingFor, canSend: true, resumes: resumable,
      canResume: !this.resumeNeedsReady && (resumable || !st.canSend && !!this.p.terminal),
      canInterrupt: !!this.p.interruptInput && !!t && st.canSend && !!s.live && !!s.busy && !st.hold && !this.resumeNeedsReady,
      canConnect: !t && !!this.host.connectTerminal && (this.host.canConnectTerminal?.(this.p.id) ?? true), resumeNeedsReady: this.resumeNeedsReady,
      connectionReason, pending: this.pending, theme: this.theme(), fontSize: this.fontSize(),
      commands: (this.p.slashCommands ?? []).map(({ command, detail }) => ({ command, detail })),
    });
    // The cached entry may be older than flush's own fresh check: flush must not re-trigger itself from it.
    if (flushQueue && st.canSend && !st.hold && !this.resumeNeedsReady && this.queue.length) void this.flush();
  }

  private waitingForReply(fresh: SessionEntry | undefined): boolean {
    if (!this.awaitingReply) return false;
    if (fresh?.busy) this.awaitingReply.seenBusy = true;
    if (!fresh || fresh.busy || (!this.awaitingReply.seenBusy && fresh.mtime <= this.awaitingReply.mtime)) return true;
    this.awaitingReply = undefined;
    return false;
  }

  /** Types one message, after a fresh look at whether that is still right: the answer may have changed meanwhile. */
  private async trySend(text: string, queueIt: boolean): Promise<'sent' | 'held' | 'refused'> {
    let fresh: SessionEntry | undefined;
    try { fresh = await this.host.fresh(this.p.id, this.session.id); } catch { return 'refused'; }
    this.session = fresh ?? this.host.session(this.p.id, this.session.id) ?? this.session;
    const { t, st } = this.sendStateOf(this.session);
    if (!t || !st.canSend) return 'refused';
    // A shell the agent runs in: if it has exited, the text would run as a shell command.
    if (!this.host.ours(t) && !fresh?.live) return 'refused';
    // A terminal we just opened is still starting: its first keystrokes would be lost until the agent has the session.
    if (this.disposed) return 'refused';
    if (this.resumeNeedsReady) { if (queueIt) this.queue.push(text); return 'held'; }
    if (this.resumeAt) {
      // A live record can appear before the CLI has mounted its input. Give it a settling interval.
      if (!fresh?.live) this.resumeLiveAt = 0;
      else if (!this.resumeLiveAt) this.resumeLiveAt = Date.now();
      if (!this.resumeLiveAt || Date.now() - this.resumeLiveAt < 1500) {
        if (queueIt) this.queue.push(text);
        return 'held';
      }
    }
    this.resumeAt = 0;
    const awaiting = this.waitingForReply(fresh);
    if (st.hold || (!this.p.queueInput && (awaiting || fresh?.busy))) { if (queueIt) this.queue.push(text); return 'held'; }
    if (this.typing) { if (queueIt) this.queue.push(text); return 'held'; }
    this.typing = true;
    try {
      // Even one-line prompts must be a single paste event: a burst of ordinary key events can swallow submission.
      const command = /^\s*[/!]/.test(text);
      t.sendText(terminalText(text, !!this.p.queueInput && !command), false);
      await new Promise(r => setTimeout(r, 150));
      if (this.disposed || this.host.terminalSessionId(t) !== this.session.id || t.exitStatus) return 'refused';
      // Use the normal submit key at idle; native queue keys are only needed for a running or unacknowledged turn.
      const queueKey = fresh?.busy || this.pending.some(d => d.status === 'agent') ? this.p.queueInput : undefined;
      t.sendText(command ? '\r' : queueKey ?? '\r', false);
      const pending = this.pending.find(d => d.status === 'held' && d.text === text);
      if (pending) { pending.status = 'agent'; pending.submittedAt = Date.now(); }
      if (/^\s*\/compact(?:\s|$)/.test(text)) this.compactRequest = { at: Date.now(), after: this.items.length };
      if (!this.p.queueInput && fresh && typeof fresh.busy === 'boolean') this.awaitingReply = { mtime: fresh.mtime, seenBusy: false };
      // Keep the next paste out of this submission's input batch when several messages arrive together.
      await new Promise(r => setTimeout(r, 200));
      return 'sent';
    } finally { this.typing = false; }
  }

  private async send(text: string) {
    this.pending.push({ id: crypto.randomBytes(8).toString('hex'), text, status: 'held', after: this.items.length });
    this.postState(false);
    let fresh: SessionEntry | undefined;
    try { fresh = await this.host.fresh(this.p.id, this.session.id); } catch {
      this.reject(text);
      void vscode.window.showInformationMessage('Not sent: could not check whether this session is running. Please try again.');
      return;
    }
    if (this.disposed) return;
    this.session = fresh ?? { ...this.session, live: false, waitingFor: undefined };
    if (!this.terminal() && !fresh?.live && this.p.terminal) return this.resumeWith(text);
    if (!this.terminal() && fresh?.live) {
      const action = 'Continue here', connect = 'Connect terminal';
      const pick = await vscode.window.showInformationMessage('Your message has been kept. This panel has no connected terminal; you can reopen this conversation here.',
        ...(this.p.terminal ? [action] : []),
        ...(this.host.connectTerminal && (this.host.canConnectTerminal?.(this.p.id) ?? true) ? [connect] : []));
      if (pick === action) return this.resumeWith(text, true);
      if (pick !== connect || !await this.host.connectTerminal?.(this.p.id, this.session.id)) { this.reject(text); return; }
    }
    if (this.queue.length) { this.queue.push(text); this.postState(); return; }
    const r = await this.trySend(text, true);
    if (r === 'refused') {
      this.reject(text);
      const why = this.sendStateOf(this.session).st.reason;
      void vscode.window.showInformationMessage(why ? why.replace(/^Read-only: /, 'Not sent: ')
        : 'Your message was restored because the terminal connection could not be verified. Reconnect or use Continue here in the panel.');
    }
    this.postState();
  }

  /** Keep input while starting the CLI. Live sessions can need a native confirmation before accepting text. */
  private resumeWith(text?: string, needsReady = false) {
    if (this.disposed) return;
    if (this.resumeAt) { if (text) this.queue.push(text); this.postState(false); return; }
    if (!this.host.resume(this.p.id, this.session.id, !needsReady)) { if (text) this.reject(text); return; }
    this.resumeAt = Date.now();
    this.resumeLiveAt = 0;
    this.resumeNeedsReady = needsReady;
    if (text) this.queue.push(text);
    this.postState(false);
    const timer = setInterval(async () => {
      if (this.disposed || !this.resumeAt) { clearInterval(timer); return; }
      if (this.resumeNeedsReady) return;
      if (Date.now() - this.resumeAt > 60_000) {
        clearInterval(timer);
        this.resumeAt = 0;
        this.rejectQueued();
        this.postState(false);
        void vscode.window.showInformationMessage('The terminal is taking longer to start. Your message was restored; open the terminal to finish any setup, then send again.', 'Open terminal')
          .then(pick => { if (pick === 'Open terminal') this.host.showTerminal(this.p.id, this.session.id); });
        return;
      }
      if (this.queue.length) void this.flush();
      else {
        try {
          const fresh = await this.host.fresh(this.p.id, this.session.id);
          if (fresh?.live) {
            if (!this.resumeLiveAt) this.resumeLiveAt = Date.now();
            if (Date.now() - this.resumeLiveAt >= 1500) this.resumeAt = 0;
          } else this.resumeLiveAt = 0;
          this.postState(false, fresh);
        } catch { /* the next pass retries */ }
      }
    }, 1500);
  }

  private async continueHere() {
    try {
      const fresh = await this.host.fresh(this.p.id, this.session.id);
      if (this.disposed) return;
      this.session = fresh ?? { ...this.session, live: false, busy: false, waitingFor: undefined };
      if (this.sendStateOf(this.session).st.canSend) return this.postState();
      this.bound = undefined;
      this.resumeWith(undefined, !!fresh?.live);
    } catch {
      void vscode.window.showInformationMessage('Could not check this conversation. Your message is still in the panel; try Continue here again.');
    }
  }

  private async interrupt() {
    if (!this.p.interruptInput || this.typing || this.flushing || this.resumeNeedsReady || this.disposed) return;
    try {
      const fresh = await this.host.fresh(this.p.id, this.session.id);
      const { t, st } = this.sendStateOf(fresh);
      if (!fresh?.live || !fresh.busy || !t || !st.canSend || st.hold || this.typing || this.flushing || this.resumeNeedsReady || this.disposed) return;
      t.sendText(this.p.interruptInput, false);
    } catch { /* no verified connection: do not send a control key to a shell or dialog */ }
  }

  /** In order, each after its own check; the pause lets a question the previous message raised show up first. */
  private async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const result = await this.trySend(this.queue[0], false);
        if (result === 'held') break;
        if (result === 'refused') {
          this.rejectQueued();
          break;
        }
        this.queue.shift();
        await new Promise(r => setTimeout(r, 400));
        if (this.disposed) return;
      }
    } finally { this.flushing = false; }
    this.postState(false);
  }

  private reject(text: string) {
    const at = this.pending.findIndex(d => d.status === 'held' && d.text === text);
    if (at >= 0) this.pending.splice(at, 1);
    this.post({ type: 'rejected', text });
    this.postState(false);
  }

  private rejectQueued() {
    const texts = this.queue.splice(0);
    for (const text of texts) {
      const at = this.pending.findIndex(d => d.status === 'held' && d.text === text);
      if (at >= 0) this.pending.splice(at, 1);
    }
    if (texts.length) this.post({ type: 'rejected', text: texts.join('\n\n') });
    this.postState(false);
  }

  private schedule() {
    if (this.debounce) return;
    // Continuous transcript writes must not postpone the first update until the turn stops.
    this.debounce = setTimeout(() => { this.debounce = undefined; void this.pump(); }, 300);
  }

  /** Reads what was appended since the last pass. One read at a time; a change meanwhile makes it run again. */
  private async pump() {
    if (this.reading) { this.again = true; return; }
    this.reading = true;
    try {
      this.watch();
      do {
        this.again = false;
        let size = 0;
        try { size = fs.statSync(this.session.file).size; } catch { /* no transcript yet */ }
        const replaced = size < this.next;
        if (replaced) { this.items = []; this.next = 0; }
        const chunk = await this.p.readTranscript!(this.session.file, this.next);
        if (this.disposed) return;
        const start = this.items.length;
        for (const it of chunk.items) this.items.push(it);
        this.pending = acknowledge(this.pending, chunk.items, start);
        if (chunk.items.some((it, i) => this.compactRequest && start + i >= this.compactRequest.after
          && it.kind === 'note' && it.title === 'Conversation compacted')) this.compactRequest = undefined;
        this.next = chunk.next;
        if (!this.ready) continue;
        if (replaced) this.sendBatch();
        else if (chunk.items.length) this.post({ type: 'items', items: toView(chunk.items, start), hasEarlier: this.shownFrom > 0 });
      } while (this.again);
      const fresh = await this.host.fresh(this.p.id, this.session.id);
      if (!this.disposed) this.postState(true, fresh ?? { ...this.session, live: false, busy: false, busySince: undefined, activity: undefined, activitySince: undefined, waitingFor: undefined });
    } catch {
      // unreadable for now; the next change or the poll tries again
      if (this.ready && !this.disposed) this.postState(false);
    } finally {
      this.reading = false;
      if (this.again && !this.disposed) this.schedule();
    }
  }

  /** The newest items only; earlier ones come on request. Images carry no data here. */
  private sendBatch() {
    this.shownFrom = Math.max(0, this.items.length - FIRST_BATCH);
    this.post({ type: 'items', reset: true, items: toView(this.items.slice(this.shownFrom), this.shownFrom), hasEarlier: this.shownFrom > 0 });
  }

  /** A picture is read from the transcript when the webview scrolls to it (`data` for providers that carry it inline). */
  private async sendImage(ref: number) {
    const it = this.items[ref];
    if (it?.kind !== 'image') return;
    try {
      const data = it.data ?? await it.load?.();
      if (!data || this.items[ref] !== it) return;
      const mime = /^image\/[\w.+-]+$/.test(it.mime) ? it.mime : 'image/png';
      this.post({ type: 'image', ref, src: `data:${mime};base64,${data}` });
    } catch { /* gone from the file: the placeholder stays */ }
  }

  private onMessage(m: any) {
    switch (m?.type) {
      case 'reload':
        this.ready = false;
        this.panel.webview.html = this.html(vscode.Uri.joinPath(this.ctx.extensionUri, 'media'));
        break;
      case 'webviewError':
        console.warn('[Agent Sessions panel]', String(m.message ?? '').slice(0, 300));
        break;
      case 'interrupt':
        void this.interrupt();
        break;
      case 'openText': {
        const item = Number.isInteger(m.ref) ? this.items[m.ref] : undefined;
        const content = item?.kind === 'tool' ? item.detail : item?.kind === 'toolResult' || item?.kind === 'note' ? item.text : undefined;
        if (typeof content === 'string') void vscode.workspace.openTextDocument({ content, language: 'plaintext' })
          .then(doc => vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside }));
        break;
      }
      case 'pasteText':
        void vscode.env.clipboard.readText().then(text => this.post({ type: 'pasteText', text }));
        break;
      case 'focus':
        this.host.focusSession?.(this.p.id, this.session.id, m.active === true);
        break;
      case 'ready':
        if (this.panel.active && !this.restored) this.host.focusSession?.(this.p.id, this.session.id, true);
        this.ready = true;
        this.postState();
        this.sendBatch();
        void this.pump();
        break;
      case 'earlier': {
        const to = this.shownFrom;
        this.shownFrom = Math.max(0, to - FIRST_BATCH);
        this.post({ type: 'items', prepend: true, items: toView(this.items.slice(this.shownFrom, to), this.shownFrom), hasEarlier: this.shownFrom > 0 });
        break;
      }
      case 'image':
        if (typeof m.ref === 'number') void this.sendImage(m.ref);
        break;
      case 'link': {
        try {
          const u = new URL(String(m.href));
          if (u.protocol === 'http:' || u.protocol === 'https:') void vscode.env.openExternal(vscode.Uri.parse(u.href));
        } catch { /* not a URL */ }
        break;
      }
      case 'terminal':
        if (!this.host.showTerminal(this.p.id, this.session.id)) void this.continueHere();
        break;
      case 'resume':
        this.submissions = this.submissions.then(() => this.disposed ? undefined : this.continueHere()).catch(() => this.postState(false));
        break;
      case 'connect':
        this.submissions = this.submissions.then(async () => {
          if (!this.disposed) { await this.host.connectTerminal?.(this.p.id, this.session.id); this.postState(); }
        }).catch(() => this.postState(false));
        break;
      case 'resumeReady':
        if (!this.resumeNeedsReady) break;
        this.resumeNeedsReady = false;
        this.resumeAt = this.queue.length ? Date.now() : 0;
        this.resumeLiveAt = 0;
        this.postState();
        break;
      case 'send':
        if (typeof m.text === 'string' && m.text.trim()) {
          this.submissions = this.submissions.then(() => this.disposed ? undefined : this.send(m.text)).catch(() => {
            this.reject(m.text);
          });
        }
        break;
      case 'pasteImage':
        if (typeof m.data === 'string' && typeof m.mime === 'string') this.saveImage(m.mime, m.data, Number(m.id));
        break;
      case 'bg':
        if (THEMES.includes(m.theme)) void this.ctx.globalState.update(THEME_KEY, m.theme).then(updatePanels);
        break;
      case 'fontSize':
        if (Number.isInteger(m.size) && m.size >= 11 && m.size <= 22) {
          void this.ctx.globalState.update(FONT_KEY, m.size).then(updatePanels);
        }
        break;
      case 'cancel': {
        const pending = this.pending.find(d => d.id === m.id && d.status === 'held');
        if (!pending || this.typing || this.flushing) break;
        const at = this.queue.indexOf(pending.text);
        if (at < 0) break;
        this.queue.splice(at, 1);
        this.reject(pending.text);
        break;
      }
      case 'recover': {
        const pending = this.pending.find(d => d.id === m.id);
        if (pending) this.post({ type: 'pasteText', text: pending.text });
        break;
      }
      case 'dismiss':
        this.pending = this.pending.filter(d => d.id !== m.id || d.status === 'held');
        this.postState(false);
        break;
    }
  }

  /** A picture pasted into the message box becomes a temp file; the agent reads an image path typed into its prompt. */
  private saveImage(mime: string, b64: string, id: number) {
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[mime];
    if (!ext || b64.length > 14_000_000) return;
    const dir = path.join(os.tmpdir(), 'agent-sessions-paste');
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (Date.now() - fs.statSync(p).mtimeMs > 86_400_000) fs.rmSync(p, { force: true });
      }
      const file = path.join(dir, `paste-${Date.now()}-${id}.${ext}`);
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      this.post({ type: 'attached', id, path: file });
    } catch { /* temp folder not writable: nothing is inserted */ }
  }

}
