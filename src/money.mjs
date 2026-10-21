/**
 * Integer money and quantity arithmetic.
 *
 * - Money is held in integer cents (EUR 12.34 -> 1234).
 * - Quantities are held in integer thousandths, "milli-units" (7.75 h -> 7750).
 * - A line amount is quantity x unit price, rounded half-up to the cent, per line.
 * - Totals are sums of already-rounded line amounts and are never rounded again.
 *
 * Nothing in this module uses floating-point multiplication on money.
 */

export class AmountError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AmountError';
  }
}

const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** Currencies with two minor-unit digits that this project accepts for payouts. */
export const SUPPORTED_CURRENCIES = Object.freeze([
  'EUR', 'USD', 'GBP', 'PLN', 'CHF', 'CZK', 'SEK', 'DKK', 'NOK', 'CAD', 'AUD',
]);

/**
 * Convert a non-negative plain decimal (JSON number or "123.45" string) to an
 * integer scaled by 10^decimals. Trailing zeros beyond the allowed decimals are
 * accepted ("38.500" with 2 decimals); significant extra digits are rejected.
 * @param {number|string} value
 * @param {number} decimals
 * @returns {number}
 */
export function toScaledInt(value, decimals) {
  let text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AmountError('not a finite number');
    if (value < 0) throw new AmountError('negative values are not allowed');
    text = String(value);
    if (/e/i.test(text)) throw new AmountError('number is outside the supported range');
  } else if (typeof value === 'string') {
    text = value.trim();
    if (text.startsWith('-')) throw new AmountError('negative values are not allowed');
  } else {
    throw new AmountError('not a number');
  }
  const match = PLAIN_DECIMAL.exec(text);
  if (!match) throw new AmountError(`"${text.slice(0, 40)}" is not a plain decimal number`);
  const intPart = match[1];
  const frac = (match[2] ?? '').replace(/0+$/, '');
  if (frac.length > decimals) throw new AmountError(`more than ${decimals} decimal places`);
  const scaled = BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) throw new AmountError('value is too large');
  return Number(scaled);
}

/** @param {number|string} value @returns {number} integer cents */
export const toCents = (value) => toScaledInt(value, 2);

/** @param {number|string} value @returns {number} integer thousandths */
export const toMilli = (value) => toScaledInt(value, 3);

/**
 * Exact product of a quantity (milli-units) and a price (cents), in milli-cents.
 * @param {number} qtyMilli
 * @param {number} priceCents
 * @returns {bigint}
 */
export function productMilliCents(qtyMilli, priceCents) {
  return BigInt(qtyMilli) * BigInt(priceCents);
}

/**
 * Line amount in cents: quantity x price, rounded half-up (commercial rounding).
 * @param {number} qtyMilli non-negative
 * @param {number} priceCents non-negative
 * @returns {number}
 */
export function lineAmountCents(qtyMilli, priceCents) {
  if (qtyMilli < 0 || priceCents < 0) throw new AmountError('negative operands');
  return Number((productMilliCents(qtyMilli, priceCents) + 500n) / 1000n);
}

/**
 * True when a written line total is less than one cent away from the exact
 * product, i.e. it is correct under any standard rounding convention.
 * @param {number} writtenCents
 * @param {number} qtyMilli
 * @param {number} priceCents
 * @returns {boolean}
 */
export function isArithmeticallyConsistent(writtenCents, qtyMilli, priceCents) {
  const diff = BigInt(writtenCents) * 1000n - productMilliCents(qtyMilli, priceCents);
  return (diff < 0n ? -diff : diff) < 1000n;
}

/**
 * PayPal amount string from integer cents: 503500 -> "5035.00".
 * @param {number} cents non-negative integer
 * @returns {string}
 */
export function centsToDecimalString(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new AmountError('cents must be a non-negative integer');
  const whole = Math.floor(cents / 100);
  const minor = String(cents % 100).padStart(2, '0');
  return `${whole}.${minor}`;
}

/**
 * Human formatting of an amount, e.g. formatMoney(503500, 'EUR') -> "€5,035.00".
 * @param {number} cents
 * @param {string} currency
 * @param {string} [locale]
 * @returns {string}
 */
export function formatMoney(cents, currency, locale = 'en-GB') {
  const sign = cents < 0 ? '-' : '';
  const value = Math.abs(cents) / 100;
  return sign + new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value);
}

/**
 * Human formatting of a milli-unit quantity, e.g. 7750 -> "7.75".
 * @param {number} milli
 * @param {string} [locale]
 * @returns {string}
 */
export function formatQuantity(milli, locale = 'en-GB') {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(milli / 1000);
}
