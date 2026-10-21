import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyCase } from '../src/verify.mjs';

const RATES = [
  { kind: 'labour', name: 'Steel fixer', aliases: ['Rebar fixer', 'Zbrojarz'], code: null, unit: 'h', unitAsWritten: 'h', priceCents: 4100 },
  { kind: 'labour', name: 'Formwork carpenter', aliases: [], code: null, unit: 'h', unitAsWritten: 'h', priceCents: 3950 },
  { kind: 'material', name: 'Ready-mix concrete C30/37', aliases: ['Beton C30/37'], code: 'RMC-C30', unit: 'm3', unitAsWritten: 'm3', priceCents: 12800 },
];

function labour(id, worker, date, hours, priceCents = 4100, totalCents = Math.round((hours * priceCents))) {
  return {
    id, kind: 'labour', worker, role: 'Steel fixer', item: null, itemCode: null, date,
    quantityMilli: Math.round(hours * 1000), unit: 'h', unitAsWritten: 'h', unitPriceCents: priceCents, lineTotalCents: totalCents,
  };
}
function concrete(id, date, qty, totalCents = qty * 12800, extra = {}) {
  return {
    id, kind: 'material', worker: null, role: null, item: 'Ready-mix concrete C30/37', itemCode: 'RMC-C30', date,
    quantityMilli: qty * 1000, unit: 'm3', unitAsWritten: 'm3', unitPriceCents: 12800, lineTotalCents: totalCents, ...extra,
  };
}
function entry(worker, date, hours, signed = true) {
  return { ref: null, worker, role: null, date, hoursMilli: Math.round(hours * 1000), signed, signedBy: signed ? 'K. Vogelsang' : null };
}
function note(ref, date, qty, extra = {}) {
  return { ref, item: 'Ready-mix concrete C30/37', itemCode: 'RMC-C30', quantityMilli: qty * 1000, unit: 'm3', unitAsWritten: 'm3', date, receivedBy: null, ...extra };
}
function run({ lines, entries = [], notes = [], cap = null, invoice = {}, contract = {} }) {
  return verifyCase({
    contract: { contractId: 'SC-1', subcontractor: 'Crew', payeeEmail: 'crew@example.com', currency: 'EUR', language: 'en', paymentCapCents: cap, rates: RATES, ...contract },
    invoice: { invoiceNumber: 'INV-1', issuer: 'Crew', issueDate: null, contractRef: 'SC-1', currency: 'EUR', payeeEmail: null, totalCents: null, lines, ...invoice },
    timesheets: [{ docId: 'ts', sheetRef: 'TS', entries }],
    deliveryNotes: [{ docId: 'dn', notes }],
  });
}
const byId = (result, id) => result.lines.find((line) => line.id === id);

test('PROVEN: signed hours at the contract rate are paid exactly as invoiced', () => {
  const result = run({ lines: [labour('1', 'Adam Kordecki', '2026-09-14', 9)], entries: [entry('Kordecki, Adam', '2026-09-14', 9)] });
  const line = byId(result, '1');
  assert.equal(line.verdict, 'PROVEN');
  assert.equal(line.payableCents, 36900);
  assert.deepEqual(line.evidenceIds, ['TS#1']);
  assert.match(line.reason, /TS#1 \(9 h signed by K\. Vogelsang\)/);
});

test('PARTIAL: only signed hours are paid', () => {
  const result = run({ lines: [labour('1', 'Ihor Tkachuk', '2026-09-17', 10)], entries: [entry('Tkachuk, Ihor', '2026-09-17', 8)] });
  const line = byId(result, '1');
  assert.equal(line.verdict, 'PARTIAL');
  assert.equal(line.provenQtyMilli, 8000);
  assert.equal(line.payableCents, 32800);
  assert.equal(line.disputedCents, 8200);
});

test('UNSIGNED: an entry without the site manager signature proves nothing', () => {
  const result = run({ lines: [labour('1', 'Bartosz Lisowiec', '2026-09-16', 8)], entries: [entry('Lisowiec, Bartosz', '2026-09-16', 8, false)] });
  assert.equal(byId(result, '1').verdict, 'UNSIGNED');
  assert.equal(byId(result, '1').payableCents, 0);
});

test('UNPROVEN: no timesheet entry for that worker and day', () => {
  const result = run({ lines: [labour('1', 'Bartosz Lisowiec', '2026-09-19', 8)], entries: [entry('Lisowiec, Bartosz', '2026-09-18', 8)] });
  assert.equal(byId(result, '1').verdict, 'UNPROVEN');
  assert.match(byId(result, '1').reason, /No timesheet entry/);
});

test('DUPLICATE: a repeated line the evidence cannot cover twice is not paid', () => {
  const result = run({
    lines: [labour('3', 'Adam Kordecki', '2026-09-15', 9), labour('4', 'Adam Kordecki', '2026-09-15', 9)],
    entries: [entry('Kordecki, Adam', '2026-09-15', 9)],
  });
  assert.equal(byId(result, '3').verdict, 'PROVEN');
  assert.equal(byId(result, '4').verdict, 'DUPLICATE');
  assert.equal(byId(result, '4').findings[0].params.duplicateOf, '3');
  assert.equal(byId(result, '4').payableCents, 0);
});

test('identical lines are both paid when the evidence really covers both (two concrete trucks)', () => {
  const result = run({
    lines: [concrete('1', '2026-09-16', 9), concrete('2', '2026-09-16', 9)],
    notes: [note('LS-1', '2026-09-16', 9), note('LS-2', '2026-09-16', 9)],
  });
  assert.equal(byId(result, '1').verdict, 'PROVEN');
  assert.equal(byId(result, '2').verdict, 'PROVEN');
  assert.deepEqual(byId(result, '2').evidenceIds, ['LS-2']);
});

test('evidence is consumed: one signed day never proves two different lines', () => {
  const result = run({
    lines: [labour('1', 'Adam Kordecki', '2026-09-14', 5), labour('2', 'Adam Kordecki', '2026-09-14', 4), labour('3', 'Adam Kordecki', '2026-09-14', 2)],
    entries: [entry('Kordecki, Adam', '2026-09-14', 8)],
  });
  assert.equal(byId(result, '1').provenQtyMilli, 5000);
  assert.equal(byId(result, '2').verdict, 'PARTIAL');
  assert.equal(byId(result, '2').provenQtyMilli, 3000);
  assert.equal(byId(result, '3').verdict, 'UNPROVEN');
  assert.match(byId(result, '3').reason, /already used by line 1, 2/);
});

test('PARTIAL material: 22 m3 invoiced, 18 m3 on delivery notes', () => {
  const result = run({ lines: [concrete('7', '2026-09-16', 22)], notes: [note('LS-4471', '2026-09-16', 9), note('LS-4472', '2026-09-16', 9)] });
  const line = byId(result, '7');
  assert.equal(line.verdict, 'PARTIAL');
  assert.equal(line.payableCents, 230400);
  assert.deepEqual(line.evidenceIds, ['LS-4471', 'LS-4472']);
});

test('materials match by article code across languages, roles by alias', () => {
  const result = run({
    lines: [
      concrete('1', '2026-09-16', 9, 115200, { item: 'Beton towarowy C30/37' }),
      { ...labour('2', 'Jan Nowak', '2026-09-16', 8), role: 'Zbrojarz' },
    ],
    entries: [entry('Nowak, Jan', '2026-09-16', 8)],
    notes: [note('LS-9', '2026-09-16', 9, { item: 'Transportbeton C30/37', unit: 'm3' })],
  });
  assert.equal(byId(result, '1').verdict, 'PROVEN');
  assert.equal(byId(result, '2').verdict, 'PROVEN');
  assert.equal(byId(result, '2').contractRateName, 'Steel fixer');
});

test('RATE_ABOVE_CONTRACT: paid at the contract rate', () => {
  const result = run({ lines: [labour('1', 'Adam Kordecki', '2026-09-14', 8, 4300, 34400)], entries: [entry('Adam Kordecki', '2026-09-14', 8)] });
  const line = byId(result, '1');
  assert.equal(line.verdict, 'RATE_ABOVE_CONTRACT');
  assert.equal(line.payRateCents, 4100);
  assert.equal(line.payableCents, 32800);
});

test('MATH_ERROR: the printed total is ignored and the correct product is paid', () => {
  const result = run({ lines: [labour('3', 'Adam Kordecki', '2026-09-15', 8, 4100, 35600)], entries: [entry('Adam Kordecki', '2026-09-15', 8)] });
  const line = byId(result, '3');
  assert.equal(line.verdict, 'MATH_ERROR');
  assert.equal(line.correctCents, 32800);
  assert.equal(line.payableCents, 32800);
});

test('a line with several problems lists them all; the verdict follows the precedence', () => {
  const result = run({ lines: [labour('5', 'Adam Kordecki', '2026-09-15', 7.5, 4300, 33250)], entries: [entry('Adam Kordecki', '2026-09-15', 7.5)] });
  const line = byId(result, '5');
  assert.deepEqual(line.findings.map((f) => f.code), ['RATE_ABOVE_CONTRACT', 'MATH_ERROR']);
  assert.equal(line.verdict, 'RATE_ABOVE_CONTRACT');
  assert.equal(line.payableCents, 30750, '7.5 h x 41.00');
});

test('OVER_CAP: the payment cap cuts the line that crosses it and everything after', () => {
  const result = run({
    cap: 50000,
    lines: [labour('1', 'Adam Kordecki', '2026-09-14', 9), labour('2', 'Adam Kordecki', '2026-09-15', 9), labour('3', 'Adam Kordecki', '2026-09-16', 9)],
    entries: [entry('Adam Kordecki', '2026-09-14', 9), entry('Adam Kordecki', '2026-09-15', 9), entry('Adam Kordecki', '2026-09-16', 9)],
  });
  assert.deepEqual(result.lines.map((line) => [line.verdict, line.payableCents]), [['PROVEN', 36900], ['OVER_CAP', 13100], ['OVER_CAP', 0]]);
  assert.equal(result.totals.payableCents, 50000);
});

test('rounding: half-up per line, printed totals within one cent are accepted as written', () => {
  const entries = [entry('Tomasz Brzezina', '2026-09-15', 7.75)];
  const halfUp = run({ lines: [{ ...labour('3', 'Tomasz Brzezina', '2026-09-15', 7.75, 3950, 30613), role: 'Formwork carpenter' }], entries });
  assert.equal(byId(halfUp, '3').verdict, 'PROVEN');
  assert.equal(byId(halfUp, '3').payableCents, 30613);
  const truncated = run({ lines: [{ ...labour('3', 'Tomasz Brzezina', '2026-09-15', 7.75, 3950, 30612), role: 'Formwork carpenter' }], entries });
  assert.equal(byId(truncated, '3').verdict, 'PROVEN', 'a different rounding convention is not an error');
  assert.equal(byId(truncated, '3').payableCents, 30612, 'never pay more than the correct invoiced amount');
  const wrong = run({ lines: [{ ...labour('3', 'Tomasz Brzezina', '2026-09-15', 7.75, 3950, 30615), role: 'Formwork carpenter' }], entries });
  assert.equal(byId(wrong, '3').verdict, 'MATH_ERROR');
  assert.equal(byId(wrong, '3').payableCents, 30613);
  const partial = run({ lines: [{ ...labour('3', 'Tomasz Brzezina', '2026-09-15', 8, 3950, 31600), role: 'Formwork carpenter' }], entries });
  assert.equal(byId(partial, '3').payableCents, 30613, 'proven 7.75 h x 39.50 rounded half-up');
});

test('totals balance: claimed - disputed + in favour = payable', () => {
  const result = run({
    lines: [labour('1', 'Adam Kordecki', '2026-09-14', 9), labour('2', 'Adam Kordecki', '2026-09-15', 8, 4100, 30000), concrete('3', '2026-09-16', 22)],
    entries: [entry('Adam Kordecki', '2026-09-14', 9), entry('Adam Kordecki', '2026-09-15', 8)],
    notes: [note('LS-1', '2026-09-16', 18)],
  });
  const t = result.totals;
  assert.equal(byId(result, '2').inFavourCents, 2800, 'an arithmetic error against the subcontractor is corrected in their favour');
  assert.equal(t.claimedCents - t.disputedCents + t.inFavourCents, t.payableCents);
  assert.equal(t.payableCents, result.lines.reduce((sum, line) => sum + line.payableCents, 0));
});

test('no contract rate or a unit mismatch makes a line UNPROVEN', () => {
  const result = run({
    lines: [{ ...labour('1', 'Adam Kordecki', '2026-09-14', 9), role: 'Crane operator' }, { ...concrete('2', '2026-09-16', 9), unit: 't', unitAsWritten: 't' }],
    entries: [entry('Adam Kordecki', '2026-09-14', 9)],
    notes: [note('LS-1', '2026-09-16', 9)],
  });
  assert.equal(byId(result, '1').verdict, 'UNPROVEN');
  assert.match(byId(result, '1').reason, /no rate for the role "Crane operator"/);
  assert.equal(byId(result, '2').verdict, 'UNPROVEN');
  assert.match(byId(result, '2').reason, /per t/);
});

test('case findings: currency mismatch blocks, payee and total mismatches warn', () => {
  const result = run({
    lines: [labour('1', 'Adam Kordecki', '2026-09-14', 9)],
    entries: [entry('Adam Kordecki', '2026-09-14', 9)],
    invoice: { currency: 'PLN', payeeEmail: 'other@example.net', totalCents: 99900 },
  });
  const codes = result.caseFindings.map((finding) => finding.code);
  assert.deepEqual(codes.sort(), ['CURRENCY_MISMATCH', 'INVOICE_TOTAL_MISMATCH', 'PAYEE_MISMATCH']);
  assert.deepEqual(result.blockers.map((b) => b.code), ['CURRENCY_MISMATCH']);
});
