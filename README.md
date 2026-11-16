# markdown-render-speed-02 entry

A fast, dependency-free Markdown renderer whose `parse(markdown)` returns
exactly the HTML that marked 18.1.3's `marked.parse` returns with default
options (GFM on, breaks off, pedantic off, async off).

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
