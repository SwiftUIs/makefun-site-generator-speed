// Fast drop-in for makefun-site 1.0.0.
// Reimplemented from the reference behaviour (README + reference code):
// front matter, template dialect, Markdown subset, slug rule and report.
// Optimisations vs the reference: direct block rendering (no token
// objects), a single-pass inline scanner that escapes whole plain runs
// at once instead of one character at a time, per-case slug/date caches,
// template rendering into one string-builder array, and cards/pages
// built once per source and reused by every list that shows them.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i); };

// ---------- text ----------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/;
const ESC_G = /[&<>"']/g;
function escapeHtml(s) { return ESC_RE.test(s) ? s.replace(ESC_G, (c) => ESC[c]) : s; }
function pushEscaped(out, s) { out.push(s.replace(ESC_G, (c) => ESC[c])); }

const SLUG_MAX = 64;
function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  // Fast path: every char is ASCII. NFKD leaves ASCII unchanged, so the
  // loop below is exactly the reference slug for such text.
  let out = '';
  let gap = false;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 127) { ascii = false; break; }
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  let result;
  if (ascii) {
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    result = out === '' ? 'untitled' : out;
  } else {
    result = slugifySlow(text);
  }
  cache.set(text, result);
  return result;
}
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}
function longDate(date, cache) {
  let hit = cache.get(date);
  if (hit === undefined) {
    hit = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    cache.set(date, hit);
  }
  return hit;
}

// ---------- front matter ----------
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}
function fmValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringOf(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    const m = FM_DATE.exec(raw);
    const y = m ? Number(m[1]) : 0;
    const mo = m ? Number(m[2]) : 0;
    const d = m ? Number(m[3]) : 0;
    if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    return { value: tags };
  }
  if (key === 'draft') return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
  if (key === 'layout') return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  // slug
  return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
}
// lines: text split on '\n'. Returns {data, bodyStart} or {error}.
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { close = i; break; }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (line === '' || /^[ \t]*$/.test(line) || line[0] === '#') continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------- Markdown ----------
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;
const WS_RE = /\s/;

// The first index >= from where `what` occurs outside a backslash
// escape, or -1. A candidate is escaped exactly when the run of
// backslashes immediately before it is odd (they pair up left to
// right, the last one escaping the character after it).
function findUnescaped(s, what, from, end) {
  let j = s.indexOf(what, from);
  while (j !== -1 && j + what.length <= end) {
    let k = j - 1;
    let cnt = 0;
    while (k >= from && s[k] === '\\') { cnt++; k--; }
    if (cnt % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}
// The first single * from `from` (one whose run is not **), outside
// an escape, or -1.
function findSingleStar(s, from, end) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < end) {
    let k = j - 1;
    let cnt = 0;
    while (k >= from && s[k] === '\\') { cnt++; k--; }
    if (cnt % 2 === 1) { j = s.indexOf('*', j + 1); continue; }
    if (s[j + 1] === '*') { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}
// Render inline text s[start..end) into out (array of strings).
// Plain segments are pushed as-is: any & < > " ' is handled in this loop
// as soon as it is met, so a segment never holds one.
const SPECIAL_RE = /[\\`*\[&<>"']/g;
// Render inline text s[start..end) into out. The next special character
// is found by one native regex scan (not a per-character JS loop); plain
// runs between specials hold no escape character, so they are pushed
// as-is. SPECIAL_RE.lastIndex is saved/restored around recursion.
function inlineRange(s, start, end, link, out) {
  const saved = SPECIAL_RE.lastIndex;
  SPECIAL_RE.lastIndex = start;
  let seg = start;
  for (;;) {
    const m = SPECIAL_RE.exec(s);
    if (m === null || m.index >= end) break;
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) { // & < > " '
      if (seg < j) out.push(s.slice(seg, j));
      out.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
      seg = j + 1;
      SPECIAL_RE.lastIndex = seg;
      continue;
    }
    if (c === 92) { // backslash
      if (j + 1 < end && ESCAPABLE.has(s[j + 1])) {
        if (seg < j) out.push(s.slice(seg, j));
        out.push(s[j + 1]);
        seg = j + 2;
        SPECIAL_RE.lastIndex = seg;
      } else {
        SPECIAL_RE.lastIndex = j + 1;
      }
      continue;
    }
    if (c === 96) { // backtick
      const close = s.indexOf('`', j + 1);
      if (close !== -1 && close < end && close > j + 1) {
        if (seg < j) out.push(s.slice(seg, j));
        out.push('<code>', escapeHtml(s.slice(j + 1, close)), '</code>');
        seg = close + 1;
        SPECIAL_RE.lastIndex = seg;
      } else {
        SPECIAL_RE.lastIndex = j + 1;
      }
      continue;
    }
    if (c === 42) { // *
      if (j + 1 < end && s[j + 1] === '*') {
        const close = findUnescaped(s, '**', j + 2, end);
        if (close > j + 2) {
          if (seg < j) out.push(s.slice(seg, j));
          out.push('<strong>');
          inlineRange(s, j + 2, close, link, out);
          out.push('</strong>');
          seg = close + 2;
          SPECIAL_RE.lastIndex = seg;
        } else {
          SPECIAL_RE.lastIndex = j + 2;
        }
      } else {
        const close = findSingleStar(s, j + 1, end);
        if (close > j + 1) {
          if (seg < j) out.push(s.slice(seg, j));
          out.push('<em>');
          inlineRange(s, j + 1, close, link, out);
          out.push('</em>');
          seg = close + 1;
          SPECIAL_RE.lastIndex = seg;
        } else {
          SPECIAL_RE.lastIndex = j + 1;
        }
      }
      continue;
    }
    // [ 
    const k = findUnescaped(s, ']', j + 1, end);
    if (k !== -1 && k + 1 < end && s[k + 1] === '(') {
      const mm = s.indexOf(')', k + 2);
      if (mm !== -1 && mm < end) {
        const target = s.slice(k + 2, mm);
        if (target !== '' && !WS_RE.test(target)) {
          if (seg < j) out.push(s.slice(seg, j));
          out.push('<a href="', link(target), '">');
          inlineRange(s, j + 1, k, link, out);
          out.push('</a>');
          seg = mm + 1;
          SPECIAL_RE.lastIndex = seg;
          continue;
        }
      }
    }
    SPECIAL_RE.lastIndex = j + 1;
  }
  if (seg < end) out.push(s.slice(seg, end));
  SPECIAL_RE.lastIndex = saved;
}
function inlineStr(s, link) {
  const out = [];
  inlineRange(s, 0, s.length, link, out);
  return out.join('');
}
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}
function isBlank(line) {
  for (let i = 0; i < line.length; i++) { const c = line[i]; if (c !== ' ' && c !== '\t') return false; }
  return true;
}
function endsParagraph(line) {
  if (line === '' || isBlank(line)) return true;
  const c = line.charCodeAt(0);
  if (c === 96) return FENCE_OPEN.test(line); // backtick
  if (c === 35) { const m = HEADING_RE.exec(line); return m !== null && m[2] !== ''; } // #
  if (c === 45 || c === 42) return HR_RE.test(line); // - *
  return false;
}
// Count words (runs of non-whitespace) in one line; unicode spaces handled.
// Single pass: the previous version first scanned the whole line with a
// non-ASCII regex and then looped again, so every line was scanned twice.
function countWordsLine(line) {
  let n = 0;
  let inW = false;
  for (let i = 0; i < line.length; i++) {
    const cc = line.charCodeAt(i);
    let ws;
    if (cc <= 32) ws = true;
    else if (cc < 128) ws = false;
    else ws = cc === 0xA0 || cc === 0x1680 || (cc >= 0x2000 && cc <= 0x200A) || cc === 0x2028 || cc === 0x2029 || cc === 0x202F || cc === 0x205F || cc === 0x3000 || cc === 0xFEFF || cc === 0x85;
    if (ws) inW = false;
    else if (!inW) { inW = true; n++; }
  }
  return n;
}
// Render body lines[start..] directly, no token array, writing into
// one htmlParts array for the whole page (no per-block temp arrays,
// except the first paragraph, whose inline HTML is also the excerpt,
// and headings, whose inline HTML is also the toc entry).
function renderMarkdown(lines, start, link, slugCache) {
  const ids = new Set();
  const htmlParts = [];
  const toc = [];
  let excerpt = null;
  let words = 0;
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const first = line.charCodeAt(0);
    // fence
    if (first === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        words += countWordsLine(line);
        const lang = fence[1];
        const body = [];
        i++;
        while (i < n && !FENCE_CLOSE.test(lines[i])) { words += countWordsLine(lines[i]); body.push(lines[i++]); }
        if (i < n) { words += countWordsLine(lines[i]); i++; } // the close line, a word itself
        else i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        htmlParts.push(`<pre><code${cls}>`);
        for (const l of body) { htmlParts.push(escapeHtml(l), '\n'); }
        htmlParts.push('</code></pre>', '\n');
        continue;
      }
    }
    // heading
    if (first === 35) {
      const m = HEADING_RE.exec(line);
      if (m !== null && m[2] !== '') {
        words += countWordsLine(line);
        const depth = m[1].length;
        const text = m[2];
        const id = uniqueSlug(slugify(text, slugCache), ids);
        const html = inlineStr(text, link);
        htmlParts.push(`<h${depth} id="${id}">`, html, `</h${depth}>`, '\n');
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
        i++;
        continue;
      }
    }
    // thematic break
    if ((first === 45 || first === 42) && HR_RE.test(line)) { words += countWordsLine(line); htmlParts.push('<hr>', '\n'); i++; continue; }
    // blockquote
    if (first === 62) { // >
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        words += countWordsLine(l);
        const stripped = l[1] === ' ' ? l.slice(2) : l.slice(1);
        body.push(trimLine(stripped));
      }
      const kept = body.filter((l) => l !== '');
      if (kept.length === 0) htmlParts.push('<blockquote>\n</blockquote>', '\n');
      else { const text = kept.join('\n'); htmlParts.push('<blockquote>\n<p>'); inlineRange(text, 0, text.length, link, htmlParts); htmlParts.push('</p>\n</blockquote>', '\n'); }
      continue;
    }
    // list
    if (first === 45 || first === 42 || (first >= 48 && first <= 57)) {
      const bullet = BULLET_RE.exec(line);
      const ordered = bullet === null ? ORDERED_RE.exec(line) : null;
      if (bullet !== null || ordered !== null) {
        const isOrdered = ordered !== null;
        const marker = isOrdered ? ORDERED_RE : BULLET_RE;
        const items = [];
        while (i < n) {
          const mm = marker.exec(lines[i]);
          if (mm !== null) {
            words += countWordsLine(lines[i]);
            items.push([trimLine(isOrdered ? mm[2] : mm[1])]);
            i++;
          } else if (CONTINUED_RE.test(lines[i])) {
            words += countWordsLine(lines[i]);
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && Number(ordered[1]) !== 1 ? `<ol start="${Number(ordered[1])}">` : `<${tag}>`;
        htmlParts.push(`${open}\n`);
        for (const parts of items) {
          const text = parts.join('\n');
          htmlParts.push('<li>');
          inlineRange(text, 0, text.length, link, htmlParts);
          htmlParts.push('</li>\n');
        }
        htmlParts.push(`</${tag}>`, '\n');
        continue;
      }
    }
    // paragraph
    {
      words += countWordsLine(line);
      const body = [trimLine(line)];
      i++;
      while (i < n && !endsParagraph(lines[i])) { words += countWordsLine(lines[i]); body.push(trimLine(lines[i++])); }
      const text = body.join('\n');
      if (excerpt === null) {
        const html = inlineStr(text, link);
        excerpt = html;
        htmlParts.push('<p>', html, '</p>', '\n');
      } else {
        htmlParts.push('<p>');
        inlineRange(text, 0, text.length, link, htmlParts);
        htmlParts.push('</p>', '\n');
      }
    }
  }
  return { html: htmlParts.join(''), toc, excerpt: excerpt ?? '', words };
}

// ---------- templates ----------
class TemplateError extends Error {}
const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node); stack.push(node); body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node); stack.push(node); body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = []; body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}
// Flat scope: one vars object per render, loop variables mutated in
// place and restored after the loop. A missing first name reads as
// undefined, exactly like the scope-chain lookup in the reference.
function lookup(vars, path) {
  let v = vars[path[0]];
  if (v === undefined) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}
function renderNodes(nodes, vars, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    if (n.kind === 'text') { out.push(n.text); continue; }
    if (n.kind === 'var') {
      const v = lookup(vars, n.path);
      if (v === undefined || v === null || v === '' || v === false || v === 0) continue;
      if (typeof v === 'string') {
        const e = ctx.escCache.get(v);
        if (e !== undefined) { out.push(e); continue; }
        const e2 = escapeHtml(v);
        ctx.escCache.set(v, e2);
        out.push(e2);
        continue;
      }
      if (typeof v === 'number') { out.push(String(v)); continue; }
      if (typeof v === 'boolean') { out.push('true'); continue; }
      const t = textOf(v);
      if (t !== '') pushEscaped(out, t);
      continue;
    }
    if (n.kind === 'raw') { out.push(textOf(lookup(vars, n.path))); continue; }
    if (n.kind === 'if') {
      const v = truthy(lookup(vars, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch !== null) renderNodes(branch, vars, ctx, depth, out);
      continue;
    }
    if (n.kind === 'for') {
      const xs = lookup(vars, n.path);
      if (!Array.isArray(xs)) continue;
      const hadName = Object.hasOwn(vars, n.name);
      const prevName = vars[n.name];
      const prevLoop = vars.loop;
      const hadLoop = Object.hasOwn(vars, 'loop');
      const loop = { index: 1, first: true, last: false, length: xs.length };
      for (let k = 0; k < xs.length; k++) {
        vars[n.name] = xs[k];
        vars.loop = loop; // after the element: if the element is itself named 'loop', the loop record wins, as in the reference's object literal
        loop.index = k + 1; loop.first = k === 0; loop.last = k === xs.length - 1;
        renderNodes(n.body, vars, ctx, depth, out);
      }
      if (hadName) vars[n.name] = prevName; else delete vars[n.name];
      if (hadLoop) vars.loop = prevLoop; else delete vars.loop;
      continue;
    }
    // include: a template that only reads site/tags/recent is rendered
    // once per case and reused (its output cannot vary by page).
    if (depth < 8) {
      const cached = ctx.constCache.get(n.name);
      if (cached !== undefined) { out.push(cached); continue; }
    }
    const t = ctx.templates.get(n.name);
    if (t !== undefined && depth < 8) renderNodes(t, vars, ctx, depth + 1, out);
  }
}

// Whether a template's output can only depend on site/tags/recent
// (plus loop variables bound from those): if so it is rendered once
// per case and reused for every page. A template that reads page,
// posts, pager, tag, or a caller's loop variable is not constant.
// Cycles are treated as not constant.
function nodesConstant(nodes, allowed, templates, memo, visiting) {
  for (const n of nodes) {
    if (n.kind === 'text') continue;
    if (n.kind === 'var' || n.kind === 'raw') { if (!allowed.has(n.path[0])) return false; continue; }
    if (n.kind === 'if') {
      if (!allowed.has(n.path[0])) return false;
      if (!nodesConstant(n.then, allowed, templates, memo, visiting)) return false;
      if (n.else !== null && !nodesConstant(n.else, allowed, templates, memo, visiting)) return false;
      continue;
    }
    if (n.kind === 'for') {
      if (!allowed.has(n.path[0])) return false;
      const inner = new Set(allowed);
      inner.add(n.name);
      inner.add('loop');
      if (!nodesConstant(n.body, inner, templates, memo, visiting)) return false;
      continue;
    }
    // include
    if (!templateIsConstant(n.name, templates, memo, visiting)) return false;
  }
  return true;
}
function templateIsConstant(name, templates, memo, visiting) {
  if (memo.has(name)) return memo.get(name);
  if (visiting.has(name)) return false;
  const nodes = templates.get(name);
  if (nodes === undefined) return true;
  visiting.add(name);
  const ok = nodesConstant(nodes, new Set(['site', 'tags', 'recent']), templates, memo, visiting);
  visiting.delete(name);
  memo.set(name, ok);
  return ok;
}

// ---------- build ----------
function resolvePath(dir, rel) {
  if (rel.indexOf('..') === -1 && rel.indexOf('./') === -1 && rel.indexOf('//') === -1) return dir === '' ? rel : `${dir}/${rel}`;
  let out = dir;
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out === '') return null;
      const cut = out.lastIndexOf('/');
      out = cut === -1 ? '' : out.slice(0, cut);
    } else out = out === '' ? seg : `${out}/${seg}`;
  }
  return out;
}

export function run(input) {
  const slugCache = new Map();
  const dateCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try { templates.set(name, parseTemplate(name, input.templates[name])); }
    catch (err) { if (!(err instanceof TemplateError)) throw err; report.push(err.message); }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      const lines = text.split('\n');
      const fm = parseFrontMatter(lines);
      if ('error' in fm) { report.push(`refused ${f.path}: ${fm.error}`); continue; }
      const s = { path: f.path, lines, bodyStart: fm.bodyStart, data: fm.data, post: f.path.startsWith('posts/') };
      const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
      if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
      if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
      s.layout = layout;
      if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
      sources.push(s);
    } else statics.push({ path: f.path, content: f.content });
  }
  // permalinks
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (!set) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  // markdown
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const hrefCache = new Map();
    // Returns the href already HTML-escaped (inlineRange pushes it as-is).
    const link = (target) => {
      const hit = hrefCache.get(target);
      if (hit !== undefined) return hit;
      let resolved;
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target[0] === '/' || target[0] === '#') resolved = target;
      else {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) resolved = `${bySource.get(path).url}${frag}`;
        else if (path !== null && staticPaths.has(path)) resolved = `${base}/${path}${frag}`;
        else { broken.add(`broken-link ${s.path} -> ${target}`); resolved = target; }
      }
      const esc = escapeHtml(resolved);
      hrefCache.set(target, esc);
      return esc;
    };
    const md = renderMarkdown(s.lines, s.bodyStart, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }
  // collections
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => { p.newer = k === 0 ? null : posts[k - 1]; p.older = k === posts.length - 1 ? null : posts[k + 1]; });
  // tags
  const bySlug = new Map();
  const ownTagList = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name, slug });
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTagList(p)) {
      let tag = bySlug.get(slug);
      if (!tag) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTagList(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  // cards / pages (built once, reused)
  const linkOf = (s) => s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache) };
  for (const s of sources) {
    const tagCards = s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url }));
    const dateLong = s.data.date === undefined ? '' : longDate(s.data.date, dateCache);
    s.card = {
      title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: dateLong,
      summary: s.data.summary ?? '', excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.words / 200)), tags: tagCards,
    };
    s.page = {
      title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: dateLong,
      summary: s.data.summary ?? '', excerpt: s.excerpt,
      reading_minutes: s.card.reading_minutes, tags: tagCards,
      slug: s.slug, content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null), older: linkOf(s.older ?? null), is_post: s.post,
    };
  }
  // layouts
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const ctx = { templates, escCache: new Map(), constCache: new Map() };
  {
    const memo = new Map();
    for (const name of templates.keys()) {
      if (templateIsConstant(name, templates, memo, new Set())) {
        const out = [];
        renderNodes(templates.get(name), { site, tags: allTags, recent }, ctx, 0, out);
        ctx.constCache.set(name, out.join(''));
      }
    }
  }
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { site, tags: allTags, recent, ...vars }, ctx, 0, out);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: s.page });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
