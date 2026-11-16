// parse.js — a fast CommonMark 0.31.2 + GFM 0.29 renderer.
//
// Behaviour target: byte-for-byte the HTML that marked 18.1.3 renders with
// its defaults (gfm on, breaks off, pedantic off, async off). Where marked
// departs from the spec, marked's output is the target. The grammar below
// (block and inline patterns) encodes that behaviour; the code around it is
// an original implementation: it scans the input by index, never builds a
// token tree, and renders HTML straight into the output string.
//
// Reference implementation: marked 18.1.3 (MIT), github.com/markedjs/marked.
// This file is not a copy of it: it is a fresh implementation written to the
// same grammar, for speed. See NOTICE.md.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// Escape HTML. encodeAll escapes every & < > " '; otherwise & is left alone
// when it starts something that already looks like an entity reference.
const ESC_TEST = /[&<>"']/;
const ESC_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_REPLACE = /[&<>"']/g;
const ESC_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function escHtml(s, encodeAll) {
  if (encodeAll) {
    return ESC_TEST.test(s) ? s.replace(ESC_REPLACE, (c) => ESC[c]) : s;
  }
  return ESC_TEST_NO_ENCODE.test(s) ? s.replace(ESC_REPLACE_NO_ENCODE, (c) => ESC[c]) : s;
}

// Decode numeric character references (&#35; &#X22;); anything else, named
// entities included, passes through untouched.
const NUM_REF_TEST = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeRefs(s) {
  if (!NUM_REF_TEST.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return "&amp;";
    const n = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (n === 0 || n > 1114111 || (n >= 55296 && n <= 57343)) return "\uFFFD";
    if (n === 38) return "&amp;";
    return String.fromCodePoint(n);
  });
}

// Clean a URL for an href/src: encodeURI, keeping % as % (not %25).
function cleanUrl(u) {
  try {
    return encodeURI(u).replace(/%25/g, "%");
  } catch {
    return null;
  }
}

// Normalize a link reference label: trim, collapse inner whitespace, fold case.
function normLabel(s) {
  return s.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase().toLowerCase();
}

// Split a table row into cells, honouring escaped pipes. One forward
// pass: a pipe splits only when the backslash run before it is even, which
// the old replace-then-split-on-" |" did by scanning backwards per pipe.
function splitCells(row, count) {
  const cuts = [];
  let esc = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === "|") cuts.push(i);
  }
  const cells = [];
  let from = 0;
  for (const cut of cuts) { cells.push(row.slice(from, cut)); from = cut + 1; }
  cells.push(row.slice(from));
  if (cells.length > 0 && !cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push("");
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, "|");
  return cells;
}

// Index of the closing paren that balances the opens in s, or -1 when the
// parens balance and -2 when an opener is left unclosed. Backslashes skip.
function findParenClose(s) {
  if (s.indexOf("(") === -1 && s.indexOf(")") === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth < 0) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Strip trailing characters equal to ch from s.
function stripTrailing(s, ch) {
  let n = s.length;
  if (n === 0) return "";
  let i = 0;
  for (; i < n;) {
    if (s.charAt(n - i - 1) === ch) i++;
    else break;
  }
  return s.slice(0, n - i);
}

// Drop trailing blank lines from a block of text, keeping at most one.
function stripTrailingBlanks(s) {
  const lines = s.split("\n");
  let t = lines.length - 1;
  for (; t >= 0 && /^[ \t]*$/.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join("\n");
}

// Expand tabs to spaces, tracking the column (tab stops every 4).
function expandTabs(s, col = 0) {
  let out = "";
  let c = col;
  for (const ch of s) {
    if (ch === "\t") {
      const w = 4 - (c % 4);
      out += " ".repeat(w);
      c += w;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// Remove a fenced code block's opening indent from every content line.
function fenceIndent(raw, content) {
  const m = raw.match(/^(\s+)(?:```)/);
  if (m === null) return content;
  const n = m[1].length;
  return content
    .split("\n")
    .map((line) => {
      const lead = line.match(/^\s+/);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, n));
    })
    .join("\n");
}

// Does the link label hold a "<" that starts a raw tag or autolink running
// past the label's end? If so the bracketed text is not a link.
function labelHasTag(label, remaining, offset) {
  if (!label.includes("<")) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === "\\") { i++; continue; }
    if (label[i] === "`") {
      const m = execAt(INLINE_CODE, label, i);
      if (m) { i += m[0].length - 1; continue; }
    }
    if (label[i] !== "<") continue;
    const rest = remaining.slice(offset + i);
    const m = execAt(INLINE_TAG, rest, 0) || execAt(INLINE_AUTOLINK, rest, 0);
    if (m) {
      if (m[0].length > label.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}


// Grammar constants generated from the reference grammar (marked 18.1.3,
// GFM rule set) for exactness; leading ^ dropped, sticky flag added.
const BLANK_RUN = /(?:[ \t]*(?:\n|$))+/y;
const INDENTED_CODE = /((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/y;
const FENCES = / {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/y;
const ATX = / {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/y;
const HR = / {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/y;
const BLOCKQUOTE = /( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/y;
const LIST_START = /( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/y;
const HTML_BLOCK = / {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$))/iy;
const LINK_DEF = / {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/y;
const TABLE = / *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/y;
const SETEXT = /(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/y;
const PARAGRAPH = /([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/y;
const TEXT_LINE = /[^\n]+/y;
const INLINE_ESCAPE = /\\([!"#$%&'()*+,\-.\/:;<=>?@\[\]\\^_`{|}~])/y;
const INLINE_TAG = /<!--(?:-?>|[\s\S]*?-->)|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|<\?[\s\S]*?\?>|<![a-zA-Z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>/y;
const INLINE_LINK = /!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/y;
const INLINE_REFLINK = /!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/y;
const INLINE_NOLINK = /!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/y;
const INLINE_CODE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
const INLINE_BR = /( {2,}|\\)\n(?!\s*$)[ \t]*/y;
const INLINE_AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/y;
const INLINE_URL = /(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/y;
const INLINE_TEXT = /(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/y;
const INLINE_DEL_L = /~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const INLINE_DEL_R = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const EM_L = /(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const EM_R_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const EM_R_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const ANY_PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const BLOCK_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const REFLINK_SEARCH = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const PUNCT_OR_SPACE = /((?![*_])[\s\p{P}\p{S}])/u;
// Small helper patterns (other).
const UNICODE_ALNUM = /[\p{L}\p{N}]/u;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_RAW_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_RAW_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
const START_ANGLE = /^</;
const END_ANGLE = />$/;
const CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const INDENT_CODE_COMP = /^(\s+)(?:```)/;
const BEGIN_SPACE = /^\s+/;
const NON_SPACE = /[^ ]/;
const NON_SPACE_TAB = /[^ \t]/;
const NEWLINE_G = /\n/g;
const LEADING_SPACE_TAB = /^[ \t]+/;
const TAB_G = /\t/g;
const BLANK_LINE = /^[ \t]*$/;
const BLOCKQUOTE_START = /^ {0,3}>/;
const BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BQ_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const LIST_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_TASK_STRIP = /^\[[ xX]\][ \t]+/;
const LIST_CHECKBOX = /\[[ xX]\]/;
const ANY_LINE = /\n.*\n/;
const HREF_BRACKETS = /^<(.*)>$/;
const TABLE_DELIM = /[:|]/;
const TABLE_ALIGN_CHARS = /^\||\| *$/g;
const TABLE_ROW_BLANK = /\n[ \t]*$/;
const ALIGN_RIGHT = /^ *-+: *$/;
const ALIGN_CENTER = /^ *:-+: *$/;
const ALIGN_LEFT = /^ *:-+ *$/;
// The reference memoizes these factories through a clamp: n = max(0, min(3, R - 1)).
// A continuation line indented R may only start a new bullet/heading/etc.
// when its indent is at most R-1 (and at most 3). Using the raw R lets an
// over-indented line wrongly end the current list item.
const clamp3 = (n) => Math.max(0, Math.min(3, n - 1));
// Memoized like the reference's D(): the clamp yields only 0..3, so each
// factory compiles at most 4 regexes total instead of one per list item.
const memoClamp = (make) => { const c = []; return (n) => { const k = clamp3(n); return c[k] || (c[k] = make(k)); }; };
const LIST_ITEM_RE = (b) => new RegExp(`^( {0,3}${b})((?:[ \t][^\\n]*)?(?:\\n|$))`);
const NEXT_BULLET_RE = memoClamp((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const HR_RE = memoClamp((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const FENCES_BEGIN_RE = memoClamp((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const HEADING_BEGIN_RE = memoClamp((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const HTML_BEGIN_RE = memoClamp((n) => new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, "i"));
const BLOCKQUOTE_BEGIN_RE = memoClamp((n) => new RegExp(`^ {0,${n}}>`));
const BLOCK_TAGS = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const ENDING_HASH = /#$/;
const ENDING_SPACE_TAB = /[ \t]$/;
const START_SPACE_CHAR = /^ /;
const END_SPACE_CHAR = / $/;
const ENDING_NEWLINE = /\n$/;
const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const LIST_NESTING = /^ {1,4}(?=( {4})*[^ ])/g;


// ---------------------------------------------------------------------------
// Block parsing. Mirrors the reference's block-tokenizer order and decisions,
// but scans by index and stores only what rendering needs (no raw strings,
// no token trees for inline content: block text is rendered inline later,
// after every link reference definition in the document has been collected).
// ---------------------------------------------------------------------------

function execAt(re, str, pos) {
  re.lastIndex = pos;
  return re.exec(str);
}

// Is marker (a char code) at str[pos..pos+3], preceded only by spaces?
// The block rules that begin ` {0,3}<marker>` need exactly this, so a
// missing marker skips the whole giant regex instead of failing it.
function markerAhead(str, pos, code) {
  let i = pos;
  for (let k = 0; k < 3; k++) {
    const c = str.charCodeAt(i);
    if (c === code) return true;
    if (c !== 32) return false;
    i++;
  }
  return str.charCodeAt(i) === code;
}

// Can the line after pos be a table delimiter (its first non-space char,
// within 3 spaces, is |, : or -)? Necessary for TABLE to match at pos.
function tableDelimAhead(str, pos) {
  const nl = str.indexOf("\n", pos);
  if (nl === -1) return false;
  let j = nl + 1;
  for (let k = 0; k < 3; k++) {
    const c = str.charCodeAt(j);
    if (c === 124 || c === 58 || c === 45) return true;
    if (c !== 32) return false;
    j++;
  }
  const c = str.charCodeAt(j);
  return c === 124 || c === 58 || c === 45;
}

// Is there a setext underline line (=== or ---, up to 3 leading spaces)
// before the next blank line? Necessary for SETEXT to match at pos.
function setextUnderlineAhead(str, pos) {
  let i = str.indexOf("\n", pos);
  while (i !== -1) {
    const j = i + 1;
    let k = j;
    while (str[k] === " " || str[k] === "\t") k++;
    if (k >= str.length || str[k] === "\n") return false;
    if (k - j <= 3 && (str[k] === "=" || str[k] === "-")) {
      let m = k;
      while (str[m] === "=" || str[m] === "-" || str[m] === " " || str[m] === "\t") m++;
      if (m >= str.length || str[m] === "\n") return true;
    }
    i = str.indexOf("\n", i + 1);
  }
  return false;
}

// /\n[ \t]*\n[ \t]*$/ without the regex: does s end with a blank line?
function endsWithBlankLine(s) {
  let i = s.length;
  while (i > 0 && (s[i - 1] === " " || s[i - 1] === "\t")) i--;
  if (i < 2 || s[i - 1] !== "\n") return false;
  let j = i - 1;
  while (j > 0 && (s[j - 1] === " " || s[j - 1] === "\t")) j--;
  return j > 0 && s[j - 1] === "\n";
}

// /\n.*\n/ without the regex: does s hold two newlines?
function hasTwoNewlines(s) {
  const a = s.indexOf("\n");
  return a !== -1 && s.indexOf("\n", a + 1) !== -1;
}

const EM_L_Y = new RegExp(EM_L.source, "yu");
const DEL_L_Y = new RegExp(INLINE_DEL_L.source, "yu");
const LINK_TEST = new RegExp("^" + INLINE_LINK.source);
const SETEXT_TEST = new RegExp("^" + SETEXT.source);

// `top` lives on cx (see parse): a paragraph is only a paragraph while
// cx.top is true. A nested list or blockquote parse flips it as the
// reference's Lexer state does, so a paragraph after a nested list inside
// a list item is a paragraph, not bare text.
function blockParse(str, cx, inBq, out) {
  const nodes = out || [];
  let pos = 0;
  const end = str.length;
  let remaining = Infinity;
  let mergePara = inBq;
  while (pos < end) {
    if (end - pos >= remaining) throw new Error("Infinite loop on byte: " + str.charCodeAt(pos));
    remaining = end - pos;
    let m;
    if ((m = execAt(BLANK_RUN, str, pos))) {
      if (!(m[0].length === 1 && nodes.length > 0)) nodes.push({ k: "space", raw: m[0] });
      pos += m[0].length;
      continue;
    }
    if ((m = execAt(INDENTED_CODE, str, pos))) {
      const raw = stripTrailingBlanks(m[0]);
      const text = raw.replace(CODE_REMOVE_INDENT, "");
      const prev = nodes[nodes.length - 1];
      if (prev && (prev.k === "paragraph" || prev.k === "text")) prev.text += "\n" + text;
      else nodes.push({ k: "code", text, lang: null });
      pos += raw.length;
      continue;
    }
    if ((m = execAt(FENCES, str, pos))) {
      const raw = m[0];
      const lang = m[2] ? m[2].trim().replace(ANY_PUNCT, "$1") : m[2];
      nodes.push({ k: "code", text: fenceIndent(raw, m[3] || ""), lang });
      pos += raw.length;
      continue;
    }
    if ((m = execAt(ATX, str, pos))) {
      const raw = stripTrailing(m[0], "\n");
      let text = m[2].trim();
      if (ENDING_HASH.test(text)) {
        const s = stripTrailing(text, "#");
        if (!s || ENDING_SPACE_TAB.test(s)) text = s.trim();
      }
      nodes.push({ k: "heading", depth: m[1].length, text });
      pos += raw.length;
      continue;
    }
    if ((m = execAt(HR, str, pos))) {
      nodes.push({ k: "hr" });
      pos += stripTrailing(m[0], "\n").length;
      continue;
    }
    let bq;
    if (markerAhead(str, pos, 62) && (bq = parseBlockquote(str, pos, cx))) {
      nodes.push(bq.node);
      pos = bq.next;
      continue;
    }
    let li;
    if ((li = parseList(str, pos, cx))) {
      nodes.push(li.node);
      pos = li.next;
      continue;
    }
    if (markerAhead(str, pos, 60) && (m = execAt(HTML_BLOCK, str, pos))) {
      const raw = stripTrailingBlanks(m[0]);
      nodes.push({ k: "html", text: raw, pre: m[1] === "pre" || m[1] === "script" || m[1] === "style" });
      pos += raw.length;
      continue;
    }
    if (markerAhead(str, pos, 91) && (m = execAt(LINK_DEF, str, pos))) {
      if (START_ANGLE.test(m[2]) || findParenClose(m[2], "()") === -1) {
        const raw = stripTrailing(m[0], "\n");
        const prev = nodes[nodes.length - 1];
        if (prev && (prev.k === "paragraph" || prev.k === "text")) {
          prev.text += "\n" + raw;
        } else {
          const tag = normLabel(m[1]);
          if (!cx.links.has(tag)) {
            cx.links.set(tag, {
              href: m[2] ? m[2].replace(HREF_BRACKETS, "$1").replace(ANY_PUNCT, "$1") : "",
              title: m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT, "$1") : m[3],
            });
          }
          nodes.push({ k: "def" });
        }
        pos += raw.length;
        continue;
      }
    }
    let tb;
    if (tableDelimAhead(str, pos) && (tb = parseTable(str, pos, cx))) {
      nodes.push(tb.node);
      pos = tb.next;
      continue;
    }
    if (setextUnderlineAhead(str, pos) && (m = execAt(SETEXT, str, pos))) {
      const raw = stripTrailing(m[0], "\n");
      nodes.push({ k: "heading", depth: m[2].charAt(0) === "=" ? 1 : 2, text: m[1].trim() });
      pos += raw.length;
      continue;
    }
    if (cx.top && (m = execAt(PARAGRAPH, str, pos))) {
      let text = m[1];
      if (text.charCodeAt(text.length - 1) === 10) text = text.slice(0, -1);
      const prev = nodes[nodes.length - 1];
      if (mergePara && prev && prev.k === "paragraph") prev.text += "\n" + text;
      else nodes.push({ k: "paragraph", text });
      mergePara = false;
      pos += m[0].length;
      continue;
    }
    if ((m = execAt(TEXT_LINE, str, pos))) {
      const prev = nodes[nodes.length - 1];
      if (prev && prev.k === "text") prev.text += "\n" + m[0];
      else nodes.push({ k: "text", text: m[0] });
      pos += m[0].length;
      continue;
    }
    throw new Error("Infinite loop on byte: " + str.charCodeAt(pos));
  }
  cx.top = true;
  return nodes;
}

function parseTable(str, pos, cx) {
  const m = execAt(TABLE, str, pos);
  if (!m || !TABLE_DELIM.test(m[2])) return null;
  const header = splitCells(m[1]);
  const aligns = m[2].replace(TABLE_ALIGN_CHARS, "").split("|");
  if (header.length !== aligns.length) return null;
  const align = aligns.map((a) =>
    ALIGN_RIGHT.test(a) ? "right" : ALIGN_CENTER.test(a) ? "center" : ALIGN_LEFT.test(a) ? "left" : null,
  );
  const rowsText = m[3] && m[3].trim() ? m[3].replace(TABLE_ROW_BLANK, "").split("\n") : [];
  const rows = rowsText.map((r) => splitCells(r, header.length).map((text, i) => ({ text, align: align[i] })));
  const head = header.map((text, i) => ({ text, align: align[i] }));
  const raw = stripTrailing(m[0], "\n");
  return { node: { k: "table", header: head, rows }, next: pos + raw.length };
}

function parseBlockquote(str, pos, cx) {
  const m = execAt(BLOCKQUOTE, str, pos);
  if (!m) return null;
  let lines = stripTrailing(m[0], "\n").split("\n");
  let s = "";
  let r = "";
  const items = [];
  while (lines.length > 0) {
    let started = false;
    const chunk = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (BLOCKQUOTE_START.test(lines[p])) {
        chunk.push(lines[p]);
        started = true;
      } else if (!started) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = chunk.join("\n");
    const u = h
      .replace(BQ_MARKER_WS, (g, b, mk) => b + expandTabs(mk, b.length))
      .replace(BQ_SETEXT, "\n    $1")
      .replace(BQ_SETEXT2, "");
    s = s ? s + "\n" + h : h;
    r = r ? r + "\n" + u : u;
    const savedTop = cx.top;
    cx.top = true;
    blockParse(u, cx, true, items);
    cx.top = savedTop;
    if (lines.length === 0) break;
    const k = items[items.length - 1];
    if (k && (k.k === "code" || k.k === "heading" || k.k === "hr" || k.k === "html" || k.k === "table")) break;
    if (k && k.k === "blockquote") {
      const g = k;
      const b = lines.join("\n");
      const m2 = g.raw + "\n" + b.replace(BQ_SETEXT2, "");
      const f = parseBlockquote(m2, 0, cx);
      items[items.length - 1] = f.node;
      const y = m2.substring(f.next).replace(/^\n/, "");
      const R = y ? y.split("\n").length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) s = s + "\n" + A.join("\n");
      r = r.substring(0, r.length - g.text.length) + f.node.text;
      lines = lines.slice(A.length);
      if (lines.length > 0 && BLOCKQUOTE_START.test(lines[0])) continue;
      break;
    } else if (k && k.k === "list") {
      const g = k;
      const b = g.raw + "\n" + lines.join("\n");
      const m2 = parseList(b, 0, cx);
      items[items.length - 1] = m2.node;
      const f = m2.node.raw.length > g.raw.length ? b.slice(g.raw.length + 1, m2.node.raw.length).split("\n").length : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join("\n");
        s = s + "\n" + y;
        r = r + "\n" + y;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  return { node: { k: "blockquote", items, raw: s, text: r }, next: pos + s.length };
}

function parseList(str, pos, cx) {
  const m0 = execAt(LIST_START, str, pos);
  if (!m0) return null;
  let e = str.slice(pos);
  const n = e;
  const consumed = () => n.length - e.length;
  const r0 = m0[1].trim();
  const ordered = r0.length > 1;
  const listNode = { k: "list", ordered, start: ordered ? +r0.slice(0, -1) : "", loose: false, items: [], raw: "" };
  const bulletRe = ordered ? `\\d{1,9}\\${r0.slice(-1)}` : `\\${r0}`;
  const itemRe = LIST_ITEM_RE(bulletRe);
  let p = false;
  while (e) {
    let u = false;
    const dParts = [];
    const t = execAt(itemRe, e, 0);
    if (!t || execAt(HR, e, 0)) break;
    const k = consumed();
    e = e.substring(t[0].length);
    const gNl = t[2].indexOf("\n");
    const g = gNl === -1 ? t[2] : t[2].slice(0, gNl);
    const b = t[1].length;
    let mLine = g.replace(LEADING_SPACE_TAB, (v) => expandTabs(v, b));
    const fNl0 = e.indexOf("\n");
    let f = fNl0 === -1 ? e : e.slice(0, fNl0);
    const y0 = !mLine.trim();
    let R = 0;
    if (y0) {
      R = b + 1;
    } else {
      R = mLine.search(NON_SPACE);
      R = R > 4 ? 1 : R;
      dParts.push(mLine.slice(R));
      R += b;
    }
    let y = y0;
    if (y && BLANK_LINE.test(f)) {
      e = e.substring(f.length + 1);
      u = true;
    }
    if (!u) {
      const v = NEXT_BULLET_RE(R);
      const Q = HR_RE(R);
      const ee = FENCES_BEGIN_RE(R);
      const te = HEADING_BEGIN_RE(R);
      const M = HTML_BEGIN_RE(R);
      const ne = BLOCKQUOTE_BEGIN_RE(R);
      while (e) {
        const nl = e.indexOf("\n");
        const U = nl === -1 ? e : e.slice(0, nl);
        f = U;
        const Z = f.replace(LEADING_SPACE_TAB, (me) => expandTabs(me));
        // The six tests below all need the line's first non-space char to
        // be one of > # ` ~ < * + - _ or a digit; anything else fails all
        // of them, so skip the regexes outright.
        const zi = Z.search(NON_SPACE);
        const fc = zi === -1 ? "" : Z[zi];
        if (fc !== "" && "><#`~*+-_0123456789".indexOf(fc) !== -1 &&
            (ee.test(f) || te.test(f) || M.test(f) || ne.test(f) || v.test(f) || Q.test(f))) break;
        const blankLine = !f.trim();
        if (zi >= R || blankLine) {
          dParts.push(Z.slice(R));
        } else {
          // Same guard for the four tests on the previous line's content
          // (fences, heading, html, hr only here).
          const mExp = mLine.includes("\t") ? mLine.replace(TAB_G, "    ") : mLine;
          const mi = mLine.search(NON_SPACE_TAB);
          const mc = mi === -1 ? "" : mLine[mi];
          if (y || mExp.search(NON_SPACE) >= 4 ||
              (mc !== "" && "`~#<-_*".indexOf(mc) !== -1 &&
               (ee.test(mLine) || te.test(mLine) || M.test(mLine) || Q.test(mLine)))) break;
          let qe = f;
          if (/^ {0,3}(?:=+|-+) *$/.test(f) && SETEXT_TEST.test(mLine + "\n" + f)) {
            qe = "    " + Z.replace(/^ {0,3}/, "");
          }
          dParts.push(qe);
        }
        y = blankLine;
        e = nl === -1 ? "" : e.slice(nl + 1);
        mLine = Z.slice(R);
      }
    }
    const d = (y0 && dParts.length > 0 ? "\n" : "") + dParts.join("\n");
    const A = n.slice(k, consumed());
    if (!listNode.loose) {
      if (p) listNode.loose = true;
      if (endsWithBlankLine(A)) p = true;
    }
    listNode.items.push({ raw: A, task: LIST_TASK.test(d), loose: false, text: d, tokens: [] });
  }
  const h = listNode.items[listNode.items.length - 1];
  if (!h) return null;
  h.raw = h.raw.trimEnd();
  h.text = h.text.trimEnd();
  listNode.raw = n.slice(0, consumed()).trimEnd();
  for (const item of listNode.items) {
    cx.top = false;
    item.tokens = blockParse(item.text, cx, false);
    if (!listNode.loose) {
      const spaces = item.tokens.filter((t) => t.k === "space");
      if (spaces.length > 0 && spaces.some((g) => hasTwoNewlines(g.raw))) listNode.loose = true;
    }
  }
  for (const item of listNode.items) {
    const d0 = item.tokens[0];
    if (item.task && d0 && (d0.k === "text" || d0.k === "paragraph")) {
      item.text = item.text.replace(LIST_TASK_STRIP, "");
      d0.text = d0.text.replace(LIST_TASK_STRIP, "");
      const kb = LIST_CHECKBOX.exec(item.raw);
      if (kb) {
        item.checked = kb[0] !== "[ ]";
        item.hasCheckbox = true;
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (listNode.loose) {
    for (const item of listNode.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.k === "text") t.k = "paragraph";
    }
  }
  return { node: listNode, next: pos + listNode.raw.length };
}

// ---------------------------------------------------------------------------
// Rendering. Block nodes render straight to the output string; inline text
// is rendered at this point, once every link reference definition has been
// collected by the block pass.
// ---------------------------------------------------------------------------

function renderNodes(nodes, cx, out) {
  for (const node of nodes) {
    switch (node.k) {
      case "space":
      case "def":
        break;
      case "code": {
        const lang = node.lang ? node.lang.match(/^\S*/)?.[0] : "";
        const r = node.text ? node.text.replace(ENDING_NEWLINE, "") + "\n" : "";
        if (lang) out.push('<pre><code class="language-' + escHtml(lang) + '">' + escHtml(r, true) + "</code></pre>\n");
        else out.push("<pre><code>" + escHtml(r, true) + "</code></pre>\n");
        break;
      }
      case "heading":
        out.push(`<h${node.depth}>`, inlineToHtml(node.text, cx), `</h${node.depth}>\n`);
        break;
      case "hr":
        out.push("<hr>\n");
        break;
      case "blockquote":
        out.push("<blockquote>\n");
        renderNodes(node.items, cx, out);
        out.push("</blockquote>\n");
        break;
      case "list":
        out.push(listHtml(node, cx));
        break;
      case "html":
        out.push(node.text);
        break;
      case "table":
        out.push(tableHtml(node, cx));
        break;
      case "paragraph":
        out.push("<p>", inlineToHtml(node.text, cx), "</p>\n");
        break;
      case "text":
        out.push(inlineToHtml(node.text, cx));
        break;
    }
  }
}

function listHtml(list, cx) {
  let s = "";
  for (const item of list.items) s += listItemHtml(item, cx);
  const tag = list.ordered ? "ol" : "ul";
  const start = list.ordered && list.start !== 1 ? ` start="${list.start}"` : "";
  return `<${tag}${start}>\n${s}</${tag}>\n`;
}

function listItemHtml(item, cx) {
  const tokens = item.tokens;
  const cb = item.hasCheckbox
    ? "<input " + (item.checked ? 'checked="" ' : "") + 'disabled="" type="checkbox"> '
    : null;
  const parts = [];
  if (cb && tokens.length > 0 && (tokens[0].k === "paragraph" || tokens[0].k === "text")) {
    const first = tokens[0];
    if (first.k === "paragraph") parts.push("<p>" + cb + inlineToHtml(first.text, cx) + "</p>\n");
    else parts.push(cb + inlineToHtml(first.text, cx));
    renderNodes(tokens.slice(1), cx, parts);
  } else {
    renderNodes(tokens, cx, parts);
  }
  return `<li>${parts.join("")}</li>\n`;
}

function tableHtml(table, cx) {
  let head = "";
  for (const cell of table.header) head += tableCellHtml(cell, true, cx);
  let thead = `<tr>\n${head}</tr>\n`;
  let body = "";
  for (const row of table.rows) {
    let r = "";
    for (const cell of row) r += tableCellHtml(cell, false, cx);
    body += `<tr>\n${r}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return `<table>\n<thead>\n${thead}</thead>\n${body}</table>\n`;
}

function tableCellHtml(cell, isHeader, cx) {
  const tag = isHeader ? "th" : "td";
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return open + inlineToHtml(cell.text, cx) + `</${tag}>\n`;
}


// ============================================================
// Part B — inline parser
//
// Inline state (mirrors marked's Lexer state): a fresh object per
// top-level inline render; nested label/inner renders share it.
//   inLink, inRawBlock, linkEmitted, linkParenPossible, textMode
// textMode renders plain text (image alt text) instead of HTML.
// ============================================================

function freshState() {
  return { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, textMode: false };
}

// Does this string contain a link (inline or reflink) whose label
// resolves? Used by the mask builder for nested-reflink masking.
function linkInText(str, cx) {
  if (!str.includes("[")) return false;
  for (const m of str.matchAll(BLOCK_SKIP)) {
    if (LINK_TEST.test(m[0]) && str.charAt(m.index - 1) !== "!") return true;
  }
  for (const m of str.matchAll(REFLINK_SEARCH)) {
    const s = m[0];
    const r = s.lastIndexOf("[");
    if (!(s.charAt(0) === "!" || !cx.links.has(normLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(s.slice(1, r - 1), cx))) {
      return true;
    }
  }
  return false;
}

// Length-preserving masked copy of an inline string: reflinks, links,
// code spans and HTML are hidden so the emphasis/delimiter scanner
// cannot see their contents; backslash-punctuation becomes "+".
function buildMask(str, cx) {
  let t = str;
  if (cx.links.size > 0 && str.includes("[")) {
    const maskReflink = (r) => {
      const o = r.lastIndexOf("[");
      if (!cx.links.has(normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== "!") {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, cx)) {
          return "[" + inner.replace(REFLINK_SEARCH, maskReflink) + "][" + "a".repeat(r.length - o - 2) + "]";
        }
      }
      return "[" + "a".repeat(r.length - 2) + "]";
    };
    t = t.replace(REFLINK_SEARCH, maskReflink);
  }
  // Both replaces below are the identity unless the string holds a
  // backtick/backslash (code spans, backslash-punctuation) or a bracket/
  // backtick/angle bracket (links, code spans, tags). Plain emphasized
  // text skips two full-string scans.
  if (str.includes("`") || str.includes("\\")) {
    t = t.replace(ANY_PUNCT_OUTSIDE_CODE, (n, s, r) =>
      r ? "+".repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, "+") + s : n,
    );
  }
  if (str.includes("[") || str.includes("`") || str.includes("<")) {
    t = t.replace(BLOCK_SKIP, (n, s, r) => {
      const o = r ? r.length : 0;
      return n.slice(0, o) + "[" + "a".repeat(n.length - o - 2) + "]";
    });
  }
  return t;
}

// Last possible closer indices in the masked string: for "*" and "_"
// the last index whose preceding char is not space/tab/newline/CR/FF
// (i.e. the closer can close); for "~" the same. (fe in marked.) Scanned
// backwards: the first run start found for a delimiter is its last one,
// and the scan stops once all three are found.
function scanClosers(s) {
  const em = { "*": -1, _: -1 };
  let del = -1;
  for (let i = s.length - 1; i >= 0; i--) {
    const r = s[i];
    if (r !== "*" && r !== "_" && r !== "~") continue;
    if (i > 0 && s[i - 1] === r) continue; // not the run's start
    const o = i === 0 ? "\n" : s[i - 1];
    if (o === " " || o === "\t" || o === "\n" || o === "\r" || o === "\f") continue;
    if (r === "~") { if (del === -1) del = i; }
    else if (em[r] === -1) em[r] = i;
    if (del !== -1 && em["*"] !== -1 && em["_"] !== -1) break;
  }
  return { em, del };
}

// Emphasis/strong at position i. Returns {html, next} or null.
// masked is the masked string, closers the scanClosers result,
// prevChar the char before i ("" at a text-run boundary).
function tryEmStrong(str, i, masked, closers, prevChar, cx, st) {
  const m = execAt(EM_L_Y, str, i);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const delim = m[0][0];
  const o = prevChar === delim;
  // The run-back and the char before the run come from the MASKED string,
  // as in the reference: when the opener sits inside a masked span (a
  // link, code span or tag), the masked char is an ordinary `a`, not the
  // original char — that decides the R/mod-3 rule below.
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  // Char before the delimiter run, as a full code point.
  let p = "";
  if (l > 0) {
    const c = masked[l - 1];
    p = (c >= "\uDC00" && c <= "\uDFFF" && l >= 2) ? masked.slice(l - 2, l) : c;
  }
  const h = p === "*" || p === "_" || PUNCT_OR_SPACE.test(p);
  let n = prevChar;
  if (l < i) n = p;
  const u = l < i ? h : PUNCT_OR_SPACE.test(n);
  if (m[4] && UNICODE_ALNUM.test(n)) return null;
  const d = m[1] || m[3] || "";
  if (d && n && !u) return null;
  // Run length in code points: m[0] is the run plus one following char;
  // subtract 1, and one more when that char is astral (2 UTF-16 units).
  let k = m[0].length - 1;
  const _lc = m[0].charCodeAt(m[0].length - 1);
  if (_lc >= 0xDC00 && _lc <= 0xDFFF) k--;
  let mLeft = k;
  let f = 0;
  const y = i - l + k;
  const R = p.trim() !== "" && (!!d || (delim === "*" && !h));
  const v = closers[delim];
  const Q = i + k;
  if (v < Q) return null;
  const slice = masked.slice(i + k);
  const RDelim = delim === "*" ? EM_R_AST : EM_R_UND;
  RDelim.lastIndex = 0;
  const ee = v - Q;
  let s;
  while ((s = RDelim.exec(slice)) !== null && s.index <= ee) {
    const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
    if (!g) continue;
    const b0 = g.length;
    if (s[3] || s[4]) { mLeft += b0; continue; }
    if (s[5] || s[6] || R) {
      if (o && (s[5] || s[6])) break;
      if (y % 3 && !((y + b0) % 3)) { f += b0; continue; }
    }
    mLeft -= b0;
    if (mLeft > 0) continue;
    const b = Math.min(b0, b0 + mLeft + f);
    const te = s[0].charCodeAt(0) >= 0xD800 && s[0].charCodeAt(0) <= 0xDBFF ? 2 : 1;
    const rawLen = k + s.index + te + b;
    const M = str.slice(i, i + rawLen);
    const innerText = Math.min(k, b) % 2 ? M.slice(1, -1) : M.slice(2, -2);
    const inner = inlineInner(innerText, cx, st);
    if (st.textMode) return { html: inner, next: i + rawLen };
    if (Math.min(k, b) % 2) return { html: "<em>" + inner + "</em>", next: i + rawLen };
    return { html: "<strong>" + inner + "</strong>", next: i + rawLen };
  }
  return null;
}

// Strikethrough at position i. Returns {html, next} or null.
function tryDel(str, i, masked, lastDel, prevChar, cx, st) {
  const m = execAt(DEL_L_Y, str, i);
  if (!m) return null;
  // marked's gate: an opener followed by punctuation can only open when
  // the char before it is absent or punctuation/space; an opener followed
  // by an ordinary char always opens (so `a~~b~~c` dels, `a~~.b~~c` does not).
  if ((m[1] || "") && prevChar && !PUNCT_OR_SPACE.test(prevChar)) return null;
  let o = m[0].length - 1;
  const _lc2 = m[0].charCodeAt(m[0].length - 1);
  if (_lc2 >= 0xDC00 && _lc2 <= 0xDFFF) o--;
  let p = o;
  const d = i + o;
  if (lastDel < d) return null;
  const slice = masked.slice(i + o);
  const RDelim = INLINE_DEL_R;
  RDelim.lastIndex = 0;
  const kk = lastDel - d;
  let s;
  while ((s = RDelim.exec(slice)) !== null && s.index <= kk) {
    const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
    if (!g) continue;
    const l0 = g.length;
    if (l0 !== o) continue;
    if (s[3] || s[4]) { p += l0; continue; }
    p -= l0;
    if (p > 0) continue;
    const l = Math.min(l0, l0 + p);
    const te = s[0].charCodeAt(0) >= 0xD800 && s[0].charCodeAt(0) <= 0xDBFF ? 2 : 1;
    const rawLen = o + s.index + te + l;
    const b = str.slice(i, i + rawLen);
    const innerText = b.slice(o, -o);
    const inner = inlineInner(innerText, cx, st);
    if (st.textMode) return { html: inner, next: i + rawLen };
    return { html: "<del>" + inner + "</del>", next: i + rawLen };
  }
  return null;
}

// Shared link/image construction from a matched label: parses the label
// (nested links suppressed), then renders the link or image. Returns the
// HTML string, or null when a nested link makes the outer link invalid.
function makeLink(m, isImage, href, title, cx, st) {
  // Only \[ and \] are unescaped in a label (outputLinkReplace); other
  // backslash escapes (e.g. \`) stay for the label's own inline parse.
  const label = m[1].replace(OUTPUT_LINK_REPLACE, "$1");
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  const savedRaw = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const inner = inlineInner(label, cx, st);
  const emittedInside = st.linkEmitted;
  st.linkEmitted = savedEmitted;
  st.inLink = savedInLink;
  if (!isImage) {
    if (emittedInside) {
      st.inRawBlock = savedRaw;
      return null;
    }
    st.linkEmitted = true;
    if (st.textMode) return inner;
    const url = cleanUrl(href);
    if (url === null) return inner;
    let out = '<a href="' + escHtml(url) + '"';
    if (title) out += ' title="' + escHtml(title) + '"';
    return out + ">" + inner + "</a>";
  }
  if (st.textMode) return inner;
  const alt = plainText(label, cx);
  const url = cleanUrl(href);
  if (url === null) return escHtml(alt);
  let out = `<img src="${escHtml(url)}" alt="${escHtml(alt)}"`;
  if (title) out += ` title="${escHtml(title)}"`;
  return out + ">";
}

// Inline link [label](dest "title") at position i, or null.
function tryLink(str, i, cx, st) {
  if (st.linkParenPossible === false) return null;
  const m = execAt(INLINE_LINK, str, i);
  if (!m) return null;
  const isImage = m[0].charAt(0) === "!";
  const off = isImage ? 2 : 1;
  if (labelHasTag(m[1], str.slice(i), off)) return null;
  let raw = m[0];
  let dest = m[2];
  let title = m[3];
  const s = dest.trim();
  if (START_ANGLE.test(s)) {
    if (!END_ANGLE.test(s)) return null;
    const inner = stripTrailing(s.slice(0, -1), "\\");
    if ((s.length - inner.length) % 2 === 0) return null;
  } else {
    const l = findParenClose(dest, "()");
    if (l === -2) return null;
    if (l > -1) {
      const h = (isImage ? 5 : 4) + m[1].length + l;
      dest = dest.substring(0, l);
      raw = raw.substring(0, h).trim();
      title = "";
    }
  }
  const r = stripTrailing(raw.slice(0, -1), "\\");
  if ((raw.length - r.length) % 2 === 0) return null;
  let href = dest.trim();
  if (START_ANGLE.test(href)) href = href.slice(1, -1);
  const html = makeLink(m, isImage, href.replace(ANY_PUNCT, "$1"), title ? title.slice(1, -1).replace(ANY_PUNCT, "$1") : "", cx, st);
  if (html === null) return null;
  return { html, next: i + raw.length };
}

// Reference/shortcut link at position i, or null. When the regex matches
// but the label has no definition, only the first char is literal text.
function tryRefLink(str, i, cx, st) {
  const m = execAt(INLINE_REFLINK, str, i) || execAt(INLINE_NOLINK, str, i);
  if (!m) return null;
  const isImage = m[0].charAt(0) === "!";
  const off = isImage ? 2 : 1;
  if (labelHasTag(m[1], str.slice(i), off)) return null;
  const ref = cx.links.get(normLabel(m[2] || m[1]));
  if (!ref) {
    const c = m[0].charAt(0);
    return { html: escHtml(c), next: i + 1, isText: true };
  }
  const html = makeLink(m, isImage, ref.href, ref.title || "", cx, st);
  if (html === null) return null;
  return { html, next: i + m[0].length };
}

// Extended autolink (www./scheme://... or bare email) at i, or null.
function tryUrl(str, i, cx, st) {
  const m = execAt(INLINE_URL, str, i);
  if (!m) return null;
  let text, href;
  if (m[2] === "@") {
    text = m[0];
    href = "mailto:" + text;
  } else {
    let t0 = m[0];
    let r;
    do {
      r = t0;
      const b = BACKPEDAL.exec(t0);
      t0 = b ? b[0] : "";
    } while (r !== t0);
    text = t0;
    href = m[1] === "www." ? "http://" + t0 : t0;
  }
  if (st.textMode) return { html: text, next: i + text.length };
  const url = cleanUrl(href);
  if (url === null) return { html: escHtml(text, true), next: i + text.length };
  return { html: '<a href="' + escHtml(url, true) + '">' + escHtml(text, true) + "</a>", next: i + text.length };
}

// Inline parse of one string with the shared state st (linkParenPossible
// save/restore around the call, as in marked's inlineTokens).
function inlineInner(str, cx, st) {
  const saved = st.linkParenPossible;
  st.linkParenPossible = saved && str.includes(")");
  try {
    return inlineScan(str, cx, st);
  } finally {
    st.linkParenPossible = saved;
  }
}

// Plain-text fast path: no inline markup can occur in str, so the whole
// string is one text run. The stop points of the text rule are a backslash,
// <, [, *, _, `, ~, a two-space hard break, an @ (email), www., http(s),
// ftp://, mailto: or xmpp: — ! alone only splits a run, never its output.
const PLAIN_INLINE = /[\\<[*_`~]| {2,}\n|@|www\.|mailto:|xmpp:|ftp:\/\/|https?/i;

function inlineScan(str, cx, st) {
  if (!PLAIN_INLINE.test(str)) {
    if (st.inRawBlock) return str;
    return st.textMode ? decodeRefs(str) : escHtml(decodeRefs(str));
  }
  let masked = str;
  let closerEm = null;
  let closerDel = -1;
  if (str.includes("*") || str.includes("_") || str.includes("~")) {
    // The mask only changes the string when it holds [, `, < or \ (code
    // spans, links, tags, backslash punctuation); without those it is str.
    masked = (str.includes("[") || str.includes("`") || str.includes("<") || str.includes("\\"))
      ? buildMask(str, cx) : str;
    const sc = scanClosers(masked);
    closerEm = sc.em;
    closerDel = sc.del;
  }
  let out = "";
  let i = 0;
  const n = str.length;
  let prevChar = "";
  let lastWasText = false;
  while (i < n) {
    if (!lastWasText) prevChar = "";
    lastWasText = false;
    const ch = str[i];
    let m;
    // backslash escape
    if (ch === "\\" && (m = execAt(INLINE_ESCAPE, str, i))) {
      out += st.textMode ? m[1] : escHtml(m[1]);
      i += m[0].length;
      continue;
    }
    // raw HTML tag
    if (ch === "<" && (m = execAt(INLINE_TAG, str, i))) {
      if (!st.inLink && START_A_TAG.test(m[0])) st.inLink = true;
      else if (st.inLink && END_A_TAG.test(m[0])) st.inLink = false;
      if (!st.inRawBlock && START_RAW_TAG.test(m[0])) st.inRawBlock = true;
      else if (st.inRawBlock && END_RAW_TAG.test(m[0])) st.inRawBlock = false;
      out += m[0];
      i += m[0].length;
      continue;
    }
    // link / reflink
    if (ch === "[" || (ch === "!" && str[i + 1] === "[")) {
      const r = tryLink(str, i, cx, st);
      if (r) { out += r.html; i = r.next; continue; }
      const rf = tryRefLink(str, i, cx, st);
      if (rf) {
        out += rf.html;
        i = rf.next;
        if (rf.isText) { prevChar = rf.html; lastWasText = true; }
        continue;
      }
    }
    // emphasis / strong
    if (ch === "*" || ch === "_") {
      const r = tryEmStrong(str, i, masked, closerEm, prevChar, cx, st);
      if (r) { out += r.html; i = r.next; continue; }
    }
    // code span
    if (ch === "`" && (m = execAt(INLINE_CODE, str, i))) {
      let text = m[2].replace(NEWLINE_G, " ");
      if (NON_SPACE.test(text) && START_SPACE_CHAR.test(text) && END_SPACE_CHAR.test(text)) text = text.substring(1, text.length - 1);
      out += st.textMode ? text : "<code>" + escHtml(text, true) + "</code>";
      i += m[0].length;
      continue;
    }
    // hard break
    if ((ch === " " || ch === "\\") && (m = execAt(INLINE_BR, str, i))) {
      out += st.textMode ? "" : "<br>";
      i += m[0].length;
      continue;
    }
    // strikethrough
    if (ch === "~") {
      const r = tryDel(str, i, masked, closerDel, prevChar, cx, st);
      if (r) { out += r.html; i = r.next; continue; }
    }
    // autolink <...>
    if (ch === "<" && (m = execAt(INLINE_AUTOLINK, str, i))) {
      const text = m[1];
      const href = m[2] === "@" ? "mailto:" + text : text;
      if (st.textMode) {
        out += text;
      } else {
        const url = cleanUrl(href);
        if (url === null) out += escHtml(text, true);
        else out += '<a href="' + escHtml(url, true) + '">' + escHtml(text, true) + "</a>";
      }
      i += m[0].length;
      continue;
    }
    // extended autolink
    if (!st.inLink && (ch === "." || ch === "_" || ch === "+" || ch === "-" || (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z"))) {
      const r = tryUrl(str, i, cx, st);
      if (r) { out += r.html; i = r.next; continue; }
    }
    // text
    m = execAt(INLINE_TEXT, str, i);
    if (m) {
      const raw = m[0];
      if (raw.slice(-1) !== "_") prevChar = raw.slice(-1);
      lastWasText = true;
      out += st.inRawBlock ? raw : (st.textMode ? decodeRefs(raw) : escHtml(decodeRefs(raw)));
      i += raw.length;
      continue;
    }
    // Fallback (should not happen): consume one char as text.
    if (ch !== "_") prevChar = ch;
    lastWasText = true;
    out += st.inRawBlock ? ch : (st.textMode ? ch : escHtml(ch));
    i++;
  }
  return out;
}

// Top-level inline render of one string. The state (inLink,
// linkEmitted) is the document-level Lexer state: it persists across
// paragraphs, so an unclosed <a> tag affects later paragraphs. But
// inRawBlock is reset before every render, as in the reference: an
// unclosed <code>/<kbd> tag only makes its own paragraph raw, and a
// later paragraph is escaped and decoded normally again.
function inlineToHtml(str, cx) {
  cx.st.inRawBlock = false;
  return inlineInner(str, cx, cx.st);
}

// Plain-text render (image alt text): fresh state in text mode.
function plainText(str, cx) {
  const st = freshState();
  st.textMode = true;
  return inlineInner(str, cx, st);
}

// ============================================================
// parse: the entry point. Renders markdown to HTML exactly as
// marked 18.1.3's marked.parse does with default options.
// ============================================================
export function parse(markdown) {
  const raw = String(markdown);
  const src = raw.indexOf("\r") === -1 ? raw : raw.replace(/\r\n|\r/g, "\n");
  const cx = { links: new Map(), st: freshState(), top: true };
  const nodes = [];
  blockParse(src, cx, false, nodes);
  const out = [];
  renderNodes(nodes, cx, out);
  return out.join("");
}
