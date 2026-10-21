import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signerMatches } from '../src/normalize.mjs';
import { verifyCase } from '../src/verify.mjs';

const RATES = [
  { kind: 'labour', name: 'Steel fixer', aliases: ['Rebar fixer', 'Zbrojarz'], code: null, unit: 'h', unitAsWritten: 'h', priceCents: 4100 },
  { kind: 'labour', name: 'Foreman', aliases: ['Brygadzista'], code: null, unit: 'h', unitAsWritten: 'h', priceCents: 4700 },
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
function entry(worker, date, hours, signed = true, extra = {}) {
  return { ref: null, worker, role: null, date, hoursMilli: Math.round(hours * 1000), signed, signedBy: signed ? 'K. Vogelsang' : null, ...extra };
}
function note(ref, date, qty, extra = {}) {
  return { ref, item: 'Ready-mix concrete C30/37', itemCode: 'RMC-C30', quantityMilli: qty * 1000, unit: 'm3', unitAsWritten: 'm3', date, receivedBy: null, ...extra };
}
function run({ lines, entries = [], notes = [], cap = null, invoice = {}, contract = {}, sheet = {} }) {
  return verifyCase({
    contract: { contractId: 'SC-1', subcontractor: 'Crew', payeeEmail: 'crew@example.com', currency: 'EUR', language: 'en', paymentCapCents: cap, rates: RATES, ...contract },
    invoice: { invoiceNumber: 'INV-1', issuer: 'Crew', issueDate: null, contractRef: 'SC-1', currency: 'EUR', payeeEmail: null, totalCents: null, lines, ...invoice },
    timesheets: [{ docId: 'ts', sheetRef: 'TS', siteManager: 'Katrin Vogelsang', entries, ...sheet }],
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

test('never more than invoiced: an under-billed line is paid as printed and the difference is reported', () => {
  const result = run({
    lines: [labour('1', 'Adam Kordecki', '2026-09-14', 9), labour('2', 'Adam Kordecki', '2026-09-15', 8, 4100, 30000), concrete('3', '2026-09-16', 22)],
    entries: [entry('Adam Kordecki', '2026-09-14', 9), entry('Adam Kordecki', '2026-09-15', 8)],
    notes: [note('LS-1', '2026-09-16', 18)],
  });
  const t = result.totals;
  const line2 = byId(result, '2');
  assert.equal(line2.verdict, 'MATH_ERROR');
  assert.equal(line2.provenValueCents, 32800, '8 h x 41.00 are proven');
  assert.equal(line2.payableCents, 30000, 'but only the 300.00 invoiced is paid');
  assert.deepEqual(line2.findings.map((f) => f.code), ['MATH_ERROR', 'UNDERBILLED']);
  assert.equal(line2.findings[1].params.differenceCents, 2800);
  assert.match(line2.reason, /Paid as printed \(€300\.00\): the proven work comes to €328\.00, so €28\.00 more could be invoiced\./);
  assert.ok(result.lines.every((line) => line.payableCents <= line.claimedCents), 'no line pays more than its claim');
  assert.equal(t.claimedCents, t.payableCents + t.disputedCents, 'claimed = payable + disputed');
  assert.equal(t.payableCents, result.lines.reduce((sum, line) => sum + line.payableCents, 0));
  assert.equal('inFavourCents' in t, false);
});

test('OVER_INVOICE_TOTAL: a printed invoice total below the proven lines caps the payout at that total', () => {
  const result = run({
    lines: [labour('1', 'Adam Kordecki', '2026-09-14', 9), labour('2', 'Adam Kordecki', '2026-09-15', 9), labour('3', 'Adam Kordecki', '2026-09-16', 9)],
    entries: [entry('Adam Kordecki', '2026-09-14', 9), entry('Adam Kordecki', '2026-09-15', 9), entry('Adam Kordecki', '2026-09-16', 9)],
    invoice: { totalCents: 50000 },
  });
  assert.deepEqual(result.lines.map((line) => [line.verdict, line.payableCents]), [['PROVEN', 36900], ['OVER_INVOICE_TOTAL', 13100], ['OVER_INVOICE_TOTAL', 0]]);
  assert.equal(result.totals.payableCents, 50000);
  assert.match(byId(result, '2').reason, /The printed invoice total €500\.00 is below the €1,107\.00 the proven lines come to; €238\.00 of this line is not paid\./);
  const mismatch = result.caseFindings.find((f) => f.code === 'INVOICE_TOTAL_MISMATCH');
  assert.equal(mismatch.severity, 'warning');
  assert.match(mismatch.reason, /No more than the printed total is paid\./);
  const higher = run({ lines: [labour('1', 'Adam Kordecki', '2026-09-14', 9)], entries: [entry('Adam Kordecki', '2026-09-14', 9)], invoice: { totalCents: 99900 } });
  assert.equal(higher.totals.payableCents, 36900, 'a printed total above the lines pays the lines');
  assert.doesNotMatch(higher.caseFindings[0].reason, /No more than/);
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

test('UNSIGNED: a sign-off by anyone but the site manager named on the sheet proves nothing', () => {
  const result = run({
    lines: [{ ...labour('1', 'Tomasz Brzezina', '2026-09-14', 8, 3950, 31600), role: 'Formwork carpenter' }],
    entries: [entry('Brzezina, Tomasz', '2026-09-14', 8, true, { signedBy: 'T. Brzezina' })],
  });
  const line = byId(result, '1');
  assert.equal(line.verdict, 'UNSIGNED');
  assert.equal(line.payableCents, 0);
  assert.match(line.reason, /TS#1 for Tomasz Brzezina on 2026-09-14 is signed by T\. Brzezina, not by the site manager Katrin Vogelsang\./);
  assert.equal(line.findings[0].params.signedBy, 'T. Brzezina');
  assert.deepEqual(result.unusedEvidence, [], 'a wrongly signed entry is not usable evidence either');
});

test('signers match the site manager by surname, diacritics folded, with consistent initials', () => {
  for (const name of ['K. Vogelsang', 'Katrin Vogelsang', 'Vogelsang K.', 'Vogelsang, Katrin', 'K.Vogelsang', 'Vogelsang']) {
    assert.equal(signerMatches(name, 'Katrin Vogelsang'), true, name);
  }
  for (const name of ['T. Brzezina', 'T. Vogelsang', 'K.V.', 'Katrin', 'Kathrin Vogelsang', '']) {
    assert.equal(signerMatches(name, 'Katrin Vogelsang'), false, name);
  }
  assert.equal(signerMatches('P. Grzybowiec', 'Paweł Grzybowiec'), true);
  assert.equal(signerMatches('Łukasz Żółć', 'Lukasz Zolc'), true);
  const result = run({
    lines: [labour('1', 'Adam Kordecki', '2026-09-14', 9)],
    entries: [entry('Kordecki, Adam', '2026-09-14', 9, true, { signedBy: 'T. Vogelsang' })],
  });
  assert.equal(byId(result, '1').verdict, 'UNSIGNED', 'same surname, different initial');
});

test('signed hours split between the site manager and someone else: only the manager\'s hours are paid', () => {
  const result = run({
    lines: [labour('1', 'Adam Kordecki', '2026-09-14', 9)],
    entries: [entry('Kordecki, Adam', '2026-09-14', 5), entry('Kordecki, Adam', '2026-09-14', 4, true, { signedBy: 'A. Kordecki' })],
  });
  const line = byId(result, '1');
  assert.equal(line.verdict, 'PARTIAL');
  assert.equal(line.provenQtyMilli, 5000);
  assert.match(line.reason, /4 h are not signed by the site manager/);
});

test('a sheet that names no site manager keeps counting signed entries, with a warning', () => {
  const result = run({
    lines: [labour('1', 'Adam Kordecki', '2026-09-14', 9)],
    entries: [entry('Kordecki, Adam', '2026-09-14', 9, true, { signedBy: 'Somebody' })],
    sheet: { siteManager: null },
  });
  assert.equal(byId(result, '1').verdict, 'PROVEN');
  assert.deepEqual(result.caseFindings.map((f) => [f.code, f.severity]), [['SIGNER_NOT_CHECKED', 'warning']]);
  assert.match(result.caseFindings[0].reason, /Timesheet TS does not name the site manager, so the signer of its 1 signed entry could not be checked/);
  const unnamed = run({
    lines: [labour('1', 'Adam Kordecki', '2026-09-14', 9)],
    entries: [entry('Kordecki, Adam', '2026-09-14', 9, true, { signedBy: null })],
  });
  assert.equal(byId(unnamed, '1').verdict, 'PROVEN');
  assert.match(unnamed.caseFindings[0].reason, /1 signed entry has no signer name, so the signer could not be compared with the site manager Katrin Vogelsang/);
});

const foreman = (id, worker, date, hours, priceCents = 4700, totalCents = Math.round(hours * priceCents)) => ({ ...labour(id, worker, date, hours, priceCents, totalCents), role: 'Foreman' });

test('ROLE_MISMATCH: a steel fixer invoiced as foreman is paid at the steel fixer rate', () => {
  const result = run({
    lines: [foreman('1', 'Adam Kordecki', '2026-09-14', 9)],
    entries: [entry('Kordecki, Adam', '2026-09-14', 9, true, { role: 'Steel fixer' })],
  });
  const line = byId(result, '1');
  assert.equal(line.verdict, 'ROLE_MISMATCH');
  assert.equal(line.payRateCents, 4100);
  assert.equal(line.payableCents, 36900);
  assert.equal(line.disputedCents, 5400);
  assert.equal(line.timesheetRole, 'Steel fixer');
  assert.equal(line.timesheetRateCents, 4100);
  assert.equal(line.reason, 'Invoiced as Foreman (€47.00/h); the signed timesheet (TS#1) says Steel fixer (€41.00/h). Paid at the Steel fixer rate.');
});

test('roles match through contract aliases; a trade on the timesheet without a contract rate proves nothing', () => {
  const alias = run({
    lines: [{ ...labour('1', 'Jan Nowak', '2026-09-16', 8), role: 'Zbrojarz' }],
    entries: [entry('Nowak, Jan', '2026-09-16', 8, true, { role: 'Steel fixer' })],
  });
  assert.equal(byId(alias, '1').verdict, 'PROVEN');
  const unpriced = run({
    lines: [labour('1', 'Jan Nowak', '2026-09-16', 8)],
    entries: [entry('Nowak, Jan', '2026-09-16', 8, true, { role: 'Crane operator' })],
  });
  const line = byId(unpriced, '1');
  assert.equal(line.verdict, 'UNPROVEN');
  assert.equal(line.findings[0].params.cause, 'ROLE_NO_RATE');
  assert.equal(line.payableCents, 0);
  assert.match(line.reason, /says Jan Nowak worked as Crane operator, and contract SC-1 has no rate per h for that trade/);
  const mixed = run({
    lines: [labour('1', 'Jan Nowak', '2026-09-16', 9)],
    entries: [entry('Nowak, Jan', '2026-09-16', 5, true, { role: 'Steel fixer' }), entry('Nowak, Jan', '2026-09-16', 4, true, { role: 'Crane operator' })],
  });
  assert.equal(byId(mixed, '1').verdict, 'PARTIAL');
  assert.equal(byId(mixed, '1').payableCents, 20500);
  assert.match(byId(mixed, '1').reason, /; 4 h are signed under a trade without a contract rate \(Crane operator\)\./);
});

test('ROLE_MISMATCH never raises a rate: a dearer trade on the timesheet is noted, the invoice price stays the limit', () => {
  const result = run({
    lines: [labour('1', 'Adam Kordecki', '2026-09-14', 9)],
    entries: [entry('Kordecki, Adam', '2026-09-14', 9, true, { role: 'Foreman' })],
  });
  const line = byId(result, '1');
  assert.equal(line.verdict, 'ROLE_MISMATCH');
  assert.equal(line.payableCents, 36900, 'paid as invoiced, never at the higher foreman rate');
  assert.equal(line.findings[0].params.rateApplied, false);
  assert.doesNotMatch(line.reason, /Paid at/);
});

test('hours under two trades on one day prove the matching invoice lines', () => {
  const result = run({
    lines: [foreman('1', 'Adam Kordecki', '2026-09-14', 4), labour('2', 'Adam Kordecki', '2026-09-14', 5)],
    entries: [
      entry('Kordecki, Adam', '2026-09-14', 5, true, { role: 'Steel fixer' }),
      entry('Kordecki, Adam', '2026-09-14', 4, true, { role: 'Foreman' }),
    ],
  });
  assert.deepEqual(result.lines.map((line) => [line.verdict, line.payableCents]), [['PROVEN', 18800], ['PROVEN', 20500]]);
});

test('a rate above the contract and a different trade: the lower trade rate applies and is named', () => {
  const result = run({
    lines: [foreman('1', 'Adam Kordecki', '2026-09-14', 9, 5000, 45000)],
    entries: [entry('Kordecki, Adam', '2026-09-14', 9, true, { role: 'Steel fixer' })],
  });
  const line = byId(result, '1');
  assert.deepEqual(line.findings.map((f) => f.code), ['ROLE_MISMATCH', 'RATE_ABOVE_CONTRACT']);
  assert.equal(line.verdict, 'ROLE_MISMATCH');
  assert.equal(line.payableCents, 36900);
  assert.equal(line.findings[1].params.paidAtContract, false);
  assert.match(line.reason, /the contract rate for Foreman is €47\.00\/h\.$/);
});

test('a material whose name and code point at different contract items has no rate and proves nothing', () => {
  const rates = [...RATES, { kind: 'material', name: 'Sand 0/2', aliases: [], code: 'SND-02', unit: 'm3', unitAsWritten: 'm3', priceCents: 3000 }];
  // A delivery note for sand that carries the concrete code cannot prove an 18 m³ concrete line.
  const sandWithConcreteCode = run({
    contract: { rates },
    lines: [concrete('1', '2026-09-16', 18)],
    notes: [note('LS-1', '2026-09-16', 18, { item: 'Sand 0/2 (RMC-C30)', itemCode: 'RMC-C30' })],
  });
  assert.equal(byId(sandWithConcreteCode, '1').verdict, 'UNPROVEN');
  assert.equal(byId(sandWithConcreteCode, '1').payableCents, 0);
  // An invoice line named sand but coded as concrete is not priced at either rate.
  const conflicting = run({
    contract: { rates },
    lines: [concrete('1', '2026-09-16', 18, 18 * 12800, { item: 'Sand 0/2 (RMC-C30)' })],
    notes: [note('LS-1', '2026-09-16', 18)],
  });
  const line = byId(conflicting, '1');
  assert.equal(line.verdict, 'UNPROVEN');
  assert.equal(line.payableCents, 0);
  assert.equal(line.findings[0].params.cause, 'NAME_CODE_CONFLICT');
  assert.match(line.findings[0].reason, /name two different contract items: Sand 0\/2 by name, Ready-mix concrete C30\/37 by code/);
  // Name and code that agree, or a code with a name the contract does not know, still match.
  const agreeing = run({ contract: { rates }, lines: [concrete('1', '2026-09-16', 18, 18 * 12800, { item: 'Ready-mix concrete C30/37 (RMC-C30)', itemCode: null })], notes: [note('LS-1', '2026-09-16', 18)] });
  assert.equal(byId(agreeing, '1').verdict, 'PROVEN');
  const foreignName = run({ contract: { rates }, lines: [concrete('1', '2026-09-16', 18, 18 * 12800, { item: 'Transportbeton C30/37' })], notes: [note('LS-1', '2026-09-16', 18)] });
  assert.equal(byId(foreignName, '1').verdict, 'PROVEN');
});
