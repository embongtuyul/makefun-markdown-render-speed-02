// parse.js — from-scratch CommonMark 0.31.2 + GFM renderer.
//
// A fast drop-in replacement for marked (defaults: gfm on, breaks off).
// Written from the CommonMark spec and black-box probing of marked's output;
// no marked source was read or copied. Dependency-free ES module.
//
// export: parse(markdown) -> string (HTML, exactly marked.parse's output)

// ---------------------------------------------------------------- utilities

const SPACE = 32, TAB = 9, LF = 10, CR = 13, FF = 12, VT = 11;

function isSpaceCode(c) {
  return c === SPACE || c === TAB || c === LF || c === CR || c === FF || c === VT;
}
function isDigitCode(c) { return c >= 48 && c <= 57; }
function lowerCode(c) { return c >= 65 && c <= 90 ? c + 32 : c; }
function isAlphaCode(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isAlnumCode(c) { return isAlphaCode(c) || isDigitCode(c); }
function isAsciiPunctCode(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

// Unicode punctuation test (for emphasis flanking). ASCII is fast-pathed.
// CommonMark punctuation is Unicode P + S (symbols like £/€ count).
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
function isPunctCode(c) {
  if (c < 128) return isAsciiPunctCode(c);
  return UNICODE_PUNCT.test(String.fromCodePoint(c));
}
function isWhitespaceCode(c) {
  // Unicode whitespace for flanking: ASCII set + NBSP etc. via regex fallback.
  if (c < 128) return isSpaceCode(c);
  return /\s/u.test(String.fromCodePoint(c));
}

// ---------------------------------------------------------------- entities
//
// marked's rules (probed): a named entity is & + [A-Za-z0-9_]+ + ';' and is
// passed through verbatim (NOT validated against the HTML5 list). A numeric
// entity is &# + 1-7 decimal digits + ';' or &#x + 1-6 hex digits + ';' and
// is decoded to the code point (0, surrogates and >0x10FFFF become U+FFFD),
// then re-escaped for HTML. Longer digit runs are not entities at all.

// Try to read an entity starting at s[i] === '&'. Returns {end, text}
// where text is the replacement output (already HTML-safe), or null.
function readEntity(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 35) { // '#'
    let j = i + 2;
    let hex = false;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { // x|X
      hex = true; j++;
    }
    const d0 = j;
    let val = 0;
    let digits = 0;
    if (hex) {
      while (j < n) {
        const c = s.charCodeAt(j);
        let d = -1;
        if (c >= 48 && c <= 57) d = c - 48;
        else if (c >= 97 && c <= 102) d = c - 87;
        else if (c >= 65 && c <= 70) d = c - 55;
        else break;
        if (digits >= 6) return null; // 7+ hex digits: not an entity
        val = val * 16 + d;
        digits++; j++;
      }
    } else {
      while (j < n) {
        const c = s.charCodeAt(j);
        if (c < 48 || c > 57) break;
        if (digits >= 7) return null; // 8+ decimal digits: not an entity
        val = val * 10 + (c - 48);
        digits++; j++;
      }
    }
    if (digits === 0 || j >= n || s.charCodeAt(j) !== 59) return null; // need ';'
    if (val === 0 || val > 0x10FFFF || (val >= 0xD800 && val <= 0xDFFF)) {
      return { end: j + 1, text: '\uFFFD' };
    }
    const ch = String.fromCodePoint(val);
    return { end: j + 1, text: escapeHtmlChar(ch) };
  }
  // Named entity: & + [A-Za-z0-9_]+ + ';' — passed through verbatim.
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isAlnumCode(c) || c === 95) { j++; continue; }
    break;
  }
  if (j === i + 1 || j >= n || s.charCodeAt(j) !== 59) return null;
  return { end: j + 1, text: s.slice(i, j + 1) };
}

// Escape a single decoded character for HTML output.
function escapeHtmlChar(ch) {
  switch (ch) {
    case '&': return '&amp;';
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '"': return '&quot;';
    case "'": return '&#39;';
    default: return ch;
  }
}

// Escape text for HTML (used for code blocks, titles, and plain text nodes
// that were not entity-scanned). '&' is escaped unless it begins an entity.
function escapeHtml(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { // '&'
      const e = readEntity(s, i);
      if (e) {
        out += s.slice(start, i) + e.text;
        i = e.end - 1;
        start = i + 1;
        continue;
      }
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return out + s.slice(start);
}

// ---------------------------------------------------------------- href encoding
//
// Percent-encode for href/src attributes. Entities (named or numeric) pass
// through verbatim; a bare & becomes &amp;; ' becomes &#39;; space, ", <, >,
// backtick, [, ], {, }, ^, |, backslash, controls and non-ASCII are
// percent-encoded (UTF-8); everything else (including %) is kept as-is.

const HREF_ENCODE = new Uint8Array(128);
(function initHrefEncode() {
  const chars = ' "<>`[]{}^|\\';
  for (let k = 0; k < chars.length; k++) HREF_ENCODE[chars.charCodeAt(k)] = 1;
  for (let k = 0; k < 32; k++) HREF_ENCODE[k] = 1;
  HREF_ENCODE[127] = 1;
})();

const HEX = '0123456789ABCDEF';
function encodeHref(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { // '&': entity passes through, bare & -> &amp;
      const e = readEntity(s, i);
      if (e) {
        // Numeric entities also pass through verbatim in hrefs.
        out += s.slice(start, i) + s.slice(i, e.end);
        i = e.end - 1;
        start = i + 1;
        continue;
      }
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else if (c === 39) { // '
      out += s.slice(start, i) + '&#39;';
      start = i + 1;
    } else if (c < 128) {
      if (HREF_ENCODE[c]) {
        out += s.slice(start, i) + '%' + HEX[c >> 4] + HEX[c & 15];
        start = i + 1;
      }
    } else {
      // Non-ASCII: UTF-8 percent-encoding.
      let cp = c;
      let len = 1;
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        const c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
          len = 2;
        }
      }
      out += s.slice(start, i);
      if (cp < 0x800) {
        const b1 = 0xC0 | (cp >> 6), b2 = 0x80 | (cp & 63);
        out += '%' + HEX[b1 >> 4] + HEX[b1 & 15] + '%' + HEX[b2 >> 4] + HEX[b2 & 15];
      } else if (cp < 0x10000) {
        const b1 = 0xE0 | (cp >> 12), b2 = 0x80 | ((cp >> 6) & 63), b3 = 0x80 | (cp & 63);
        out += '%' + HEX[b1 >> 4] + HEX[b1 & 15] + '%' + HEX[b2 >> 4] + HEX[b2 & 15] +
          '%' + HEX[b3 >> 4] + HEX[b3 & 15];
      } else {
        const b1 = 0xF0 | (cp >> 18), b2 = 0x80 | ((cp >> 12) & 63),
          b3 = 0x80 | ((cp >> 6) & 63), b4 = 0x80 | (cp & 63);
        out += '%' + HEX[b1 >> 4] + HEX[b1 & 15] + '%' + HEX[b2 >> 4] + HEX[b2 & 15] +
          '%' + HEX[b3 >> 4] + HEX[b3 & 15] + '%' + HEX[b4 >> 4] + HEX[b4 & 15];
      }
      i += len - 1;
      start = i + 1;
    }
  }
  return out + s.slice(start);
}

// Normalize a link label: collapse whitespace runs to one space, trim,
// lowercase (CommonMark label normalization). Unicode case folding
// maps ß (and ẞ, via lowercase) to "ss".
function normalizeLabel(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// Unescape backslash escapes in a link destination or title:
// backslash + ASCII punct -> the punct; anything else stays.
function unescapeBackslashes(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length &&
      isAsciiPunctCode(s.charCodeAt(i + 1))) {
      out += s.slice(start, i) + s[i + 1];
      i++;
      start = i + 1;
    }
  }
  return out + s.slice(start);
}

// ---------------------------------------------------------------- inline parsing
//
// Node types:
//  text: {t:'text', s}        raw source text (HTML-escaped at render)
//  raw:  {t:'raw', s}         already HTML-safe (entities)
//  code: {t:'code', s}        code span content
//  br:   {t:'br'}             hard break
//  html: {t:'html', s}        raw inline HTML
//  link: {t:'link', href, title, children}
//  image:{t:'image', src, alt, title}
//  em/strong/del: {t, children}

// Escape plain text (no entities present — they were resolved at scan time).
function escapeText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { out += s.slice(start, i) + '&amp;'; start = i + 1; }
    else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return out + s.slice(start);
}

// Escape a link title: entities (named AND numeric) pass through verbatim.
function escapeTitle(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const e = readEntity(s, i);
      if (e) {
        out += s.slice(start, i) + s.slice(i, e.end);
        i = e.end - 1;
        start = i + 1;
        continue;
      }
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return out + s.slice(start);
}

function renderInline(nodes) {
  let out = '';
  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
    switch (node.t) {
      case 'text': out += escapeText(node.s); break;
      case 'raw': out += node.s; break;
      case 'code': out += '<code>' + escapeText(node.s) + '</code>'; break;
      case 'br': out += '<br>'; break;
      case 'html': out += node.s; break;
      case 'link': {
        out += '<a href="' + encodeHref(node.href) + '"';
        if (node.title !== null && node.title !== undefined) {
          out += ' title="' + escapeTitle(node.title) + '"';
        }
        out += '>' + renderInline(node.children) + '</a>';
        break;
      }
      case 'image': {
        out += '<img src="' + encodeHref(node.src) + '" alt="' +
          escapeHtml(node.alt) + '"';
        if (node.title !== null && node.title !== undefined) {
          out += ' title="' + escapeTitle(node.title) + '"';
        }
        out += '>';
        break;
      }
      case 'em': out += '<em>' + renderInline(node.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInline(node.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderInline(node.children) + '</del>'; break;
    }
  }
  return out;
}

// Plain text of inline nodes (for image alt text). Formatting is stripped;
// br contributes nothing; a nested image contributes its alt.
function plainText(nodes) {
  let out = '';
  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
    switch (node.t) {
      case 'text': case 'raw': case 'code': case 'html': out += node.s; break;
      case 'br': break;
      case 'link': case 'em': case 'strong': case 'del':
        out += plainText(node.children);
        break;
      case 'image': out += node.alt; break;
    }
  }
  return out;
}

// Find the closing backtick run of exactly runLen backticks starting at j.
// Returns its index, or -1.
function findCodeClose(src, j, runLen) {
  const n = src.length;
  while (j < n) {
    if (src.charCodeAt(j) === 96) {
      let k = j;
      while (k < n && src.charCodeAt(k) === 96) k++;
      if (k - j === runLen) return j;
      j = k;
    } else {
      j++;
    }
  }
  return -1;
}

// Marked: a link does not form if its text has an ODD number of
// unpaired backtick runs (runs pair by equal length, left to right),
// or a code span holding a backtick that is not the last thing in
// the text (any character after such a span breaks it).
// Escaped backticks (\`) are literal text, not code delimiters.
function linkTextHasBadBackticks(text) {
  const n = text.length;
  let j = 0;
  let unpaired = 0;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 92 && j + 1 < n) { j += 2; continue; } // \-escape: skip both
    if (c === 96) {
      let m = j;
      while (m < n && text.charCodeAt(m) === 96) m++;
      const run = m - j;
      const close = findCodeClose(text, m, run);
      if (close === -1) {
        unpaired++;
        j = m;
        continue;
      }
      const inner = text.indexOf('`', m);
      if (inner !== -1 && inner < close && close + run < n) return true;
      j = close + run;
    } else {
      j++;
    }
  }
  return unpaired % 2 === 1;
}

// Does the text hold any unpaired backtick run (length-pairing, as
// above)? Used for the emphasis-suppression rule: a link whose text
// has unpaired backticks suppresses emphasis after it until the next
// code span.
function hasUnpairedBackticks(text) {
  const n = text.length;
  let j = 0;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 92 && j + 1 < n) { j += 2; continue; }
    if (c === 96) {
      let m = j;
      while (m < n && text.charCodeAt(m) === 96) m++;
      const run = m - j;
      const close = findCodeClose(text, m, run);
      if (close === -1) return true;
      j = close + run;
    } else {
      j++;
    }
  }
  return false;
}

// Find the LAST backtick run at or after `from` that forms a code
// span (has a matching closer). Returns its position, or -1.
// (The emphasis-suppression zone after a link with unpaired backticks
// runs to the last code span in the paragraph, not the first.)
function findLastCodeSpan(src, from) {
  const n = src.length;
  let j = from;
  let last = -1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92 && j + 1 < n) { j += 2; continue; }
    if (c === 96) {
      let m = j;
      while (m < n && src.charCodeAt(m) === 96) m++;
      const run = m - j;
      const close = findCodeClose(src, m, run);
      if (close !== -1) { last = j; j = close + run; }
      else j = m;
    } else {
      j++;
    }
  }
  return last;
}

// Trim the end of a scanned autolink URL (www/scheme). Removes trailing
// punctuation (.,;:?!'"*_~), unbalanced parens, and a trailing &name;
// entity. Returns the trimmed end index.
function trimAutolinkEnd(url, start, end) {
  let changed = true;
  while (changed) {
    changed = false;
    if (end === start) break;
    const c = url.charCodeAt(end - 1);
    // Trailing entity &name; (name = alnum only) is excluded as a whole.
    if (c === 59) {
      let j = end - 2;
      while (j >= start && isAlnumCode(url.charCodeAt(j))) j--;
      if (j >= start && url.charCodeAt(j) === 38 && j < end - 2) {
        end = j;
        changed = true;
        continue;
      }
    }
    if (c === 46 || c === 44 || c === 59 || c === 58 || c === 63 || c === 33 ||
      c === 39 || c === 34 || c === 42 || c === 95 || c === 126) {
      end--;
      changed = true;
      continue;
    }
    if (c === 41 || c === 40) {
      // A trailing '(' is always unclosed: trim it.
      if (c === 40) { end--; changed = true; continue; }
      // A trailing ')' is trimmed only if it has no matching '('
      // before it (an unmatched ')' earlier in the URL does not make
      // a matched trailing ')' trimmable).
      let depth = 0;
      for (let k = start; k < end - 1; k++) {
        const ch = url.charCodeAt(k);
        if (ch === 40) depth++;
        else if (ch === 41 && depth > 0) depth--;
      }
      if (depth === 0) { end--; changed = true; continue; }
    }
  }
  // An unclosed '(' in the middle (e.g. `https://a.com)](https://b.com`
  // where a space ends the URL before the paren closes) trims the URL
  // back to just before the first unclosed '('.
  let depth = 0, firstUnclosed = -1;
  for (let k = start; k < end; k++) {
    const ch = url.charCodeAt(k);
    if (ch === 40) { depth++; if (depth === 1 && firstUnclosed === -1) firstUnclosed = k; }
    else if (ch === 41 && depth > 0) { depth--; if (depth === 0) firstUnclosed = -1; }
  }
  if (depth > 0 && firstUnclosed !== -1) {
    return trimAutolinkEnd(url, start, firstUnclosed);
  }
  return end;
}

// Scan a www/scheme autolink URL starting at i (i points at 'w' or the
// scheme start). The URL runs to the first whitespace, '<' or '>'. Returns
// {end, text} (trimmed) or null if the URL part is empty.
function scanUrlAutolink(src, i, prefixLen, stopAtBracket) {
  const n = src.length;
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (isSpaceCode(c) || c === 60 || c === 62) break;
    if (stopAtBracket && c === 93) break; // ']' closes link text
    j++;
  }
  const end = trimAutolinkEnd(src, i, j);
  if (end <= i + prefixLen) return null;
  return { end, text: src.slice(i, end) };
}

// Is c a valid email local-part char? marked's set: [A-Za-z0-9._+-].
function isEmailLocalCode(c) {
  return isAlnumCode(c) || c === 46 || c === 95 || c === 43 || c === 45;
}
// Is c a valid email domain char? [A-Za-z0-9._-].
function isEmailDomainCode(c) {
  return isAlnumCode(c) || c === 46 || c === 95 || c === 45;
}

// Validate an email domain (the maximal [A-Za-z0-9._-]+ run, trailing dots
// stripped): must contain '.', no '..', must not start with '.', must end
// with an alnum. Returns the validated end index, or -1.
function validateEmailDomain(src, start, end) {
  let e = end;
  while (e > start && src.charCodeAt(e - 1) === 46) e--; // strip trailing dots
  if (e <= start) return -1;
  if (!isAlnumCode(src.charCodeAt(e - 1))) return -1; // must end alnum
  if (src.charCodeAt(start) === 46) return -1; // must not start with '.'
  let hasDot = false;
  for (let k = start; k < e; k++) {
    const c = src.charCodeAt(k);
    if (c === 46) {
      hasDot = true;
      if (k + 1 < e && src.charCodeAt(k + 1) === 46) return -1; // '..'
    }
  }
  if (!hasDot) return -1;
  return e;
}

// Is the char at pos escaped (preceded by an odd number of backslashes)?
function isEscaped(src, pos) {
  let bs = 0;
  let j = pos - 1;
  while (j >= 0 && src.charCodeAt(j) === 92) { bs++; j--; }
  return bs % 2 === 1;
}

// Try to match an email autolink at the '@' at position atPos. localStart
// is the earliest position the local part may start (the text-run start).
// Returns {start, end, text} or null.
// Can a '_' run at [runStart, runEnd) close emphasis? (Underscore rule:
// right-flanking, and either not left-flanking or preceded by punct.)
function underscoreCanClose(src, runStart, runEnd) {
  const before = runStart > 0 ? src[runStart - 1] : '';
  const after = runEnd < src.length ? src[runEnd] : '';
  const beforeWs = before === '' ? false : isSpaceCode(before.charCodeAt(0));
  const afterWs = after === '' ? false : isSpaceCode(after.charCodeAt(0));
  const beforePunct = before === '' ? false : UNICODE_PUNCT.test(before);
  const afterPunct = after === '' ? false : UNICODE_PUNCT.test(after);
  const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return rightFlanking && (!leftFlanking || beforePunct);
}

function tryEmailAt(src, atPos, localStart, hasUnderscoreOpener) {
  let ls = atPos;
  // An escaped char cannot be part of the local part.
  while (ls > localStart && isEmailLocalCode(src.charCodeAt(ls - 1)) &&
    !isEscaped(src, ls - 1)) ls--;
  if (ls === atPos) return null; // empty local part
  const n = src.length;
  let j = atPos + 1;
  while (j < n && isEmailDomainCode(src.charCodeAt(j))) {
    // A '_' run that can close emphasis (and has an opener waiting)
    // is an emphasis closer, not domain text: stop before it.
    if (hasUnderscoreOpener && src.charCodeAt(j) === 95) {
      let m = j;
      while (m < n && src.charCodeAt(m) === 95) m++;
      if (underscoreCanClose(src, j, m)) break;
      j = m;
      continue;
    }
    j++;
  }
  if (j === atPos + 1) return null;
  const domainEnd = validateEmailDomain(src, atPos + 1, j);
  if (domainEnd === -1) return null;
  return { start: ls, end: domainEnd, text: src.slice(ls, domainEnd) };
}

// Try to match an autolink or inline HTML tag starting at src[i] === '<'.
// Returns {end, node} or null.
function tryAngle(src, i) {
  const n = src.length;
  if (i + 1 >= n) return null;
  const c1 = src.charCodeAt(i + 1);
  // Comment <!-- ... -->
  if (c1 === 33) {
    if (src.startsWith('<!--', i)) {
      // <!--> and <!---> are complete comments on their own.
      if (src.startsWith('<!-->', i)) {
        return { end: i + 5, node: { t: 'html', s: '<!-->' } };
      }
      if (src.startsWith('<!--->', i)) {
        return { end: i + 6, node: { t: 'html', s: '<!--->' } };
      }
      const end = src.indexOf('-->', i + 4);
      if (end !== -1) return { end: end + 3, node: { t: 'html', s: src.slice(i, end + 3) } };
      return null;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      if (end !== -1) return { end: end + 3, node: { t: 'html', s: src.slice(i, end + 3) } };
      return null;
    }
    // Declaration <!A ... >
    if (i + 2 < n && isAlphaCode(src.charCodeAt(i + 2))) {
      const end = src.indexOf('>', i + 2);
      if (end !== -1) return { end: end + 1, node: { t: 'html', s: src.slice(i, end + 1) } };
    }
    return null;
  }
  // Processing instruction <? ... ?>
  if (c1 === 63) {
    const end = src.indexOf('?>', i + 2);
    if (end !== -1) return { end: end + 2, node: { t: 'html', s: src.slice(i, end + 2) } };
    return null;
  }
  // Closing tag </name>
  if (c1 === 47) {
    let j = i + 2;
    while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 ||
      src.charCodeAt(j) === 10 || src.charCodeAt(j) === 13)) j++;
    if (j < n && isAlphaCode(src.charCodeAt(j))) {
      j++;
      while (j < n && (isAlnumCode(src.charCodeAt(j)) || src.charCodeAt(j) === 45)) j++;
      while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 ||
        src.charCodeAt(j) === 10 || src.charCodeAt(j) === 13)) j++;
      if (j < n && src.charCodeAt(j) === 62) {
        return { end: j + 1, node: { t: 'html', s: src.slice(i, j + 1) } };
      }
    }
    return null;
  }
  if (!isAlphaCode(c1)) return null;
  // Scheme autolink: <scheme:...> — scheme is 2-32 chars.
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (isAlnumCode(c) || c === 43 || c === 46 || c === 45) j++;
    else break;
  }
  const schemeLen = j - (i + 1);
  if (schemeLen >= 2 && schemeLen <= 32 && j < n && src.charCodeAt(j) === 58) {
    let k = j + 1;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (isSpaceCode(c) || c === 60 || c === 62) break;
      k++;
    }
    if (k > j + 1 && k < n && src.charCodeAt(k) === 62) {
      const text = src.slice(i + 1, k);
      return {
        end: k + 1,
        node: { t: 'link', href: text, title: null, angle: true, children: [{ t: 'text', s: text }] },
      };
    }
    return null; // a ':' after a name means it can't be a tag either
  }
  // Email autolink: <local@domain>
  {
    let k = i + 1;
    while (k < n && isEmailLocalCode(src.charCodeAt(k))) k++;
    if (k > i + 1 && k < n && src.charCodeAt(k) === 64) {
      let d = k + 1;
      while (d < n && isEmailDomainCode(src.charCodeAt(d))) d++;
      const domainEnd = validateEmailDomain(src, k + 1, d);
      if (domainEnd !== -1 && domainEnd < n && src.charCodeAt(domainEnd) === 62) {
        const text = src.slice(i + 1, domainEnd);
        return {
          end: domainEnd + 1,
          node: { t: 'link', href: 'mailto:' + text, title: null, angle: true, children: [{ t: 'text', s: text }] },
        };
      }
    }
  }
  // Open tag <name ...> or <name ... />
  j = i + 1;
  while (j < n && (isAlnumCode(src.charCodeAt(j)) || src.charCodeAt(j) === 45)) j++;
  while (true) {
    // Skip whitespace (an attribute must be preceded by whitespace).
    let k = j;
    let ws = 0;
    while (k < n && isSpaceCode(src.charCodeAt(k))) { k++; ws++; }
    if (k >= n) return null;
    const c = src.charCodeAt(k);
    if (c === 62) { // '>'
      return { end: k + 1, node: { t: 'html', s: src.slice(i, k + 1) } };
    }
    if (c === 47 && k + 1 < n && src.charCodeAt(k + 1) === 62) { // '/>'
      return { end: k + 2, node: { t: 'html', s: src.slice(i, k + 2) } };
    }
    if (ws === 0) return null; // no whitespace before attribute
    // Attribute name.
    if (!(isAlphaCode(c) || c === 95 || c === 58)) return null;
    k++;
    while (k < n) {
      const ac = src.charCodeAt(k);
      if (isAlnumCode(ac) || ac === 95 || ac === 58 || ac === 46 || ac === 45) k++;
      else break;
    }
    // Optional = value.
    let m = k;
    while (m < n && isSpaceCode(src.charCodeAt(m))) m++;
    if (m < n && src.charCodeAt(m) === 61) { // '='
      m++;
      while (m < n && isSpaceCode(src.charCodeAt(m))) m++;
      if (m >= n) return null;
      const vc = src.charCodeAt(m);
      if (vc === 34 || vc === 39) { // quoted value
        const q = vc;
        m++;
        while (m < n && src.charCodeAt(m) !== q) m++;
        if (m >= n) return null;
        m++;
      } else { // unquoted value
        let v0 = m;
        while (m < n) {
          const uc = src.charCodeAt(m);
          if (isSpaceCode(uc) || uc === 34 || uc === 39 || uc === 61 ||
            uc === 60 || uc === 62 || uc === 96) break;
          m++;
        }
        if (m === v0) return null;
      }
      k = m;
    }
    j = k;
  }
}

// Parse a link label starting at src[i] === '['. Returns {end, label}
// (end is the index just past the closing ']') or null. The label may
// contain balanced nested brackets and is capped at 999 chars.
function parseLinkLabel(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92 && j + 1 < n) { j += 2; continue; } // backslash escape
    if (c === 91) return null; // unescaped '[' inside a label
    if (c === 93) {
      const label = src.slice(i + 1, j);
      if (label.length > 999) return null;
      if (label.trim() === '') return null; // all-whitespace label
      return { end: j + 1, label };
    }
    j++;
  }
  return null;
}

// Skip inline whitespace (space/tab/newline) starting at i. Returns the
// new index.
function skipInlineWs(src, i) {
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) i++;
    else break;
  }
  return i;
}

// Parse a link destination starting at i. Returns {end, dest} or null.
// Forms: <...> (no newline) or bare (no spaces, balanced parens).
function parseLinkDest(src, i) {
  const n = src.length;
  if (i >= n) return null;
  if (src.charCodeAt(i) === 60) { // <...>
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 92 && j + 1 < n) { j += 2; continue; } // backslash escape
      if (c === 62) return { end: j + 1, dest: unescapeBackslashes(src.slice(i + 1, j)) };
      if (c === 10) return null;
      j++;
    }
    return null;
  }
  // Bare destination: no spaces, balanced parens, backslash escapes.
  let j = i;
  let depth = 0;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92 && j + 1 < n && isAsciiPunctCode(src.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === 32 || c === 9 || c === 10 || c === 13) break;
    if (c === 40) { depth++; j++; continue; }
    if (c === 41) {
      if (depth === 0) break;
      depth--; j++; continue;
    }
    j++;
  }
  if (j === i) return null;
  return { end: j, dest: unescapeBackslashes(src.slice(i, j)) };
}

// Parse a link title starting at i. Returns {end, title} or null.
// Forms: "...", '...', (...) — may span lines; backslash escapes apply.
function parseLinkTitle(src, i) {
  const n = src.length;
  if (i >= n) return null;
  const q = src.charCodeAt(i);
  if (q === 34 || q === 39) { // "..." or '...'
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 92 && j + 1 < n) { j += 2; continue; }
      if (c === q) return { end: j + 1, title: unescapeBackslashes(src.slice(i + 1, j)) };
      j++;
    }
    return null;
  }
  if (q === 40) { // (...) — no unescaped parens inside
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 92 && j + 1 < n) { j += 2; continue; }
      if (c === 40 || c === 41) {
        if (c === 41) return { end: j + 1, title: unescapeBackslashes(src.slice(i + 1, j)) };
        return null;
      }
      j++;
    }
    return null;
  }
  return null;
}

// Wrap the nodes between the opener's and closer's text nodes in an
// emphasis node. The delimiter text nodes keep their remaining delimiters.
// Returns the wrapped children, or null if either delimiter node is no
// longer in the top-level node list (it fell inside an earlier wrap).
// Does any descendant hold a *-emphasis/strong that blocks an outer
// *-emphasis/strong? Blocking iff the nested opener cannot close and
// the nested closer can also open (marked's emphasis scan).
function hasBlockingEm(nodes, outerUse) {
  for (const node of nodes) {
    if ((node.t === 'em' || node.t === 'strong') && node.ch === 42 &&
      !node.oc && node.co && node.use !== outerUse) return true;
    if (node.children && hasBlockingEm(node.children, outerUse)) return true;
  }
  return false;
}

// Does the subtree hold a text node containing a '*' (a leftover
// delimiter)? A lone '*' between a nested emphasis and the outer
// closer cancels the blocking rule.
function childrenContainStar(nodes) {
  for (const node of nodes) {
    if (node.t === 'text' && node.s.indexOf('*') !== -1) return true;
    if (node.children && childrenContainStar(node.children)) return true;
  }
  return false;
}

// Does the subtree hold any em/strong node?
function containsEmStrong(nodes) {
  for (const node of nodes) {
    if (node.t === 'em' || node.t === 'strong') return true;
    if (node.children && containsEmStrong(node.children)) return true;
  }
  return false;
}

function wrapEmphasis(nodes, opener, closer, use, tag) {
  const openIdx = nodes.indexOf(opener.node);
  const closeIdx = nodes.indexOf(closer.node);
  if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) return null;
  const children = nodes.slice(openIdx + 1, closeIdx);
  // Marked: a *-emphasis/strong does not form if its content holds a
  // nested *-emphasis/strong whose opener cannot close and whose
  // closer can also open — but only when the nested delimiter count
  // differs from the outer's (same-length nesting is fine), only when
  // the closer run originally had fewer than 3 delimiters (a 3+ run
  // does not block, even after part of it was consumed), and only
  // when no lone '*' sits between the nested emphasis and the closer.
  if (opener.char === 42 && closer.origLen < 3 &&
      !(use === 2 && childrenContainStar(children)) &&
      hasBlockingEm(children, use)) return null;
  nodes.splice(openIdx + 1, closeIdx - openIdx - 1,
    { t: tag, children, ch: opener.char, oc: opener.canClose,
      co: closer.canOpen, use });
  return children;
}

// Update a delimiter's text node after `use` delimiters were consumed.
// The opener keeps its FIRST len chars; the closer keeps its LAST len chars.
// Removes the node if it becomes empty.
function shrinkDelimNode(nodes, delim, isOpener) {
  const node = delim.node;
  if (delim.len === 0) {
    const idx = nodes.indexOf(node);
    if (idx !== -1) nodes.splice(idx, 1);
    return;
  }
  if (isOpener) node.s = node.s.slice(0, delim.len);
  else node.s = node.s.slice(node.s.length - delim.len);
}

// Remove autolinks nested inside a link's children (a link cannot
// contain another link): replace each link node with its text content.
// Recurses into em/strong/del children. Images are left alone.
// Unwrap bare autolinks nested inside a link's children (marked does
// not form bare autolinks inside link text). Angle-bracket autolinks
// (<...>) DO nest and are kept.
function unlinkNested(nodes) {
  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
    if (node.t === 'link' && !node.angle) {
      nodes.splice(k, 1, ...node.children);
      k += node.children.length - 1;
    } else if (node.children) {
      unlinkNested(node.children);
    }
  }
}

// Deactivate delimiter entries whose text nodes fell inside a wrapped
// emphasis range (they are nested now and must not match later).
function deactivateInside(delims, fromIdx, toIdx, wrapped) {
  for (let d = fromIdx; d < toIdx; d++) {
    const dm = delims[d];
    if (dm && !dm.isLink && dm.active && wrapped.includes(dm.node)) {
      dm.active = false;
    }
  }
}

// Process emphasis/strikethrough delimiters in delims[fromIdx..toIdx).
// Closers are processed left to right; each looks back for the nearest
// matching opener (CommonMark delimiter-stack algorithm).
function processEmphasis(delims, nodes, fromIdx, toIdx) {
  for (let i = fromIdx; i < toIdx; i++) {
    const closer = delims[i];
    if (!closer || closer.isLink || !closer.active || !closer.canClose) continue;
    let j = i - 1;
    while (j >= fromIdx) {
      const opener = delims[j];
      if (opener && !opener.isLink && opener.active && opener.canOpen &&
        opener.char === closer.char) {
        if (opener.char === 126) {
          // Strikethrough: opener and closer must have the SAME count
          // (1 or 2); runs of 3+ never match.
          if (opener.len !== closer.len || opener.len > 2 || opener.len === 0) {
            j--;
            continue;
          }
          const use = opener.len;
          const wrapped = wrapEmphasis(nodes, opener, closer, use, 'del');
          if (!wrapped) { j--; continue; }
          deactivateInside(delims, fromIdx, toIdx, wrapped);
          opener.len = 0;
          closer.len = 0;
          opener.active = false;
          closer.active = false;
          shrinkDelimNode(nodes, opener, true);
          shrinkDelimNode(nodes, closer, false);
          break;
        }
        // Emphasis: the rule of 3.
        if (opener.canClose || closer.canOpen) {
          const sum = opener.len + closer.len;
          if (sum % 3 === 0 && (opener.len % 3 !== 0 || closer.len % 3 !== 0)) {
            j--;
            continue;
          }
        }
        const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
        // Marked prefers a strong over an em competing for the same
        // `**` opener: if this em would consume 1 star of a 2-star
        // opener (leaving too few for a strong) while a later `**`
        // closer could still form the strong, skip the em and let
        // the strong form. A 3+ opener has enough for both.
        if (use === 1 && opener.char === 42 && opener.len === 2) {
          let laterStrong = false;
          for (let k = i + 1; k < toIdx; k++) {
            const d = delims[k];
            if (d && !d.isLink && d.active && d.canClose &&
              d.char === 42 && d.len >= 2) { laterStrong = true; break; }
          }
          if (laterStrong) { j--; continue; }
        }
        const wrapped = wrapEmphasis(nodes, opener, closer, use,
          use === 2 ? 'strong' : 'em');
        if (!wrapped) { j--; continue; }
        deactivateInside(delims, fromIdx, toIdx, wrapped);
        opener.len -= use;
        closer.len -= use;
        // Marked: when the closer has leftover delimiters and the
        // wrapped content holds a blocking-configuration nested
        // emphasis (different length, opener cannot close, closer can
        // open — the case the 3+ closer exception unblocks), the
        // leftovers go INSIDE the emphasis; otherwise they stay
        // outside as trailing text.
        if (closer.len > 0 && hasBlockingEm(wrapped, use)) {
          wrapped.push({ t: 'text',
            s: String.fromCharCode(closer.char).repeat(closer.len) });
          closer.len = 0;
        }
        shrinkDelimNode(nodes, opener, true);
        shrinkDelimNode(nodes, closer, false);
        if (opener.len === 0) opener.active = false;
        if (closer.len === 0) { closer.active = false; break; }
        // The closer still has delimiters: look for another opener.
        j = i - 1;
        continue;
      }
      j--;
    }
  }
}

// The main inline parser. src is a single block's inline content
// (paragraph lines joined with \n, heading text, or a table cell).
// refs is the document's link-reference map (normalized label -> {dest, title}).
// Document-wide "inside a link" flag (marked's lexer state): an
// unclosed inline <a> open tag sets it, an inline </a> clears it.
// While set, bare autolinks (email, www, scheme) are suppressed.
// Reset at the start of every parse().
let inlineInLink = false;

// Classify an inline HTML tag's effect on the inLink state:
// 'open' for <a ...>, 'close' for </a>, null otherwise. A self-closing
// <a/> does not open a link.
function htmlTagLinkState(tagText) {
  if (tagText.length < 3) return null;
  if (tagText.charCodeAt(1) === 47) { // '</'
    if ((tagText.charCodeAt(2) | 32) === 97) {
      const c3 = tagText.length > 3 ? tagText.charCodeAt(3) : -1;
      if (c3 === 62 || c3 === 32 || c3 === 9 || c3 === 10 || c3 === 13 ||
        c3 === 47) return 'close';
    }
    return null;
  }
  if ((tagText.charCodeAt(1) | 32) === 97) { // '<a'
    const c2 = tagText.length > 2 ? tagText.charCodeAt(2) : -1;
    if (c2 === 62 || c2 === 32 || c2 === 9 || c2 === 10 || c2 === 13 ||
      c2 === 47) {
      // Only the exact tag <a/> is self-closing: <a />, <a href="x"/>
      // and any other variant count as an open tag.
      if (tagText.length === 4 && c2 === 47) return null;
      return 'open';
    }
  }
  return null;
}

function parseInline(src, refs) {
  const nodes = [];
  const delims = [];
  const n = src.length;
  let i = 0;
  let textStart = 0;
  // Emphasis-suppression zone end (exclusive): after a link whose text
  // holds unpaired backticks, emphasis is suppressed until the next
  // code span. -1 when no suppression is active.
  let suppressEmUntil = -1;
  const flushText = (end) => {
    if (end > textStart) nodes.push({ t: 'text', s: src.slice(textStart, end) });
    textStart = end;
  };

  while (i < n) {
    const c = src.charCodeAt(i);

    if (c === 92) { // backslash
      if (i + 1 < n) {
        const c2 = src.charCodeAt(i + 1);
        if (c2 === 10) { // backslash + newline = hard break
          flushText(i);
          nodes.push({ t: 'br' });
          i += 2;
          // After a hard break, leading spaces/tabs of the next line
          // are skipped.
          while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
          textStart = i;
          continue;
        }
        if (isAsciiPunctCode(c2)) {
          flushText(i);
          nodes.push({ t: 'text', s: src[i + 1] });
          i += 2;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }

    if (c === 96) { // backtick: code span
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      const runLen = j - i;
      const close = findCodeClose(src, j, runLen);
      if (close !== -1) {
        // Link priority: a code span must not swallow a `]` that closes a
        // reference link whose label is defined. If an active link opener
        // sits before this backtick and the span would contain `]` +
        // `[defined-label]`, leave the backticks literal so the link forms.
        // (Inline `](` links do NOT get this priority — the span wins.)
        let hasOpenLink = false;
        let openPos = -1;
        for (let d = delims.length - 1; d >= 0; d--) {
          if (delims[d].isLink && delims[d].active && delims[d].pos < i) { hasOpenLink = true; openPos = delims[d].pos; break; }
        }
        if (hasOpenLink) {
          let blocked = false;
          for (let p = j; p < close; p++) {
            if (src.charCodeAt(p) !== 93 || p + 1 >= close) continue;
            const nc = src.charCodeAt(p + 1);
            // Only block if the link could actually form: clean link
            // text (a bad backtick in the text kills the link, so the
            // code span wins — cm-537) plus a resolvable destination.
            if (nc === 91) { // [label] full ref
              const lab = parseLinkLabel(src, p + 1);
              if (lab && refs.has(normalizeLabel(lab.label)) &&
                  !linkTextHasBadBackticks(src.slice(openPos + 1, p))) { blocked = true; break; }
            } else if (nc === 40) { // (dest) inline
              let q = skipInlineWs(src, p + 2);
              let ok = false;
              if (q < n && src.charCodeAt(q) === 41) ok = true;
              else {
                const dd = parseLinkDest(src, q);
                if (dd) {
                  let r = skipInlineWs(src, dd.end);
                  if (r < n && src.charCodeAt(r) !== 41) {
                    const tt = parseLinkTitle(src, r);
                    if (tt) r = skipInlineWs(src, tt.end);
                  }
                  if (r < n && src.charCodeAt(r) === 41) ok = true;
                }
              }
              if (ok && !linkTextHasBadBackticks(src.slice(openPos + 1, p))) { blocked = true; break; }
            }
          }
          if (blocked) { i = j; continue; }
        }
        flushText(i);
        let content = src.slice(j, close);
        if (content.indexOf('\n') !== -1) content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === 32 &&
          content.charCodeAt(content.length - 1) === 32 &&
          content.trim() !== '') {
          content = content.slice(1, -1);
        }
        nodes.push({ t: 'code', s: content });
        if (suppressEmUntil !== -1 && i >= suppressEmUntil) suppressEmUntil = -1;
        i = close + runLen;
        textStart = i;
        continue;
      }
      i = j; // no closer: literal backticks
      continue;
    }

    if (c === 42 || c === 95 || c === 126) { // * _ ~ delimiter runs
      let j = i;
      while (j < n && src.charCodeAt(j) === c) j++;
      const runLen = j - i;
      // Inside an emphasis-suppression zone (after a link with
      // unpaired backticks, before the last code span) the run is
      // literal text, not a delimiter — unless it sits inside a
      // later link's text (an unclosed '[' opener), where emphasis
      // resolves normally.
      if (suppressEmUntil !== -1 && i < suppressEmUntil) {
        let inLinkText = false;
        for (let d = delims.length - 1; d >= 0; d--) {
          if (delims[d].isLink && delims[d].active) { inLinkText = true; break; }
        }
        if (!inLinkText) { i = j; continue; }
      }
      const before = i > 0 ? src.charCodeAt(i - 1) : -1;
      const after = j < n ? src.charCodeAt(j) : -1;
      const beforeWs = before === -1 || isWhitespaceCode(before);
      const afterWs = after === -1 || isWhitespaceCode(after);
      const beforePunct = before !== -1 && isPunctCode(before);
      const afterPunct = after !== -1 && isPunctCode(after);
      const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
      let canOpen, canClose;
      if (c === 95) {
        canOpen = leftFlanking && (!rightFlanking || beforePunct);
        canClose = rightFlanking && (!leftFlanking || afterPunct);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      flushText(i);
      const node = { t: 'text', s: src.slice(i, j) };
      nodes.push(node);
      if (canOpen || canClose) {
        delims.push({
          char: c, len: runLen, origLen: runLen, canOpen, canClose,
          active: true, node, isLink: false,
        });
      }
      i = j;
      textStart = i;
      continue;
    }

    if (c === 91) { // [ link opener
      flushText(i);
      const node = { t: 'text', s: '[' };
      nodes.push(node);
      delims.push({
        char: 91, isLink: true, isImage: false, active: true,
        closed: false, node, pos: i,
      });
      i++;
      textStart = i;
      continue;
    }

    if (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91) { // ![
      flushText(i);
      const node = { t: 'text', s: '![' };
      nodes.push(node);
      delims.push({
        char: 91, isLink: true, isImage: true, active: true,
        closed: false, node, pos: i,
      });
      i += 2;
      textStart = i;
      continue;
    }

    if (c === 93) { // ] — try to form a link or image
      let openerIdx = -1;
      for (let d = delims.length - 1; d >= 0; d--) {
        if (delims[d].isLink && delims[d].active) { openerIdx = d; break; }
      }
      if (openerIdx === -1) { i++; continue; }
      const opener = delims[openerIdx];
      // The link text must have balanced brackets: an opener inside the
      // text that has not been closed by its own ']' blocks the link.
      // The current ']' closes the nearest such opener (bracket-wise),
      // so mark it closed and treat this ']' as literal.
      let blocked = -1;
      for (let d = delims.length - 1; d > openerIdx; d--) {
        const dm = delims[d];
        if (dm.isLink && !dm.closed) { blocked = d; break; }
      }
      if (blocked !== -1) {
        delims[blocked].closed = true;
        i++;
        continue;
      }
      const linkTextStart = opener.isImage ? opener.pos + 2 : opener.pos + 1;
      const linkText = src.slice(linkTextStart, i);
      // Bad backticks in the link text: no link forms, and emphasis
      // inside the text is suppressed (marked).
      if (linkTextHasBadBackticks(linkText)) {
        for (let d = openerIdx + 1; d < delims.length; d++) {
          if (!delims[d].isLink) delims[d].active = false;
        }
        opener.active = false;
        opener.closed = true;
        i++;
        continue;
      }
      // Try inline link, full ref, collapsed ref, shortcut ref (in order).
      let dest = null, title = null, endPos = -1;
      let inlineDestParsed = false;
      let after = i + 1;
      if (after < n && src.charCodeAt(after) === 40) { // ( inline
        let p = skipInlineWs(src, after + 1);
        // An empty destination "()" forms a link with href="".
        if (p < n && src.charCodeAt(p) === 41) {
          dest = '';
          title = null;
          endPos = p + 1;
        } else {
          const d = parseLinkDest(src, p);
          if (d) {
            inlineDestParsed = true;
            let q = skipInlineWs(src, d.end);
            let t = null;
            if (q < n && src.charCodeAt(q) !== 41) {
              const tt = parseLinkTitle(src, q);
              if (tt) { t = tt.title; q = skipInlineWs(src, tt.end); }
            }
            if (q < n && src.charCodeAt(q) === 41) {
              dest = d.dest;
              title = t;
              endPos = q + 1;
            }
          }
        }
      }
      if (dest === null && after < n && src.charCodeAt(after) === 91) {
        // Full ref [label] or collapsed [].
        if (after + 1 < n && src.charCodeAt(after + 1) === 93) {
          const ref = refs.get(normalizeLabel(linkText));
          if (ref) { dest = ref.dest; title = ref.title; endPos = after + 2; }
        } else {
          const lab = parseLinkLabel(src, after);
          if (lab) {
            const ref = refs.get(normalizeLabel(lab.label));
            if (ref) { dest = ref.dest; title = ref.title; endPos = lab.end; }
            // Undefined full ref: NO shortcut fallback — literal.
          }
          // No closing ']' for the label: fall through to shortcut.
          else {
            const ref = refs.get(normalizeLabel(linkText));
            if (ref) { dest = ref.dest; title = ref.title; endPos = i + 1; }
          }
        }
      }
      if (dest === null && !(after < n && src.charCodeAt(after) === 91)) {
        // Shortcut ref (only when no '[' follows — a '[' with a valid
        // label that isn't defined means literal, not shortcut).
        const ref = refs.get(normalizeLabel(linkText));
        if (ref) { dest = ref.dest; title = ref.title; endPos = i + 1; }
      }
      if (dest === null) {
        // Not a link: deactivate this opener and move on. Its own ']'
        // has come, so it counts as closed for bracket balance.
        // A failed inline link whose destination parsed suppresses
        // emphasis inside the link text (marked); a failed reference
        // (or a dest that never parsed) leaves emphasis alone.
        if (inlineDestParsed) {
          for (let d = openerIdx + 1; d < delims.length; d++) {
            if (!delims[d].isLink) delims[d].active = false;
          }
        }
        opener.active = false;
        opener.closed = true;
        i++;
        continue;
      }
      // Resolve emphasis inside the link text, then form the link.
      processEmphasis(delims, nodes, openerIdx + 1, delims.length);
      flushText(i);
      // Form the link/image: wrap the nodes after the opener node.
      const startIdx = nodes.indexOf(opener.node);
      if (startIdx === -1) {
        // The opener's node fell inside an earlier emphasis wrap: it
        // cannot form a link.
        opener.active = false;
        i++;
        continue;
      }
      const children = nodes.slice(startIdx + 1);
      nodes.splice(startIdx, nodes.length - startIdx);
      // A link cannot contain another link: unwrap autolinks inside.
      unlinkNested(children);
      let linkNode;
      if (opener.isImage) {
        linkNode = {
          t: 'image', src: dest, alt: plainText(children),
          title: title !== null ? title : null,
        };
      } else {
        linkNode = {
          t: 'link', href: dest,
          title: title !== null ? title : null, children,
        };
      }
      nodes.push(linkNode);
      // A link whose text holds unpaired backticks suppresses emphasis
      // after it until the next code span (marked's tokenizer pairs the
      // stray backtick with that span's opener for emphasis purposes).
      // No later code span means no suppression at all.
      if (!opener.isImage && hasUnpairedBackticks(linkText)) {
        const cs = findLastCodeSpan(src, endPos);
        if (cs !== -1) suppressEmUntil = cs;
      }
      // Remove the opener and all delimiters after it (they are now
      // inside the link). Forming a link deactivates earlier '['
      // (non-image) openers only — an earlier '![' can still form an
      // image. Forming an image deactivates nothing.
      delims.splice(openerIdx, delims.length - openerIdx);
      if (!opener.isImage) {
        for (let d = 0; d < delims.length; d++) {
          if (delims[d].isLink && !delims[d].isImage) {
            delims[d].active = false;
          }
        }
      }
      i = endPos;
      textStart = i;
      continue;
    }

    if (c === 60) { // < autolink or HTML tag
      const res = tryAngle(src, i);
      if (res) {
        flushText(i);
        nodes.push(res.node);
        // An inline <a> tag opens (</a> closes) the document-wide
        // inLink state, which suppresses bare autolinks.
        if (res.node.t === 'html') {
          const st = htmlTagLinkState(res.node.s);
          if (st === 'open') inlineInLink = true;
          else if (st === 'close') inlineInLink = false;
        }
        i = res.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    if (c === 38) { // & entity
      const e = readEntity(src, i);
      if (e) {
        flushText(i);
        nodes.push({ t: 'raw', s: e.text });
        i = e.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    if (c === 10) { // newline: hard break if 2+ trailing spaces
      let k = i - 1;
      let spaces = 0;
      while (k >= textStart && src.charCodeAt(k) === 32) { spaces++; k--; }
      if (spaces >= 2) {
        flushText(i - spaces);
        nodes.push({ t: 'br' });
        i++;
        // After a hard break, leading spaces/tabs of the next line
        // are skipped.
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
        textStart = i;
        continue;
      }
      i++; // soft break: the \n stays in the text
      continue;
    }

    if (c === 119 && src.startsWith('www.', i)) { // www. autolink
      const prev = i > 0 ? src.charCodeAt(i - 1) : -1;
      if (!inlineInLink &&
        (prev === -1 || isSpaceCode(prev) || prev === 42 || prev === 95 ||
        prev === 126 || prev === 40)) {
        // Inside link text, a bare URL must not cross the ']'.
        let inLink = false;
        for (let d = delims.length - 1; d >= 0; d--) {
          if (delims[d].isLink && delims[d].active) { inLink = true; break; }
        }
        const res = scanUrlAutolink(src, i, 4, inLink);
        if (res) {
          flushText(i);
          nodes.push({
            t: 'link', href: 'http://' + res.text, title: null,
            children: [{ t: 'text', s: res.text }],
          });
          i = res.end;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }

    if (c === 104 || c === 102 || c === 72 || c === 70) { // h/f/H/F
      // Case-insensitive http:// https:// ftp:// autolink.
      let plen = 0;
      if ((c | 32) === 104) { // h
        if (lowerCode(src.charCodeAt(i + 1)) === 116 &&
          lowerCode(src.charCodeAt(i + 2)) === 116 &&
          lowerCode(src.charCodeAt(i + 3)) === 112) {
          if (lowerCode(src.charCodeAt(i + 4)) === 115 &&
            src.startsWith('://', i + 5)) plen = 8;
          else if (src.startsWith('://', i + 4)) plen = 7;
        }
      } else { // f
        if (lowerCode(src.charCodeAt(i + 1)) === 116 &&
          lowerCode(src.charCodeAt(i + 2)) === 112 &&
          src.startsWith('://', i + 3)) plen = 6;
      }
      if (plen > 0 && !inlineInLink) {
        // Inside link text, a bare URL must not cross the ']'.
        let inLink = false;
        for (let d = delims.length - 1; d >= 0; d--) {
          if (delims[d].isLink && delims[d].active) { inLink = true; break; }
        }
        const res = scanUrlAutolink(src, i, plen, inLink);
        if (res) {
          flushText(i);
          nodes.push({
            t: 'link', href: res.text, title: null,
            children: [{ t: 'text', s: res.text }],
          });
          i = res.end;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }

    if (c === 64 && !inlineInLink) { // @ email autolink
      // Resolve the email + an optional mailto:/xmpp: scheme prefix
      // immediately before it (at a boundary). localStart bounds the
      // local-part scan.
      const resolveEmail = (localStart) => {
        let hasUnderscoreOpener = false;
        for (let d = delims.length - 1; d >= 0; d--) {
          const dm = delims[d];
          if (!dm.isLink && dm.char === 95 && dm.active && dm.canOpen) {
            hasUnderscoreOpener = true;
            break;
          }
        }
        const r = tryEmailAt(src, i, localStart, hasUnderscoreOpener);
        if (!r) return null;
        let start = r.start;
        let href = 'mailto:' + r.text;
        let isXmpp = false;
        const before = r.start;
        let schemeStart = -1;
        if (before >= 7 && src.slice(before - 7, before) === 'mailto:') {
          const bp = before - 7;
          const prev = bp > 0 ? src.charCodeAt(bp - 1) : -1;
          if (prev === -1 || isSpaceCode(prev) || prev === 42 || prev === 95 ||
            prev === 126 || prev === 40) schemeStart = bp;
        } else if (before >= 5 && src.slice(before - 5, before) === 'xmpp:') {
          const bp = before - 5;
          const prev = bp > 0 ? src.charCodeAt(bp - 1) : -1;
          if (prev === -1 || isSpaceCode(prev) || prev === 42 || prev === 95 ||
            prev === 126 || prev === 40) { schemeStart = bp; isXmpp = true; }
        }
        if (schemeStart !== -1) {
          start = schemeStart;
          href = src.slice(schemeStart, r.end);
        }
        return { res: r, start, href, isXmpp };
      };
      // Is [start, textStart) covered only by text nodes? (Used to
      // decide whether the email may rewind over flushed text.)
      const rangeIsText = (start) => {
        let runStart = textStart;
        for (let q = nodes.length - 1; q >= 0; q--) {
          if (nodes[q].t !== 'text') break;
          runStart -= nodes[q].s.length;
        }
        return start >= runStart;
      };
      // Scan the local part back freely: a '_' inside it flushes text
      // and resets textStart, which would cut the local part short.
      let found = resolveEmail(0);
      if (found && found.start < textStart && !rangeIsText(found.start)) {
        // A non-text node is in the way: retry with the text-run bound.
        found = resolveEmail(textStart);
        // The fallback's scheme prefix may straddle the text-run start;
        // drop it then (the prefix is in already-flushed nodes).
        if (found && found.start < textStart) {
          found = {
            res: found.res, start: found.res.start,
            href: 'mailto:' + found.res.text, isXmpp: false,
          };
        }
      }
      if (found) {
        const { res, isXmpp } = found;
        let { start, href } = found;
        let end = res.end;
        // xmpp: only — include one path segment after the domain.
        if (isXmpp && end < n && src.charCodeAt(end) === 47) {
          let p = end + 1;
          while (p < n) {
            const pc = src.charCodeAt(p);
            if (pc === 47 || isSpaceCode(pc)) break;
            p++;
          }
          if (p > end + 1) {
            end = p;
            href = src.slice(start, end);
          }
        }
        // Rewind text nodes covering [start, textStart).
        if (start < textStart) {
          let need = textStart - start;
          while (need > 0 && nodes.length > 0) {
            const node = nodes[nodes.length - 1];
            if (node.t !== 'text') break;
            if (node.s.length <= need) {
              need -= node.s.length;
              nodes.pop();
              for (let d = delims.length - 1; d >= 0; d--) {
                if (delims[d].node === node) delims.splice(d, 1);
              }
            } else {
              node.s = node.s.slice(0, node.s.length - need);
              for (let d = 0; d < delims.length; d++) {
                if (delims[d].node === node && !delims[d].isLink) {
                  delims[d].len = node.s.length;
                  if (delims[d].len === 0) delims[d].active = false;
                }
              }
              need = 0;
            }
          }
          textStart = start;
        }
        flushText(start);
        const text = src.slice(start, end);
        nodes.push({
          t: 'link', href, title: null,
          children: [{ t: 'text', s: text }],
        });
        i = end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    i++;
  }

  flushText(n);
  processEmphasis(delims, nodes, 0, delims.length);
  return renderInline(nodes);
}

// ---------------------------------------------------------------- block parsing

// A cursor into a line: {line, pos, col, ptab}.
// pos = index into line; col = current column; ptab = remaining spaces of a
// partially consumed tab (0 if none; when >0, line[pos] is the tab).
function makeCursor(line) { return { line, pos: 0, col: 0, ptab: 0 }; }

// Char code at the cursor (-1 at EOL). A partial tab reads as a space.
function curChar(cur) {
  if (cur.ptab > 0) return 32;
  if (cur.pos >= cur.line.length) return -1;
  return cur.line.charCodeAt(cur.pos);
}

// Advance the cursor by one column (a space, or part of a tab).
function advanceOne(cur) {
  if (cur.ptab > 0) {
    cur.ptab--;
    cur.col++;
    if (cur.ptab === 0) cur.pos++;
    return;
  }
  const c = cur.line.charCodeAt(cur.pos);
  if (c === 9) cur.col += 4 - (cur.col % 4);
  else cur.col++;
  cur.pos++;
}

// Advance the cursor by up to n columns of spaces/tabs. Returns the
// columns actually consumed.
function advanceSpaces(cur, n) {
  let consumed = 0;
  while (consumed < n) {
    if (cur.ptab > 0) {
      const take = Math.min(cur.ptab, n - consumed);
      cur.ptab -= take;
      cur.col += take;
      consumed += take;
      if (cur.ptab === 0) cur.pos++;
      continue;
    }
    if (cur.pos >= cur.line.length) break;
    const c = cur.line.charCodeAt(cur.pos);
    if (c === 32) { cur.pos++; cur.col++; consumed++; }
    else if (c === 9) {
      const width = 4 - (cur.col % 4);
      if (consumed + width <= n) {
        cur.pos++; cur.col += width; consumed += width;
      } else {
        const take = n - consumed;
        cur.ptab = width - take;
        cur.col += take;
        consumed += take;
      }
    } else break;
  }
  return consumed;
}

// Columns of indent (spaces/tabs) from the cursor to the first non-space
// char or EOL. Does not move the cursor.
function measureIndent(cur) {
  let col = cur.col;
  let pos = cur.pos;
  let ptab = cur.ptab;
  const line = cur.line;
  while (true) {
    if (ptab > 0) { col += ptab; ptab = 0; pos++; continue; }
    if (pos >= line.length) break;
    const c = line.charCodeAt(pos);
    if (c === 32) { pos++; col++; }
    else if (c === 9) { col += 4 - (col % 4); pos++; }
    else break;
  }
  return col - cur.col;
}

// Remaining content of the line from the cursor (partial tab -> spaces).
function restOfLine(cur) {
  if (cur.ptab > 0) {
    return ' '.repeat(cur.ptab) + cur.line.slice(cur.pos + 1);
  }
  return cur.line.slice(cur.pos);
}

// Expand the leading tabs of s to spaces, based on absolute columns
// starting at startCol. Only the leading whitespace run is expanded;
// tabs later in the line are preserved raw.
function expandLeadingTabs(s, startCol) {
  let col = startCol;
  let k = 0;
  let out = '';
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (c === 32) { out += ' '; col++; k++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      k++;
    } else break;
  }
  return out + s.slice(k);
}

// Is there any remaining content on this line (after prefix
// consumption)? A whitespace-only remainder still counts as content
// here (it is not an empty line).
function hasRemainder(cur) {
  if (cur.ptab > 0) return true;
  return cur.pos < cur.line.length;
}

// Is the rest of the line blank (only spaces/tabs)?
function isBlankFrom(cur) {
  let pos = cur.pos;
  const line = cur.line;
  if (cur.ptab > 0) pos++;
  while (pos < line.length) {
    const c = line.charCodeAt(pos);
    if (c !== 32 && c !== 9) return false;
    pos++;
  }
  return true;
}

// Split the input into lines (normalizing \r\n and \r to \n). A trailing
// newline does not produce an extra empty line.
function splitLines(input) {
  let s = input;
  if (s.indexOf('\r') !== -1) s = s.replace(/\r\n?/g, '\n');
  const lines = s.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ---------------------------------------------------------------- HTML blocks
//
// Types 1-6 end at a closing marker (or end of container); type 7 ends at
// a blank line. Types 1-6 may interrupt a paragraph; type 7 may not.
const HTML_BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'meta', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param',
  'search', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'title', 'tr', 'track', 'ul',
]);
const HTML_END_MARKERS = {
  1: '-->', 2: '?>', 3: ']]>',
  4: null, 5: null, 6: null, // set per tag below
};

// Detect an HTML block start at the cursor (indent already <= 3).
// Returns {type, canInterrupt} or 0.
// Types 1-5: comment/PI/CDATA/declaration — always interrupt.
// Type 6: script/pre/style/textarea OPEN tag (+ boundary) — interrupts.
//   A closing special tag is type 7 (marked continues it to a blank line).
// Type 7: block-tag open (name + boundary) — interrupts; block-tag close
//   (complete, alone) — interrupts; other open/close tags (complete,
//   alone) — do NOT interrupt.
function htmlBlockStart(cur) {
  const s = restOfLine(cur);
  if (s.startsWith('<!--')) return { type: 1, canInterrupt: true };
  if (s.startsWith('<?')) return { type: 2, canInterrupt: true };
  if (s.startsWith('<![CDATA[')) return { type: 3, canInterrupt: true };
  // Type 5: <![ + uppercase letter (SGML conditional section).
  if (s.startsWith('<![', 0) && s.length > 3 &&
    s.charCodeAt(3) >= 65 && s.charCodeAt(3) <= 90) {
    return { type: 5, canInterrupt: true };
  }
  if (s.startsWith('<!')) {
    if (s.length > 2 && isAlphaCode(s.charCodeAt(2))) {
      return { type: 4, canInterrupt: true };
    }
    return 0;
  }
  // Open or closing tag.
  let j = 0;
  let closing = false;
  if (s.startsWith('</')) { j = 2; closing = true; }
  else if (s.charCodeAt(0) === 60 && s.length > 1 && isAlphaCode(s.charCodeAt(1))) {
    j = 1;
  } else return 0;
  let k = j;
  while (k < s.length && (isAlnumCode(s.charCodeAt(k)) || s.charCodeAt(k) === 45)) k++;
  if (k === j) return 0;
  const tag = s.slice(j, k).toLowerCase();
  const isSpecial = tag === 'script' || tag === 'pre' || tag === 'style' ||
    tag === 'textarea';
  const isBlockTag = HTML_BLOCK_TAGS.has(tag);
  if (closing) {
    // Closing tag: optional whitespace, then '>'.
    let m = k;
    while (m < s.length && isSpaceCode(s.charCodeAt(m))) m++;
    if (m >= s.length || s.charCodeAt(m) !== 62) return 0;
    m++;
    // A closing BLOCK tag starts a type-7 block as soon as it is
    // complete, whatever follows on the line (</td></tr></table>).
    // Closing special/other tags must be alone on the line.
    if (isBlockTag) return { type: 7, canInterrupt: true };
    while (m < s.length && isSpaceCode(s.charCodeAt(m))) m++;
    if (m < s.length) return 0;
    return { type: 7, canInterrupt: false };
  }
  // Open tag.
  if (isSpecial) {
    // Type 6: the tag name must be followed by whitespace, '>' or EOL.
    // '/' is NOT a valid boundary (<script/> is not a block at all).
    if (k >= s.length) return { type: 6, canInterrupt: true };
    const c = s.charCodeAt(k);
    if (c === 32 || c === 9 || c === 62) return { type: 6, canInterrupt: true };
    return 0;
  }
  if (isBlockTag) {
    // Type 7 block tag: the tag name must be followed by whitespace,
    // '>', '/>' or EOL. Starts on the name alone (even incomplete).
    if (k >= s.length) return { type: 7, canInterrupt: true };
    const c = s.charCodeAt(k);
    if (c === 32 || c === 9 || c === 62) return { type: 7, canInterrupt: true };
    if (c === 47 && k + 1 < s.length && s.charCodeAt(k + 1) === 62) {
      return { type: 7, canInterrupt: true };
    }
    return 0;
  }
  // Other open tag: must be a complete tag alone on the line (type 7),
  // and cannot interrupt a paragraph. Scan attributes to '>' (or '/>').
  let m = k;
  while (true) {
    let w = m;
    while (w < s.length && isSpaceCode(s.charCodeAt(w))) w++;
    if (w >= s.length) return 0;
    const c = s.charCodeAt(w);
    if (c === 62) { // '>'
      // Type 7: the tag must be followed only by whitespace.
      let e = w + 1;
      while (e < s.length && isSpaceCode(s.charCodeAt(e))) e++;
      return e >= s.length ? { type: 7, canInterrupt: false } : 0;
    }
    if (c === 47 && w + 1 < s.length && s.charCodeAt(w + 1) === 62) { // '/>'
      let e = w + 2;
      while (e < s.length && isSpaceCode(s.charCodeAt(e))) e++;
      return e >= s.length ? { type: 7, canInterrupt: false } : 0;
    }
    if (w === m) return 0; // attribute needs preceding whitespace
    // Attribute name.
    if (!(isAlphaCode(c) || c === 95 || c === 58)) return 0;
    w++;
    while (w < s.length) {
      const ac = s.charCodeAt(w);
      if (isAlnumCode(ac) || ac === 95 || ac === 58 || ac === 46 || ac === 45) w++;
      else break;
    }
    let v = w;
    while (v < s.length && isSpaceCode(s.charCodeAt(v))) v++;
    if (v < s.length && s.charCodeAt(v) === 61) { // '='
      v++;
      while (v < s.length && isSpaceCode(s.charCodeAt(v))) v++;
      if (v >= s.length) return 0;
      const vc = s.charCodeAt(v);
      if (vc === 34 || vc === 39) {
        v++;
        while (v < s.length && s.charCodeAt(v) !== vc) v++;
        if (v >= s.length) return 0;
        v++;
      } else {
        const v0 = v;
        while (v < s.length) {
          const uc = s.charCodeAt(v);
          if (isSpaceCode(uc) || uc === 34 || uc === 39 || uc === 61 ||
            uc === 60 || uc === 62 || uc === 96) break;
          v++;
        }
        if (v === v0) return 0;
      }
      w = v;
    }
    m = w;
  }
}

// The end marker for an HTML block of the given type (type 6 needs the
// specific closing tag). Returns {marker, regex} — regex is used for the
// case-insensitive type-6 closing tag.
function htmlBlockEndMarker(type, firstLine) {
  if (type === 1) return { marker: '-->', regex: null };
  if (type === 2) return { marker: '?>', regex: null };
  if (type === 3) return { marker: ']]>', regex: null };
  if (type === 4 || type === 5) return { marker: '>', regex: null };
  if (type === 6) {
    const m = /<\/?(script|pre|style|textarea)/i.exec(firstLine);
    if (m) {
      const tag = m[1].toLowerCase();
      return { marker: '</' + tag + '>', regex: new RegExp('</' + tag + '\\s*>', 'i') };
    }
    return { marker: '>', regex: null };
  }
  return { marker: null, regex: null }; // type 7: ends at a blank line
}

// Does `line` contain the end marker for an HTML block? For types 1-5 the
// marker is a plain substring search; for type 6 it's a case-insensitive
// closing-tag match. `after` skips the start sequence on the first line.
function htmlBlockHasEnd(endInfo, line, after) {
  if (endInfo.regex) return endInfo.regex.test(line.slice(after));
  if (!endInfo.marker) return false;
  return line.indexOf(endInfo.marker, after) !== -1;
}

// ---------------------------------------------------------------- tables

// Is this line (content after indent) a table delimiter row? If so return
// the array of alignments ('left'|'center'|'right'|null) per cell, else null.
// A delimiter cell is ':'? '-' ':'? with optional surrounding spaces.
function parseTableDelimiter(s) {
  // Strip optional leading/trailing pipes and surrounding space.
  let t = s.trim();
  if (t === '') return null;
  if (t.charCodeAt(0) === 124) t = t.slice(1);
  if (t.length > 0 && t.charCodeAt(t.length - 1) === 124) t = t.slice(0, -1);
  if (t.trim() === '') return null;
  const cells = t.split('|');
  const aligns = [];
  for (let k = 0; k < cells.length; k++) {
    const cell = cells[k].trim();
    if (!/^:?-{1,}:?$/.test(cell)) return null;
    const left = cell.charCodeAt(0) === 58;
    const right = cell.charCodeAt(cell.length - 1) === 58;
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return aligns;
}

// Split a table row line into cells. Pipes escaped with backslash and
// pipes inside code spans do not split. Leading/trailing pipes are
// dropped; cells are trimmed of one leading/trailing space each side
// (actually: trimmed of all surrounding whitespace).
function splitTableRow(s) {
  let t = s.trim();
  if (t.charCodeAt(0) === 124) t = t.slice(1);
  if (t.length > 0 && t.charCodeAt(t.length - 1) === 124) t = t.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let k = 0; k < t.length; k++) {
    const c = t.charCodeAt(k);
    if (c === 92 && k + 1 < t.length) {
      const c2 = t.charCodeAt(k + 1);
      if (c2 === 124) { // \| -> | (backslash consumed by the splitter)
        cur += '|';
        k++;
        continue;
      }
      if (c2 === 92) { // \\ stays for the inline parser
        cur += '\\\\';
        k++;
        continue;
      }
    }
    // Marked splits on every unescaped |, even inside a code span:
    // backticks do not protect pipes (only \| does).
    if (c === 124) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += t[k];
  }
  cells.push(cur.trim());
  return cells;
}

// Count the cells of a header line (same splitting as a row).
function countTableCells(s) {
  return splitTableRow(s).length;
}

// ---------------------------------------------------------------- link reference definitions

// Try to parse a link reference definition at the start of `text`
// (a paragraph's content). Returns {end, label, dest, title} (end is the
// index just past the definition) or null. The definition may span lines.
function parseRefDef(text, start) {
  const n = text.length;
  let i = start;
  // Up to 3 spaces indent.
  let ind = 0;
  while (i < n && text.charCodeAt(i) === 32 && ind < 3) { i++; ind++; }
  if (i >= n || text.charCodeAt(i) !== 91) return null; // '['
  const lab = parseLinkLabel(text, i);
  if (!lab || lab.label === '') return null;
  i = lab.end;
  if (i >= n || text.charCodeAt(i) !== 58) return null; // ':'
  i++;
  // Skip whitespace (including newlines).
  i = skipInlineWs(text, i);
  if (i >= n) return null;
  const d = parseLinkDest(text, i);
  if (!d) return null;
  i = d.end;
  // Optional title on the same line or the next. A title needs
  // whitespace separation from the destination.
  let title = null;
  let j = i;
  // Skip spaces/tabs (not newlines yet).
  while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
  const hadWs = j > i;
  let k = j;
  let crossedNL = false;
  if (k < n && text.charCodeAt(k) === 10) {
    // Newline: the title may be on the next line.
    crossedNL = true;
    k++;
    while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
  }
  if (k < n && (hadWs || crossedNL)) {
    const t = parseLinkTitle(text, k);
    if (t) {
      title = t.title;
      j = t.end;
      while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
    }
  }
  // After the definition there must be only whitespace to end of line.
  if (j < n && text.charCodeAt(j) !== 10) {
    // Title-path failure: fall back to a dest-only definition if the
    // dest line is clean (only whitespace after the dest).
    let e = i;
    while (e < n && (text.charCodeAt(e) === 32 || text.charCodeAt(e) === 9)) e++;
    if (e >= n) return { end: e, label: lab.label, dest: d.dest, title: null };
    if (text.charCodeAt(e) === 10) {
      return { end: e + 1, label: lab.label, dest: d.dest, title: null };
    }
    return null;
  }
  const end = j < n ? j + 1 : j; // consume the newline
  return { end, label: lab.label, dest: d.dest, title };
}

// ---------------------------------------------------------------- the block parser

// Does the line at the cursor start a block? Used to decide lazy
// continuation (a line that starts a block is not a lazy paragraph line)
// and to decide when a table ends. `includeIndented` adds indented code
// (which ends a table but cannot interrupt a paragraph). Does not move
// the cursor.
function lineStartsBlock(cur, includeIndented) {
  const ind = measureIndent(cur);
  if (isBlankFrom(cur)) return false;
  if (ind >= 4) return includeIndented;
  if (ind > 3) return false;
  // Peek at the content after the indent.
  const sp = cur.pos, sc = cur.col, st = cur.ptab;
  advanceSpaces(cur, ind);
  const content = restOfLine(cur);
  const c0 = content.charCodeAt(0);
  let result = false;
  if (c0 === 62) result = true; // blockquote
  else if (c0 === 35) { // ATX heading
    let h = 0;
    while (h < content.length && content.charCodeAt(h) === 35) h++;
    result = h >= 1 && h <= 6 &&
      (h === content.length || content.charCodeAt(h) === 32 ||
        content.charCodeAt(h) === 9);
  } else if (c0 === 96 || c0 === 126) { // fenced code
    let f = 0;
    while (f < content.length && content.charCodeAt(f) === c0) f++;
    if (f >= 3) {
      const info = content.slice(f).trim();
      result = !(c0 === 96 && info.indexOf('`') !== -1);
    }
  } else if (c0 === 60) { // HTML block
    const hs = htmlBlockStart(cur);
    result = hs !== 0 && hs.canInterrupt;
  } else if (c0 === 45 || c0 === 95 || c0 === 42) { // thematic break / list
    if (/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(content)) result = true;
    else if (parseListMarker(content)) result = true;
  } else if (c0 === 43) { // '+' list
    result = parseListMarker(content) !== null;
  } else if (c0 >= 48 && c0 <= 57) { // ordered list
    result = parseListMarker(content) !== null;
  }
  cur.pos = sp; cur.col = sc; cur.ptab = st;
  return result;
}

function parseBlocks(input) {
  const inputEndsWithNL = input.endsWith('\n') || input.endsWith('\r');
  const lines = splitLines(input);
  const root = { type: 'doc', children: [] };
  const refs = new Map();
  const stack = [root];
  let lastWasBlank = false;
  // An HTML block (types 1-6) that closed via its end marker and whose
  // trailing newline is still undecided: resolved at the next line.
  let pendingHtml = null;
  // A paragraph whose last line is a tentative whitespace-only line
  // from a quote (cm-241): dropped if a new block starts in the same
  // container, kept otherwise.
  let pendingWsPara = null;

  const isContainer = (b) => b.type === 'quote' || b.type === 'list' || b.type === 'item';
  const isLeaf = (b) => b.type === 'para' || b.type === 'code' || b.type === 'html' || b.type === 'table';

  function finalize(block) {
    if (block.type === 'para') {
      // Parse link reference definitions from the start of the paragraph.
      const text = block.lines.join('\n');
      let pos = 0;
      while (pos < text.length) {
        const def = parseRefDef(text, pos);
        if (!def) break;
        const key = normalizeLabel(def.label);
        if (!refs.has(key)) refs.set(key, { dest: def.dest, title: def.title });
        pos = def.end;
      }
      if (pos > 0) {
        const rest = text.slice(pos);
        if (rest.trim() === '') {
          // The paragraph was only definitions: remove it.
          block.removed = true;
        } else {
          block.lines = rest.split('\n');
        }
      }
    } else if (block.type === 'code' && !block.fenced) {
      // Strip trailing blank lines from indented code.
      while (block.lines.length > 0 &&
        block.lines[block.lines.length - 1].trim() === '') {
        block.lines.pop();
      }
    } else if (block.type === 'html') {
      // A block still open at end of input (or when its container
      // closes): a trailing newline only at the top level when the
      // input ends with one. 'pending' blocks are resolved at the next
      // line start or at the end of the input.
      if (block.trailingNL === undefined) {
        block.trailingNL = block.parentIdx === 0 && inputEndsWithNL;
      }
    }
  }

  function closeTo(idx) {
    while (stack.length > idx) {
      const b = stack.pop();
      finalize(b);
    }
  }

  // Start a new block of the given type as a child of `parent`.
  function addBlock(parent, block) {
    // A new block in the same container drops a pending tentative
    // whitespace line (cm-241).
    if (pendingWsPara && pendingWsPara.parent === parent) {
      pendingWsPara.para.lines.pop();
      pendingWsPara = null;
    }
    parent.children.push(block);
    return block;
  }

  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const cur = makeCursor(line);
    // True once a container prefix (quote marker or item indent) was
    // consumed on this line, in phase 1 or phase 3. Stored content
    // lines then get their leading tabs expanded (marked expands tabs
    // when it strips a container prefix); at the top level tabs stay raw.
    let consumedPrefix = false;
    // Columns consumed by matching list-item indents in phase 1.
    let itemIndentConsumed = 0;
    // Columns consumed by quote matches in phase 1, and by the first
    // one. Nested quotes beyond the first do not count toward the tab
    // column (their width is subtracted).
    let quoteCols = 0, firstQuoteCols = -1;
    // True once this line matched or created a '>' quote marker: such
    // a line is never blank for list-looseness purposes.
    let sawQuoteMarker = false;
    // The line's remaining content, with leading tabs expanded when a
    // container prefix was consumed. Tab columns count quote markers
    // but not list-item indents — but only when a quote marker was
    // matched on this line; a bare item indent still counts. Nested
    // quotes beyond the first do not count either.
    const contentLine = () => consumedPrefix ?
      expandLeadingTabs(restOfLine(cur),
        sawQuoteMarker ? cur.col - itemIndentConsumed -
          (firstQuoteCols === -1 ? 0 : quoteCols - firstQuoteCols) : cur.col) :
      restOfLine(cur);

    // One optional space after a '>' marker. A tab's width is
    // measured from the column relative to item indents consumed
    // before the quote (marked counts tab stops from the container
    // content start, not the absolute column).
    const advanceQuoteSpace = () => {
      const c = curChar(cur);
      if (c === 32) { advanceSpaces(cur, 1); return; }
      if (c !== 9) return;
      const width = 4 - ((cur.col - itemIndentConsumed) % 4);
      if (width <= 1) { cur.pos++; cur.col += width; }
      else { cur.ptab = width - 1; cur.col += 1; }
    };

    // ---- Phase 1: match open containers.
    let i = 1;
    let allMatched = true;
    while (i < stack.length) {
      const b = stack[i];
      if (isLeaf(b)) break;
      if (b.type === 'list') { i++; continue; }
      if (b.type === 'quote') {
        const sp = cur.pos, sc = cur.col, st = cur.ptab;
        const ind = measureIndent(cur);
        if (ind <= 3) {
          advanceSpaces(cur, ind);
          if (curChar(cur) === 62) {
            advanceOne(cur);
            // One optional space after '>'.
            advanceQuoteSpace();
            const qc = cur.col - sc;
            quoteCols += qc;
            if (firstQuoteCols === -1) firstQuoteCols = qc;
            consumedPrefix = true;
            sawQuoteMarker = true;
            i++;
            continue;
          }
        }
        cur.pos = sp; cur.col = sc; cur.ptab = st;
        allMatched = false;
        break;
      }
      if (b.type === 'item') {
        if (isBlankFrom(cur)) { i++; continue; }
        const ind = measureIndent(cur);
        // contentIndent is relative to the container-content-start
        // column, which is cur.col here (enclosing prefixes consumed).
        if (ind >= b.contentIndent) {
          advanceSpaces(cur, b.contentIndent);
          // Only item indents matched before any quote on this line
          // count against the tab column (an item inside a quote
          // keeps its indent in the column).
          if (!sawQuoteMarker) itemIndentConsumed += b.contentIndent;
          consumedPrefix = true;
          i++;
          continue;
        }
        allMatched = false;
        break;
      }
      i++;
    }
    const matchedDepth = i; // stack[0..matchedDepth) matched (containers only)
    // The open leaf block, if any (a leaf is always the stack top).
    // Used by the lazy-continuation check even when containers above
    // it did not match (a lazy line joins the open paragraph).
    const topBlock = stack[stack.length - 1];
    const leaf = isLeaf(topBlock) ? topBlock : null;

    // Resolve a pending HTML block's trailing newline: it gets one iff
    // this line is inside the same container and is not an empty line.
    // (A whitespace-only line still counts: only a truly empty remainder
    // suppresses the newline.)
    if (pendingHtml) {
      pendingHtml.trailingNL = matchedDepth > pendingHtml.parentIdx &&
        hasRemainder(cur);
      pendingHtml = null;
    }

    // ---- Lazy continuation: if containers didn't match but a paragraph
    // is open and the line isn't blank and doesn't start a new block,
    // the line joins the paragraph.
    if (!allMatched && leaf && leaf.type === 'para' && !isBlankFrom(cur) &&
      !lineStartsBlock(cur, false)) {
      // Lazy continuation lines keep their leading whitespace, except
      // that an indent of 4+ columns loses exactly 4 columns (the
      // indented-code indent). A partially-consumed tab's remainder
      // expands to spaces that are content (they come first in
      // contentLine()) and is always kept.
      const ptabKeep = cur.ptab;
      let lazyText = contentLine();
      const head = lazyText.slice(0, ptabKeep);
      let rest = lazyText.slice(ptabKeep);
      let cols = 0, cut = 0;
      for (let k = 0; k < rest.length; k++) {
        const ch = rest.charCodeAt(k);
        if (ch === 32) { cols++; cut = k + 1; if (cols >= 4) break; }
        else if (ch === 9) { cols += 4 - (cols % 4); cut = k + 1; if (cols >= 4) break; }
        else break;
      }
      if (cols >= 4) rest = rest.slice(cut);
      lazyText = head + rest;
      // A lazy setext-underline line whose previous line was also lazy
      // gets exactly four leading spaces when the paragraph's immediate
      // parent is a blockquote (marked's quirk).
      const paraParent = stack[stack.length - 2];
      if (leaf.lastLineLazy && paraParent && paraParent.type === 'quote' &&
        /^(=+|--)[ \t]*$/.test(lazyText)) {
        lazyText = '    ' + lazyText;
      }
      leaf.lines.push(lazyText);
      leaf.lastLineLazy = true;
      lastWasBlank = false;
      continue;
    }

    // Lazy fenced-code continuation: a non-blank line that doesn't match
    // a list item still belongs to an open fenced code block — unless it
    // looks like a closing fence, which closes the block (and the line
    // then starts a new block in phase 3). Lazy content keeps its raw
    // text (no indent stripping). A line that fails a blockquote is NOT
    // lazy (the quote closes), and blank lines are never lazy here.
    // The quote check scans all unmatched containers above the fence,
    // not just the one where matching stopped.
    let failsQuote = false;
    if (!allMatched && leaf && leaf.type === 'code' && leaf.fenced) {
      for (let q = matchedDepth; q < stack.length - 1; q++) {
        if (stack[q].type === 'quote') { failsQuote = true; break; }
      }
    }
    if (!allMatched && leaf && leaf.type === 'code' && leaf.fenced &&
      !isBlankFrom(cur) && !failsQuote &&
      leaf.lines.some(l => /[^ \t]/.test(l))) {
      let isFence = false;
      const ind = measureIndent(cur);
      if (ind <= 3) {
        const savePos = cur.pos, saveCol = cur.col, savePtab = cur.ptab;
        advanceSpaces(cur, ind);
        if (curChar(cur) === leaf.fenceChar) {
          let j = cur.pos;
          let run = 0;
          while (j < line.length && line.charCodeAt(j) === leaf.fenceChar) { j++; run++; }
          if (run >= leaf.fenceLen && line.slice(j).trim() === '') isFence = true;
        }
        cur.pos = savePos; cur.col = saveCol; cur.ptab = savePtab;
      }
      if (!isFence) {
        leaf.lines.push(contentLine());
        lastWasBlank = false;
        continue;
      }
    }
    if (!allMatched) {
      // Close unmatched containers and the leaf.
      closeTo(matchedDepth);
    }

    // The current container is the deepest matched container.
    let container = stack[stack.length - 1];
    if (isLeaf(container)) container = stack[stack.length - 2];

    // ---- Phase 2: handle the open leaf (if any).
    let leafHandled = false;
    if (leaf && allMatched) {
      if (leaf.type === 'code' && leaf.fenced) {
        // Closing fence? Same char, >= opening length, no info, <=3 indent.
        const ind = measureIndent(cur);
        if (ind <= 3) {
          const savePos = cur.pos, saveCol = cur.col, savePtab = cur.ptab;
          advanceSpaces(cur, ind);
          const c0 = curChar(cur);
          if (c0 === leaf.fenceChar) {
            let j = cur.pos;
            let run = 0;
            while (j < line.length && line.charCodeAt(j) === leaf.fenceChar) { j++; run++; }
            let rest = line.slice(j);
            if (run >= leaf.fenceLen && rest.trim() === '') {
              closeTo(stack.length - 1); // close the code block
              leafHandled = true;
            }
          }
          if (!leafHandled) { cur.pos = savePos; cur.col = saveCol; cur.ptab = savePtab; }
        }
        if (!leafHandled) {
          // Content line: remove up to the opening fence's indent.
          const ptabBefore = cur.ptab;
          advanceSpaces(cur, Math.min(measureIndent(cur), leaf.fenceIndent));
          // Marked drops a tab partially consumed by the fence-indent
          // strip (no space remainder). A tab already partial from a
          // container prefix keeps its remainder (doc-25).
          if (ptabBefore === 0 && cur.ptab > 0) { cur.pos++; cur.ptab = 0; }
          leaf.lines.push(contentLine());
          lastWasBlank = false;
          continue;
        }
      } else if (leaf.type === 'code' && !leaf.fenced) {
        if (isBlankFrom(cur)) {
          // A blank line inside indented code keeps (indent - 4)
          // spaces: only the block's 4-space indent is stripped.
          const ind = measureIndent(cur);
          leaf.lines.push(ind > 4 ? ' '.repeat(ind - 4) : '');
          lastWasBlank = false;
          continue;
        }
        const ind = measureIndent(cur);
        if (ind >= 4) {
          advanceSpaces(cur, 4);
          leaf.lines.push(contentLine());
          lastWasBlank = false;
          continue;
        }
        // Not indented enough: close the code block, fall through.
        closeTo(stack.length - 1);
        container = stack[stack.length - 1];
      } else if (leaf.type === 'html') {
        if (leaf.htmlType === 7) {
          if (isBlankFrom(cur)) {
            // Type 7 ends at a blank line: no trailing newline.
            leaf.trailingNL = false;
            closeTo(stack.length - 1);
            container = stack[stack.length - 1];
          } else {
            leaf.lines.push(contentLine());
            lastWasBlank = false;
            continue;
          }
        } else {
          const content = contentLine();
          leaf.lines.push(content);
          if (htmlBlockHasEnd(leaf.endInfo, content, 0)) {
            leaf.trailingNL = 'pending';
            closeTo(stack.length - 1);
            pendingHtml = leaf;
            container = stack[stack.length - 1];
          }
          lastWasBlank = false;
          continue;
        }
      } else if (leaf.type === 'table') {
        if (isBlankFrom(cur)) {
          // A whitespace-only line containing a tab is an empty table
          // row (marked); a spaces-only or empty line ends the table.
          let hasTab = cur.ptab > 0;
          if (!hasTab) {
            for (let p = cur.pos; p < cur.line.length; p++) {
              if (cur.line.charCodeAt(p) === 9) { hasTab = true; break; }
            }
          }
          if (hasTab) {
            leaf.rows.push(splitTableRow(restOfLine(cur)));
            lastWasBlank = false;
            continue;
          }
          closeTo(stack.length - 1);
          container = stack[stack.length - 1];
        } else if (lineStartsBlock(cur, true)) {
          // A line that starts a new block ends the table.
          closeTo(stack.length - 1);
          container = stack[stack.length - 1];
        } else {
          leaf.rows.push(splitTableRow(restOfLine(cur)));
          lastWasBlank = false;
          continue;
        }
      } else if (leaf.type === 'para') {
        // Setext underline?
        const ind = measureIndent(cur);
        if (ind <= 3) {
          const savePos = cur.pos, saveCol = cur.col, savePtab = cur.ptab;
          advanceSpaces(cur, ind);
          const rest = restOfLine(cur);
          const setext = /^=+ *$/.test(rest) ? 1 :
            /^-+ *$/.test(rest) ? 2 : 0;
          if (setext > 0) {
            // Convert the paragraph to a heading.
            const para = stack.pop();
            finalize(para);
            if (para.removed) {
              // The paragraph was only ref defs: remove it and let
              // phase 3 handle this line as a new block.
              const parent = stack[stack.length - 1];
              const idx = parent.children.indexOf(para);
              if (idx !== -1) parent.children.splice(idx, 1);
              cur.pos = savePos; cur.col = saveCol; cur.ptab = savePtab;
            } else {
              // Setext heading content: strip the first line's leading
              // whitespace and trim the last line's trailing whitespace.
              const lines = para.lines.slice();
              lines[0] = lines[0].replace(/^[ \t]+/, '');
              lines[lines.length - 1] =
                lines[lines.length - 1].replace(/[ \t]+$/, '');
              const heading = {
                type: 'heading', level: setext,
                inline: lines.join('\n'),
              };
              // Replace the paragraph in its parent with the heading.
              const parent = stack[stack.length - 1];
              const idx = parent.children.indexOf(para);
              parent.children[idx] = heading;
              lastWasBlank = false;
              leafHandled = true;
              continue;
            }
          } else {
            // Table delimiter?
            const aligns = parseTableDelimiter(rest);
            if (aligns) {
            const para = leaf;
            const headerLine = para.lines[para.lines.length - 1];
            const headerCells = splitTableRow(headerLine);
            if (headerCells.length === aligns.length) {
              // Form a table: pop the header line from the paragraph.
              para.lines.pop();
              stack.pop();
              finalize(para);
              if (para.removed || para.lines.length === 0) {
                // Remove the (now empty) paragraph from its parent.
                const parent = stack[stack.length - 1];
                const idx = parent.children.indexOf(para);
                if (idx !== -1) parent.children.splice(idx, 1);
              }
              const table = {
                type: 'table', header: headerCells, aligns, rows: [],
              };
              addBlock(stack[stack.length - 1], table);
              stack.push(table);
              lastWasBlank = false;
              leafHandled = true;
              continue;
            }
            // Delimiter doesn't match: split the paragraph — the header
            // candidate line starts a new paragraph (marked's behavior).
            para.lines.pop();
            stack.pop();
            finalize(para);
            if (para.removed || para.lines.length === 0) {
              const parent = stack[stack.length - 1];
              const idx = parent.children.indexOf(para);
              if (idx !== -1) parent.children.splice(idx, 1);
            }
            const newPara = { type: 'para', lines: [headerLine, rest] };
            addBlock(stack[stack.length - 1], newPara);
            stack.push(newPara);
            lastWasBlank = false;
            leafHandled = true;
            continue;
            }
          }
          // A '-' thematic break that isn't a setext underline (e.g.
          // "--- -") still interrupts the paragraph: close it here so
          // phase 3 can start the hr.
          if (rest.charCodeAt(0) === 45 &&
            /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest)) {
            closeTo(stack.length - 1);
          }
          cur.pos = savePos; cur.col = saveCol; cur.ptab = savePtab;
        }
        // Otherwise the paragraph continues below (phase 3 checks for
        // interrupting blocks first).
      }
    }
    if (leafHandled) continue;

    // ---- Phase 3: start new blocks (loop for nested containers).
    // `cur` is positioned after the matched container prefixes.
    while (true) {
      const ind = measureIndent(cur);
      const blank = isBlankFrom(cur);
      if (blank) {
        const t = stack[stack.length - 1];
        if (t && t.type === 'para') {
          if (sawQuoteMarker) {
            // A whitespace-only line inside a quote joins the open
            // paragraph as a content line (tentatively: dropped if a
            // new block starts in the same container afterwards).
            // Only when actual whitespace remains after the quote
            // marker (a bare '>' or '> ' appends nothing).
            const wsLine = contentLine();
            if (wsLine !== '') t.lines.push(wsLine);
            closeTo(stack.length - 1);
            if (!t.removed && wsLine !== '') {
              pendingWsPara = { para: t, parent: stack[stack.length - 1] };
            }
          } else {
            closeTo(stack.length - 1);
          }
        }
        // A blank line closes an empty list item (one with no blocks).
        let top = stack[stack.length - 1];
        while (top && top.type === 'item' && top.children.length === 0) {
          closeTo(stack.length - 1);
          top = stack[stack.length - 1];
        }
        // A blank line counts for list looseness unless it sits inside
        // a blockquote (a blank line in a quote separates quote blocks,
        // not list blocks). The innermost container decides: an item
        // (or the document) means the blank line is a list-level blank.
        lastWasBlank = stack[stack.length - 1].type !== 'quote';
        break;
      }
      // If the stack top is a list and this line doesn't start a list
      // item joining it, close the list first (the new block is a
      // sibling of the list, not a child).
      const topBlock = stack[stack.length - 1];
      if (topBlock && topBlock.type === 'list') {
        const sp2 = cur.pos, sc2 = cur.col, st2 = cur.ptab;
        if (ind <= 3) advanceSpaces(cur, ind);
        const peekContent = restOfLine(cur);
        const peekInfo = parseListMarker(peekContent);
        cur.pos = sp2; cur.col = sc2; cur.ptab = st2;
        // A thematic break takes precedence over a list item.
        const isHr = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(peekContent);
        const joins = !isHr && peekInfo &&
          peekInfo.bullet === topBlock.bullet &&
          peekInfo.delim === topBlock.delim && peekInfo.char === topBlock.char;
        if (!joins) closeTo(stack.length - 1);
      }
      // Save the cursor: block starts consume up to 3 spaces of indent,
      // but a paragraph line keeps its leading spaces.
      const sp = cur.pos, sc = cur.col, st = cur.ptab;
      if (ind <= 3) advanceSpaces(cur, ind);
      const content = restOfLine(cur);
      const c0 = content.charCodeAt(0);

      // Thematic break: 3+ of -, _, * with optional spaces/tabs.
      if (ind <= 3 && (c0 === 45 || c0 === 95 || c0 === 42) &&
        /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(content)) {
        // A '-' thematic break can't interrupt a paragraph (it's a
        // setext underline — handled in phase 2). '_' and '*' can.
        const t = stack[stack.length - 1];
        if (!(t && t.type === 'para' && c0 === 45)) {
          if (t && t.type === 'para') closeTo(stack.length - 1);
          addBlock(stack[stack.length - 1], { type: 'hr' });
          if (lastWasBlank) markLoose(stack);
          lastWasBlank = false;
          break;
        }
      }

      // ATX heading.
      if (ind <= 3 && c0 === 35) {
        let h = 0;
        while (h < content.length && content.charCodeAt(h) === 35) h++;
        if (h >= 1 && h <= 6 &&
          (h === content.length || content.charCodeAt(h) === 32 ||
            content.charCodeAt(h) === 9)) {
          // Strip a closing sequence of #'s (only when preceded by space).
          // The closing strip runs BEFORE the trim, so a heading that
          // is only a closing sequence (e.g. "### ###") comes out empty.
          const text = content.slice(h).replace(/[ \t]+#+[ \t]*$/, '').trim();
          const t = stack[stack.length - 1];
          if (t && t.type === 'para') closeTo(stack.length - 1);
          addBlock(stack[stack.length - 1], {
            type: 'heading', level: h, inline: text,
          });
          if (lastWasBlank) markLoose(stack);
          lastWasBlank = false;
          break;
        }
      }

      // Fenced code block.
      if (ind <= 3 && (c0 === 96 || c0 === 126)) {
        let f = 0;
        while (f < content.length && content.charCodeAt(f) === c0) f++;
        if (f >= 3) {
          const info = content.slice(f).trim();
          if (!(c0 === 96 && info.indexOf('`') !== -1)) {
            const t = stack[stack.length - 1];
            if (t && t.type === 'para') closeTo(stack.length - 1);
            const code = {
              type: 'code', fenced: true, fenceChar: c0, fenceLen: f,
              // Marked strips the opening fence's indent from content
              // lines for backtick fences only; tilde fences keep it.
              fenceIndent: c0 === 96 ? ind : 0, info, lines: [],
            };
            addBlock(stack[stack.length - 1], code);
            stack.push(code);
            if (lastWasBlank) markLoose(stack);
            lastWasBlank = false;
            break;
          }
        }
      }

      // HTML block.
      if (ind <= 3 && c0 === 60) {
        const hs = htmlBlockStart(cur);
        if (hs !== 0) {
          const t = stack[stack.length - 1];
          const paraOpen = t && t.type === 'para';
          if (!paraOpen || hs.canInterrupt) {
            if (paraOpen) closeTo(stack.length - 1);
            const endInfo = htmlBlockEndMarker(hs.type, content);
            // The first line keeps its original text, including the
            // leading indent (up to 3 spaces).
            cur.pos = sp; cur.col = sc; cur.ptab = st;
            const html = {
              type: 'html', htmlType: hs.type, lines: [contentLine()],
              endInfo, parentIdx: stack.length - 1,
              trailingNL: undefined,
            };
            addBlock(stack[stack.length - 1], html);
            const startLen = hs.type === 1 ? 4 : hs.type === 2 ? 2 :
              hs.type === 3 ? 9 : hs.type === 4 ? 3 : hs.type === 5 ? 4 : 0;
            let closesNow = hs.type !== 7 &&
              htmlBlockHasEnd(endInfo, content, startLen);
            if (hs.type === 1 && !closesNow) {
              // <!--> and <!---> are complete comments on their own.
              closesNow = content.startsWith('<!-->') ||
                content.startsWith('<!--->');
            }
            if (closesNow) {
              html.trailingNL = 'pending';
              pendingHtml = html;
            } else {
              stack.push(html);
            }
            if (lastWasBlank) markLoose(stack);
            lastWasBlank = false;
            break;
          }
        }
      }

      // Blockquote.
      if (ind <= 3 && c0 === 62) {
        const t = stack[stack.length - 1];
        if (t && t.type === 'para') closeTo(stack.length - 1);
        const quote = { type: 'quote', children: [] };
        addBlock(stack[stack.length - 1], quote);
        stack.push(quote);
        if (lastWasBlank) markLoose(stack);
        lastWasBlank = false;
        advanceOne(cur);
        advanceQuoteSpace();
        consumedPrefix = true;
        sawQuoteMarker = true;
        continue;
      }

      // List item.
      if (ind <= 3) {
        const listInfo = parseListMarker(content);
        if (listInfo) {
          const t = stack[stack.length - 1];
          const paraOpen = t && t.type === 'para';
          // An empty list item (nothing but whitespace after the
          // marker) cannot interrupt a paragraph.
          let emptyItem = true;
          for (let e = listInfo.markerLen; e < content.length; e++) {
            const ec = content.charCodeAt(e);
            if (ec !== 32 && ec !== 9) { emptyItem = false; break; }
          }
          // An ordered list starting with a number other than 1 cannot
          // interrupt a paragraph — except when the paragraph's parent
          // is a list item (marked lets any start interrupt there).
          const paraParentIsItem = paraOpen &&
            stack[stack.length - 2] &&
            stack[stack.length - 2].type === 'item';
          if ((!paraOpen || listInfo.bullet || listInfo.start === 1 ||
            paraParentIsItem) && !(paraOpen && emptyItem)) {
            if (paraOpen) closeTo(stack.length - 1);
            // Find or create the list: join the open parent list, a
            // matching just-closed sibling list, or create a new one.
            let list = null;
            let listOnStack = false;
            const parent = stack[stack.length - 1];
            const matches = (l) => l.bullet === listInfo.bullet &&
              l.delim === listInfo.delim && l.char === listInfo.char;
            if (parent.type === 'list' && matches(parent)) {
              list = parent;
              listOnStack = true;
            } else {
              const lastChild = parent.children[parent.children.length - 1];
              if (lastChild && lastChild.type === 'list' && matches(lastChild)) {
                list = lastChild;
              }
            }
            const isNewList = list === null;
            if (isNewList) {
              list = {
                type: 'list', bullet: listInfo.bullet,
                start: listInfo.bullet ? null : listInfo.start,
                delim: listInfo.delim, char: listInfo.char,
                tight: true, children: [],
              };
              addBlock(parent, list);
            }
            if (lastWasBlank) {
              if (!isNewList) list.tight = false; // blank between items
              else markLoose(stack); // blank before a new nested list
            }
            // Compute the content indent (columns, relative to the
            // container-content-start column sc).
            const markerCol = cur.col - sc;
            const markerWidth = listInfo.markerLen;
            for (let m = 0; m < markerWidth; m++) advanceOne(cur);
            const wsStart = cur.col;
            let p = cur.pos;
            let col = cur.col;
            let ptab = cur.ptab;
            const lineStr = cur.line;
            while (true) {
              if (ptab > 0) { col += ptab; ptab = 0; p++; continue; }
              if (p >= lineStr.length) break;
              const ch = lineStr.charCodeAt(p);
              if (ch === 32) { p++; col++; }
              else if (ch === 9) { col += 4 - (col % 4); p++; }
              else break;
            }
            const wsCols = col - wsStart;
            const blankItem = p >= lineStr.length;
            let contentIndent;
            if (blankItem || wsCols >= 5) {
              contentIndent = markerCol + markerWidth + 1;
              advanceSpaces(cur, 1);
            } else {
              contentIndent = markerCol + markerWidth + wsCols;
              advanceSpaces(cur, wsCols);
            }
            consumedPrefix = true;
            const item = {
              type: 'item', children: [], contentIndent,
              markerCol,
            };
            list.children.push(item);
            if (!listOnStack) stack.push(list);
            stack.push(item);
            lastWasBlank = false;
            // A blank item has no content on this line: done.
            if (blankItem) break;
            continue;
          }
        }
      }

      // Indented code (only when no paragraph is open).
      if (ind >= 4) {
        const t = stack[stack.length - 1];
        if (!(t && t.type === 'para')) {
          // Restore the cursor (we only advanced when ind <= 3, so the
          // cursor is already at the container prefix here).
          cur.pos = sp; cur.col = sc; cur.ptab = st;
          advanceSpaces(cur, 4);
          const code = {
            type: 'code', fenced: false, info: '', lines: [contentLine()],
          };
          addBlock(stack[stack.length - 1], code);
          stack.push(code);
          if (lastWasBlank) markLoose(stack);
          lastWasBlank = false;
          break;
        }
      }

      // Paragraph (or continuation of the open paragraph). Restore the
      // cursor so the line keeps its leading spaces.
      cur.pos = sp; cur.col = sc; cur.ptab = st;
      {
        const t = stack[stack.length - 1];
        if (t && t.type === 'para') {
          t.lines.push(contentLine());
          t.lastLineLazy = false;
          lastWasBlank = false;
          break;
        }
        const para = { type: 'para', lines: [contentLine()] };
        addBlock(stack[stack.length - 1], para);
        stack.push(para);
        if (lastWasBlank) markLoose(stack);
        lastWasBlank = false;
        break;
      }
    }
  }

  // A block that closed on the last line: trailing newline only at the
  // top level when the input ends with one.
  if (pendingHtml) {
    pendingHtml.trailingNL = pendingHtml.parentIdx === 0 && inputEndsWithNL;
    pendingHtml = null;
  }

  // Close all remaining open blocks.
  closeTo(1);

  // Mark loose lists: a list is loose if a blank line separated two of
  // its items or two blocks within an item (tracked via markLoose).
  return { root, refs };

  // Helper: when a new block starts after a blank line inside an item,
  // the item's list becomes loose — but only if the item already had a
  // block (the new block is not the item's first). Called after the new
  // block was added, so "already had a block" means >1 child.
  function markLoose(st) {
    for (let s = st.length - 1; s >= 1; s--) {
      if (st[s].type === 'item') {
        const list = st[s - 1];
        if (list && list.type === 'list') {
          if (st[s].children.length > 1) list.tight = false;
        }
        return;
      }
    }
  }
}

// Parse a list marker at the start of `content` (already indent-stripped).
// Returns {bullet, start, delim, markerLen} or null.
function parseListMarker(content) {
  const c0 = content.charCodeAt(0);
  if (c0 === 45 || c0 === 43 || c0 === 42) { // - + *
    if (content.length === 1) return { bullet: true, start: null, delim: null, markerLen: 1, char: c0 };
    const c1 = content.charCodeAt(1);
    if (c1 === 32 || c1 === 9) {
      return { bullet: true, start: null, delim: null, markerLen: 1, char: c0 };
    }
    return null;
  }
  if (c0 >= 48 && c0 <= 57) {
    let j = 0;
    while (j < content.length && content.charCodeAt(j) >= 48 &&
      content.charCodeAt(j) <= 57) j++;
    if (j > 9) return null; // too many digits
    if (j < content.length) {
      const d = content.charCodeAt(j);
      if ((d === 46 || d === 41) &&
        (j + 1 === content.length || content.charCodeAt(j + 1) === 32 ||
          content.charCodeAt(j + 1) === 9)) {
        return {
          bullet: false, start: parseInt(content.slice(0, j), 10),
          delim: d === 46 ? '.' : ')', markerLen: j + 1, char: 0,
        };
      }
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- rendering

function renderBlock(block, refs, out) {
  switch (block.type) {
    case 'doc':
      for (const child of block.children) renderBlock(child, refs, out);
      break;
    case 'para': {
      if (block.removed) break;
      out.push('<p>' + parseInline(block.lines.join('\n'), refs) + '</p>\n');
      break;
    }
    case 'heading':
      out.push('<h' + block.level + '>' + parseInline(block.inline, refs) +
        '</h' + block.level + '>\n');
      break;
    case 'code': {
      let literal = block.lines.length > 0 ?
        block.lines.join('\n') + '\n' : '';
      // Fenced code: drop exactly one trailing newline when the last
      // content line is blank.
      if (block.fenced && block.lines.length > 0 &&
        block.lines[block.lines.length - 1] === '' &&
        literal.endsWith('\n')) {
        literal = literal.slice(0, -1);
      }
      let tag = '<pre><code';
      if (block.fenced && block.info !== '') {
        const lang = block.info.split(/\s+/)[0];
        tag += ' class="language-' +
          escapeTitle(unescapeBackslashes(lang)) + '"';
      }
      tag += '>' + escapeText(literal) + '</code></pre>\n';
      out.push(tag);
      break;
    }
    case 'quote':
      out.push('<blockquote>\n');
      for (const child of block.children) renderBlock(child, refs, out);
      out.push('</blockquote>\n');
      break;
    case 'list': {
      const tag = block.bullet ? 'ul' : 'ol';
      let open = '<' + tag;
      if (!block.bullet && block.start !== 1) open += ' start="' + block.start + '"';
      open += '>\n';
      out.push(open);
      for (const item of block.children) renderItem(item, block.tight, refs, out);
      out.push('</' + tag + '>\n');
      break;
    }
    case 'html':
      out.push(block.lines.join('\n') + (block.trailingNL ? '\n' : ''));
      break;
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let k = 0; k < block.header.length; k++) {
        const a = block.aligns[k];
        out.push('<th' + (a ? ' align="' + a + '"' : '') + '>' +
          parseInline(block.header[k], refs) + '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (block.rows.length > 0) {
        out.push('<tbody>');
        for (const row of block.rows) {
          out.push('<tr>\n');
          for (let k = 0; k < block.header.length; k++) {
            const a = block.aligns[k];
            const cell = k < row.length ? row[k] : '';
            out.push('<td' + (a ? ' align="' + a + '"' : '') + '>' +
              parseInline(cell, refs) + '</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody></table>\n');
      } else {
        out.push('</table>\n');
      }
      break;
    }
    case 'hr':
      out.push('<hr>\n');
      break;
    default:
      break;
  }
}

function renderItem(item, tight, refs, out) {
  out.push('<li>');
  const parts = [];
  let firstChild = true;
  for (const child of item.children) {
    if (child.removed) continue;
    if (child.type === 'para' && firstChild) {
      // Task list item: [ ] / [x] / [X] + space(s) at the start of the
      // first paragraph, with non-empty content after the marker.
      const text = child.lines.join('\n');
      const m = /^\[( |x|X)\][ \t]+/.exec(text);
      if (m) {
        const rest = text.slice(m[0].length);
        if (rest.trim() !== '') {
          const box = m[1] === ' ' ?
            '<input disabled="" type="checkbox"> ' :
            '<input checked="" disabled="" type="checkbox"> ';
          if (tight) parts.push(box + parseInline(rest, refs));
          else parts.push('<p>' + box + parseInline(rest, refs) + '</p>\n');
          firstChild = false;
          continue;
        }
      }
    }
    if (child.type === 'para' && tight) {
      parts.push(parseInline(child.lines.join('\n'), refs));
    } else {
      const sub = [];
      renderBlock(child, refs, sub);
      parts.push(sub.join(''));
    }
    firstChild = false;
  }
  for (let k = 0; k < parts.length; k++) {
    out.push(parts[k]);
  }
  out.push('</li>\n');
}

// ---------------------------------------------------------------- entry point

export function parse(markdown) {
  inlineInLink = false;
  const { root, refs } = parseBlocks(markdown);
  const out = [];
  renderBlock(root, refs, out);
  return out.join('');
}

export default parse;
