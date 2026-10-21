/**
 * Offline sample parser. NOT AI.
 *
 * A deterministic reader for the fixed plain-text layout of the bundled sample
 * documents (English, German and Polish labels). It exists so the whole flow
 * can be demonstrated without any model or API key. Anything that does not
 * follow the sample layout is rejected with a clear message; the UI and API
 * label its output "Offline sample parser — no AI used".
 *
 * It returns the same raw JSON shape an LLM is asked to return, so its output
 * goes through exactly the same validator (schema.mjs).
 */
import { foldText } from './normalize.mjs';

export const OFFLINE_LABEL = 'Offline sample parser — no AI used';

export class OfflineParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OfflineParseError';
  }
}

const NOT_SAMPLE = 'The offline sample parser only reads the bundled sample layout. Set AI_PROVIDER=gemini or AI_PROVIDER=openai to read other documents.';

/** First-line titles of each document type, with the number locale they imply. */
const TITLES = {
  contract: [['subcontract rate sheet', 'en'], ['nachunternehmervertrag', 'de'], ['umowa podwykonawcza', 'pl']],
  invoice: [['invoice', 'en'], ['rechnung', 'de'], ['faktura', 'pl']],
  timesheet: [['weekly timesheet', 'en'], ['stundenzettel', 'de'], ['karta pracy', 'pl']],
  delivery_notes: [['delivery note', 'en'], ['lieferschein', 'de'], ['dokument wz', 'pl']],
};

const LABELS = {
  contractId: ['contract no', 'vertrag nr', 'umowa nr'],
  mainContractor: ['main contractor', 'auftraggeber', 'zamawiajacy'],
  subcontractor: ['subcontractor', 'nachunternehmer', 'podwykonawca'],
  payee: ['payee paypal', 'zahlungsempfanger paypal', 'odbiorca platnosci paypal'],
  currency: ['currency', 'wahrung', 'waluta'],
  language: ['correspondence language', 'korrespondenzsprache', 'jezyk korespondencji'],
  paymentCap: ['payment cap per invoice', 'zahlungsobergrenze je rechnung', 'limit platnosci na fakture'],
  invoiceNumber: ['invoice no', 'rechnung nr', 'rechnungsnummer', 'numer faktury'],
  invoiceDate: ['invoice date', 'rechnungsdatum', 'data wystawienia'],
  issuer: ['from', 'rechnungssteller', 'sprzedawca'],
  contractRef: ['contract', 'vertrag', 'umowa'],
  total: ['total', 'gesamtbetrag', 'razem do zaplaty'],
  sheetRef: ['sheet', 'blatt', 'karta nr'],
  siteManager: ['site manager', 'bauleitung', 'kierownik budowy'],
  noteRef: ['note no', 'lieferschein nr', 'numer wz'],
  date: ['date', 'datum', 'data'],
  item: ['item', 'artikel', 'towar'],
  code: ['code', 'art nr', 'kod'],
  quantity: ['quantity', 'menge', 'ilosc'],
  receivedBy: ['received by', 'empfangen', 'odebral'],
};

const KIND_WORDS = { labour: ['labour', 'lohn', 'robocizna'], material: ['material', 'materia'] };

function labelKey(label) {
  return foldText(label).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function detectLocale(type, text) {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  const title = labelKey(firstLine);
  for (const [prefix, locale] of TITLES[type] ?? []) {
    if (title.startsWith(prefix)) return locale;
  }
  throw new OfflineParseError(`${NOT_SAMPLE} (This does not start like a sample ${type.replace('_', ' ')}.)`);
}

function readHeader(lines) {
  const fields = new Map();
  for (const line of lines) {
    if (line.includes('|')) continue;
    const match = /^([^:]{2,60}):\s*(.*)$/.exec(line.trim());
    if (match && !fields.has(labelKey(match[1]))) fields.set(labelKey(match[1]), match[2].trim());
  }
  return fields;
}

function pick(fields, name) {
  for (const key of LABELS[name]) if (fields.has(key)) return fields.get(key);
  return null;
}

function requireField(fields, name) {
  const value = pick(fields, name);
  if (value === null || value === '') throw new OfflineParseError(`${NOT_SAMPLE} (Missing field "${LABELS[name][0]}".)`);
  return value;
}

/**
 * Read a number written in the document's locale: "1,040.00" (en), "1.040,00" (de), "2 090,00" (pl).
 * @param {string} text
 * @param {'en'|'de'|'pl'} locale
 * @returns {number}
 */
export function parseLocaleNumber(text, locale) {
  let value = String(text).replace(/[\s  ]/g, '').replace(/(eur|€|pln|zł)$/i, '');
  value = locale === 'en' ? value.replace(/,/g, '') : value.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(value)) throw new OfflineParseError(`Cannot read the number "${text}".`);
  return Number(value);
}

function parseDate(text) {
  const value = String(text).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value);
  if (!match) throw new OfflineParseError(`Cannot read the date "${value}".`);
  return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

function tableRows(lines, columns) {
  return lines
    .filter((line) => line.includes('|'))
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .filter((cells) => cells.length === columns);
}

function kindOf(word) {
  const folded = foldText(word);
  for (const [kind, prefixes] of Object.entries(KIND_WORDS)) {
    if (prefixes.some((prefix) => folded.startsWith(prefix))) return kind;
  }
  return null;
}

function splitCode(text) {
  const match = /^(.*?)\s*\(([A-Za-z0-9][A-Za-z0-9.\-/]*)\)\s*$/.exec(text);
  return match ? { name: match[1].trim(), code: match[2] } : { name: text.trim(), code: null };
}

function parseContract(text, locale) {
  const lines = text.split(/\r?\n/);
  const fields = readHeader(lines);
  const cap = pick(fields, 'paymentCap');
  const rates = tableRows(lines, 6)
    .filter((cells) => kindOf(cells[0]) !== null)
    .map(([kind, name, aliases, code, unit, price]) => ({
      kind: kindOf(kind),
      name,
      aliases: aliases ? aliases.split(/[;,]/).map((alias) => alias.trim()).filter(Boolean) : [],
      code: code || null,
      unit,
      price: parseLocaleNumber(price, locale),
    }));
  if (rates.length === 0) throw new OfflineParseError(`${NOT_SAMPLE} (No rate table found.)`);
  return {
    contractId: requireField(fields, 'contractId'),
    mainContractor: pick(fields, 'mainContractor'),
    subcontractor: requireField(fields, 'subcontractor'),
    payeeEmail: requireField(fields, 'payee'),
    currency: requireField(fields, 'currency'),
    language: pick(fields, 'language'),
    paymentCap: cap ? parseLocaleNumber(cap, locale) : null,
    rates,
  };
}

function parseInvoice(text, locale) {
  const lines = text.split(/\r?\n/);
  const fields = readHeader(lines);
  const total = pick(fields, 'total');
  const payeeLine = lines.find((line) => foldText(line).includes('paypal') && /@/.test(line));
  const payeeEmail = payeeLine ? (/[^\s:]+@[^\s]+\.[a-z]{2,}/i.exec(payeeLine)?.[0] ?? null) : null;
  const rows = tableRows(lines, 9).filter((cells) => /^\d+$/.test(cells[0]));
  if (rows.length === 0) throw new OfflineParseError(`${NOT_SAMPLE} (No invoice lines found.)`);
  const invoiceLines = rows.map(([id, type, subject, role, date, quantity, unit, unitPrice, amount]) => {
    const kind = kindOf(type);
    if (!kind) throw new OfflineParseError(`Unknown line type "${type}" in line ${id}.`);
    const { name, code } = kind === 'material' ? splitCode(subject) : { name: subject, code: null };
    return {
      id,
      kind,
      worker: kind === 'labour' ? subject : null,
      role: kind === 'labour' ? role : null,
      item: kind === 'material' ? name : null,
      itemCode: code,
      date: parseDate(date),
      quantity: parseLocaleNumber(quantity, locale),
      unit,
      unitPrice: parseLocaleNumber(unitPrice, locale),
      lineTotal: parseLocaleNumber(amount, locale),
    };
  });
  const issuer = requireField(fields, 'issuer').split(',')[0].trim();
  return {
    invoiceNumber: requireField(fields, 'invoiceNumber'),
    issuer,
    issueDate: pick(fields, 'invoiceDate') ? parseDate(pick(fields, 'invoiceDate')) : null,
    contractRef: pick(fields, 'contractRef'),
    currency: requireField(fields, 'currency'),
    payeeEmail,
    lines: invoiceLines,
    total: total ? parseLocaleNumber(total, locale) : null,
  };
}

const UNSIGNED_WORDS = ['not signed', 'unsigned', 'nicht unterschrieben', 'brak podpisu', 'niepodpisan'];
const SIGNED_WORDS = ['signed', 'unterschrieben', 'podpisano', 'podpisal'];

function parseSignOff(text) {
  const folded = foldText(text).trim();
  if (UNSIGNED_WORDS.some((word) => folded.startsWith(word))) return { signed: false, signedBy: null };
  const word = SIGNED_WORDS.find((candidate) => folded.startsWith(candidate));
  if (!word) throw new OfflineParseError(`Cannot read the sign-off "${text}".`);
  const signedBy = text.trim().slice(word.length).trim();
  return { signed: true, signedBy: signedBy || null };
}

function parseTimesheet(text, locale) {
  const lines = text.split(/\r?\n/);
  const fields = readHeader(lines);
  const rows = tableRows(lines, 5).filter((cells) => /^\d/.test(cells[0]));
  if (rows.length === 0) throw new OfflineParseError(`${NOT_SAMPLE} (No timesheet rows found.)`);
  return {
    sheetRef: pick(fields, 'sheetRef'),
    siteManager: pick(fields, 'siteManager'),
    entries: rows.map(([date, worker, role, hours, signOff], position) => ({
      ref: String(position + 1),
      worker,
      role: role || null,
      date: parseDate(date),
      hours: parseLocaleNumber(hours, locale),
      ...parseSignOff(signOff),
    })),
  };
}

function parseDeliveryNotes(text) {
  const blocks = text.split(/^\s*-{3,}\s*$/m).map((block) => block.trim()).filter(Boolean);
  if (blocks.length === 0) throw new OfflineParseError(NOT_SAMPLE);
  return {
    notes: blocks.map((block) => {
      const locale = detectLocale('delivery_notes', block);
      const fields = readHeader(block.split(/\r?\n/));
      const quantity = requireField(fields, 'quantity');
      const match = /^(\d[\d.,\s]*?)\s*([^\d\s.,].*)$/.exec(quantity);
      if (!match) throw new OfflineParseError(`Cannot read the quantity "${quantity}".`);
      return {
        ref: requireField(fields, 'noteRef'),
        item: requireField(fields, 'item'),
        itemCode: pick(fields, 'code'),
        quantity: parseLocaleNumber(match[1], locale),
        unit: match[2].trim(),
        date: parseDate(requireField(fields, 'date')),
        receivedBy: pick(fields, 'receivedBy'),
      };
    }),
  };
}

/**
 * Parse one bundled-sample document deterministically.
 * @param {'contract'|'invoice'|'timesheet'|'delivery_notes'} type
 * @param {string} text
 * @returns {object} raw extraction (to be validated by schema.mjs)
 */
export function parseOffline(type, text) {
  if (typeof text !== 'string' || text.trim() === '') throw new OfflineParseError('The document is empty.');
  const locale = detectLocale(type, text);
  switch (type) {
    case 'contract': return parseContract(text, locale);
    case 'invoice': return parseInvoice(text, locale);
    case 'timesheet': return parseTimesheet(text, locale);
    case 'delivery_notes': return parseDeliveryNotes(text);
    default: throw new OfflineParseError(`Unknown document type "${type}".`);
  }
}
