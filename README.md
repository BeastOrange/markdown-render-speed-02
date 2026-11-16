# markdown-render-speed-02 entry

A fast, dependency-free Markdown renderer. `parse(markdown)` returns
exactly the HTML that marked 18.1.3's `marked.parse` returns with default
options (GFM on, breaks off, pedantic off, async off) — byte for byte, for
every string. Where marked departs from CommonMark or GFM, marked's output
is the target, never the spec's.

## Layout

- `parse.js` — the renderer. An original implementation: index-based
  sticky-regex scanning over the block and inline grammars, no token
  trees, direct HTML rendering. The grammar patterns are generated from
  the reference grammar for byte-exactness (see NOTICE.md).
- `main.ts` — the harness driver: reads `/input/cases.json`, renders each
  case with `parse`, writes `/output/html.json`.

## Run

```sh
node main.ts   # with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR set, or /input and /output
```

No dependencies, no network, no build step. Node 22.

## How it stays byte-exact

- The block and inline patterns are the reference grammar's own, adapted
  to sticky (`y`) matching so the scanner works by index.
- Link reference definitions are collected in a first block pass, exactly
  as the reference does, before any inline text is rendered.
- Emphasis, strong emphasis and strikethrough use the reference's
  delimiter-matching algorithm (masked source, last-possible-closer scan,
  left/right delimiter rules), including its edge cases: a `~~` opener
  followed by punctuation only opens after start-of-string or
  punctuation/space, while one followed by an ordinary character always
  opens (`a~~b~~c` strikethroughs, `a~~.b~~c` does not). The
  emphasis run-back and the char before the run are read from the masked
  source, as the reference does, so an opener inside a masked link or
  code span gets the reference's mod-3 treatment.
- Block state follows the reference's Lexer state: `top` flips as nested
  lists and blockquotes are parsed, and the raw-block flag resets before
  every inline render while the in-link flag persists across paragraphs.

## How it gets faster than marked

- No token tree: blocks render straight to the output string and inline
  text is rendered once, when its paragraph is emitted.
- Cheap guards before the big block grammars: blockquote, HTML block,
  link definition, table and setext-heading patterns only run when the
  next characters can start one (a `>`, `<`, `[`, a table delimiter line,
  or a setext underline line ahead).
- Plain-text fast path: an inline string with no markup characters at all
  is escaped in one pass instead of going through the inline dispatcher.
- The emphasis/strikethrough mask is skipped when the string holds no
  `[`, `` ` ``, `<` or `\` — then the mask is the string itself.
- Lists accumulate item text in an array and join once; table rows split
  in one forward pass instead of scanning backwards from every pipe.

## Verification

- Practice set: 720/720 cases byte-identical to marked 18.1.3.
- CommonMark 0.31.2 spec examples (680): byte-identical.
- Differential fuzzing against marked: 100,000+ mutated and composed
  documents across many seeds, plus 120 large (50–110 KB) multi-paragraph
  documents — no differences.
- Deterministic: two runs over the same input produce byte-identical
  output — `parse` is a pure function of its input (no clock, randomness
  or I/O).
