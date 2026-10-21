/**
 * Copies third-party browser assets from node_modules into public/ (self-hosted, no CDN).
 * Run after changing the versions in package.json: npm run vendor
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const copies = [
  ['node_modules/ag-grid-community/dist/ag-grid-community.min.noStyle.js', 'public/vendor/ag-grid-community.min.noStyle.js'],
  ['node_modules/ag-grid-community/LICENSE.txt', 'public/vendor/ag-grid-community.LICENSE.txt'],
  ['node_modules/@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2', 'public/fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2'],
  ['node_modules/@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-ext-wght-normal.woff2', 'public/fonts/atkinson-hyperlegible-next-latin-ext-wght-normal.woff2'],
  ['node_modules/@fontsource-variable/atkinson-hyperlegible-mono/files/atkinson-hyperlegible-mono-latin-wght-normal.woff2', 'public/fonts/atkinson-hyperlegible-mono-latin-wght-normal.woff2'],
  ['node_modules/@fontsource-variable/atkinson-hyperlegible-next/LICENSE', 'public/fonts/OFL-atkinson-hyperlegible.txt'],
];
for (const [from, to] of copies) {
  mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  copyFileSync(path.join(root, from), path.join(root, to));
  console.log(`copied ${to}`);
}
