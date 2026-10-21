import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, hashCanonical, sha256Hex } from '../src/canonical.mjs';
import {
  AmountError, centsToDecimalString, formatMoney, isArithmeticallyConsistent, lineAmountCents, toCents, toMilli,
} from '../src/money.mjs';
import { matchKey, normalizeUnit } from '../src/normalize.mjs';

test('decimal values convert to integer cents and milli-units without float error', () => {
  assert.equal(toCents(1040), 104000);
  assert.equal(toCents('38.50'), 3850);
  assert.throws(() => toCents(0.1 + 0.2), /decimal places/, 'float noise is never silently rounded');
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents('38.500'), 3850, 'trailing zeros beyond 2 decimals are fine');
  assert.equal(toMilli(7.75), 7750);
  assert.equal(toMilli('0.001'), 1);
});

test('invalid amounts are rejected: negative, too many decimals, exponent, text', () => {
  assert.throws(() => toCents(-1), AmountError);
  assert.throws(() => toCents('-5.00'), /negative/);
  assert.throws(() => toCents('1.005'), /more than 2 decimal/);
  assert.throws(() => toMilli('0.0005'), /more than 3 decimal/);
  assert.throws(() => toCents(1e21), /range/);
  assert.throws(() => toCents('12 EUR'), /plain decimal/);
  assert.throws(() => toCents(Number.NaN), /finite/);
});

test('line amounts round half-up to the cent, per line', () => {
  assert.equal(lineAmountCents(7750, 3950), 30613, '7.75 h x 39.50 = 306.125 -> 306.13');
  assert.equal(lineAmountCents(500, 1), 1, '0.5 cent rounds up');
  assert.equal(lineAmountCents(499, 1), 0, '0.499 cent rounds down');
  assert.equal(lineAmountCents(2345, 1001), 2347, '2.345 x 10.01 = 23.47345 -> 23.47');
  assert.equal(lineAmountCents(18000, 12800), 230400);
  assert.equal(lineAmountCents(0, 99999), 0);
});

test('a printed total is consistent when it is less than one cent from the exact product', () => {
  assert.ok(isArithmeticallyConsistent(30613, 7750, 3950), 'half-up');
  assert.ok(isArithmeticallyConsistent(30612, 7750, 3950), 'truncated / half-even');
  assert.ok(!isArithmeticallyConsistent(30614, 7750, 3950));
  assert.ok(!isArithmeticallyConsistent(32600, 8000, 3700), '326.00 vs 8 x 37.00 = 296.00');
});

test('PayPal amount strings come from integer cents', () => {
  assert.equal(centsToDecimalString(503500), '5035.00');
  assert.equal(centsToDecimalString(5), '0.05');
  assert.equal(centsToDecimalString(0), '0.00');
  assert.throws(() => centsToDecimalString(1.5), AmountError);
  assert.equal(formatMoney(503500, 'EUR'), '€5,035.00');
});

test('canonical JSON is independent of key order and keeps array order', () => {
  const a = { b: 1, a: { d: [3, 1], c: 'x' }, skip: undefined };
  const b = { a: { c: 'x', d: [3, 1] }, b: 1 };
  assert.equal(canonicalJson(a), '{"a":{"c":"x","d":[3,1]},"b":1}');
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(hashCanonical(a), hashCanonical(b));
  assert.notEqual(canonicalJson({ d: [1, 3] }), canonicalJson({ d: [3, 1] }));
  assert.throws(() => canonicalJson({ n: Number.POSITIVE_INFINITY }), TypeError);
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('names, roles and units match across languages and word order', () => {
  assert.equal(matchKey('Kordecki, Adam'), matchKey('Adam Kordecki'));
  assert.equal(matchKey('Grzybowiec, Paweł'), matchKey('Paweł Grzybowiec'));
  assert.equal(matchKey('ŁUKASZ Żak'), 'lukasz zak');
  assert.equal(normalizeUnit('Std.'), 'h');
  assert.equal(normalizeUnit('godz.'), 'h');
  assert.equal(normalizeUnit('m³'), 'm3');
  assert.equal(normalizeUnit('Rollen'), 'roll');
  assert.equal(normalizeUnit('rol.'), 'roll');
  assert.equal(normalizeUnit('Stück'), 'pcs');
  assert.equal(normalizeUnit('шт'), 'pcs');
});
