/**
 * End-to-end check of the real UI in Chromium, offline: offline sample parser + MOCK PayPal.
 * Loads the page, picks the "Overbilled" sample, checks the verdicts, approves, pays,
 * waits for the PayPal readback and saves screenshots to docs/img/.
 *
 *   npm run e2e            (needs a Chromium for playwright-core, e.g. PLAYWRIGHT_BROWSERS_PATH)
 *
 * Fails on console errors, CSP violations or horizontal page scrolling.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'img');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
let base;

const runs = [
  { name: 'desktop-light', viewport: { width: 1280, height: 800 }, colorScheme: 'light', scale: 1 },
  { name: 'desktop-dark', viewport: { width: 1280, height: 800 }, colorScheme: 'dark', scale: 1 },
  { name: 'phone-light', viewport: { width: 390, height: 844 }, colorScheme: 'light', scale: 2, mobile: true },
  { name: 'phone-dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark', scale: 2, mobile: true },
];

/** "Your documents": edit a sample number offline and watch the verdict move; non-sample text is refused. */
async function pasteFlow(page) {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#tab-paste').click();
  await page.locator('#paste-sample').selectOption('overbilled');
  await page.locator('#paste-fill').click();
  const invoice = page.locator('#paste-invoice');
  await invoice.fill((await invoice.inputValue()).replace('| 22.0  | m3   | 128.00     | 2,816.00', '| 18.0  | m3   | 128.00     | 2,304.00'));
  await page.locator('#analyze-btn').click();
  await page.waitForFunction(() => document.querySelector('#sum-payable')?.textContent.trim() === '€5,035.00'
    && document.querySelector('#sum-claimed')?.textContent.trim() === '€5,826.00');
  await page.locator('#tab-paste').click();
  await invoice.fill('Hi, please pay me 5000 EUR for last week. Bob');
  await page.locator('#analyze-btn').click();
  await page.locator('#cannot-verify:not([hidden])').waitFor();
  assert.match(await page.locator('#cannot-verify').textContent(), /Invoice could not be read/);
  assert.ok(await page.locator('#approve').isHidden(), 'an unreadable case cannot be approved');
  assert.ok(await page.locator('#ledger').isHidden(), 'no payable figure is shown from missing evidence');
}

/** The paid-invoice ledger: the invoice just paid cannot be paid again through a new case. */
async function paidTwiceFlow(page) {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('label[for="sample-overbilled"]').click();
  await page.locator('#analyze-btn').click();
  await page.locator('#case-findings li[data-severity="blocker"]').getByText('was already sent to PayPal in case').waitFor();
  assert.ok(await page.locator('#approve-btn').isDisabled(), 'the second case for the same invoice cannot be approved');
}

let failures = 0;
for (const run of runs) {
  // A fresh server per run: its paid-invoice ledger (in memory with MOCK PayPal) starts empty.
  const app = await createApp({ env: { PAYPAL_MOCK: '1', AI_PROVIDER: 'offline', LOG_REQUESTS: '0' }, quiet: true, readbackDelaysMs: [0, 250, 500] });
  base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
  const context = await browser.newContext({
    viewport: run.viewport, colorScheme: run.colorScheme, deviceScaleFactor: run.scale,
    isMobile: Boolean(run.mobile), hasTouch: Boolean(run.mobile), reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || /content security policy/i.test(message.text())) problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.locator('.case-option').first().waitFor();
    assert.equal(await page.locator('.case-option').count(), 4, 'four sample cases');
    await page.screenshot({ path: path.join(outDir, `${run.name}-start.png`) });

    await page.locator('label[for="sample-overbilled"]').click();
    await page.locator('#analyze-btn').click();
    await page.locator('#lines-grid .ag-row').first().waitFor();
    await page.waitForFunction(() => document.querySelectorAll('#lines-grid .ag-row').length === 8);
    assert.equal((await page.locator('#sum-payable').textContent()).trim(), '€5,035.00');
    assert.equal((await page.locator('#sum-disputed').textContent()).trim(), '€1,303.00');
    const verdicts = await page.locator('#lines-grid .verdict').allTextContents();
    for (const expected of ['Duplicate', 'Unsigned', 'Partial', 'Proven']) assert.ok(verdicts.includes(expected), `verdict ${expected} shown`);
    assert.match(await page.locator('#title-block').textContent(), /Offline sample parser — no AI used/);
    await page.locator('#proof').screenshot({ path: path.join(outDir, `${run.name}-proof.png`) });

    await page.locator('#confirm-check').check();
    await page.locator('#approve-btn').click();
    await page.locator('#approval-state').getByText('Approved at').waitFor();
    await page.locator('#pay-btn:not([disabled])').waitFor();
    await page.locator('#pay-btn').click();
    await page.locator('.stamp').getByText('Paid & verified').waitFor({ timeout: 15_000 });
    assert.match(await page.locator('#receipt').textContent(), /SUCCESS/);
    assert.match(await page.locator('#paypal-badge').textContent(), /MOCK PayPal/);

    await page.evaluate(() => document.querySelector('#toast')?.removeAttribute('data-show'));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `no horizontal page scroll (overflow ${overflow}px)`);
    await page.locator('#receipt').screenshot({ path: path.join(outDir, `${run.name}-receipt.png`) });
    await page.screenshot({ path: path.join(outDir, `${run.name}.png`), fullPage: true });
    if (run.name === 'desktop-light') {
      await paidTwiceFlow(page);
      await pasteFlow(page);
    }
    assert.deepEqual(problems, [], 'no console errors or CSP violations');
    console.log(`ok ${run.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAILED ${run.name}: ${error.message}`);
    if (problems.length) console.error(problems.join('\n'));
    await page.screenshot({ path: path.join(outDir, `${run.name}-failure.png`), fullPage: true }).catch(() => {});
  }
  await context.close();
  await app.close();
}

await browser.close();
if (failures) {
  console.error(`${failures} run(s) failed`);
  process.exit(1);
}
console.log(`screenshots written to ${path.relative(root, outDir)}`);
