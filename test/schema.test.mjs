import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateContract, validateDeliveryNotes, validateExtraction, validateInvoice, validateTimesheet } from '../src/schema.mjs';

function invoice(overrides = {}, lineOverrides = {}) {
  return {
    invoiceNumber: 'INV-1',
    issuer: 'Example Crew',
    issueDate: '2026-09-21',
    contractRef: 'SC-1',
    currency: 'EUR',
    payeeEmail: null,
    total: 369,
    lines: [{
      id: '1', kind: 'labour', worker: 'Adam Kordecki', role: 'Steel fixer', item: null, itemCode: null,
      date: '2026-09-14', quantity: 9, unit: 'h', unitPrice: 41, lineTotal: 369, ...lineOverrides,
    }],
    ...overrides,
  };
}

test('a well-formed invoice is normalised to integer cents and milli-units', () => {
  const result = validateInvoice(invoice());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  const line = result.data.lines[0];
  assert.equal(line.quantityMilli, 9000);
  assert.equal(line.unitPriceCents, 4100);
  assert.equal(line.lineTotalCents, 36900);
  assert.equal(line.unit, 'h');
  assert.equal(result.data.totalCents, 36900);
});

test('missing required fields are errors and the data is withheld', () => {
  const raw = invoice({ invoiceNumber: undefined });
  delete raw.lines[0].worker;
  const result = validateInvoice(raw);
  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  const paths = result.errors.map((error) => error.path);
  assert.ok(paths.includes('$.invoiceNumber'));
  assert.ok(paths.includes('$.lines[0].worker'));
});

test('plain numbers sent as strings are converted with a warning', () => {
  const result = validateInvoice(invoice({}, { quantity: '9.00', unitPrice: '41', lineTotal: '369.00' }));
  assert.equal(result.ok, true);
  assert.equal(result.data.lines[0].quantityMilli, 9000);
  assert.equal(result.warnings.filter((w) => /converted/.test(w.message)).length, 3);
});

test('localised or unit-suffixed number strings are rejected, never guessed', () => {
  for (const value of ['1.040,00', '1,040.00', '369 EUR', '9h']) {
    const result = validateInvoice(invoice({}, { lineTotal: value }));
    assert.equal(result.ok, false, value);
    assert.match(result.errors[0].message, /not a plain number/);
  }
});

test('negative, zero and over-precise values are rejected', () => {
  assert.match(validateInvoice(invoice({}, { quantity: -9 })).errors[0].message, /negative/);
  assert.match(validateInvoice(invoice({}, { unitPrice: '-41' })).errors[0].message, /negative/);
  assert.match(validateInvoice(invoice({}, { quantity: 0 })).errors[0].message, /greater than zero/);
  assert.match(validateInvoice(invoice({}, { unitPrice: 41.005 })).errors[0].message, /decimal places/);
});

test('dates must be real calendar dates; DD.MM.YYYY is converted with a warning', () => {
  assert.equal(validateInvoice(invoice({}, { date: '2026-02-30' })).ok, false);
  assert.equal(validateInvoice(invoice({}, { date: 'next Monday' })).ok, false);
  const converted = validateInvoice(invoice({}, { date: '14.09.2026' }));
  assert.equal(converted.ok, true);
  assert.equal(converted.data.lines[0].date, '2026-09-14');
  assert.ok(converted.warnings.some((w) => /DD\.MM\.YYYY/.test(w.message)));
});

test('duplicate line ids, wrong kinds, bad emails and unknown currencies are errors', () => {
  const twoLines = invoice();
  twoLines.lines.push({ ...twoLines.lines[0] });
  assert.match(validateInvoice(twoLines).errors[0].message, /duplicate line id/);
  assert.match(validateInvoice(invoice({}, { kind: 'bonus' })).errors[0].message, /labour/);
  assert.match(validateInvoice(invoice({ payeeEmail: 'not-an-email' })).errors[0].message, /email/);
  assert.match(validateInvoice(invoice({ currency: 'XYZ' })).errors[0].message, /unsupported currency/);
});

test('unexpected fields are ignored with a warning; non-objects are rejected', () => {
  const result = validateInvoice({ ...invoice(), confidence: 0.99 });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.path === '$.confidence'));
  assert.equal(validateInvoice([invoice()]).ok, false);
  assert.equal(validateInvoice(null).errors[0].message, 'must be a JSON object');
});

test('contracts: rates, aliases, codes and language names are normalised', () => {
  const result = validateContract({
    contractId: 'NU-1', mainContractor: null, subcontractor: 'Crew', payeeEmail: 'Crew@Example.com', currency: 'eur', language: 'Polnisch', paymentCap: 1800,
    rates: [
      { kind: 'Lohn', name: 'Dachdecker', aliases: 'Dekarz, Roofer', code: null, unit: 'Std.', price: 38 },
      { kind: 'material', name: 'Oberlage', aliases: [], code: 'BSO-5', unit: 'Rolle', price: 42 },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.payeeEmail, 'crew@example.com');
  assert.equal(result.data.currency, 'EUR');
  assert.equal(result.data.language, 'pl');
  assert.equal(result.data.paymentCapCents, 180000);
  assert.deepEqual(result.data.rates[0].aliases, ['Dekarz', 'Roofer']);
  assert.equal(result.data.rates[0].kind, 'labour');
  assert.equal(result.data.rates[0].unit, 'h');
  assert.equal(result.data.rates[1].unit, 'roll');
});

test('timesheets need a boolean signature flag and plausible hours', () => {
  const entry = { ref: '1', worker: 'A B', role: null, date: '2026-09-14', hours: 9, signed: true, signedBy: 'K. V.' };
  assert.equal(validateTimesheet({ sheetRef: 'TS', siteManager: null, entries: [entry] }).ok, true);
  assert.match(validateTimesheet({ entries: [{ ...entry, signed: 'yes' }] }).errors[0].message, /true or false/);
  assert.match(validateTimesheet({ entries: [{ ...entry, hours: 30 }] }).errors[0].message, /implausibly large/);
  const converted = validateTimesheet({ entries: [{ ...entry, signed: 'false' }] });
  assert.equal(converted.data.entries[0].signed, false);
});

test('delivery notes: duplicate note numbers are rejected; the dispatcher validates by type', () => {
  const note = { ref: 'LS-1', item: 'Concrete', itemCode: 'C30', quantity: 9, unit: 'm3', date: '2026-09-16', receivedBy: null };
  assert.equal(validateDeliveryNotes({ notes: [note] }).data.notes[0].quantityMilli, 9000);
  assert.match(validateDeliveryNotes({ notes: [note, note] }).errors[0].message, /duplicate delivery note/);
  assert.equal(validateExtraction('delivery_notes', { notes: [note] }).ok, true);
  assert.throws(() => validateExtraction('receipt', {}), TypeError);
});
