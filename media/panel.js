// Panel view webview. The host sends already-escaped HTML for message text; everything else is set with textContent.
(async () => {
  const vscode = typeof panelBridge === 'undefined' ? acquireVsCodeApi() : panelBridge;
  try {
  const script = document.currentScript;
  if (typeof window.followConversation !== 'function') await new Promise((resolve, reject) => {
    const dependency = document.createElement('script');
    dependency.src = new URL('scroll.js', script.src).href;
    dependency.nonce = script.nonce;
    dependency.onload = resolve;
    dependency.onerror = () => reject(new Error('Could not load conversation scrolling. Close and reopen the panel to retry.'));
    document.head.append(dependency);
  });
  window.addEventListener('focus', () => vscode.postMessage({ type: 'focus', active: true }));
  window.addEventListener('blur', () => vscode.postMessage({ type: 'focus', active: false }));
  document.addEventListener('focusin', () => vscode.postMessage({ type: 'focus', active: true }));
  const $ = id => document.getElementById(id);
  const chat = $('chat'), list = $('items'), earlier = $('earlier'), hd = $('hd'), ov = $('ov'), ovbox = $('ovbox');
  const pendingBox = $('pending');
  const scroll = followConversation(chat, [list, pendingBox, $('activity')]);
  const msg = $('msg'), compose = $('compose'), ro = $('ro'), wait = $('wait');
  const saved = vscode.getState() || {};
  if (typeof saved.draft === 'string') msg.value = saved.draft;
  const saveDraft = () => vscode.setState({ ...(vscode.getState() || {}), draft: msg.value });
  let activityState = { text: '', since: undefined, label: 'working' };
  let canInterrupt = false;
  const elapsed = since => {
    const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
    return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
  };
  const paintActivity = () => {
    const status = $('activity');
    const { text, since, label } = activityState;
    const duration = since ? ` (${elapsed(since)})` : '';
    status.hidden = !text;
    status.textContent = text ? '● ' + text.replace(/[.…]+$/, '') + duration + '…' : '';
    const header = hd.querySelector('.busy');
    if (header) header.textContent = '● ' + label + duration + '…';
  };
  const showActivity = (text, since, label = 'working') => { activityState = { text, since, label }; paintActivity(); };
  setInterval(paintActivity, 1000);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  // During local development the host can still be loaded from before a media update. Keep that HTML usable.
  const control = (id, text, parent) => {
    if ($(id)) return $(id);
    const button = el('button', null, text);
    button.id = id;
    button.hidden = true;
    parent.append(button);
    return button;
  };
  let live = $('live');
  if (!live) { live = el('div'); live.id = 'live'; chat.append(live); live.append($('activity')); }
  control('interrupt', 'Esc to interrupt', live);
  for (const [id, label] of [['connect', 'Connect terminal'], ['resumeReady', 'Continue in panel'], ['resumeTerminal', 'Open terminal']]) control(id, label, ro);

  function paintPending(messages) {
    pendingBox.replaceChildren(...messages.map(d => {
      const bubble = el('div', 'u pending-message');
      bubble.append(el('div', null, d.text));
      const status = el('div', 'delivery');
      status.append(el('span', null, d.status === 'agent' ? 'Sent to terminal · acceptance not yet confirmed' : d.status === 'unconfirmed'
        ? d.reason === 'disconnected' ? 'Terminal disconnected · delivery unconfirmed'
          : d.reason === 'timeout' ? 'No delivery confirmation · may still be in terminal input or agent queue'
          : 'Delivery unconfirmed after reload' : 'Waiting to send'));
      const clipboard = el('button', null, 'Copy');
      clipboard.onclick = () => void copyText(d.text).then(() => {
        clipboard.textContent = 'Copied ✓';
        setTimeout(() => { clipboard.textContent = 'Copy'; }, 1200);
      });
      status.append(clipboard);
      const copy = el('button', null, 'Copy to input');
      copy.title = 'Copy this text for editing; this does not send it again';
      copy.onclick = () => vscode.postMessage({ type: 'recover', id: d.id });
      status.append(copy);
      {
        const cancel = el('button', null, d.status === 'held' ? 'Cancel' : 'Dismiss');
        cancel.title = d.status === 'held' ? 'Cancel before sending and restore the text' : 'Dismiss this notice; messages already in the agent are unaffected';
        cancel.onclick = () => vscode.postMessage({ type: d.status === 'held' ? 'cancel' : 'dismiss', id: d.id });
        status.append(cancel);
      }
      bubble.append(status);
      return bubble;
    }));
  }

  // Change locations form an overview beside the main scrollbar. Nearby edits share one hit target.
  const changeNodes = new Map(), pins = el('nav', 'change-pins');
  pins.setAttribute('aria-label', 'Code changes in this conversation');
  document.body.append(pins);
  let pinsFrame = 0;
  function paintPins() {
    pinsFrame = 0;
    const rect = chat.getBoundingClientRect(), height = Math.max(0, rect.height - 16), groups = new Map();
    pins.style.top = rect.top + 8 + 'px';
    pins.style.height = height + 'px';
    if (height < 14) { pins.replaceChildren(); return; }
    for (const [node, title] of changeNodes) {
      if (!node.isConnected) { changeNodes.delete(node); continue; }
      const y = node.getBoundingClientRect().top - rect.top + chat.scrollTop;
      const bucket = Math.round(y / Math.max(1, chat.scrollHeight) * height / 14);
      if (!groups.has(bucket)) groups.set(bucket, []);
      groups.get(bucket).push({ node, title });
    }
    pins.replaceChildren(...[...groups].map(([bucket, changes]) => {
      const pin = el('button', 'change-pin');
      pin.style.top = Math.min(height - 14, bucket * 14) + 'px';
      pin.title = changes.slice(0, 6).map(c => c.title).join('\n') + (changes.length > 6 ? `\n+${changes.length - 6} more changes` : '');
      pin.setAttribute('aria-label', pin.title);
      pin.onclick = () => { scroll.pause(); changes[0].node.scrollIntoView({ block: 'start' }); };
      return pin;
    }));
  }
  const schedulePins = () => { if (!pinsFrame) pinsFrame = requestAnimationFrame(paintPins); };
  const pinResize = new ResizeObserver(schedulePins);
  for (const node of [chat, list, pendingBox]) pinResize.observe(node);

  // ---- enlarged view -------------------------------------------------------
  const closeOv = () => { ov.hidden = true; ovbox.onwheel = null; ovbox.replaceChildren(); };
  function openOv(node, hint) {
    ovbox.replaceChildren(node, el('div', 'hint', hint));
    ov.hidden = false;
  }
  const ovx = el('button', 'ovx', '✕');
  ovx.title = 'Close (Esc)';
  ovx.onclick = closeOv;
  ov.append(ovx);
  ov.addEventListener('click', e => { if (e.target === ov) closeOv(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !ov.hidden) { closeOv(); e.preventDefault(); e.stopImmediatePropagation(); }
  });

  // Click: one zoom in, one zoom out. The wheel zooms freely. The cursor always says what the next click does.
  const ZMAX = 5, ZCLICK = 2.5;
  function zoomable(img) {
    let scale = 1, fit = 0;
    const apply = () => {
      if (!fit) fit = img.getBoundingClientRect().width;
      img.style.maxWidth = img.style.maxHeight = scale > 1 ? 'none' : '';
      img.style.width = scale > 1 ? fit * scale + 'px' : '';
      img.style.cursor = scale > 1 ? 'zoom-out' : 'zoom-in';
    };
    img.style.cursor = 'zoom-in';
    img.onclick = () => { fit = fit || img.getBoundingClientRect().width; scale = scale > 1 ? 1 : ZCLICK; apply(); };
    ovbox.onwheel = e => {
      e.preventDefault();
      fit = fit || img.getBoundingClientRect().width;
      scale = Math.max(1, Math.min(ZMAX, scale * (e.deltaY < 0 ? 1.25 : 0.8)));
      if (scale < 1.05) scale = 1;
      apply();
    };
  }

  // ---- tables --------------------------------------------------------------
  function tsv(table) {
    const cell = c => c.innerText.replace(/[\t\r\n]+/g, ' ').trim();
    return [...table.querySelectorAll('tr')].map(r => [...r.cells].map(cell).join('\t')).join('\n');
  }
  function copyText(text) {
    const fallback = () => {
      const t = el('textarea');
      t.value = text;
      document.body.append(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    };
    return navigator.clipboard ? navigator.clipboard.writeText(text).catch(fallback) : Promise.resolve(fallback());
  }
  // Code blocks get the same hover Copy button as tables.
  function syntaxLines(source, language) {
    if (!window.hljs || source.length > 40000) return null;
    try {
      const highlighted = language && hljs.getLanguage(language) ? hljs.highlight(source, { language, ignoreIllegals: true })
        : hljs.highlightAuto(source, ['typescript', 'javascript', 'json', 'python', 'bash', 'css', 'xml', 'rust', 'go', 'cpp', 'sql', 'powershell']);
      // Only library-generated markup is parsed. Transcript text was escaped by Highlight.js.
      const template = document.createElement('template');
      template.innerHTML = highlighted.value;
      const lines = [document.createDocumentFragment()];
      const visit = (node, classes = '') => {
        if (node.nodeType === Node.TEXT_NODE) {
          node.textContent.split('\n').forEach((text, i) => {
            if (i) lines.push(document.createDocumentFragment());
            if (text) lines[lines.length - 1].append(el('span', classes || null, text));
          });
        } else {
          const next = [classes, node.nodeType === Node.ELEMENT_NODE ? node.className : ''].filter(Boolean).join(' ');
          for (const child of node.childNodes) visit(child, next);
        }
      };
      visit(template.content);
      return lines;
    } catch { return null; }
  }

  function enhanceCode(root) {
    for (const pre of root.querySelectorAll('pre')) {
      const code = pre.querySelector('code');
      if (code) {
        const source = code.textContent;
        const lines = syntaxLines(source, /lang-([\w+#.-]+)/.exec(code.className)?.[1]);
        if (lines) {
          if (source.endsWith('\n')) lines.pop();
          code.replaceChildren(...lines.map((content, i) => {
            const row = el('span', 'code-line');
            row.dataset.number = i + 1;
            row.append(content, '\n');
            return row;
          }));
        }
      }
      const wrap = el('div', 'tblw');
      pre.replaceWith(wrap);
      const copy = el('button', null, 'Copy');
      copy.onclick = e => {
        e.stopPropagation();
        void copyText(pre.textContent).then(() => {
          copy.textContent = 'Copied ✓';
          setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
        });
      };
      const btns = el('div', 'tbtns');
      btns.append(copy);
      wrap.append(pre, btns);
    }
  }
  // Whatever is selected goes to the clipboard as plain text, even where the webview's own copy does not.
  document.addEventListener('copy', e => {
    const sel = String(getSelection() || '');
    if (!sel || e.target === msg) return;
    e.clipboardData.setData('text/plain', sel);
    e.preventDefault();
  });

  function enhanceTables(root) {
    for (const t of root.querySelectorAll('.tbl')) {
      const wrap = el('div', 'tblw');
      t.replaceWith(wrap);
      const btns = el('div', 'tbtns');
      const copy = el('button', null, 'Copy');
      copy.title = 'Copy as cells (pastes into Excel / Sheets)';
      copy.onclick = e => {
        e.stopPropagation();
        void copyText(tsv(t.querySelector('table'))).then(() => {
          copy.textContent = 'Copied ✓';
          setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
        });
      };
      const big = el('button', null, '⤢');
      big.title = 'Enlarge';
      big.onclick = e => { e.stopPropagation(); openOv(t.cloneNode(true), 'Select and copy the text · click outside or press Esc to close'); };
      btns.append(copy, big);
      wrap.append(t, btns);
    }
  }

  // ---- images: placeholders until scrolled into view -----------------------
  const holders = new Map();
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      vscode.postMessage({ type: 'image', ref: Number(e.target.dataset.ref) });
    }
  }, { root: chat, rootMargin: '400px' });

  function showImage(ref, src) {
    const ph = holders.get(ref);
    if (!ph) return;
    const img = el('img', 'thumb');
    img.src = src;
    img.onclick = () => {
      const big = el('img');
      big.src = src;
      openOv(big, 'Click or scroll to zoom · Esc or click outside to close');
      zoomable(big);
    };
    ph.replaceWith(img);
    holders.delete(ref);
  }

  // ---- folding sections ------------------------------------------------------
  // <details> cannot animate its content here (no ::details-content / interpolate-size in this Chromium), so the
  // summary click is taken over: the content wrapper's height goes between 0 and its natural height.
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function settle(d, dc) {
    if (!d.classList.contains('is-open')) d.open = false;
    dc.style.height = '';
  }
  function toggle(d, dc) {
    clearTimeout(d._settle);
    const want = !d.classList.contains('is-open');
    if (want) scroll.pause();
    d.classList.toggle('is-open', want);
    if (reduceMotion()) { d.open = want; dc.style.height = ''; return; }
    if (want && !d.open) { d.open = true; dc.style.height = '0px'; }
    else dc.style.height = dc.getBoundingClientRect().height + 'px'; // pin where it is: a click mid-way turns it round
    void dc.offsetHeight;
    dc.style.height = (want ? dc.scrollHeight : 0) + 'px';
    // transitionend does not fire when there is no distance to travel
    d._settle = setTimeout(() => settle(d, dc), 300);
  }
  function collapsible(cls, title, body, expanded = false) {
    const d = el('details', cls);
    if (expanded) { d.open = true; d.classList.add('is-open'); }
    const dc = el('div', 'dc');
    const sum = el('summary');
    if (typeof title === 'string') sum.textContent = title;
    else sum.append(title);
    const tools = el('div', 'detail-tools');
    const close = el('button', 'detail-close', 'Close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Collapse details');
    const collapse = () => { if (d.classList.contains('is-open')) toggle(d, dc); sum.focus(); };
    close.onclick = e => { e.stopPropagation(); collapse(); };
    tools.append(close);
    dc.append(tools, body);
    d.append(sum, dc);
    sum.addEventListener('click', e => { e.preventDefault(); toggle(d, dc); });
    d.addEventListener('keydown', e => {
      if (e.key === 'Escape' && ov.hidden && d.classList.contains('is-open')) { e.stopPropagation(); e.preventDefault(); collapse(); }
    });
    dc.addEventListener('transitionend', e => {
      if (e.target !== dc || e.propertyName !== 'height') return;
      clearTimeout(d._settle);
      settle(d, dc);
    });
    return d;
  }

  // ---- items ---------------------------------------------------------------
  function fullOutput(node, v) {
    if (!v.more) return node;
    const open = el('button', 'full-output', `Open full output · ${v.more.toLocaleString()} more characters`);
    open.onclick = () => vscode.postMessage({ type: 'openText', ref: v.i });
    node.querySelector('.dc')?.append(open);
    return node;
  }
  function render(v) {
    switch (v.kind) {
      case 'user': { const d = el('div', 'u'); d.innerHTML = v.html; return d; }
      case 'assistant': { const d = el('div', 'a'); d.innerHTML = v.html; enhanceTables(d); enhanceCode(d); return d; }
      case 'tool': {
        const d = el('div', v.done ? 'tool done' : 'tool');
        d.append(el('b', null, v.name), v.summary ? el('span', 'tool-command', ' ' + v.summary) : '');
        if (v.detail) return fullOutput(collapsible('res tool-input', d, el('pre', null, v.detail)), v);
        return d;
      }
      case 'toolResult': {
        const first = v.text.split('\n').find(l => l.trim()) || 'result';
        if (v.code) {
          const pre = el('pre', 'source');
          const source = v.code.map(line => line.tokens.map(t => t.text).join('')).join('\n');
          const ext = /\.([a-z0-9]+)(?:\s|$)/i.exec(first)?.[1]?.toLowerCase();
          const language = ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', rs: 'rust', ps1: 'powershell', html: 'xml', sh: 'bash' })[ext] || ext;
          const highlighted = syntaxLines(source, language);
          for (const [index, line] of v.code.entries()) {
            const row = el('span', 'code-line' + (line.tone ? ' diff-' + line.tone : ''));
            row.dataset.number = line.number ?? '';
            row.dataset.sign = line.sign ?? '';
            if (highlighted && line.tone !== 'meta') row.append(highlighted[index]);
            else for (const token of line.tokens) row.append(el('span', null, token.text));
            row.append('\n');
            pre.append(row);
          }
          if (v.more) pre.append(`\n… ${v.more} more characters`);
          return fullOutput(collapsible(v.error ? 'res err' : 'res', first, pre, true), v);
        }
        return fullOutput(collapsible(v.error ? 'res err' : 'res', (v.error ? 'error · ' : 'result · ') + first.slice(0, 120),
          el('pre', null, v.text + (v.more ? `\n… ${v.more} more characters` : ''))), v);
      }
      case 'image': {
        const d = el('div', 'img');
        const ph = el('div', 'ph');
        ph.dataset.ref = String(v.ref);
        holders.set(v.ref, ph);
        io.observe(ph);
        d.append(ph);
        return d;
      }
      case 'note': {
        if (!v.text) return el('div', 'note', v.title);
        if (v.title === 'Question from agent') return collapsible('note question', v.title, el('pre', null, v.text), true);
        if (v.title.startsWith('Ran ')) {
          const label = el('span', 'run-label');
          label.append(el('b', null, 'Ran '), el('span', 'tool-command', v.title.slice(4)));
          return collapsible('note command', label, el('pre', null, v.text));
        }
        return collapsible('note', v.title, el('pre', null, v.text));
      }
    }
    return el('div');
  }

  function onItems(m) {
    scroll.update(() => {
      if (m.reset) { list.replaceChildren(); holders.clear(); changeNodes.clear(); }
      const frag = document.createDocumentFragment();
      for (const v of m.items) {
        const node = render(v);
        if (v.kind === 'toolResult' && v.code?.length && !v.error) {
          const added = v.code.filter(l => l.tone === 'add').length, removed = v.code.filter(l => l.tone === 'del').length;
          const files = [...v.text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m => m[1]);
          const title = files.length ? 'Requested patch · ' + files.slice(0, 6).join(', ') : v.text.split('\n')[0];
          changeNodes.set(node, title + (v.text.startsWith('File · ') ? ` · ${v.code.length} lines` : ` · +${added} / −${removed} lines`) + (v.more ? ' (preview)' : ''));
        }
        frag.append(node);
      }
      if (m.prepend) list.prepend(frag);
      else list.append(frag);
      earlier.hidden = !m.hasEarlier;
      if (!list.children.length) list.append(el('div', 'empty', emptyText()));
      else list.querySelector('.empty')?.remove();
    }, m.prepend);
    schedulePins();
  }

  // A session started from here has no transcript until its first message: say where to write it.
  let typing = false;
  const emptyText = () => (typing ? 'Nothing here yet. Type your first message below.' : 'No messages yet.');

  // ---- header --------------------------------------------------------------
  function meter(label, m, cls) {
    const s = el('span', 'meter' + (cls ? ' ' + cls : '') + (m.pct >= 80 ? ' hot' : '') + (m.stale ? ' stale' : ''));
    const bar = el('span', 'bar');
    const fill = el('i');
    fill.style.width = Math.max(0, Math.min(100, m.pct)) + '%';
    bar.append(fill);
    s.append(label + ' ', bar, ` ${m.stale ? '~' : ''}${m.pct}%` + (m.label ? ` · ${m.label}` : ''));
    return s;
  }

  function onState(m) {
    commands = (m.commands || []).filter(c => typeof c.command === 'string' && typeof c.detail === 'string');
    paintCommands();
    showActivity(m.activity || (m.busy ? 'Working…' : ''), m.busySince, m.busyLabel);
    $('activity').classList.toggle('inactive', !m.busy);
    canInterrupt = !!m.canInterrupt;
    $('interrupt').hidden = !canInterrupt;
    $('interrupt').disabled = false;
    if (m.session) vscode.setState({ session: m.session, draft: msg.value, pending: m.pending || [], resumeNeedsReady: !!m.resumeNeedsReady });
    document.body.classList.toggle('working', !!m.busy);
    const h = m.header;
    const row = el('div', 'hd');
    const ag = el('span', 'ag', h.agent);
    const identity = el('span', 'identity');
    identity.append(ag);
    row.append(identity);
    const model = [h.model, h.effort].filter(Boolean).join(' · ');
    if (model) { const label = el('span', 'm', model); label.title = model; identity.append(label); }
    const meters = [h.ctx && meter('ctx', h.ctx, 'ctx'), h.five && meter('5h', h.five), h.week && meter('wk', h.week)].filter(Boolean);
    const metrics = el('div', 'metrics');
    metrics.append(...meters);
    if (m.busy) metrics.append(el('span', 'busy', '● ' + (m.busyLabel || 'working') + '…'));
    if (metrics.childNodes.length) row.append(metrics);
    const seg = el('span', 'seg');
    const term = el('button', null, 'Open terminal');
    term.title = 'Show this session’s terminal';
    term.onclick = () => vscode.postMessage({ type: 'terminal' });
    seg.append(term);
    const bg = el('button', 'bgtoggle', '◐');
    const NEXT = { editor: 'dark', dark: 'terminal', terminal: 'editor' }, NAME = { editor: 'VS Code editor', terminal: 'terminal background', dark: 'dark design' };
    let theme = NAME[m.theme] ? m.theme : 'editor';
    const paintTheme = () => {
      bg.title = `Look: ${NAME[theme]} (click: ${NAME[NEXT[theme]]})`;
      bg.setAttribute('aria-label', bg.title);
      document.body.classList.toggle('term', theme === 'terminal');
      document.body.classList.toggle('dark', theme === 'dark');
    };
    bg.onclick = () => { theme = NEXT[theme]; paintTheme(); vscode.postMessage({ type: 'bg', theme }); };
    paintTheme();
    let fontSize = Number.isInteger(m.fontSize) ? Math.max(11, Math.min(22, m.fontSize)) : 14;
    const zoom = el('span', 'textzoom');
    zoom.setAttribute('role', 'group');
    zoom.setAttribute('aria-label', 'Text size');
    const smaller = el('button', null, '−'), reset = el('button', 'textsize'), larger = el('button', null, '+');
    const paintSize = () => {
      document.body.style.setProperty('--text-size', fontSize + 'px');
      smaller.disabled = fontSize <= 11;
      larger.disabled = fontSize >= 22;
      reset.textContent = fontSize;
      reset.title = `Text size: ${fontSize}px (click to reset to 14px)`;
      reset.setAttribute('aria-label', reset.title);
      grow();
    };
    const resizeText = size => { fontSize = size; paintSize(); vscode.postMessage({ type: 'fontSize', size }); };
    smaller.title = 'Decrease text size';
    smaller.setAttribute('aria-label', smaller.title);
    larger.title = 'Increase text size';
    larger.setAttribute('aria-label', larger.title);
    smaller.onclick = () => resizeText(Math.max(11, fontSize - 1));
    larger.onclick = () => resizeText(Math.min(22, fontSize + 1));
    reset.onclick = () => resizeText(14);
    zoom.append(smaller, reset, larger);
    paintSize();
    const right = el('span', 'right');
    right.append(zoom, bg, seg);
    row.append(right);
    ag.title = [h.title, h.repo].filter(Boolean).join(' · ');
    hd.replaceChildren(row);
    const context = el('div', 'session-context');
    if (h.cwd) {
      const repo = el('button', 'repo-path', h.cwd);
      repo.title = `Copy repository path: ${h.cwd}`;
      repo.onclick = () => void copyText(h.cwd);
      context.append(repo);
    }
    if (h.title) { const title = el('span', 'session-name', h.title); title.title = h.title; context.append(title); }
    if (context.childNodes.length) hd.append(context);
    const modes = el('div', 'session-modes');
    if (h.mode) modes.append(el('span', null, h.mode + ' mode'));
    const permission = [h.approvalPolicy && 'Approval: ' + h.approvalPolicy, h.sandbox && 'Sandbox: ' + h.sandbox].filter(Boolean).join(' · ');
    if (permission) { const label = el('span', null, permission); label.title = 'Last recorded turn settings; the agent controls these settings.'; modes.append(label); }
    if (modes.childNodes.length) hd.append(modes);
    paintActivity();
    msg.placeholder = `Message ${h.agent}…`;
    msg.setAttribute('aria-label', `Message ${h.agent}`);
    msg.title = (m.resumes ? 'Sending resumes this session. ' : '') + 'Enter sends · Shift+Enter adds a line';

    // Waiting for the user: orange glow once when it begins, then steady; the bar stays while it lasts.
    const waiting = !!m.waitingFor;
    if (waiting && !document.body.classList.contains('waiting')) {
      document.body.classList.add('pulse');
      setTimeout(() => document.body.classList.remove('pulse'), 1700);
    }
    document.body.classList.toggle('waiting', waiting);
    wait.hidden = !waiting;
    $('why').textContent = m.waitingFor || '';

    typing = !!m.canSend;
    const empty = list.querySelector('.empty');
    if (empty) empty.textContent = emptyText();
    compose.hidden = !m.canSend;
    ro.hidden = !m.connectionReason && m.canSend;
    $('rowhy').textContent = m.connectionReason || m.readOnlyReason || '';
    $('resume').hidden = !m.canResume;
    $('connect').hidden = !m.canConnect || !!m.resumeNeedsReady;
    $('resumeReady').hidden = !m.resumeNeedsReady;
    $('resumeTerminal').hidden = !m.resumeNeedsReady;

    paintPending(m.pending || []);
    if ($('loading')) $('loading').hidden = true;
  }

  // ---- message box -----------------------------------------------------------
  const commandMenu = el('div', 'commands');
  commandMenu.id = 'commands';
  commandMenu.hidden = true;
  commandMenu.setAttribute('role', 'listbox');
  commandMenu.setAttribute('aria-label', 'Slash commands');
  compose.before(commandMenu);
  msg.setAttribute('aria-controls', 'commands');
  msg.setAttribute('aria-autocomplete', 'list');
  let commands = [], matches = [], selectedCommand = 0, dismissedCommand = '';
  function paintCommands() {
    const query = /^\/[^\s]*$/.test(msg.value) ? msg.value.toLowerCase() : '';
    matches = query ? commands.filter(c => c.command.toLowerCase().startsWith(query)).slice(0, 8) : [];
    commandMenu.hidden = !matches.length || msg.value === dismissedCommand;
    msg.setAttribute('aria-expanded', String(!commandMenu.hidden));
    selectedCommand = Math.min(selectedCommand, Math.max(0, matches.length - 1));
    msg.removeAttribute('aria-activedescendant');
    commandMenu.replaceChildren(...matches.map((command, i) => {
      const row = el('button', 'command-option');
      row.type = 'button';
      row.id = 'command-option-' + i;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === selectedCommand));
      row.append(el('b', null, command.command), el('span', null, command.detail));
      row.onmousedown = e => e.preventDefault();
      row.onclick = () => completeCommand(command);
      return row;
    }));
    if (!commandMenu.hidden) msg.setAttribute('aria-activedescendant', 'command-option-' + selectedCommand);
  }
  function completeCommand(command) {
    msg.value = command.command + ' ';
    grow(); saveDraft(); paintCommands(); msg.focus();
  }
  msg.addEventListener('keydown', e => {
    if (commandMenu.hidden || e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      selectedCommand = (selectedCommand + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
      paintCommands();
    } else if (!e.shiftKey && (e.key === 'Tab' || (e.key === 'Enter' && msg.value !== matches[selectedCommand]?.command))) {
      e.preventDefault(); completeCommand(matches[selectedCommand]);
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); dismissedCommand = msg.value; paintCommands();
    }
  });
  document.addEventListener('mousedown', e => {
    if (e.target !== msg && !commandMenu.contains(e.target)) { dismissedCommand = msg.value; paintCommands(); }
  });
  const grow = () => {
    const style = getComputedStyle(msg);
    const base = parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 2;
    msg.style.height = '0px';
    const height = msg.value ? Math.max(base, msg.scrollHeight + 2) : base;
    msg.style.height = Math.min(height, 160) + 'px';
    msg.style.overflowY = height > 160 ? 'auto' : 'hidden';
  };
  new ResizeObserver(() => grow()).observe(compose);
  function submit() {
    const paths = [...cards.values()].map(c => c.path).filter(Boolean);
    if (!msg.value.trim() && !paths.length) return;
    const text = [msg.value.trim(), ...paths].join(' ');
    cards.clear(); shots.replaceChildren(); shots.hidden = true;
    showActivity('Sending…');
    const sending = el('div', 'u pending-message');
    sending.append(el('div', null, text), el('div', 'delivery', 'Sending…'));
    pendingBox.append(sending);
    msg.value = '';
    paintCommands();
    grow();
    saveDraft();
    scroll.toBottom();
    vscode.postMessage({ type: 'send', text });
  }
  msg.addEventListener('input', () => { selectedCommand = 0; dismissedCommand = ''; grow(); saveDraft(); paintCommands(); });
  // Dictation tools commonly use the terminal paste chord throughout VS Code.
  msg.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyV') {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: 'pasteText' });
    }
  });
  // Pasted pictures cannot go into a text box: the host saves each as a file, a card shows it above the box, and the
  // paths are appended to the message when it is sent.
  const shots = el('div', 'shots');
  shots.hidden = true;
  compose.before(shots);
  const cards = new Map();
  let shotId = 0;
  msg.addEventListener('paste', e => {
    const fs = [...(e.clipboardData?.files || [])].filter(x => /^image\/(png|jpe?g|gif|webp)$/.test(x.type));
    if (!fs.length) return;
    e.preventDefault();
    for (const f of fs) {
      const id = ++shotId, r = new FileReader();
      r.onload = () => {
        const url = String(r.result);
        const card = el('div', 'shot'), img = el('img'), x = el('button', 'x', '×');
        img.src = url;
        img.onclick = () => { const big = el('img'); big.src = url; openOv(big, 'Click or scroll to zoom · Esc or click outside to close'); zoomable(big); };
        x.title = 'Remove';
        x.onclick = () => { cards.delete(id); card.remove(); shots.hidden = !cards.size; };
        card.append(img, x);
        cards.set(id, { card, path: '' });
        shots.append(card);
        shots.hidden = false;
        vscode.postMessage({ type: 'pasteImage', id, mime: f.type, data: url.split(',')[1] || '' });
      };
      r.readAsDataURL(f);
    }
  });
  // Enter and Ctrl+Enter send, Shift+Enter adds a line. Not while an IME is composing.
  msg.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.defaultPrevented && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  $('send').onclick = submit;
  $('answer').onclick = () => vscode.postMessage({ type: 'terminal' });
  $('resume').onclick = () => vscode.postMessage({ type: 'resume' });
  $('connect').onclick = () => vscode.postMessage({ type: 'connect' });
  $('resumeReady').onclick = () => { vscode.postMessage({ type: 'resumeReady' }); msg.focus(); };
  $('resumeTerminal').onclick = () => vscode.postMessage({ type: 'terminal' });
  const interrupt = () => {
    if (!canInterrupt) return;
    canInterrupt = false;
    $('interrupt').disabled = true;
    vscode.postMessage({ type: 'interrupt' });
  };
  $('interrupt').onclick = interrupt;
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !e.defaultPrevented && canInterrupt && commandMenu.hidden) { e.preventDefault(); interrupt(); }
  });

  // ---- wiring --------------------------------------------------------------
  earlier.onclick = () => vscode.postMessage({ type: 'earlier' });
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (href) vscode.postMessage({ type: 'link', href });
  });
  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'items') onItems(m);
    else if (m.type === 'image') showImage(m.ref, m.src);
    else if (m.type === 'attached') { const c = cards.get(m.id); if (c) c.path = m.path; }
    else if (m.type === 'state') scroll.update(() => onState(m));
    else if (m.type === 'pasteText' && typeof m.text === 'string') {
      msg.setRangeText(m.text, msg.selectionStart, msg.selectionEnd, 'end');
      grow();
      saveDraft();
      paintCommands();
      msg.focus();
    }
    // The host would not type it (the terminal moved or closed meanwhile): give the text back.
    else if (m.type === 'rejected') { showActivity(''); msg.value = [m.text, msg.value].filter(Boolean).join('\n\n'); grow(); saveDraft(); }
  });
  grow();
  vscode.postMessage({ type: 'ready' });
  } catch (error) {
    const loading = document.getElementById('loading') || document.createElement('div');
    loading.id = 'loading'; loading.hidden = false; loading.setAttribute('role', 'alert');
    loading.textContent = 'The panel could not load. Close and reopen it, or use Developer: Reload Window.';
    if (!loading.isConnected) document.body.prepend(loading);
    vscode.postMessage({ type: 'webviewError', message: String(error).slice(0, 300) });
  }
})();
