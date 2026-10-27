// Panel view webview. The host sends already-escaped HTML for message text; everything else is set with textContent.
(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const chat = $('chat'), list = $('items'), earlier = $('earlier'), hd = $('hd'), ov = $('ov'), ovbox = $('ovbox');
  const msg = $('msg'), compose = $('compose'), ro = $('ro'), wait = $('wait'), queueBox = $('queue');
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const atBottom = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;

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
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeOv(); });

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
    const stick = atBottom();
    const img = el('img', 'thumb');
    img.onload = () => { if (stick) chat.scrollTop = chat.scrollHeight; };
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
    d.classList.toggle('is-open', want);
    if (reduceMotion()) { d.open = want; dc.style.height = ''; return; }
    if (want && !d.open) { d.open = true; dc.style.height = '0px'; }
    else dc.style.height = dc.getBoundingClientRect().height + 'px'; // pin where it is: a click mid-way turns it round
    void dc.offsetHeight;
    dc.style.height = (want ? dc.scrollHeight : 0) + 'px';
    // transitionend does not fire when there is no distance to travel
    d._settle = setTimeout(() => settle(d, dc), 300);
  }
  function collapsible(cls, title, body) {
    const d = el('details', cls);
    const dc = el('div', 'dc');
    const sum = el('summary', null, title);
    dc.append(body);
    d.append(sum, dc);
    sum.addEventListener('click', e => { e.preventDefault(); toggle(d, dc); });
    dc.addEventListener('transitionend', e => {
      if (e.target !== dc || e.propertyName !== 'height') return;
      clearTimeout(d._settle);
      settle(d, dc);
    });
    return d;
  }

  // ---- items ---------------------------------------------------------------
  function render(v) {
    switch (v.kind) {
      case 'user': { const d = el('div', 'u'); d.innerHTML = v.html; return d; }
      case 'assistant': { const d = el('div', 'a'); d.innerHTML = v.html; enhanceTables(d); return d; }
      case 'tool': {
        const d = el('div', v.done ? 'tool done' : 'tool');
        d.append(el('b', null, v.name), v.summary ? ' ' + v.summary : '');
        return d;
      }
      case 'toolResult': {
        const first = v.text.split('\n').find(l => l.trim()) || 'result';
        return collapsible(v.error ? 'res err' : 'res', (v.error ? 'error · ' : 'result · ') + first.slice(0, 120),
          el('pre', null, v.text + (v.more ? `\n… ${v.more} more characters` : '')));
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
        return collapsible('note', v.title, el('pre', null, v.text));
      }
    }
    return el('div');
  }

  function onItems(m) {
    const stick = m.reset || atBottom();
    if (m.reset) { list.replaceChildren(); holders.clear(); }
    const frag = document.createDocumentFragment();
    for (const v of m.items) frag.append(render(v));
    if (m.prepend) {
      const before = chat.scrollHeight;
      list.prepend(frag);
      chat.scrollTop += chat.scrollHeight - before;
    } else {
      list.append(frag);
      if (stick) chat.scrollTop = chat.scrollHeight;
    }
    earlier.hidden = !m.hasEarlier;
    if (!list.children.length) list.append(el('div', 'empty', emptyText()));
    else list.querySelector('.empty')?.remove();
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
    const h = m.header;
    const row = el('div', 'hd');
    const ag = el('span', 'ag');
    ag.append(el('span', 'badge', h.letter), h.agent);
    row.append(ag);
    const model = [h.model, h.effort].filter(Boolean).join(' · ');
    if (model) row.append(el('span', 'm', model));
    const meters = [h.ctx && meter('ctx', h.ctx, 'ctx'), h.five && meter('5h', h.five), h.week && meter('wk', h.week)].filter(Boolean);
    if (meters.length) row.append(el('span', 'sep', '|'), ...meters);
    if (m.busy) row.append(el('span', 'busy', '● working…'));
    const seg = el('span', 'seg');
    const term = el('button', null, 'Terminal');
    term.title = 'Show this session’s terminal';
    term.onclick = () => vscode.postMessage({ type: 'terminal' });
    seg.append(term, el('button', 'on', 'Panel'));
    const bg = el('button', 'bgtoggle', '◐');
    const NEXT = { editor: 'dark', dark: 'terminal', terminal: 'editor' }, NAME = { editor: 'VS Code editor', terminal: 'terminal background', dark: 'dark design' };
    const theme = NAME[m.theme] ? m.theme : 'editor';
    bg.title = `Look: ${NAME[theme]} (click: ${NAME[NEXT[theme]]})`;
    bg.onclick = () => vscode.postMessage({ type: 'bg' });
    const right = el('span', 'right');
    right.append(bg, seg);
    document.body.classList.toggle('term', theme === 'terminal');
    document.body.classList.toggle('dark', theme === 'dark');
    row.append(right);
    ag.title = [h.title, h.repo].filter(Boolean).join(' · ');
    hd.replaceChildren(row);
    msg.placeholder = m.resumes ? `Sending resumes this session in a terminal, then types your message` : `Message ${h.agent} · Enter sends, Shift+Enter adds a line`;

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
    ro.hidden = m.canSend;
    $('rowhy').textContent = m.readOnlyReason || '';
    $('resume').hidden = !m.canResume;

    queueBox.replaceChildren(...(m.queue || []).map((text, i) => {
      const q = el('div', 'q');
      const x = el('button', 'x', '×');
      x.title = 'Cancel this message';
      x.onclick = () => vscode.postMessage({ type: 'cancel', index: i });
      q.append(el('span', null, 'queued · ' + text.replace(/\s+/g, ' ').slice(0, 100)), x);
      return q;
    }));
  }

  // ---- message box -----------------------------------------------------------
  const grow = () => { msg.style.height = 'auto'; msg.style.height = Math.min(msg.scrollHeight, 160) + 'px'; };
  function submit() {
    const paths = [...cards.values()].map(c => c.path).filter(Boolean);
    if (!msg.value.trim() && !paths.length) return;
    const text = [msg.value.trim(), ...paths].join(' ');
    cards.clear(); shots.replaceChildren(); shots.hidden = true;
    vscode.postMessage({ type: 'send', text });
    msg.value = '';
    grow();
  }
  msg.addEventListener('input', grow);
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
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  $('send').onclick = submit;
  $('answer').onclick = () => vscode.postMessage({ type: 'terminal' });
  $('resume').onclick = () => vscode.postMessage({ type: 'resume' });

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
    else if (m.type === 'state') onState(m);
    // The host would not type it (the terminal moved or closed meanwhile): give the text back.
    else if (m.type === 'rejected' && !msg.value.trim()) { msg.value = m.text; grow(); }
  });
  vscode.postMessage({ type: 'ready' });
})();
