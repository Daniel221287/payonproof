/**
 * Strict, hand-written validation of extracted document data.
 *
 * Everything an extractor returns (an LLM or the offline sample parser) passes
 * through these validators before the verification engine sees it. Output is
 * normalised to integer cents / milli-units. Errors reject the document,
 * warnings are shown to the human but do not block.
 */
import { AmountError, SUPPORTED_CURRENCIES, toScaledInt } from './money.mjs';
import { matchKey, normalizeUnit } from './normalize.mjs';

export const DOCUMENT_TYPES = Object.freeze(['contract', 'invoice', 'timesheet', 'delivery_notes']);
export const LANGUAGES = Object.freeze(['en', 'de', 'pl', 'uk']);

const MAX_TEXT = 300;
const MAX_ROWS = 300;

/**
 * @typedef {{path: string, message: string}} Issue
 * @typedef {{ok: boolean, errors: Issue[], warnings: Issue[], data: object|null}} ValidationResult
 */

class Issues {
  constructor() {
    /** @type {Issue[]} */ this.errors = [];
    /** @type {Issue[]} */ this.warnings = [];
  }
  error(path, message) { this.errors.push({ path, message }); }
  warn(path, message) { this.warnings.push({ path, message }); }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBlank = (value) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

function checkKeys(obj, allowed, path, issues) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) issues.warn(`${path}.${key}`, 'unexpected field ignored');
  }
}

function readString(obj, key, path, issues, { required = true, max = MAX_TEXT, numberOk = false } = {}) {
  const value = obj[key];
  const at = `${path}.${key}`;
  if (isBlank(value)) {
    if (required) issues.error(at, 'is required');
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && numberOk) return String(value);
  if (typeof value !== 'string') {
    issues.error(at, 'must be text');
    return null;
  }
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length > max) {
    issues.error(at, `is longer than ${max} characters`);
    return null;
  }
  return text;
}

function readScaled(obj, key, path, issues, { decimals, required = true, positive = false, max } = {}) {
  const value = obj[key];
  const at = `${path}.${key}`;
  if (value === undefined || value === null) {
    if (required) issues.error(at, 'is required');
    return null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
      issues.error(at, `"${text.slice(0, 30)}" is not a plain number (localised or unit-suffixed text is rejected)`);
      return null;
    }
    if (!text.startsWith('-')) issues.warn(at, 'number given as text was converted');
  } else if (typeof value !== 'number') {
    issues.error(at, 'must be a number');
    return null;
  }
  try {
    const scaled = toScaledInt(value, decimals);
    if (positive && scaled === 0) {
      issues.error(at, 'must be greater than zero');
      return null;
    }
    if (max !== undefined && scaled > max) {
      issues.error(at, 'is implausibly large');
      return null;
    }
    return scaled;
  } catch (error) {
    if (error instanceof AmountError) {
      issues.error(at, error.message);
      return null;
    }
    throw error;
  }
}

function readDate(obj, key, path, issues, { required = true } = {}) {
  const value = obj[key];
  const at = `${path}.${key}`;
  if (isBlank(value)) {
    if (required) issues.error(at, 'is required');
    return null;
  }
  if (typeof value !== 'string') {
    issues.error(at, 'must be a date string YYYY-MM-DD');
    return null;
  }
  const text = value.trim();
  let y; let m; let d;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) {
    [, y, m, d] = match;
  } else {
    match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
    if (!match) {
      issues.error(at, `"${text.slice(0, 20)}" is not a YYYY-MM-DD date`);
      return null;
    }
    [, d, m, y] = match;
    issues.warn(at, 'date converted from DD.MM.YYYY');
  }
  const year = Number(y); const month = Number(m); const day = Number(d);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || year > 2100 || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    issues.error(at, `"${text}" is not a valid calendar date`);
    return null;
  }
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const EMAIL = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,255}\.[a-z]{2,24}$/i;

function readEmail(obj, key, path, issues, { required = true } = {}) {
  const text = readString(obj, key, path, issues, { required, max: 127 });
  if (text === null) return null;
  if (!EMAIL.test(text)) {
    issues.error(`${path}.${key}`, 'is not a valid email address');
    return null;
  }
  return text.toLowerCase();
}

function readCurrency(obj, key, path, issues) {
  const text = readString(obj, key, path, issues, { max: 8 });
  if (text === null) return null;
  let code = text.toUpperCase();
  if (code === '€') {
    code = 'EUR';
    issues.warn(`${path}.${key}`, 'currency symbol converted to EUR');
  }
  if (!SUPPORTED_CURRENCIES.includes(code)) {
    issues.error(`${path}.${key}`, `unsupported currency "${text}"`);
    return null;
  }
  return code;
}

const LANGUAGE_NAMES = {
  en: ['en', 'eng', 'english', 'englisch', 'angielski', 'англійська'],
  de: ['de', 'deu', 'ger', 'german', 'deutsch', 'niemiecki', 'німецька'],
  pl: ['pl', 'pol', 'polish', 'polnisch', 'polski', 'польська'],
  uk: ['uk', 'ua', 'ukr', 'ukrainian', 'ukrainisch', 'ukrainski', 'ukraiński', 'українська'],
};

function readLanguage(obj, key, path, issues) {
  const value = obj[key];
  const at = `${path}.${key}`;
  if (isBlank(value)) {
    issues.warn(at, 'missing; English is used for messages');
    return 'en';
  }
  if (typeof value !== 'string') {
    issues.warn(at, 'not text; English is used for messages');
    return 'en';
  }
  const folded = value.trim().toLowerCase();
  for (const [code, names] of Object.entries(LANGUAGE_NAMES)) {
    if (names.includes(folded)) {
      if (folded !== code) issues.warn(at, `"${value}" read as "${code}"`);
      return code;
    }
  }
  issues.warn(at, `unsupported language "${value.slice(0, 20)}"; English is used for messages`);
  return 'en';
}

const KIND_WORDS = {
  labour: ['labour', 'labor', 'work', 'lohn', 'arbeit', 'robocizna', 'praca', 'праця', 'робота'],
  material: ['material', 'materials', 'materiał', 'materialy', 'materiały', 'матеріал', 'матеріали'],
};

function readKind(obj, key, path, issues) {
  const text = readString(obj, key, path, issues, { max: 40 });
  if (text === null) return null;
  const folded = text.toLowerCase();
  for (const [kind, words] of Object.entries(KIND_WORDS)) {
    if (words.includes(folded)) {
      if (folded !== kind) issues.warn(`${path}.${key}`, `"${text}" read as "${kind}"`);
      return kind;
    }
  }
  issues.error(`${path}.${key}`, 'must be "labour" or "material"');
  return null;
}

function readBoolean(obj, key, path, issues) {
  const value = obj[key];
  const at = `${path}.${key}`;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'false') {
    issues.warn(at, 'boolean given as text was converted');
    return value === 'true';
  }
  issues.error(at, 'must be true or false');
  return null;
}

function readArray(obj, key, path, issues, { min = 1, max = MAX_ROWS } = {}) {
  const value = obj[key];
  const at = `${path}.${key}`;
  if (!Array.isArray(value)) {
    issues.error(at, 'must be a list');
    return [];
  }
  if (value.length < min) issues.error(at, `must contain at least ${min} item(s)`);
  if (value.length > max) {
    issues.error(at, `has more than ${max} items`);
    return [];
  }
  return value;
}

function readAliases(obj, key, path, issues) {
  const value = obj[key];
  if (isBlank(value)) return [];
  const list = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/[;,]/) : null);
  if (!list) {
    issues.warn(`${path}.${key}`, 'ignored: must be a list of names');
    return [];
  }
  return list
    .filter((alias) => typeof alias === 'string' && alias.trim() !== '')
    .map((alias) => alias.replace(/\s+/g, ' ').trim().slice(0, 100))
    .slice(0, 10);
}

function finish(issues, data) {
  return { ok: issues.errors.length === 0, errors: issues.errors, warnings: issues.warnings, data: issues.errors.length === 0 ? data : null };
}

function requireObject(raw, issues) {
  if (!isPlainObject(raw)) {
    issues.error('$', 'must be a JSON object');
    return false;
  }
  return true;
}

/**
 * Validate a contract (rate sheet) extraction.
 * @param {unknown} raw
 * @returns {ValidationResult}
 */
export function validateContract(raw) {
  const issues = new Issues();
  if (!requireObject(raw, issues)) return finish(issues, null);
  checkKeys(raw, ['contractId', 'mainContractor', 'subcontractor', 'payeeEmail', 'currency', 'language', 'paymentCap', 'rates'], '$', issues);
  const data = {
    contractId: readString(raw, 'contractId', '$', issues, { max: 80 }),
    mainContractor: readString(raw, 'mainContractor', '$', issues, { required: false }),
    subcontractor: readString(raw, 'subcontractor', '$', issues),
    payeeEmail: readEmail(raw, 'payeeEmail', '$', issues),
    currency: readCurrency(raw, 'currency', '$', issues),
    language: readLanguage(raw, 'language', '$', issues),
    paymentCapCents: readScaled(raw, 'paymentCap', '$', issues, { decimals: 2, required: false }),
    rates: [],
  };
  const seen = new Set();
  readArray(raw, 'rates', '$', issues).forEach((rate, index) => {
    const at = `$.rates[${index}]`;
    if (!isPlainObject(rate)) {
      issues.error(at, 'must be an object');
      return;
    }
    checkKeys(rate, ['kind', 'name', 'aliases', 'code', 'unit', 'price'], at, issues);
    const entry = {
      kind: readKind(rate, 'kind', at, issues),
      name: readString(rate, 'name', at, issues, { max: 120 }),
      aliases: readAliases(rate, 'aliases', at, issues),
      code: readString(rate, 'code', at, issues, { required: false, max: 40 }),
      unitAsWritten: readString(rate, 'unit', at, issues, { max: 20 }),
      priceCents: readScaled(rate, 'price', at, issues, { decimals: 2, positive: true }),
    };
    entry.unit = entry.unitAsWritten === null ? null : normalizeUnit(entry.unitAsWritten);
    if (entry.kind && entry.name) {
      const key = `${entry.kind}:${matchKey(entry.name)}`;
      if (seen.has(key)) issues.error(at, `duplicate rate for "${entry.name}"`);
      seen.add(key);
    }
    data.rates.push(entry);
  });
  return finish(issues, data);
}

/**
 * Validate an invoice extraction.
 * @param {unknown} raw
 * @returns {ValidationResult}
 */
export function validateInvoice(raw) {
  const issues = new Issues();
  if (!requireObject(raw, issues)) return finish(issues, null);
  checkKeys(raw, ['invoiceNumber', 'issuer', 'issueDate', 'contractRef', 'currency', 'payeeEmail', 'lines', 'total'], '$', issues);
  const data = {
    invoiceNumber: readString(raw, 'invoiceNumber', '$', issues, { max: 80, numberOk: true }),
    issuer: readString(raw, 'issuer', '$', issues),
    issueDate: readDate(raw, 'issueDate', '$', issues, { required: false }),
    contractRef: readString(raw, 'contractRef', '$', issues, { required: false, max: 80 }),
    currency: readCurrency(raw, 'currency', '$', issues),
    payeeEmail: readEmail(raw, 'payeeEmail', '$', issues, { required: false }),
    totalCents: readScaled(raw, 'total', '$', issues, { decimals: 2, required: false }),
    lines: [],
  };
  const ids = new Set();
  readArray(raw, 'lines', '$', issues).forEach((line, index) => {
    const at = `$.lines[${index}]`;
    if (!isPlainObject(line)) {
      issues.error(at, 'must be an object');
      return;
    }
    checkKeys(line, ['id', 'kind', 'worker', 'role', 'item', 'itemCode', 'date', 'quantity', 'unit', 'unitPrice', 'lineTotal'], at, issues);
    const kind = readKind(line, 'kind', at, issues);
    const entry = {
      id: readString(line, 'id', at, issues, { max: 20, numberOk: true }),
      kind,
      worker: readString(line, 'worker', at, issues, { required: kind === 'labour', max: 120 }),
      role: readString(line, 'role', at, issues, { required: kind === 'labour', max: 120 }),
      item: readString(line, 'item', at, issues, { required: kind === 'material', max: 160 }),
      itemCode: readString(line, 'itemCode', at, issues, { required: false, max: 40 }),
      date: readDate(line, 'date', at, issues),
      quantityMilli: readScaled(line, 'quantity', at, issues, { decimals: 3, positive: true, max: 1_000_000_000 }),
      unitAsWritten: readString(line, 'unit', at, issues, { max: 20 }),
      unitPriceCents: readScaled(line, 'unitPrice', at, issues, { decimals: 2, max: 100_000_000 }),
      lineTotalCents: readScaled(line, 'lineTotal', at, issues, { decimals: 2, max: 10_000_000_000 }),
    };
    entry.unit = entry.unitAsWritten === null ? null : normalizeUnit(entry.unitAsWritten);
    if (entry.id !== null) {
      if (ids.has(entry.id)) issues.error(`${at}.id`, `duplicate line id "${entry.id}"`);
      ids.add(entry.id);
    }
    data.lines.push(entry);
  });
  return finish(issues, data);
}

/**
 * Validate a timesheet extraction.
 * @param {unknown} raw
 * @returns {ValidationResult}
 */
export function validateTimesheet(raw) {
  const issues = new Issues();
  if (!requireObject(raw, issues)) return finish(issues, null);
  checkKeys(raw, ['sheetRef', 'siteManager', 'entries'], '$', issues);
  const data = {
    sheetRef: readString(raw, 'sheetRef', '$', issues, { required: false, max: 80 }),
    siteManager: readString(raw, 'siteManager', '$', issues, { required: false, max: 120 }),
    entries: [],
  };
  readArray(raw, 'entries', '$', issues).forEach((entryRaw, index) => {
    const at = `$.entries[${index}]`;
    if (!isPlainObject(entryRaw)) {
      issues.error(at, 'must be an object');
      return;
    }
    checkKeys(entryRaw, ['ref', 'worker', 'role', 'date', 'hours', 'signed', 'signedBy'], at, issues);
    data.entries.push({
      ref: readString(entryRaw, 'ref', at, issues, { required: false, max: 40, numberOk: true }),
      worker: readString(entryRaw, 'worker', at, issues, { max: 120 }),
      role: readString(entryRaw, 'role', at, issues, { required: false, max: 120 }),
      date: readDate(entryRaw, 'date', at, issues),
      hoursMilli: readScaled(entryRaw, 'hours', at, issues, { decimals: 3, positive: true, max: 24_000 }),
      signed: readBoolean(entryRaw, 'signed', at, issues),
      signedBy: readString(entryRaw, 'signedBy', at, issues, { required: false, max: 120 }),
    });
  });
  return finish(issues, data);
}

/**
 * Validate a delivery-notes extraction (one document may hold several notes).
 * @param {unknown} raw
 * @returns {ValidationResult}
 */
export function validateDeliveryNotes(raw) {
  const issues = new Issues();
  if (!requireObject(raw, issues)) return finish(issues, null);
  checkKeys(raw, ['notes'], '$', issues);
  const data = { notes: [] };
  const refs = new Set();
  readArray(raw, 'notes', '$', issues).forEach((note, index) => {
    const at = `$.notes[${index}]`;
    if (!isPlainObject(note)) {
      issues.error(at, 'must be an object');
      return;
    }
    checkKeys(note, ['ref', 'item', 'itemCode', 'quantity', 'unit', 'date', 'receivedBy'], at, issues);
    const entry = {
      ref: readString(note, 'ref', at, issues, { max: 40, numberOk: true }),
      item: readString(note, 'item', at, issues, { max: 160 }),
      itemCode: readString(note, 'itemCode', at, issues, { required: false, max: 40 }),
      quantityMilli: readScaled(note, 'quantity', at, issues, { decimals: 3, positive: true, max: 1_000_000_000 }),
      unitAsWritten: readString(note, 'unit', at, issues, { max: 20 }),
      date: readDate(note, 'date', at, issues),
      receivedBy: readString(note, 'receivedBy', at, issues, { required: false, max: 120 }),
    };
    entry.unit = entry.unitAsWritten === null ? null : normalizeUnit(entry.unitAsWritten);
    if (entry.ref !== null) {
      if (refs.has(entry.ref)) issues.error(`${at}.ref`, `duplicate delivery note "${entry.ref}"`);
      refs.add(entry.ref);
    }
    data.notes.push(entry);
  });
  return finish(issues, data);
}

const VALIDATORS = {
  contract: validateContract,
  invoice: validateInvoice,
  timesheet: validateTimesheet,
  delivery_notes: validateDeliveryNotes,
};

/**
 * Validate extracted data for a document type.
 * @param {'contract'|'invoice'|'timesheet'|'delivery_notes'} type
 * @param {unknown} raw
 * @returns {ValidationResult}
 */
export function validateExtraction(type, raw) {
  const validator = VALIDATORS[type];
  if (!validator) throw new TypeError(`unknown document type "${type}"`);
  return validator(raw);
}
