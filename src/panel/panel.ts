import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatItem, Provider, SessionEntry, Snapshot } from '../api';
import { FIRST_BATCH, headerOf, toView } from './view-model';

export { FIRST_BATCH, toView } from './view-model';

export interface PanelHost {
  /** Fresh entry for this session (live, busy, waitingFor), or undefined if gone. */
  session(providerId: string, id: string): SessionEntry | undefined;
  /** Our terminal currently on this session, if any (launched + terminalFor). */
  terminal(providerId: string, id: string): vscode.Terminal | undefined;
  /** Shows the session's terminal in this window, ours or the user's own shell; false when there is none. */
  showTerminal(providerId: string, id: string): boolean;
  resume(providerId: string, id: string): void;
  /** The provider's last Snapshot, for the header's 5h / wk bars. */
  snapshot(providerId: string): Snapshot | undefined;
}

const panels = new Map<string, SessionPanel>();

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
  private debounce?: NodeJS.Timeout;
  private readonly poll: NodeJS.Timeout;
  private watcher?: fs.FSWatcher;

  constructor(private readonly key: string, private readonly host: PanelHost, private readonly p: Provider, s: SessionEntry, ctx: vscode.ExtensionContext) {
    this.session = s;
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('workspaceAgentSessions.sessionPanel', s.title, vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    this.panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'images', 'icon.png');
    this.panel.webview.html = this.html(media);
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m));
    this.panel.onDidDispose(() => this.dispose());
    // The directory is watched, not the file: a new Claude session has no transcript until its first message.
    try {
      this.watcher = fs.watch(path.dirname(s.file), (_, name) => { if (!name || name === path.basename(s.file)) this.schedule(); });
      this.watcher.on('error', () => { /* the poll below keeps it going */ });
    } catch { /* folder not there yet */ }
    this.poll = setInterval(() => this.schedule(), 5000);
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
<body><header id="hd"></header>
<main id="chat"><button id="earlier" hidden>Show earlier</button><div id="items"></div></main>
<div id="ov" hidden><div id="ovbox"></div></div>
<script nonce="${nonce}" src="${uri('panel.js')}"></script></body></html>`;
  }

  private post(m: unknown) { if (!this.disposed) void this.panel.webview.postMessage(m); }

  postState() {
    this.session = this.host.session(this.p.id, this.session.id) ?? this.session;
    if (this.panel.title !== this.session.title) this.panel.title = this.session.title;
    this.post({ type: 'state', header: headerOf(this.p.name, this.session, this.host.snapshot(this.p.id)), busy: !!this.session.busy });
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
      case 'image': {
        const it = typeof m.ref === 'number' ? this.items[m.ref] : undefined;
        if (it?.kind === 'image') {
          const mime = /^image\/[\w.+-]+$/.test(it.mime) ? it.mime : 'image/png';
          this.post({ type: 'image', ref: m.ref, src: `data:${mime};base64,${it.data}` });
        }
        break;
      }
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
    }
  }

  /** Nothing of this window holds the session: offer to open it when it is closed, else say where it is. */
  private noTerminal() {
    if (!this.session.live && this.p.terminal) this.host.resume(this.p.id, this.session.id);
    else void vscode.window.showInformationMessage(`"${this.session.title}" is open in ${this.session.source ?? 'another process'}, not in a terminal of this window.`);
  }
}
