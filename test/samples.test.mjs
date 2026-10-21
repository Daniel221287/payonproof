import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAiProvider } from '../src/ai.mjs';
import { assembleCaseInput, extractDocuments } from '../src/extract.mjs';
import { OFFLINE_LABEL, OfflineParseError, parseLocaleNumber, parseOffline } from '../src/offline-parser.mjs';
import { loadSamples } from '../src/samples.mjs';
import { verifyCase } from '../src/verify.mjs';

const samples = loadSamples(fileURLToPath(new URL('../samples', import.meta.url)));
const offline = createAiProvider({ provider: 'offline', model: 'offline-sample-parser' });

test('four fictional sample cases are bundled, each with all four document types', () => {
  assert.deepEqual(samples.map((s) => s.id), ['overbilled', 'honest', 'rate-drift', 'multilingual']);
  for (const sample of samples) {
    assert.deepEqual(sample.documents.map((d) => d.type).sort(), ['contract', 'delivery_notes', 'invoice', 'timesheet']);
    for (const doc of sample.documents) assert.doesNotMatch(doc.text, /@(?!example\.(com|net|org))[a-z0-9-]+\.[a-z]+/i, 'only example.* email domains');
  }
});

for (const sample of samples) {
  test(`offline parser + engine reproduce the expected verdicts for "${sample.id}"`, async () => {
    const expected = JSON.parse(readFileSync(new URL(`./fixtures/${sample.id}.expected.json`, import.meta.url), 'utf8'));
    const extraction = await extractDocuments(sample.documents, { provider: offline });
    assert.equal(extraction.label, OFFLINE_LABEL);
    assert.equal(extraction.isAI, false);
    for (const doc of extraction.documents) assert.equal(doc.status, 'ok', `${doc.name}: ${JSON.stringify(doc.errors)}`);
    const { input, blockers } = assembleCaseInput(extraction);
    assert.deepEqual(blockers, []);
    const result = verifyCase(input);
    assert.deepEqual(
      { claimedCents: result.totals.claimedCents, payableCents: result.totals.payableCents, disputedCents: result.totals.disputedCents },
      expected.totals,
    );
    assert.deepEqual(result.caseFindings.map((f) => f.code), expected.caseFindings);
    assert.deepEqual(
      result.lines.map((line) => ({ id: line.id, verdict: line.verdict, findings: line.findings.map((f) => f.code), payableCents: line.payableCents })),
      expected.lines,
    );
  });
}

test('the multilingual sample reads a Polish invoice against German site papers', () => {
  const sample = samples.find((s) => s.id === 'multilingual');
  const invoice = parseOffline('invoice', sample.documents.find((d) => d.type === 'invoice').text);
  assert.equal(invoice.invoiceNumber, '14/09/2026');
  assert.equal(invoice.total, 2090);
  assert.equal(invoice.lines[0].date, '2026-09-16');
  assert.equal(invoice.lines[4].itemCode, 'BSO-5');
  const sheet = parseOffline('timesheet', sample.documents.find((d) => d.type === 'timesheet').text);
  assert.deepEqual(sheet.entries.map((e) => e.signed), [true, true, true, false]);
  const contract = parseOffline('contract', sample.documents.find((d) => d.type === 'contract').text);
  assert.equal(contract.language, 'pl');
  assert.equal(contract.paymentCap, 1800);
  assert.deepEqual(contract.rates[0].aliases, ['Dekarz']);
});

test('locale numbers are read per document language', () => {
  assert.equal(parseLocaleNumber('1,040.00', 'en'), 1040);
  assert.equal(parseLocaleNumber('1.040,00', 'de'), 1040);
  assert.equal(parseLocaleNumber('2 090,00 EUR', 'pl'), 2090);
  assert.equal(parseLocaleNumber('9,00', 'de'), 9);
  assert.throws(() => parseLocaleNumber('nine', 'en'), OfflineParseError);
});

test('the offline parser refuses anything that is not the sample layout', async () => {
  assert.throws(() => parseOffline('invoice', 'Hi, please pay me 5000 EUR for last week. Thanks, Bob'), /only reads the bundled sample layout/);
  assert.throws(() => parseOffline('timesheet', 'INVOICE\nInvoice no.: 1'), /does not start like a sample timesheet/);
  const extraction = await extractDocuments([
    { id: 'c', name: 'Contract', type: 'contract', text: 'Our deal: 40 EUR per hour.' },
    { id: 'i', name: 'Invoice', type: 'invoice', text: 'Please pay 1000 EUR.' },
  ], { provider: offline });
  assert.ok(extraction.documents.every((doc) => doc.status === 'rejected'));
  const { input, blockers } = assembleCaseInput(extraction);
  assert.equal(input, null);
  assert.deepEqual(blockers.map((b) => b.code), ['DOCUMENT_REJECTED', 'DOCUMENT_REJECTED']);
});

test('edited sample text is read as edited (offline demo: change a number, see the verdict move)', async () => {
  const sample = samples.find((s) => s.id === 'overbilled');
  const documents = sample.documents.map((doc) => (doc.type === 'invoice'
    ? { ...doc, text: doc.text.replace('| 22.0  | m3   | 128.00     | 2,816.00', '| 18.0  | m3   | 128.00     | 2,304.00') }
    : doc));
  const { input } = assembleCaseInput(await extractDocuments(documents, { provider: offline }));
  const line7 = verifyCase(input).lines.find((line) => line.id === '7');
  assert.equal(line7.verdict, 'PROVEN');
});
