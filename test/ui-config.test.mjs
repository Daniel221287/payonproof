import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../src/config.mjs';
import { loadDotEnv, parseDotEnv } from '../src/env.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const html = read('public/index.html');

test('every script, stylesheet and icon the page references exists in public/', () => {
  const refs = [...html.matchAll(/(?:src|href)="\/([^"#?]+)"/g)].map((match) => match[1]).filter((ref) => ref !== '');
  assert.ok(refs.includes('app.js') && refs.includes('styles.css') && refs.includes('vendor/ag-grid-community.min.noStyle.js'));
  for (const ref of refs) assert.ok(existsSync(`${root}public/${ref}`), `public/${ref} exists`);
  for (const match of read('public/styles.css').matchAll(/url\(\/([^)]+)\)/g)) assert.ok(existsSync(`${root}public/${match[1]}`), match[1]);
});

test('no inline scripts or inline event handlers in the page', () => {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(match[1], /\ssrc="/, 'every script is external');
    assert.equal(match[2].trim(), '', 'script elements have no inline body');
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no onclick= style handlers');
  assert.doesNotMatch(html, /javascript:/i);
  assert.match(html, /<meta name="csp-nonce" content="\{\{CSP_NONCE\}\}">/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<h1 /);
});

test('the client never turns data into HTML', () => {
  const app = read('public/app.js');
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
    assert.ok(!app.includes(sink), `app.js does not use ${sink}`);
  }
});

test('the UI shows the sandbox badge, the MOCK label and the PayPal pay button', () => {
  const app = read('public/app.js');
  assert.match(html, /Sandbox: no real money/);
  assert.match(app, /MOCK PayPal/);
  assert.match(html, /Pay with PayPal \(sandbox\)/);
  assert.match(html, /Approve exactly this payment/);
  assert.match(read('public/styles.css'), /@media \(prefers-color-scheme: dark\)/);
  assert.match(read('public/styles.css'), /:root\[data-theme="dark"\]/);
});

test('AG Grid Community is self-hosted at the pinned MIT-licensed version', () => {
  const pkg = JSON.parse(read('package.json'));
  const version = pkg.devDependencies['ag-grid-community'];
  assert.match(version, /^\d+\.\d+\.\d+$/, 'exact version pin');
  assert.ok(read('public/vendor/ag-grid-community.min.noStyle.js').includes(`"${version}"`));
  assert.match(read('public/vendor/ag-grid-community.LICENSE.txt'), /The MIT License/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.ok(notices.includes(`ag-grid-community ${version}`));
  assert.match(notices, /SIL Open Font License/);
  assert.match(read('LICENSE'), /MIT License[\s\S]*2026 Daniel221287/);
});

test('.env parsing: comments, export, quotes; existing variables win; values never echoed', () => {
  const parsed = parseDotEnv('# comment\nexport A=1\nB = "two words" \nC=\'x#y\'\nD=plain # trailing\nE="line\\nbreak"\nbad line\n');
  assert.deepEqual(parsed, { A: '1', B: 'two words', C: 'x#y', D: 'plain', E: 'line\nbreak' });
  const target = { A: 'kept' };
  const missing = loadDotEnv(`${root}does-not-exist.env`, target);
  assert.equal(missing.found, false);
  const result = loadDotEnv(`${root}.env.example`, target);
  assert.equal(result.found, true);
  assert.ok(result.loaded.every((name) => /^[A-Z0-9_]+$/.test(name)), 'only names are reported');
});

test('a .env copied from .env.example picks the AI provider from the key that is added to it', () => {
  const example = parseDotEnv(read('.env.example'));
  assert.equal(example.AI_PROVIDER, '', 'AI_PROVIDER is left empty (automatic)');
  assert.equal(resolveConfig(example).ai.provider, 'offline');
  assert.equal(resolveConfig({ ...example, GEMINI_API_KEY: 'dummy' }).ai.provider, 'gemini');
  assert.equal(resolveConfig({ ...example, NEBIUS_API_KEY: 'dummy' }).ai.provider, 'nebius');
});

test('.env.example documents every environment variable the code reads', () => {
  const documented = new Set([...read('.env.example').matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]));
  const files = ['server.mjs', 'mcp.mjs', ...readdirSync(`${root}src`).map((file) => `src/${file}`)];
  const used = new Set();
  for (const file of files) {
    for (const match of read(file).matchAll(/\b(?:env|effective|process\.env)\.([A-Z][A-Z0-9_]+)/g)) used.add(match[1]);
  }
  assert.ok(used.size > 10);
  for (const name of used) assert.ok(documented.has(name), `${name} is documented in .env.example`);
  assert.ok(!existsSync(`${root}.env`) || read('.gitignore').includes('.env'), '.env is never committed');
  assert.match(read('.gitignore'), /^\.env$/m);
  assert.match(read('.gitignore'), /^node_modules\/?$/m);
});
