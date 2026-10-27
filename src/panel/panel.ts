import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatItem, Provider, SessionEntry, Snapshot } from '../api';
import { terminalText, sendState } from './send';
import { FIRST_BATCH, headerOf, toView } from './view-model';

export { FIRST_BATCH, toView } from './view-model';

export interface PanelHost {
  /** Fresh entry for this session (live, busy, waitingFor), or undefined if gone. */
  session(providerId: string, id: string): SessionEntry | undefined;
  /** Our terminal currently on this session, if any (launched + terminalFor). */
  terminal(providerId: string, id: string): vscode.Terminal | undefined;
  /** Shows the session's terminal in this window, ours or the user's own shell; false when there is none. */
  showTerminal(providerId: string, id: string): boolean;
  /** Opens the session in a new terminal; false when that is not possible (nothing to resume, no terminal capability). */
  resume(providerId: string, id: string): boolean;
  /** The provider's last Snapshot, for the header's 5h / wk bars. */
  snapshot(providerId: string): Snapshot | undefined;
  /** The session re-read right now (not the cached entry); undefined when it is not among the open ones. */
  fresh(providerId: string, id: string): Promise<SessionEntry | undefined>;
  /** The session a terminal of ours is on now (it moves on after /clear), or undefined once it is not ours any more. */
  terminalSessionId(t: vscode.Terminal): string | undefined;
}

const panels = new Map<string, SessionPanel>();
const THEME_KEY = 'panelTheme';
const THEMES = ['editor', 'terminal', 'dark'] as const;

/** One panel per session: opening it again brings the open one forward. */
export function openPanel(host: PanelHost, p: Provider, s: SessionEntry, ctx: vscode.ExtensionContext): void {
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
  private flushing = false;
  /** When this panel resumed its session to send a message; the first keystrokes wait for the agent to be live. */
  private resumeAt = 0;
  private debounce?: NodeJS.Timeout;
  private readonly poll: NodeJS.Timeout;
  private watcher?: fs.FSWatcher;
  private watchedDir?: string;

  constructor(private readonly key: string, private readonly host: PanelHost, private readonly p: Provider, s: SessionEntry, private readonly ctx: vscode.ExtensionContext) {
    this.session = s;
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('workspaceAgentSessions.sessionPanel', s.title, vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    this.panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'images', 'icon.png');
    this.panel.webview.html = this.html(media);
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m));
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
<body${this.theme() === 'editor' ? '' : ` class="${this.theme() === 'terminal' ? 'term' : 'dark'}"`}><header id="hd"></header>
<main id="chat"><button id="earlier" hidden>Show earlier</button><div id="items"></div></main>
<footer id="ft">
<div id="wait" class="waitbar" hidden><span><b>Waiting in terminal:</b> <span id="why"></span></span><button id="answer">Answer in terminal</button></div>
<div id="queue"></div>
<div id="compose"><textarea id="msg" rows="1"></textarea><button id="send">Send</button></div>
<div id="ro" class="ro" hidden><span id="rowhy"></span><button id="resume" hidden>Resume in terminal</button></div>
</footer>
<div id="ov" hidden><div id="ovbox"></div></div>
<script nonce="${nonce}" src="${uri('panel.js')}"></script></body></html>`;
  }

  /** The panel's look: the editor's colours (default), the terminal's background, or a fixed dark design. One choice for all panels. */
  private theme = () => this.ctx.globalState.get<string>(THEME_KEY, 'editor');

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

  postState(flushQueue = true) {
    this.session = this.host.session(this.p.id, this.session.id) ?? this.session;
    const s = this.session;
    const { t, st } = this.sendStateOf(s);
    const resumable = !t && !s.live && !!this.p.terminal;
    const title = (s.waitingFor ? '● ' : '') + s.title;
    if (this.panel.title !== title) this.panel.title = title;
    this.post({
      type: 'state', header: headerOf(this.p.name, s, this.host.snapshot(this.p.id)), busy: !!s.busy,
      waitingFor: s.waitingFor, canSend: st.canSend || resumable, resumes: resumable, readOnlyReason: st.canSend || resumable ? undefined : st.reason,
      canResume: resumable, queue: this.queue, theme: this.theme(),
    });
    // The cached entry may be older than flush's own fresh check: flush must not re-trigger itself from it.
    if (flushQueue && st.canSend && !st.hold && this.queue.length) void this.flush();
  }

  /** Types one message, after a fresh look at whether that is still right: the answer may have changed meanwhile. */
  private async trySend(text: string, queueIt: boolean): Promise<'sent' | 'held' | 'refused'> {
    const fresh = await this.host.fresh(this.p.id, this.session.id);
    this.session = fresh ?? this.host.session(this.p.id, this.session.id) ?? this.session;
    const { t, st } = this.sendStateOf(this.session);
    if (!t || !st.canSend) return 'refused';
    // A terminal we just opened is still starting: its first keystrokes would be lost until the agent has the session.
    if (this.resumeAt && Date.now() - this.resumeAt < 60_000 && !fresh?.live) { if (queueIt) this.queue.push(text); return 'held'; }
    this.resumeAt = 0;
    if (st.hold) { if (queueIt) this.queue.push(text); return 'held'; }
    t.sendText(terminalText(text), true);
    return 'sent';
  }

  private async send(text: string) {
    if (!this.terminal() && !this.session.live && this.p.terminal) return this.resumeWith(text);
    const r = await this.trySend(text, true);
    if (r === 'refused') this.post({ type: 'rejected', text });
    this.postState();
  }

  /** The session is closed: open it in a terminal, keep the message, and type it once the agent is up. */
  private resumeWith(text: string) {
    if (!this.host.resume(this.p.id, this.session.id)) { this.post({ type: 'rejected', text }); return; }
    this.resumeAt = Date.now();
    this.queue.push(text);
    this.postState(false);
    const timer = setInterval(() => {
      if (this.disposed || !this.queue.length || !this.resumeAt || Date.now() - this.resumeAt > 90_000) { clearInterval(timer); return; }
      void this.flush();
    }, 1500);
  }

  /** In order, each after its own check; the pause lets a question the previous message raised show up first. */
  private async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        if (await this.trySend(this.queue[0], false) !== 'sent') break;
        this.queue.shift();
        await new Promise(r => setTimeout(r, 400));
        if (this.disposed) return;
      }
    } finally { this.flushing = false; }
    this.postState(false);
  }

  private schedule() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.pump(), 300);
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
        this.next = chunk.next;
        if (!this.ready) continue;
        if (replaced) this.sendBatch();
        else if (chunk.items.length) this.post({ type: 'items', items: toView(chunk.items, start), hasEarlier: this.shownFrom > 0 });
      } while (this.again);
    } catch {
      // unreadable for now; the next change or the poll tries again
    } finally {
      this.reading = false;
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
      case 'ready':
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
        if (!this.host.showTerminal(this.p.id, this.session.id)) this.noTerminal();
        break;
      case 'resume':
        this.host.resume(this.p.id, this.session.id);
        break;
      case 'send':
        if (typeof m.text === 'string' && m.text.trim()) void this.send(m.text);
        break;
      case 'pasteImage':
        if (typeof m.data === 'string' && typeof m.mime === 'string') this.saveImage(m.mime, m.data, Number(m.id));
        break;
      case 'bg':
        void this.ctx.globalState.update(THEME_KEY, THEMES[(THEMES.indexOf(this.theme() as typeof THEMES[number]) + 1) % THEMES.length]).then(updatePanels);
        break;
      case 'cancel':
        if (typeof m.index === 'number') { this.queue.splice(m.index, 1); this.postState(); }
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

  /** Nothing of this window holds the session: offer to open it when it is closed, else say where it is. */
  private noTerminal() {
    if (!this.session.live && this.p.terminal) this.host.resume(this.p.id, this.session.id);
    else void vscode.window.showInformationMessage(`"${this.session.title}" is open in ${this.session.source ?? 'another process'}, not in a terminal of this window.`);
  }
}
