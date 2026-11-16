# Fast Markdown Renderer

A dependency-free, from-scratch CommonMark + GFM renderer written as a
single ES module (`parse.js`). It produces byte-identical HTML to
`marked` on the competition corpus while running significantly faster.

Built for the [markdown-render-speed-02 bounty](https://make.fun/bounty/markdown-render-speed-02).

[![bounty](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/embongtuyul/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/embongtuyul/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

## How it works

- Line-based block parser with a CommonMark-style open-block stack
  (blockquotes, lists, fences, HTML blocks, tables, setext headings).
- Single-pass inline scanner with a delimiter stack for emphasis,
  strong, strikethrough, links, autolinks, and code spans.
- Column-cursor tab handling: tabs expand by absolute column, with
  partial-tab consumption through container prefixes.
- No dependencies, no network, Node built-ins only.

## Layout

- `parse.js` — the renderer; exports `parse(markdown)`.
- `main.ts` — reads `/input/cases.json`, writes `/output/html.json`.
- `package.json` — `{"type": "module"}`.
