# Third-party notices

PayOnProof is released under the MIT License (see `LICENSE`). It includes or depends on the following third-party software.

## Shipped to the browser (self-hosted in `public/`)

### AG Grid Community: ag-grid-community 36.2.0

- Files: `public/vendor/ag-grid-community.min.noStyle.js` (unmodified UMD build from the npm package `ag-grid-community@36.2.0`, `dist/ag-grid-community.min.noStyle.js`) and `public/vendor/ag-grid-community.LICENSE.txt`.
- License: MIT. Copyright (c) 2015-2026 AG GRID LTD.
- Only AG Grid Community features are used; no AG Grid Enterprise code or license key is involved.

```
The MIT License

Copyright (c) 2015-2026 AG GRID LTD

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### Atkinson Hyperlegible Next and Atkinson Hyperlegible Mono (fonts)

- Files: `public/fonts/*.woff2`, taken unmodified from `@fontsource-variable/atkinson-hyperlegible-next@5.3.0` and `@fontsource-variable/atkinson-hyperlegible-mono@5.3.0`.
- License: SIL Open Font License, Version 1.1. Full text: `public/fonts/OFL-atkinson-hyperlegible.txt`.
- Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors (https://github.com/googlefonts/atkinson-hyperlegible-next).
- Copyright 2020-2024 The Atkinson Hyperlegible Mono Project Authors (https://github.com/googlefonts/atkinson-hyperlegible-next-mono).

## Server-side npm dependencies (installed by `npm ci`, not redistributed in this repository)

| Package | Version | License | Use |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT (Copyright (c) 2024 Anthropic, PBC) | MCP server over Streamable HTTP |
| `zod` | 4.6.7 | MIT | MCP tool input schemas |
| `playwright-core` (dev only) | 1.56.1 | Apache-2.0 | End-to-end screenshot script |

Their transitive dependencies carry their own licenses, listed in `node_modules/*/package.json` after installation.

## Trademarks

PayPal is a trademark of PayPal, Inc. Gemini is a trademark of Google LLC. AG Grid is a trademark of AG GRID LTD. They are named only to describe integrations; this project is not affiliated with or endorsed by them.
