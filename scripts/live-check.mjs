/**
 * Live check of the configured AI provider against the deterministic offline reference.
 * Every bundled sample is analysed twice through the HTTP API, in-process on 127.0.0.1 with
 * MOCK PayPal: once with the offline sample parser (the reference) and once with the AI provider
 * from .env / the environment (for example NEBIUS_API_KEY for NVIDIA Nemotron on Nebius Token Factory).
 * It prints a table and exits with 1 if any verdict or total differs or a sample fell back.
 *
 *   npm run live-check                       all samples, one run
 *   npm run live-check -- --runs 3           three runs
 *   npm run live-check -- overbilled honest  selected samples
 *
 * Makes real model calls (about five per sample and run). Keys are never printed.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from '../src/env.mjs';
import { createApp } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const runsAt = args.indexOf('--runs');
const runs = runsAt >= 0 ? Math.max(1, Number(args[runsAt + 1]) || 1) : 1;
const chosen = args.filter((arg, index) => !arg.startsWith('--') && !(runsAt >= 0 && index === runsAt + 1));

const env = { ...process.env };
loadDotEnv(path.join(root, '.env'), env);
for (const key of ['PORT', 'RENDER', 'RENDER_EXTERNAL_HOSTNAME', 'ALLOWED_HOSTS', 'PUBLIC_BASE_URL', 'LEDGER_PATH']) delete env[key];
const common = { PAYPAL_MOCK: '1', PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '', LOG_REQUESTS: '0' };

async function start(extra) {
  const app = await createApp({ env: { ...env, ...common, ...extra }, quiet: true });
  const { port } = await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${port}` };
}

async function analyze(base, sampleId) {
  const started = Date.now();
  const response = await fetch(`${base}/api/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sampleId }) });
  const body = await response.json();
  if (!response.ok) throw new Error(`${sampleId}: HTTP ${response.status} ${body?.error?.message ?? ''}`);
  return { ms: Date.now() - started, view: body.case };
}

const verdicts = (view) => (view.verification?.lines ?? []).map((line) => line.verdict).join(',');
const totals = (view) => JSON.stringify(view.verification?.totals ?? null);

const reference = await start({ AI_PROVIDER: 'offline' });
// A fresh server for every run, so no run is served from another run's cache.
let live = await start({});
const health = await (await fetch(`${live.base}/health`)).json();
if (health.ai === 'offline') {
  console.error('No AI provider is configured (set NEBIUS_API_KEY, GEMINI_API_KEY or AI_BASE_URL in .env).');
  await reference.app.close();
  await live.app.close();
  process.exit(2);
}
const label = `${health.ai}: ${live.app.config.ai.model}`;
const samples = (await (await fetch(`${reference.base}/api/cases`)).json()).samples.map((sample) => sample.id);
const ids = chosen.length ? chosen : samples;

console.log(`Live check: ${label}, ${runs} run(s), samples ${ids.join(', ')}\n`);
console.log('| Run | Sample | Same verdicts | Same totals | Read as | Message | Time |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
let failures = 0;
try {
  for (let run = 1; run <= runs; run += 1) {
    if (run > 1) {
      await live.app.close();
      live = await start({});
    }
    for (const id of ids) {
      const expected = (await analyze(reference.base, id)).view;
      const { ms, view } = await analyze(live.base, id);
      const sameVerdicts = verdicts(view) === verdicts(expected);
      const sameTotals = totals(view) === totals(expected);
      const fellBack = Boolean(view.extraction.fallback);
      if (!sameVerdicts || !sameTotals || fellBack) failures += 1;
      const readAs = fellBack ? `fallback: ${view.extraction.fallback.reason}` : `${view.extraction.outputFormat ?? 'n/a'}${view.extraction.cached ? ' (cached)' : ''}`;
      const message = view.message ? `${view.message.source}${view.message.note ? ' (note)' : ''}` : 'none';
      console.log(`| ${run} | ${id} | ${sameVerdicts ? 'yes' : `NO: ${verdicts(view)}`} | ${sameTotals ? 'yes' : 'NO'} | ${readAs} | ${message} | ${(ms / 1000).toFixed(1)} s |`);
    }
  }
} finally {
  await reference.app.close();
  await live.app.close();
}
console.log(failures === 0 ? '\nAll cases match the reference.' : `\n${failures} case(s) differ from the reference or fell back.`);
process.exit(failures === 0 ? 0 : 1);
