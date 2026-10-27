// Panel view webview. The host sends already-escaped HTML for message text; everything else is set with textContent.
(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const chat = $('chat'), list = $('items'), earlier = $('earlier'), hd = $('hd'), ov = $('ov'), ovbox = $('ovbox');
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const atBottom = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;

  // ---- enlarged view -------------------------------------------------------
  const closeOv = () => { ov.hidden = true; ovbox.replaceChildren(); };
  function openOv(node, hint) {
    ovbox.replaceChildren(node, el('div', 'hint', hint));
    ov.hidden = false;
  }
  ov.addEventListener('click', e => { if (e.target === ov) closeOv(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeOv(); });

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
      big.onclick = closeOv;
      openOv(big, 'Click the image or outside it to close');
    };
    ph.replaceWith(img);
    holders.delete(ref);
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
        const d = el('details', v.error ? 'res err' : 'res');
        const first = v.text.split('\n').find(l => l.trim()) || 'result';
        d.append(el('summary', null, (v.error ? 'error · ' : 'result · ') + first.slice(0, 120)),
          el('pre', null, v.text + (v.more ? `\n… ${v.more} more characters` : '')));
        return d;
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
        const d = el('details', 'note');
        d.append(el('summary', null, v.title), el('pre', null, v.text));
        return d;
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
    if (!list.children.length) list.append(el('div', 'empty', 'No messages yet.'));
    else list.querySelector('.empty')?.remove();
  }

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
    const right = el('span', 'right');
    right.append(seg);
    row.append(right);
    hd.replaceChildren(row, el('div', 'sub', [h.title, h.repo].filter(Boolean).join(' · ')));
  }

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
    else if (m.type === 'state') onState(m);
  });
  vscode.postMessage({ type: 'ready' });
})();
