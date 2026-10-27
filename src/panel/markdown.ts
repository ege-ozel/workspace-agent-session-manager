/** Small Markdown to HTML renderer for the Panel view. Transcript text is untrusted: everything is escaped first. */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s*>/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function renderMarkdown(md: string): string {
  return blocks(md.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').split('\n'));
}

const isTable = (lines: string[], i: number) =>
  lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && DELIM.test(lines[i + 1]);

const isBlockStart = (lines: string[], i: number) =>
  FENCE.test(lines[i]) || HEADING.test(lines[i]) || HR.test(lines[i]) || QUOTE.test(lines[i]) || ITEM.test(lines[i]) || isTable(lines, i);

function blocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    let m: RegExpExecArray | null;
    if (!l.trim()) { i++; continue; }
    if ((m = FENCE.exec(l))) {
      const [, fence, lang] = m;
      const body: string[] = [];
      for (i++; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.startsWith(fence[0].repeat(fence.length)) && !t.replace(new RegExp(`^\\${fence[0]}+`), '').trim()) { i++; break; }
        body.push(lines[i]);
      }
      out.push(`<pre><code${lang ? ` class="lang-${lang}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre>`);
    } else if ((m = HEADING.exec(l))) {
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
      i++;
    } else if (HR.test(l)) {
      out.push('<hr>');
      i++;
    } else if (QUOTE.test(l)) {
      const q: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) q.push(lines[i].replace(/^\s*> ?/, ''));
      out.push(`<blockquote>${blocks(q)}</blockquote>`);
    } else if (ITEM.test(l)) {
      i = list(lines, i, out);
    } else if (isTable(lines, i)) {
      i = table(lines, i, out);
    } else {
      const p = [l];
      for (i++; i < lines.length && lines[i].trim() && !isBlockStart(lines, i); i++) p.push(lines[i]);
      out.push(`<p>${p.map(inline).join('<br>')}</p>`);
    }
  }
  return out.join('\n');
}

interface Item { indent: number; ordered: boolean; num: number; text: string }

function list(lines: string[], i: number, out: string[]): number {
  const items: Item[] = [];
  for (; i < lines.length; i++) {
    const m = ITEM.exec(lines[i]);
    if (m) { items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), num: parseInt(m[2], 10), text: m[3] }); continue; }
    if (!lines[i].trim()) {
      // a blank line keeps the list going only if another item follows
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && ITEM.test(lines[j])) { i = j - 1; continue; }
      break;
    }
    if (/^\s/.test(lines[i]) && items.length) items[items.length - 1].text += '\n' + lines[i].trim();
    else break;
  }
  const pos = { i: 0 };
  while (pos.i < items.length) out.push(buildList(items, pos));
  return i;
}

function buildList(items: Item[], pos: { i: number }): string {
  const base = items[pos.i];
  const tag = base.ordered ? 'ol' : 'ul';
  let h = `<${tag}${base.ordered && base.num !== 1 ? ` start="${base.num}"` : ''}>`;
  while (pos.i < items.length && items[pos.i].indent >= base.indent && !(items[pos.i].indent === base.indent && items[pos.i].ordered !== base.ordered)) {
    const it = items[pos.i++];
    h += `<li>${it.text.split('\n').map(inline).join('<br>')}`;
    if (pos.i < items.length && items[pos.i].indent > base.indent) h += buildList(items, pos);
    h += '</li>';
  }
  return h + `</${tag}>`;
}

/** Cells of one table row. `\|` is a literal pipe; pipes inside `code` do not split. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let open = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '|') { cur += '|'; i++; }
    else if (c === '`') {
      let n = 1;
      while (line[i + n] === '`') n++;
      open = !open ? n : open === n ? 0 : open;
      cur += '`'.repeat(n);
      i += n - 1;
    } else if (c === '|' && !open) { cells.push(cur); cur = ''; }
    else cur += c;
  }
  cells.push(cur);
  if (line.trim().startsWith('|')) cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '' && line.trim().endsWith('|')) cells.pop();
  return cells.map(c => c.trim());
}

function table(lines: string[], i: number, out: string[]): number {
  const head = splitRow(lines[i]);
  const align = splitRow(lines[i + 1]).map(c => (c.startsWith(':') ? (c.endsWith(':') ? 'center' : 'left') : c.endsWith(':') ? 'right' : ''));
  const cols = Math.max(head.length, 1);
  const cell = (tag: string, text: string | undefined, k: number) =>
    `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(text ?? '')}</${tag}>`;
  const row = (tag: string, cells: string[]) => `<tr>${Array.from({ length: cols }, (_, k) => cell(tag, cells[k], k)).join('')}</tr>`;
  const body: string[] = [];
  for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) body.push(row('td', splitRow(lines[i])));
  out.push(`<div class="tbl"><table><thead>${row('th', head)}</thead><tbody>${body.join('')}</tbody></table></div>`);
  return i;
}

/** Inline pass on raw text: code spans first, then escape, then links / emphasis. */
function inline(s: string): string {
  const stash: string[] = [];
  const keep = (h: string) => `\u0000${stash.push(h) - 1}\u0000`;
  let t = s.replace(/(`+)(.+?)\1(?!`)/g, (_, _q, c) => keep(`<code>${escapeHtml(c)}</code>`));
  t = escapeHtml(t).replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_, label, url) =>
    /^https?:\/\//i.test(url) ? keep(`<a href="${url}">${emphasis(label)}</a>`) : emphasis(label));
  t = emphasis(t);
  while (/\u0000\d+\u0000/.test(t)) t = t.replace(/\u0000(\d+)\u0000/g, (_, n) => stash[+n]);
  return t;
}

function emphasis(t: string): string {
  return t
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>');
}
