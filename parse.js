// A fast drop-in for marked 18.1.3 (default options, GFM on): parse(markdown)
// returns exactly the HTML marked renders, byte for byte. Dependency-free,
// single pass block parser plus a recursive inline parser. Written from the
// CommonMark 0.31.2 + GFM 0.29 specs and marked's observable behaviour.

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// ASCII punctuation (CommonMark): !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
function isPunct(cc) {
  return (cc >= 33 && cc <= 47) || (cc >= 58 && cc <= 64) || (cc >= 91 && cc <= 96) || (cc >= 123 && cc <= 126);
}
// Unicode punctuation or symbol (general categories P and S). Only used for
// non-ASCII characters, which are rare in practice; the regex is compiled once.
const UNI_PUNCT = /[\p{P}\p{S}]/u;
function isUnicodePunct(ch) {
  return UNI_PUNCT.test(ch);
}
function isPunctChar(ch) {
  const cc = ch.charCodeAt(0);
  return cc < 128 ? isPunct(cc) : isUnicodePunct(ch);
}
function isSpace(cc) {
  return cc === 32 || cc === 9 || cc === 10 || cc === 13 || cc === 11 || cc === 12;
}
function isAlnum(ch) {
  const cc = ch.charCodeAt(0);
  if (cc < 128) return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122);
  return /[\p{L}\p{N}]/u.test(ch);
}

// Escape HTML text. encode=true escapes every & < > " '; encode=false leaves
// a & alone when it starts something that looks like a character reference
// (&#123; &#x1f; or &name;), matching marked's escapeHtmlEntities.
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESC_REPLACE = /[&<>"']/g;
function esc(s, encode) {
  if (encode) {
    return ESC_TEST.test(s) ? s.replace(ESC_REPLACE, (c) => ESC_MAP[c]) : s;
  }
  return ESC_TEST_NO_ENCODE.test(s) ? s.replace(ESC_REPLACE_NO_ENCODE, (c) => ESC_MAP[c]) : s;
}

// Decode numeric character references in text: &#35; &#x1F600; &#0;.
// Zero, surrogates and out-of-range values become U+FFFD; a decoded & is
// re-escaped so it cannot join its neighbours into a new reference.
const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeNumericRefs(text) {
  if (!text.includes('&') || !NUM_REF.test(text)) return text;
  return text.replace(NUM_REF_OR_AMP, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

// Percent-encode a URL the way marked does: encodeURI, then un-double-encode
// any %25 back to %. Returns null when the URL cannot be encoded.
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

// The dangerous-protocol guard marked applies to link destinations: after
// decoding, a destination starting with javascript:, vbscript: or data:
// makes the link render as plain text.
const BAD_PROTO = /^(?:javascript|vbscript|data):/i;
function urlIsSafe(href) {
  let decoded = href;
  try { decoded = decodeURIComponent(href.replace(/\\(.)/g, '$1')); } catch { /* keep raw */ }
  decoded = decoded.replace(/[^\w:]/g, '');
  return !BAD_PROTO.test(decoded);
}

// Normalise a link label for definition/reference matching: trim, collapse
// inner whitespace runs to one space, Unicode case-fold via lower-upper-lower.
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the closing bracket of a balanced pair starting inside str (str holds
// the text after the opening bracket). Returns its index, -2 when the brackets
// never balance, -1 when there is no closing bracket at all. Backslashes
// escape the next character.
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') { i++; continue; }
    if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

// Split a table row into cells. An escaped \| is not a delimiter; leading and
// trailing pipes are dropped; cells are trimmed and \| becomes |.
function splitCells(row, count) {
  const cells = [];
  let cur = '', i = 0, n = row.length;
  while (i < n) {
    const c = row[i];
    if (c === '\\' && i + 1 < n && row[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (c === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  cells.push(cur);
  // Drop an empty first cell (leading pipe) and empty last cell (trailing pipe).
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.length = count;
    else while (cells.length < count) cells.push('');
  }
  for (let j = 0; j < cells.length; j++) cells[j] = cells[j].trim();
  return cells;
}

// Expand the leading whitespace of a line to spaces (tab stops of 4).
// Interior tabs are kept: only leading whitespace decides the indent.
function expandLeadingTabs(line, baseCol) {
  let i = 0, col = baseCol || 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { col++; i++; continue; }
    if (c === '\t') { col += 4 - (col % 4); i++; continue; }
    break;
  }
  if (i === 0 || !line.slice(0, i).includes('\t')) return line;
  return ' '.repeat(col - (baseCol || 0)) + line.slice(i);
}

// Column width of the leading whitespace (a tab jumps to the next multiple
// of 4). Any leading tab makes the indent at least 4, so a line with an
// indent below 4 has only spaces up front and slice(indent) is exact.
function indentOf(line) {
  let col = 0, i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return col;
}
// Remove one indented-code indent from a raw line: up to 4 spaces, or up to
// 3 spaces plus a tab. The rest of the line (tabs included) is kept.
function removeCodeIndent(line) {
  const m = /^(?: {0,3}\t| {1,4})/.exec(line);
  return m ? line.slice(m[0].length) : line;
}
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ---------- inline parser ----------
// The inline grammar is marked 18.1.3's GFM set, used verbatim: the same
// regexes drive the same decisions, so the same input yields the same HTML.
// The win over marked is structural (no token objects, direct string
// emission, a hand-rolled text scanner) rather than a different grammar.

const INLINE_ESCAPE = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/y;
const INLINE_CODE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
const INLINE_BR = /( {2,}|\\)\n(?!\s*$)[ \t]*/y;
const INLINE_TAG = /<!--(?:-?>|[\s\S]*?-->)|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|<\?[\s\S]*?\?>|<![a-zA-Z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>/y;
const INLINE_AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/y;
const INLINE_URL = /(?:(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-]))/y;
const INLINE_BACKPEDAL = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
// A link label: at most two levels of nested brackets, escapes, code spans.
const INLINE_LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const INLINE_LABEL = /(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/;
const INLINE_LINK = new RegExp('!?\\[(' + INLINE_LABEL.source + ')\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^\\)\\\\])*\\)))?[ \\t\\n]*\\)', 'y');
const BLOCK_LABEL = /(?!\\s*\\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const INLINE_REFLINK = new RegExp('!?\\[(' + INLINE_LABEL.source + ')\\]\\[(' + BLOCK_LABEL.source + ')\\]', 'y');
const INLINE_NOLINK = new RegExp('!?\\[(' + BLOCK_LABEL.source + ')\\](?:\\[\\])?', 'y');
// Bounded labels for the masked-source search (labels cap at 999 items).
const BOUNDED_BLOCK_LABEL = /(?!\\s*\\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = /(?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/;
const REFLINK_SEARCH = new RegExp('!?\\[(' + BOUNDED_INLINE_LABEL.source + ')\\]\\[(' + BOUNDED_BLOCK_LABEL.source + ')\\]|!?\\[(' + BOUNDED_BLOCK_LABEL.source + ')\\](?:\\[\\])?(?!\\()', 'g');
const BLOCK_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const ANY_PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
// Emphasis delimiters (GFM set: ~ is not punctuation for * / _ runs).
const EMSTRONG_LDELIM = /(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/uy;
const EMSTRONG_RDELIM_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const EMSTRONG_RDELIM_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const DEL_LDELIM = /~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/uy;
const DEL_RDELIM = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const PUNCT_OR_SPACE_NOT_STAR_UND = /^((?![*_])[\s\p{P}\p{S}])/u;
const UNICODE_ALNUM = /[\p{L}\p{N}]/u;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_SCRIPT_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_SCRIPT_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;

// Does this link text already hold a link? An image does not count.
function linkInText(text, refs) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(BLOCK_SKIP)) {
    INLINE_LINK.lastIndex = 0;
    if (INLINE_LINK.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(REFLINK_SEARCH)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(refs, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1), refs)) continue;
    return true;
  }
  return false;
}

// True when the label's closing bracket is swallowed by a tag or autolink
// that starts inside the label and runs past its end.
function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      INLINE_CODE.lastIndex = i;
      const code = INLINE_CODE.exec(label);
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    INLINE_TAG.lastIndex = 0;
    INLINE_AUTOLINK.lastIndex = 0;
    const token = INLINE_TAG.exec(tokenSrc) || INLINE_AUTOLINK.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Mask links, escapes and code spans out of the source so emphasis closers
// cannot be found inside them. Every mask keeps the length it replaces.
function maskSrc(src, refs) {
  let masked = src;
  if (refs && src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(refs, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text, refs)) {
          return '[' + text.replace(REFLINK_SEARCH, maskReflink) + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    masked = masked.replace(REFLINK_SEARCH, maskReflink);
  }
  if (src.includes('`') || src.includes('\\')) {
    masked = masked.replace(ANY_PUNCT_OUTSIDE_CODE, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(BLOCK_SKIP, (match0) => '[' + 'a'.repeat(match0.length - 2) + ']');
  }
  return masked;
}

// One scan for the last delimiter run that can close emphasis, strong or
// strikethrough. A run can close only when it is not preceded by ASCII
// whitespace or the start of the string.
function scanClosers(masked) {
  const out = { '*': -1, _: -1, '~': -1 };
  const len = masked.length;
  for (let i = 0; i < len; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < len && masked[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      out[ch] = i;
    }
    i = j - 1;
  }
  return out;
}

// ---------- inline helpers ----------
function isAsciiAlnum(ch) {
  if (!ch) return false;
  const cc = ch.charCodeAt(0);
  return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122);
}
function isEmailLocal(ch) {
  if (!ch) return false;
  const cc = ch.charCodeAt(0);
  if (cc >= 128) return false;
  return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)
    || '.!#$%&\'*+/=?^_`{|}~-'.indexOf(ch) !== -1;
}
function isUrlStart(ch) { return isEmailLocal(ch); }
function isSpaceChar(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}
function rtrimBackslashes(s) {
  let i = s.length;
  while (i > 0 && s[i - 1] === '\\') i--;
  return s.slice(0, i);
}
// End of the email-local run starting at j, and whether it is followed by @.
function emailRunEnd(src, j) {
  let k = j;
  const n = src.length;
  while (k < n && isEmailLocal(src[k])) k++;
  return k;
}
function emailReachesAt(src, j) {
  const k = emailRunEnd(src, j);
  return k < src.length && src[k] === '@';
}
function renderText(raw, inRawBlock, textMode) {
  if (textMode) return inRawBlock ? raw : decodeNumericRefs(raw);
  if (inRawBlock) return raw;
  return esc(decodeNumericRefs(raw));
}

// The text run: consumes at least one character and stops right before the
// next inline construct, mirroring marked's inlineText regex.
// Next stop position for a text run: construct chars, hard break, www.,
// URL schemes, mailto:/xmpp:. Backtick and www. stops need boundary
// validation; the loop below re-scans past invalid ones.
const SCAN_STOP = /[\\<\[*~_!`]| {2,}\n|www\.|[Hh][Tt][Tt][Pp][Ss]?:\/\/|[Ff][Tt][Pp]:\/\/|mailto:|xmpp:/g;

// First email start at or after `from`: an @ whose email-local run begins
// at a word boundary. -1 when there is none.
function nextEmailStart(src, from) {
  let at = src.indexOf('@', from);
  while (at !== -1) {
    let p = at;
    while (p > from && isEmailLocal(src[p - 1])) p--;
    if (p < at && (p === 0 || !isEmailLocal(src[p - 1]))) return p;
    at = src.indexOf('@', at + 1);
  }
  return -1;
}

function scanText(src, pos, inRawBlock, textMode) {
  const n = src.length;
  // A single non-alphanumeric character before mailto:/xmpp: is its own run.
  if (pos + 1 < n && !isAsciiAlnum(src[pos]) && (src.startsWith('mailto:', pos + 1) || src.startsWith('xmpp:', pos + 1))) {
    const raw = src[pos];
    return { raw, html: renderText(raw, inRawBlock, textMode) };
  }
  let end = n;
  // Email lookahead right after the first character.
  if (pos + 1 < n && emailReachesAt(src, pos + 1)) {
    end = pos + 1;
  } else {
    const emailPos = nextEmailStart(src, pos + 1);
    if (emailPos !== -1) end = emailPos;
    SCAN_STOP.lastIndex = pos + 1;
    let m;
    while ((m = SCAN_STOP.exec(src)) !== null) {
      const idx = m.index;
      if (idx >= end) break;
      const tok = m[0];
      if (tok[0] === '`') {
        // Only stop before a backtick run that starts a valid code span.
        if (src[idx - 1] !== '`') {
          INLINE_CODE.lastIndex = idx;
          if (INLINE_CODE.exec(src)) { end = idx; break; }
        }
        continue;
      }
      if (tok === 'www.') {
        const p = idx === 0 ? '' : src[idx - 1];
        if (p === '' || isSpaceChar(p) || p === '*' || p === '_' || p === '~' || p === '(') { end = idx; break; }
        continue;
      }
      end = idx;
      break;
    }
  }
  const raw = src.slice(pos, end);
  return { raw, html: renderText(raw, inRawBlock, textMode) };
}

function renderAutolink(text, href, textMode) {
  if (textMode) return text;
  const parsedText = esc(text, true);
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return parsedText;
  return '<a href="' + esc(cleanHref, true) + '">' + parsedText + '</a>';
}
function tryAutolink(src, pos, textMode) {
  INLINE_AUTOLINK.lastIndex = pos;
  const cap = INLINE_AUTOLINK.exec(src);
  if (!cap) return null;
  const text = cap[1];
  const href = cap[2] === '@' ? 'mailto:' + text : text;
  return { html: renderAutolink(text, href, textMode), len: cap[0].length, isText: false };
}
function tryUrl(src, pos, textMode) {
  INLINE_URL.lastIndex = pos;
  const cap = INLINE_URL.exec(src);
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      const m = INLINE_BACKPEDAL.exec(cap[0]);
      cap[0] = m ? m[0] : '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return { html: renderAutolink(text, href, textMode), len: cap[0].length, isText: false };
}

// Render a formed link or image. Returns null when the label already holds
// a link (the outer link bails so the inner one is kept).
function outputLink(cap, href, title, raw, isImage, refs, st, lpp, textMode) {
  const text = cap[1].replace(OUTPUT_LINK_REPLACE, '$1');
  const outerInLink = st.inLink, outerLinkEmitted = st.linkEmitted, outerInRawBlock = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const inner = inlineRun(text, refs, st, lpp, isImage ? 1 : textMode);
  const textHasLink = st.linkEmitted;
  st.linkEmitted = outerLinkEmitted;
  st.inLink = outerInLink;
  // A link whose label already contains a link bails (the text stays
  // literal) — in text mode as well as normal mode.
  if (!isImage && textHasLink) { st.inRawBlock = outerInRawBlock; return null; }
  // In text mode (image alt text) nested links/images collapse to their
  // plain text — no <a> or <img> tag is emitted. A link still marks
  // linkEmitted so an outer link bails (its label then stays literal).
  if (textMode) {
    st.inRawBlock = outerInRawBlock;
    if (!isImage) st.linkEmitted = true;
    return { html: inner, len: raw.length, isText: false };
  }
  if (!isImage) {
    st.linkEmitted = true;
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) return { html: inner, len: raw.length, isText: false };
    let out = '<a href="' + esc(cleanHref) + '"';
    if (title) out += ' title="' + esc(title) + '"';
    out += '>' + inner + '</a>';
    return { html: out, len: raw.length, isText: false };
  }
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { html: esc(inner), len: raw.length, isText: false };
  let out = '<img src="' + esc(cleanHref) + '" alt="' + esc(inner) + '"';
  if (title) out += ' title="' + esc(title) + '"';
  out += '>';
  return { html: out, len: raw.length, isText: false };
}

function tryLink(src, pos, refs, st, lpp, textMode) {
  const isImage = src[pos] === '!' && src[pos + 1] === '[';
  const start = isImage ? pos + 1 : pos;
  if (src[start] !== '[') return null;
  if (lpp) {
    INLINE_LINK.lastIndex = pos;
    const cap = INLINE_LINK.exec(src);
    if (cap) {
      const labelStart = isImage ? 2 : 1;
      if (!isLabelEndInsideToken(src.slice(pos), cap[1], labelStart)) {
        const trimmedUrl = cap[2].trim();
        let href = cap[2], title = cap[3] ? cap[3].slice(1, -1) : '', raw = cap[0];
        let ok = true;
        if (trimmedUrl.startsWith('<')) {
          if (!trimmedUrl.endsWith('>')) ok = false;
          else {
            const rtrimSlash = rtrimBackslashes(trimmedUrl.slice(0, -1));
            if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) ok = false;
          }
        } else {
          const lastParenIndex = findClosingBracket(cap[2], '()');
          if (lastParenIndex === -2) ok = false;
          else if (lastParenIndex > -1) {
            const startIdx = isImage ? 5 : 4;
            const linkLen = startIdx + cap[1].length + lastParenIndex;
            href = cap[2].substring(0, lastParenIndex);
            raw = cap[0].substring(0, linkLen).trim();
            title = '';
          }
        }
        if (ok) {
          const unescaped = rtrimBackslashes(raw.slice(0, -1));
          if ((raw.length - unescaped.length) % 2 === 0) ok = false;
        }
        if (ok) {
          href = href.trim();
          if (href.startsWith('<')) href = href.slice(1, -1);
          href = href.replace(ANY_PUNCT, '$1');
          title = title.replace(ANY_PUNCT, '$1');
          const made = outputLink(cap, href, title, raw, isImage, refs, st, lpp, textMode);
          if (made) return made;
        }
      }
    }
  }
  INLINE_REFLINK.lastIndex = pos;
  let cap2 = INLINE_REFLINK.exec(src);
  if (!cap2) {
    INLINE_NOLINK.lastIndex = pos;
    cap2 = INLINE_NOLINK.exec(src);
  }
  if (cap2) {
    const labelStart = isImage ? 2 : 1;
    if (!isLabelEndInsideToken(src.slice(pos), cap2[1], labelStart)) {
      const link = refs[normalizeLabel(cap2[2] || cap2[1])];
      if (!link) {
        const ch = src[pos];
        return { html: textMode ? ch : esc(ch), len: 1, isText: true, raw: ch };
      }
      return outputLink(cap2, link.href, link.title || '', cap2[0], isImage, refs, st, lpp, textMode);
    }
  }
  return null;
}

// Emphasis / strong, following marked's delimiter scan over the masked source.
function tryEmStrong(src, pos, masked, prevChar, lastCloser, refs, st, lpp, textMode) {
  EMSTRONG_LDELIM.lastIndex = pos;
  const match0 = EMSTRONG_LDELIM.exec(src);
  if (!match0) return null;
  if (!match0[1] && !match0[2] && !match0[3] && !match0[4]) return null;
  const delimChar = match0[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = pos;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const runPrevSlice = masked.slice(Math.max(0, runStart - 2), runStart);
  const runPrevChar = runPrevSlice ? [...runPrevSlice].at(-1) ?? '' : '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!PUNCT_OR_SPACE_NOT_STAR_UND.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!PUNCT_OR_SPACE_NOT_STAR_UND.exec(prevChar);
  if (match0[4] && prevChar.match(UNICODE_ALNUM)) return null;
  const nextChar = match0[1] || match0[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match0[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? EMSTRONG_RDELIM_AST : EMSTRONG_RDELIM_UND;
    const lastPossible = lastCloser[delimChar];
    const windowStart = pos + lLength;
    if (lastPossible < windowStart) return null;
    const clipped = masked.slice(pos + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    let match;
    while ((match = endReg.exec(clipped)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (match[3] || match[4]) { delimTotal += rLength; continue; }
      else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) { midDelimTotal += rLength; continue; }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const rawLen = lLength + match.index + lastCharLength + rLength;
      if (Math.min(lLength, rLength) % 2) {
        const inner = inlineRun(src.slice(pos + 1, pos + rawLen - 1), refs, st, lpp, textMode);
        return { html: textMode ? inner : '<em>' + inner + '</em>', len: rawLen, isText: false };
      }
      const inner = inlineRun(src.slice(pos + 2, pos + rawLen - 2), refs, st, lpp, textMode);
      return { html: textMode ? inner : '<strong>' + inner + '</strong>', len: rawLen, isText: false };
    }
  }
  return null;
}

// Strikethrough, same delimiter scan with ~ runs.
function tryDel(src, pos, masked, prevChar, lastCloser, refs, st, lpp, textMode) {
  DEL_LDELIM.lastIndex = pos;
  const match0 = DEL_LDELIM.exec(src);
  if (!match0) return null;
  const nextChar = match0[1] || '';
  if (!nextChar || !prevChar || PUNCT_OR_SPACE_NOT_STAR_UND.exec(prevChar)) {
    const lLength = [...match0[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;
    const lastPossible = lastCloser['~'];
    const windowStart = pos + lLength;
    if (lastPossible < windowStart) return null;
    const clipped = masked.slice(pos + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    DEL_RDELIM.lastIndex = 0;
    let match;
    while ((match = DEL_RDELIM.exec(clipped)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) { delimTotal += rLength; continue; }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const rawLen = lLength + match.index + lastCharLength + rLength;
      const inner = inlineRun(src.slice(pos + lLength, pos + rawLen - lLength), refs, st, lpp, textMode);
      return { html: textMode ? inner : '<del>' + inner + '</del>', len: rawLen, isText: false };
    }
  }
  return null;
}

// Parse one inline run (a paragraph, heading, table cell or list item line)
// to HTML. textMode 1 renders plain text (image alt text).
function inlineRun(src, refs, st, parentLPP, textMode) {
  const lpp = parentLPP === false ? false : src.includes(')');
  let masked = null, lastCloser = null;
  if (src.includes('*') || src.includes('_') || src.includes('~')) {
    masked = maskSrc(src, refs);
    lastCloser = scanClosers(masked);
  }
  let out = '';
  let pos = 0;
  const n = src.length;
  let prevChar = '';
  let keepPrevChar = false;
  while (pos < n) {
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    const ch = src[pos];
    // escape
    if (ch === '\\') {
      INLINE_ESCAPE.lastIndex = pos;
      const m = INLINE_ESCAPE.exec(src);
      if (m) { out += textMode ? m[1] : esc(m[1]); pos += m[0].length; continue; }
    }
    // html tag, then autolink
    if (ch === '<') {
      INLINE_TAG.lastIndex = pos;
      const m = INLINE_TAG.exec(src);
      if (m) {
        if (!st.inLink && START_A_TAG.test(m[0])) st.inLink = true;
        else if (st.inLink && END_A_TAG.test(m[0])) st.inLink = false;
        if (!st.inRawBlock && START_PRE_SCRIPT_TAG.test(m[0])) st.inRawBlock = true;
        else if (st.inRawBlock && END_PRE_SCRIPT_TAG.test(m[0])) st.inRawBlock = false;
        out += m[0];
        pos += m[0].length;
        continue;
      }
      const r = tryAutolink(src, pos, textMode);
      if (r) { out += r.html; pos += r.len; continue; }
    }
    // link / image / reflink
    if (ch === '[' || (ch === '!' && src[pos + 1] === '[')) {
      const r = tryLink(src, pos, refs, st, lpp, textMode);
      if (r) {
        out += r.html;
        pos += r.len;
        if (r.isText) {
          if (r.raw !== '_') prevChar = r.raw;
          keepPrevChar = true;
        }
        continue;
      }
    }
    // emphasis / strong
    if (ch === '*' || ch === '_') {
      const r = tryEmStrong(src, pos, masked, prevChar, lastCloser, refs, st, lpp, textMode);
      if (r) { out += r.html; pos += r.len; continue; }
    }
    // code span
    if (ch === '`') {
      INLINE_CODE.lastIndex = pos;
      const m = INLINE_CODE.exec(src);
      if (m) {
        let text = m[2].replace(/\n/g, ' ');
        if (/[^ ]/.test(text) && /^ /.test(text) && / $/.test(text)) text = text.substring(1, text.length - 1);
        out += textMode ? text : '<code>' + esc(text, true) + '</code>';
        pos += m[0].length;
        continue;
      }
    }
    // hard break
    if (ch === ' ' || ch === '\\') {
      INLINE_BR.lastIndex = pos;
      const m = INLINE_BR.exec(src);
      if (m) { if (!textMode) out += '<br>'; pos += m[0].length; continue; }
    }
    // strikethrough
    if (ch === '~') {
      const r = tryDel(src, pos, masked, prevChar, lastCloser, refs, st, lpp, textMode);
      if (r) { out += r.html; pos += r.len; continue; }
    }
    // extended autolink (not inside a link)
    if (!st.inLink && isUrlStart(ch)) {
      const r = tryUrl(src, pos, textMode);
      if (r) { out += r.html; pos += r.len; continue; }
    }
    // plain text
    const t = scanText(src, pos, st.inRawBlock, textMode);
    out += t.html;
    if (t.raw.length && t.raw[t.raw.length - 1] !== '_') prevChar = t.raw[t.raw.length - 1];
    keepPrevChar = true;
    pos += t.raw.length;
  }
  return out;
}

// ---------- block parser ----------
// Document-level inline state. Marked keeps ONE Lexer state per parse:
// inLink persists across the whole document (an unclosed <a> suppresses
// every later GFM autolink), while inRawBlock is reset before each block's
// inline run. linkEmitted is per-run.
let DOC_ST = null;
// Top-level inline runs only (the 5 call sites in parseBlocks/table):
// reset inRawBlock + linkEmitted, keep inLink (document-persistent).
function freshInlineState() {
  DOC_ST.inRawBlock = false;
  DOC_ST.linkEmitted = false;
  return DOC_ST;
}

function matchAtx(line) {
  const ind = indentOf(line);
  if (ind >= 4) return null;
  let i = ind, level = 0;
  while (i < line.length && line[i] === '#') { level++; i++; }
  if (level === 0 || level > 6) return null;
  if (i < line.length && line[i] !== ' ' && line[i] !== '\t') return null;
  let text = line.slice(i).trim();
  if (text.endsWith('#')) {
    const trimmed = text.replace(/#+$/, '');
    if (!trimmed || /[ \t]$/.test(trimmed)) text = trimmed.trim();
  }
  return { level, text };
}
function isHrLine(line) {
  const ind = indentOf(line);
  if (ind >= 4) return false;
  const s = line.slice(ind);
  const c = s[0];
  if (c !== '-' && c !== '_' && c !== '*') return false;
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === c) count++;
    else if (ch !== ' ' && ch !== '\t') return false;
  }
  return count >= 3;
}
function matchFence(line) {
  const ind = indentOf(line);
  if (ind >= 4) return null;
  const s = line.slice(ind);
  const ch = s[0];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (len < s.length && s[len] === ch) len++;
  if (len < 3) return null;
  const info = s.slice(len);
  if (ch === '`' && info.includes('`')) return null;
  return { indent: ind, ch, len, info };
}
function isFenceStart(line) {
  const ind = indentOf(line);
  if (ind >= 4) return false;
  const s = line.slice(ind);
  const ch = s[0];
  if (ch !== '`' && ch !== '~') return false;
  let len = 0;
  while (len < s.length && s[len] === ch) len++;
  if (len < 3) return false;
  if (ch === '`' && s.slice(len).includes('`')) return false;
  return true;
}
function isFenceClose(line, ch, len) {
  const ind = indentOf(line);
  if (ind >= 4) return false;
  const s = line.slice(ind);
  let n = 0;
  while (n < s.length && s[n] === ch) n++;
  if (n < len) return false;
  for (let i = n; i < s.length; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}
function isBlockquoteStart(line) {
  const ind = indentOf(line);
  return ind < 4 && line[ind] === '>';
}
// A list marker that interrupts a paragraph: a bullet, or an ordered item
// starting from 1, followed by space/tab and content.
function isListInterrupt(line) {
  const ind = indentOf(line);
  if (ind >= 4) return false;
  const s = line.slice(ind);
  const c = s[0];
  if (c === '*' || c === '+' || c === '-') {
    return s.length > 1 && (s[1] === ' ' || s[1] === '\t') && s.slice(2).trim() !== '';
  }
  if (c >= '0' && c <= '9') {
    const m = /^1[.)][ \t]+\S/.exec(s);
    return !!m;
  }
  return false;
}
// Inside a list item any ordered number interrupts a paragraph (marked's
// list-item lexer uses a looser listInterrupt than top level / blockquote).
function isListInterruptAny(line) {
  const ind = indentOf(line);
  if (ind >= 4) return false;
  const s = line.slice(ind);
  const c = s[0];
  if (c === '*' || c === '+' || c === '-') {
    return s.length > 1 && (s[1] === ' ' || s[1] === '\t') && s.slice(2).trim() !== '';
  }
  if (c >= '0' && c <= '9') {
    const m = /^\d{1,9}[.)][ \t]+\S/.exec(s);
    return !!m;
  }
  return false;
}
// Any list marker (used where setext text and table rows stop).
function isAnyListMarker(line) {
  const ind = indentOf(line);
  if (ind >= 4) return false;
  const s = line.slice(ind);
  const c = s[0];
  if (c === '*' || c === '+' || c === '-') {
    return s.length > 1 && (s[1] === ' ' || s[1] === '\t');
  }
  if (c >= '0' && c <= '9') {
    return /^\d{1,9}[.)][ \t]/.test(s);
  }
  return false;
}
// An HTML block start of types (1)-(6): these interrupt a paragraph.
function isHtmlInterrupt(line) {
  const ind = indentOf(line);
  if (ind >= 4) return false;
  const s = line.slice(ind);
  if (s[0] !== '<') return false;
  const low = s.toLowerCase();
  if (/^<(script|pre|style|textarea)[\s>]/.test(low)) return true;
  if (low.startsWith('<!--') || low.startsWith('<?') || low.startsWith('<![cdata[')) return true;
  if (/^<![a-z]/.test(s)) return true;
  const m = /^<\/?([a-z][a-z0-9-]*)/i.exec(s);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) {
    const rest = s.slice(m[0].length);
    if (rest === '' || rest[0] === ' ' || rest[0] === '\t' || rest[0] === '/' || rest[0] === '>') {
      // a tab after the tag does not count (only spaces do), but a lone tag
      // at end of line or followed by /> or > does
      if (rest === '' || rest[0] === ' ' || rest[0] === '/' || rest[0] === '>') return true;
      if (rest[0] === '\t') return false;
    }
  }
  return false;
}
// A setext underline line, and its level (1 for =, 2 for -).
function setextLevel(line) {
  const ind = indentOf(line);
  if (ind >= 4) return 0;
  const s = line.slice(ind);
  let i = 0, ch = s[0];
  if (ch !== '=' && ch !== '-') return 0;
  while (i < s.length && s[i] === ch) i++;
  for (let j = i; j < s.length; j++) {
    if (s[j] !== ' ' && s[j] !== '\t') return 0;
  }
  return ch === '=' ? 1 : 2;
}

// --- tables ---
const TABLE_DELIM_RE = /^(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/;
function isTableStart(lines, i, end) {
  if (i + 1 >= end) return false;
  if (indentOf(lines[i]) >= 4) return false;
  if (lines[i].trim() === '') return false;
  const dind = indentOf(lines[i + 1]);
  if (dind > 3) return false;
  const d = lines[i + 1].slice(dind);
  if (!TABLE_DELIM_RE.test(d)) return false;
  if (!/[:|]/.test(d)) return false;
  const headers = splitCells(lines[i]);
  const aligns = d.replace(/^\||\| *$/g, '').split('|');
  return headers.length === aligns.length;
}
function tryTable(lines, i, end, refs, defsOnly) {
  if (!isTableStart(lines, i, end)) return null;
  const d = lines[i + 1].slice(indentOf(lines[i + 1]));
  const headers = splitCells(lines[i]);
  const aligns = d.replace(/^\||\| *$/g, '').split('|').map((a) => {
    if (/^ *-+: *$/.test(a)) return 'right';
    if (/^ *:-+: *$/.test(a)) return 'center';
    if (/^ *:-+ *$/.test(a)) return 'left';
    return null;
  });
  const rows = [];
  let j = i + 2;
  while (j < end) {
    const line = lines[j];
    // A tab-only line is a table row (empty cells); only a truly empty or
    // spaces-only line ends the table.
    if (line.trim() === '' && !line.includes('\t')) break;
    const isTabRow = line.trim() === '' && line.includes('\t');
    if (!isTabRow && (isHrLine(line) || matchAtx(line) || isBlockquoteStart(line) || isFenceStart(line) || indentOf(line) >= 4 || isAnyListMarker(line) || isHtmlInterrupt(line))) break;
    rows.push(line);
    j++;
  }
  if (defsOnly) return { html: '', next: j };
  let out = '<table>\n<thead>\n<tr>\n';
  for (let k = 0; k < headers.length; k++) {
    const a = aligns[k] ? ' align="' + aligns[k] + '"' : '';
    out += '<th' + a + '>' + inlineRun(headers[k], refs, freshInlineState(), true, 0) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (rows.length) {
    out += '<tbody>';
    for (const row of rows) {
      const cells = splitCells(row, headers.length);
      out += '<tr>\n';
      for (let k = 0; k < cells.length; k++) {
        const a = aligns[k] ? ' align="' + aligns[k] + '"' : '';
        out += '<td' + a + '>' + inlineRun(cells[k], refs, freshInlineState(), true, 0) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  out += '</table>\n';
  return { html: out, next: j };
}

// --- link reference definitions ---
const DEF_RE = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^)\\])*\)))? *(?:\n+|$)/;
function matchDef(lines, i, end) {
  if (indentOf(lines[i]) >= 4) return null;
  if (lines[i][indentOf(lines[i])] !== '[') return null;
  const maxJ = Math.min(end, i + 10);
  let s = lines.slice(i, maxJ).join('\n');
  let cap = DEF_RE.exec(s);
  if (cap && cap[0].length >= s.length && maxJ < end) {
    s = lines.slice(i, end).join('\n');
    cap = DEF_RE.exec(s);
  }
  if (!cap) return null;
  if (!cap[2].startsWith('<') && findClosingBracket(cap[2], '()') !== -1) return null;
  const label = normalizeLabel(cap[1]);
  let href = cap[2];
  if (href.startsWith('<')) href = href.slice(1, -1);
  href = href.replace(ANY_PUNCT, '$1');
  const title = cap[3] ? cap[3].slice(1, -1).replace(ANY_PUNCT, '$1') : '';
  const nl = (cap[0].match(/\n/g) || []).length;
  let next = i + nl + (cap[0].endsWith('\n') ? 0 : 1);
  if (next > end) next = end;
  return { label, href, title, next };
}

// --- HTML blocks ---
// Find the last line of an HTML block starting at line i. Returns null when
// the line is not an HTML block start.
function htmlBlockEnd(lines, i, end) {
  const ind = indentOf(lines[i]);
  if (ind >= 4) return null;
  const s = lines[i].slice(ind);
  if (s[0] !== '<') return null;
  const low = s.toLowerCase();
  // (1) script / pre / style / textarea: ends at the matching close tag.
  const m1 = /^<(script|pre|style|textarea)(?:[\s>]|$)/.exec(low);
  if (m1) {
    const tag = m1[1];
    const closeRe = new RegExp('</' + tag + '[\\s>]', 'i');
    for (let k = i; k < end; k++) {
      if (closeRe.test(lines[k])) return { k, type: 1 };
    }
    return { k: end - 1, type: 1 };
  }
  // (2) comment: ends at the line holding -->
  if (low.startsWith('<!--')) {
    for (let k = i; k < end; k++) {
      if (lines[k].includes('-->')) return { k, type: 2 };
    }
    return { k: end - 1, type: 2 };
  }
  // (3) processing instruction: ends at the line holding ?>
  if (low.startsWith('<?')) {
    for (let k = i; k < end; k++) {
      if (lines[k].includes('?>')) return { k, type: 3 };
    }
    return { k: end - 1, type: 3 };
  }
  // (4) declaration: ends at the first line holding > after <![A-Z]
  if (/^<![A-Z]/.test(s)) {
    for (let k = i; k < end; k++) {
      const from = k === i ? s.indexOf('>') : lines[k].indexOf('>');
      if (from !== -1) return { k, type: 4 };
    }
    return { k: end - 1, type: 4 };
  }
  // (5) CDATA: ends at the line holding ]]>
  if (low.startsWith('<![cdata[')) {
    for (let k = i; k < end; k++) {
      if (lines[k].includes(']]>')) return { k, type: 5 };
    }
    return { k: end - 1, type: 5 };
  }
  // (6) a block-level tag, or (7) any tag alone on its line: ends at a blank line.
  const m6 = /^<\/?([a-z][a-z0-9-]*)/i.exec(s);
  if (m6) {
    const tag = m6[1].toLowerCase();
    const rest = s.slice(m6[0].length);
    const isBlockTag = BLOCK_TAGS.has(tag);
    if (isBlockTag && (rest === '' || rest[0] === ' ' || rest[0] === '/' || rest[0] === '>')) {
      let k = i;
      while (k < end && !isBlank(lines[k])) k++;
      return { k: k - 1, type: 6 };
    }
    // (7) open tag alone on its line (not script/pre/style/textarea)
    if (!isBlockTag || true) {
      const trimmed = s.replace(/[ \t]+$/, '');
      const openRe = /^<[a-z][a-z0-9-]*(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)* *\/?>$/i;
      const closeRe = /^<\/[a-z][a-z0-9-]*\s*>$/i;
      const isPre = /^(script|pre|style|textarea)$/i.test(tag);
      if ((openRe.test(trimmed) && !isPre) || closeRe.test(trimmed)) {
        let k = i;
        while (k < end && !isBlank(lines[k])) k++;
        return { k: k - 1, type: 7 };
      }
    }
  }
  return null;
}
function tryHtmlBlock(lines, i, end) {
  const e = htmlBlockEnd(lines, i, end);
  if (!e || e.k < i) return null;
  const k = e.k;
  let b = 0;
  while (k + 1 + b < end && isBlank(lines[k + 1 + b])) b++;
  // A trailing empty element is the input's final newline, not a blank line.
  if (b > 0 && lines[end - 1] === '' && k + 1 + b === end) b--;
  let out = lines.slice(i, k + 1).join('\n');
  // Trailing newline: types 1-5 (close-tag-terminated) keep it unless the
  // very next line is a real blank line (truly empty, and not the input's
  // final newline); types 6-7 (blank-line-terminated) keep it only when
  // no blank line follows.
  const after = lines[k + 1];
  const realBlankAfter = after === '' && k + 1 < end - 1;
  const addNl = e.type <= 5
    ? (k < end - 1 && !realBlankAfter)
    : (b === 0 && k < end - 1);
  if (addNl) out += '\n';
  return { html: out, next: k + 1 + b };
}

// --- setext heading / paragraph ---
// A setext heading: paragraph lines (which may not include indented lines or
// list markers) followed by an = or - underline.
function collectSetext(lines, i, end) {
  let j = i;
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) return null;
    if (indentOf(line) >= 4) return null;
    if (isAnyListMarker(line)) return null;
    if (isHrLine(line) || matchAtx(line) || isBlockquoteStart(line) || isFenceStart(line) || isHtmlInterrupt(line)) return null;
    if (isTableStart(lines, j, end)) return null;
    j++;
    const lvl = j < end ? setextLevel(lines[j]) : 0;
    if (lvl) {
      const text = lines.slice(i, j).join('\n').trim();
      return { level: lvl, text, next: j + 1 };
    }
  }
  return null;
}
// A paragraph: lines until a blank line or an interrupter.
function collectParagraph(lines, i, end, top) {
  let j = i + 1;
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) {
      // A whitespace-only line that is the last line (with content, not
      // the empty element left by a trailing newline) belongs to the
      // paragraph: marked's paragraph regex only excludes a blank line
      // that is followed by a newline.
      if (j === end - 1 && line !== '') { j++; }
      break;
    }
    const listInt = top ? isListInterrupt(line) : isListInterruptAny(line);
    if (isHrLine(line) || matchAtx(line) || isBlockquoteStart(line) || isFenceStart(line) || listInt || isHtmlInterrupt(line)) break;
    if (isTableStart(lines, j, end)) break;
    j++;
  }
  return { text: lines.slice(i, j).join('\n'), next: j };
}

// --- blockquote ---
// Strip one quote marker. Marked first expands the whitespace after the
// marker to spaces (a tab runs to the next tab stop from the marker's end),
// then removes the marker plus one space.
function stripQuoteMarker(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (line[i] !== '>') return line;
  const markerLen = i + 1;
  let j = markerLen;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  const ws = line.slice(markerLen, j);
  const expanded = expandLeadingTabs(ws, markerLen);
  const rebuilt = line.slice(0, markerLen) + expanded + line.slice(j);
  const m = /^ {0,3}>[ \t]?/.exec(rebuilt);
  return rebuilt.slice(m[0].length);
}
// A line that lazily continues a paragraph inside a blockquote.
function isLazyContinuation(line, lines, j, end) {
  if (isBlank(line)) return false;
  if (isHrLine(line) || matchAtx(line) || isBlockquoteStart(line) || isFenceStart(line) || isAnyListMarker(line) || isHtmlInterrupt(line)) return false;
  if (isTableStart(lines, j, end)) return false;
  return true;
}
function parseBlockquote(lines, i, end, refs, defsOnly) {
  let inner = [];
  let j = i;
  while (j < end && isBlockquoteStart(lines[j])) {
    inner.push(stripQuoteMarker(lines[j]));
    j++;
  }
  // Parse the inner content (top level: paragraphs carry <p>).
  let lastType = '';
  const renderInner = () => {
    const out = [];
    lastType = parseBlocks(inner, 0, inner.length, refs, true, out, undefined, defsOnly);
    return out.join('');
  };
  let html = renderInner();
  // Lazy continuations: lines after the quote that belong to its last block.
  while (j < end) {
    if (lastType === 'code' || lastType === 'heading' || lastType === 'hr' || lastType === 'html' || lastType === 'table') break;
    // A restated '>' line after a lazy line still belongs to this quote.
    if (isBlockquoteStart(lines[j])) {
      const start = inner.length;
      while (j < end && isBlockquoteStart(lines[j])) {
        inner.push(stripQuoteMarker(lines[j]));
        j++;
      }
      const newHtml = renderInner();
      if (lastType === 'blockquote' || lastType === 'paragraph' || lastType === 'text' || lastType === 'list' || lastType === 'code') { html = newHtml; continue; }
      inner.length = start;
      break;
    }
    if (lastType === 'paragraph' || lastType === 'text') {
      // A blank line inside the quote closes the paragraph: a lazy line
      // after it is a new top-level block, not a continuation.
      if (inner.length && isBlank(inner[inner.length - 1])) break;
      const start = inner.length;
      let changed = false;
      while (j < end && isLazyContinuation(lines[j], lines, j, end)) {
        let l = lines[j];
        // A lazy setext underline is neutralised (kept in the paragraph).
        if (setextLevel(l)) l = '    ' + l.replace(/^ {0,3}/, '');
        // A lazy line that is indented code cannot interrupt the paragraph;
        // it is merged into the paragraph text with the code indent
        // removed (appended to the paragraph's last line so it is not
        // re-read as a list marker).
        else if (indentOf(l) >= 4) {
          inner[inner.length - 1] += '\n' + removeCodeIndent(l);
          j++;
          changed = true;
          continue;
        }
        inner.push(l);
        j++;
        changed = true;
      }
      if (!changed) break;
      html = renderInner();
      continue;
    }
    if (lastType === 'list') {
      const start = inner.length;
      const startJ = j;
      while (j < end && !isBlank(lines[j]) && !isBlockquoteStart(lines[j])) {
        // A new bullet at indent 0 is a new top-level list, not part of
        // this quote's list.
        const lb = listBullet(lines[j]);
        if (lb && lb.indent === 0) break;
        inner.push(lines[j]);
        j++;
      }
      if (inner.length === start) break;
      const newHtml = renderInner();
      if (lastType === 'list') { html = newHtml; continue; }
      inner.length = start;
      j = startJ;
      break;
    }
    if (lastType === 'blockquote') {
      // A lazy line (or a restated marker) may continue the nested quote's
      // innermost paragraph; try one line at a time and keep it only if
      // the nested quote still absorbs it.
      if (j >= end || isBlank(lines[j])) break;
      const start = inner.length;
      const startJ = j;
      if (isBlockquoteStart(lines[j])) inner.push(stripQuoteMarker(lines[j]));
      else inner.push(lines[j]);
      j++;
      const newHtml = renderInner();
      if (lastType === 'blockquote') { html = newHtml; continue; }
      inner.length = start;
      j = startJ;
      break;
    }
    break;
  }
  return { html: defsOnly ? '' : '<blockquote>\n' + html + '</blockquote>\n', next: j };
}

// --- lists ---
function listBullet(line) {
  const ind = indentOf(line);
  if (ind >= 4) return null;
  const s = line.slice(ind);
  const c = s[0];
  if (c === '*' || c === '+' || c === '-') {
    if (s.length === 1 || s[1] === ' ' || s[1] === '\t') return { bullet: c, ordered: false, start: 0, indent: ind, markerLen: 1 };
    return null;
  }
  if (c >= '0' && c <= '9') {
    const m = /^(\d{1,9})([.)])(?:[ \t]|$)/.exec(s);
    if (m) return { bullet: m[1] + m[2], ordered: true, start: parseInt(m[1], 10), indent: ind, markerLen: m[1].length + 1, delim: m[2] };
    return null;
  }
  return null;
}
function parseList(lines, i, end, refs, defsOnly) {
  const first = listBullet(lines[i]);
  if (!first) return null;
  const items = [];
  let j = i;
  let endsWithBlankLine = false;
  let loose = false;
  const maxSpaces = (indent) => Math.max(0, Math.min(3, indent - 1));
  while (j < end) {
    const b = listBullet(lines[j]);
    if (!b) break;
    if (first.ordered !== b.ordered) break;
    if (!first.ordered && b.bullet !== first.bullet) break;
    if (first.ordered && b.delim !== first.delim) break;
    if (isHrLine(lines[j])) break;
    const bulletIndent = b.indent + b.markerLen;
    const firstLineRaw = lines[j].slice(b.indent + b.markerLen);
    const firstLine = expandLeadingTabs(firstLineRaw, bulletIndent);
    const nextLine = j + 1 < end ? lines[j + 1] : '';
    const blankFirst = firstLine.trim() === '';
    let indent, itemLines = [];
    if (blankFirst) {
      indent = bulletIndent + 1;
    } else {
      let off = 0;
      while (off < firstLine.length && firstLine[off] === ' ') off++;
      indent = off > 4 ? 1 : off;
      itemLines.push(firstLine.slice(indent));
      indent += bulletIndent;
    }
    j++;
    let itemBlankInternal = false;
    let itemEndedBlank = false;
    let endEarly = false;
    if (blankFirst && j < end && isBlank(lines[j])) {
      j++;
      endEarly = true;
      // An empty item followed by a blank line separates it from the next
      // item, so the list is loose.
      itemEndedBlank = true;
    }
    let line = itemLines.length ? itemLines[0] : '';
    let blankLine = blankFirst;
    if (!endEarly) {
      const ms = maxSpaces(indent);
      while (j < end) {
        const rawLine = lines[j];
        const nextLineWithoutTabs = expandLeadingTabs(rawLine);
        const ind2 = indentOf(rawLine);
        // End the item at a fence, heading, html block, blockquote, new
        // bullet or hr (tested on the raw line, indent-clamped).
        const startsBlock = (re) => {
          if (ind2 > ms) return false;
          return re.test(rawLine.slice(ind2));
        };
        if (startsBlock(/^(?:```|~~~)/) && isFenceStart(rawLine)) break;
        if (startsBlock(/^#{1,6}(?:\s|$)/)) break;
        if (startsBlock(/^</) && isHtmlInterrupt(rawLine)) break;
        if (startsBlock(/^>/)) break;
        if (startsBlock(/^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/)) break;
        if (startsBlock(/^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/) && isHrLine(rawLine)) break;
        if (indentOf(nextLineWithoutTabs) >= indent || isBlank(rawLine)) {
          itemLines.push(nextLineWithoutTabs.slice(indent));
        } else {
          if (blankLine) break;
          const prev = line.replace(/\t/g, '    ');
          if (indentOf(prev) >= 4) break;
          if (/^(?:```|~~~)/.test(prev)) break;
          if (/^#{1,6}(?:\s|$)/.test(prev)) break;
          if (prev.startsWith('<') && isHtmlInterrupt(prev)) break;
          if (/^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/.test(prev) && isHrLine(prev)) break;
          // Lazy continuation; a setext underline is neutralised.
          const setextCont = /^ {0,3}(?:=+|-+) *$/.test(rawLine) && setextLevel(rawLine) && (() => {
            const two = line + '\n' + rawLine;
            const parts = two.split('\n');
            return collectSetext(parts, 0, parts.length) !== null;
          })();
          if (setextCont) {
            itemLines.push('    ' + nextLineWithoutTabs.replace(/^ {0,3}/, ''));
          } else if (indentOf(nextLineWithoutTabs) >= 4) {
            // A lazy line that is indented code cannot interrupt the
            // paragraph; it is merged into the paragraph text with the code
            // indent removed (appended to the last line so it is not
            // re-read as a list marker).
            itemLines[itemLines.length - 1] += '\n' + removeCodeIndent(nextLineWithoutTabs);
          } else {
            // Lazy continuation: marked adds the raw line (its indentation
            // is part of the paragraph text); only an indented-code line
            // (handled above) loses its indent, via the code merge.
            itemLines.push(nextLineWithoutTabs);
          }
        }
        blankLine = isBlank(rawLine);
        line = nextLineWithoutTabs.slice(indent);
        j++;
      }
    }
    // Blank-line state is judged on the collected lines, so a trailing
    // empty element (the input's final newline) never counts as a blank
    // line inside the item.
    itemEndedBlank = itemEndedBlank || (itemLines.length > 0 && isBlank(itemLines[itemLines.length - 1]));
    // Trim trailing blank lines from the item content.
    while (itemLines.length && isBlank(itemLines[itemLines.length - 1])) itemLines.pop();
    // A blank line makes the list loose only when it separates two top-level
    // blocks of this item. Blank lines inside a fenced code block, or inside
    // a nested list (the next line still belongs to that nested list), do
    // not count. Track the outermost nested list's bullet/content indent.
    itemBlankInternal = (() => {
      let inFence = false;
      let fenceCh = '';
      let fenceLen = 0;
      let nestedBullet = -1;
      let nestedContent = -1;
      for (let k = 0; k < itemLines.length; k++) {
        const l = itemLines[k];
        if (inFence) {
          if (isFenceClose(l, fenceCh, fenceLen)) inFence = false;
          continue;
        }
        const f = matchFence(l);
        if (f) { inFence = true; fenceCh = f.ch; fenceLen = f.len; continue; }
        const lb = listBullet(l);
        if (lb && nestedBullet < 0) {
          nestedBullet = lb.indent;
          nestedContent = lb.indent + lb.markerLen + 1;
        }
        if (!isBlank(l)) continue;
        // Find the next non-blank line.
        let m = k + 1;
        while (m < itemLines.length && isBlank(itemLines[m])) m++;
        if (m >= itemLines.length) continue;
        const nl = itemLines[m];
        const ni = indentOf(nl);
        const nlb = listBullet(nl);
        // Inside a nested list? A list item at/after the nested bullet
        // indent, or a continuation at/after its content indent, belongs
        // to the nested list.
        if (nestedBullet >= 0) {
          if (nlb && ni >= nestedBullet) continue;
          if (!nlb && ni >= nestedContent) continue;
        }
        // Outside any nested list: a top-level block (indent 0), an
        // indented code block (indent >= 4), or a new list item counts.
        if (ni === 0 || ni >= 4 || nlb) return true;
      }
      return false;
    })();
    // Loose: a blank line inside the item, or after it before the next item.
    if (itemBlankInternal) loose = true;
    if (endsWithBlankLine) loose = true;
    endsWithBlankLine = itemEndedBlank;
    const text = itemLines.join('\n');
    const task = /^\[[ xX]\][ \t]+\S/.test(text);
    items.push({ text, task, loose: false, lines: itemLines });
  }
  if (items.length === 0) return null;
  // Render items (top=false: text runs are bare, or <p> when loose).
  const renderItems = () => {
    let body = '';
    for (const item of items) {
      let checkbox = '';
      let checked = false;
      // Use the stored line array (not a re-split of the joined text) so
      // embedded newlines from merged lazy lines stay intact.
      const itemLines = item.lines.slice();
      if (item.task) {
        const m = /^\[[ xX]\]/.exec(itemLines[0]);
        checked = m[0] !== '[ ]';
        itemLines[0] = itemLines[0].replace(/^\[[ xX]\][ \t]+/, '');
        checkbox = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
      }
      const out = [];
      parseBlocks(itemLines, 0, itemLines.length, refs, false, out, loose, defsOnly);
      let inner = out.join('');
      // A loose item's checkbox belongs inside the opening <p>; a tight
      // item's goes before the bare text.
      if (checkbox) {
        if (inner.startsWith('<p>')) inner = '<p>' + checkbox + inner.slice(3);
        else inner = checkbox + inner;
      }
      body += '<li>' + inner + '</li>\n';
    }
    return body;
  };
  const body = defsOnly ? '' : renderItems();
  const type = first.ordered ? 'ol' : 'ul';
  const startAttr = (first.ordered && first.start !== 1) ? ' start="' + first.start + '"' : '';
  return { html: defsOnly ? '' : '<' + type + startAttr + '>\n' + body + '</' + type + '>\n', next: j };
}

// --- block dispatcher ---
// Parses lines[start..end) and appends HTML to out. Returns the type of the
// last block emitted ('paragraph', 'text', 'list', 'blockquote', 'code',
// defsOnly: walk the block structure and register link reference
// definitions only, without rendering inline content. A first pass in this
// mode lets later paragraphs resolve references defined after them.
function parseBlocks(lines, start, end, refs, top, out, looseList, defsOnly) {
  let i = start;
  let lastType = '';
  while (i < end) {
    while (i < end && isBlank(lines[i])) i++;
    if (i >= end) break;
    const line = lines[i];
    const ind = indentOf(line);
    // indented code
    if (ind >= 4) {
      const content = [];
      let j = i;
      while (j < end) {
        const l = lines[j];
        if (isBlank(l)) {
          let k = j + 1;
          while (k < end && isBlank(lines[k])) k++;
          if (k < end && indentOf(lines[k]) >= 4) {
            while (j < k) { content.push(lines[j]); j++; }
            continue;
          }
          break;
        }
        if (indentOf(l) >= 4) { content.push(l); j++; continue; }
        break;
      }
      if (!defsOnly) {
        const text = content.map(removeCodeIndent).join('\n');
        const code = text ? text.replace(/\n$/, '') + '\n' : '';
        out.push('<pre><code>' + esc(code, true) + '</code></pre>\n');
      }
      lastType = 'code';
      i = j;
      continue;
    }
    // fenced code
    const fence = matchFence(line);
    if (fence) {
      let k = i + 1;
      while (k < end && !isFenceClose(lines[k], fence.ch, fence.len)) k++;
      if (!defsOnly) {
        const content = lines.slice(i + 1, k);
        const comp = fence.ch === '`' ? content.map((l) => {
          let m = 0;
          while (m < l.length && (l[m] === ' ' || l[m] === '\t')) m++;
          return l.slice(Math.min(m, fence.indent));
        }) : content;
        const text = comp.join('\n');
        const lang = fence.info.trim().replace(ANY_PUNCT, '$1');
        const langStr = lang.match(/^\S*/)[0];
        const code = text ? text.replace(/\n$/, '') + '\n' : '';
        out.push('<pre><code' + (langStr ? ' class="language-' + esc(langStr) + '"' : '') + '>' + esc(code, true) + '</code></pre>\n');
      }
      lastType = 'code';
      i = k < end ? k + 1 : end;
      continue;
    }
    // ATX heading
    const atx = matchAtx(line);
    if (atx) {
      if (!defsOnly) out.push('<h' + atx.level + '>' + inlineRun(atx.text, refs, freshInlineState(), true, 0) + '</h' + atx.level + '>\n');
      lastType = 'heading';
      i++;
      continue;
    }
    // hr
    if (isHrLine(line)) {
      if (!defsOnly) out.push('<hr>\n');
      lastType = 'hr';
      i++;
      continue;
    }
    // blockquote
    if (ind < 4 && line[ind] === '>') {
      const q = parseBlockquote(lines, i, end, refs, defsOnly);
      if (!defsOnly) out.push(q.html);
      lastType = 'blockquote';
      i = q.next;
      continue;
    }
    // list
    if (listBullet(line)) {
      const l = parseList(lines, i, end, refs, defsOnly);
      if (l) {
        if (!defsOnly) out.push(l.html);
        lastType = 'list';
        i = l.next;
        continue;
      }
    }
    // html block
    const html = tryHtmlBlock(lines, i, end);
    if (html) {
      if (!defsOnly) out.push(html.html);
      lastType = 'html';
      i = html.next;
      continue;
    }
    // link reference definition
    const def = matchDef(lines, i, end);
    if (def) {
      if (!Object.hasOwn(refs, def.label)) refs[def.label] = { href: def.href, title: def.title };
      i = def.next;
      continue;
    }
    // table
    const table = tryTable(lines, i, end, refs, defsOnly);
    if (table) {
      if (!defsOnly) out.push(table.html);
      lastType = 'table';
      i = table.next;
      continue;
    }
    // setext heading
    const setext = collectSetext(lines, i, end, refs);
    if (setext) {
      if (!defsOnly) out.push('<h' + setext.level + '>' + inlineRun(setext.text, refs, freshInlineState(), true, 0) + '</h' + setext.level + '>\n');
      lastType = 'heading';
      i = setext.next;
      continue;
    }
    // paragraph (top) or text (nested)
    const para = collectParagraph(lines, i, end, top);
    if (!defsOnly) {
      const inner = inlineRun(para.text, refs, freshInlineState(), true, 0);
      if (top || looseList) out.push('<p>' + inner + '</p>\n');
      else out.push(inner);
    }
    lastType = top ? 'paragraph' : 'text';
    i = para.next;
  }
  return lastType;
}

function parse(src) {
  const text = src.includes('\r') ? src.replace(/\r\n?/g, '\n') : src;
  const lines = text.split('\n');
  const refs = Object.create(null);
  DOC_ST = { inLink: false, inRawBlock: false, linkEmitted: false };
  // First pass: collect every link reference definition (a paragraph may
  // use a reference defined after it). Second pass: render. A definition
  // always contains ']:', so cases without it skip the first pass.
  if (src.includes(']:')) parseBlocks(lines, 0, lines.length, refs, true, [], undefined, true);
  const out = [];
  parseBlocks(lines, 0, lines.length, refs, true, out);
  return out.join('');
}

module.exports = { parse };
