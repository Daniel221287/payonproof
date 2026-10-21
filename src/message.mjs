/**
 * The explanation sent to the subcontractor, in their language (en/de/pl/uk).
 *
 * Facts (line ids, amounts, reasons) always come from the verification engine.
 * With an AI provider the model only phrases those facts; its draft is
 * fact-checked (totals and every disputed line must appear) and replaced by the
 * fixed template if the check fails. Offline mode always uses the template and
 * labels it as such. The human can edit the text before approving.
 */
import { AiError } from './ai.mjs';
import { formatMoney, formatQuantity } from './money.mjs';

export const LANGUAGE_NAMES = Object.freeze({ en: 'English', de: 'German', pl: 'Polish', uk: 'Ukrainian' });
const LOCALES = { en: 'en-GB', de: 'de-DE', pl: 'pl-PL', uk: 'uk-UA' };

const PHRASES = {
  en: {
    DUPLICATE: ({ duplicateOf }) => `duplicate of line ${duplicateOf}`,
    NO_EVIDENCE_LABOUR: () => 'no timesheet entry for this day',
    NO_EVIDENCE_MATERIAL: () => 'no delivery note for this delivery',
    NO_RATE: () => 'no agreed rate in the contract',
    UNIT_MISMATCH: () => 'the unit does not match the contract',
    EVIDENCE_USED: () => 'the evidence is already used by another line',
    UNSIGNED: () => 'the timesheet for this day is not signed by the site manager',
    PARTIAL: ({ proven, claimed, unit }) => `only ${proven} of ${claimed} ${unit} are proven`,
    RATE_ABOVE_CONTRACT: ({ invoiced, contract }) => `the rate ${invoiced} is above the contract rate ${contract}, so the contract rate is paid`,
    MATH_ERROR: ({ written, correct }) => `the line total ${written} should be ${correct}`,
    OVER_CAP: ({ cap }) => `it exceeds the contract payment cap of ${cap} per invoice`,
  },
  de: {
    DUPLICATE: ({ duplicateOf }) => `doppelt berechnet (wie Pos. ${duplicateOf})`,
    NO_EVIDENCE_LABOUR: () => 'kein Stundenzettel für diesen Tag',
    NO_EVIDENCE_MATERIAL: () => 'kein Lieferschein für diese Lieferung',
    NO_RATE: () => 'kein vereinbarter Preis im Vertrag',
    UNIT_MISMATCH: () => 'die Einheit entspricht nicht dem Vertrag',
    EVIDENCE_USED: () => 'der Nachweis ist bereits einer anderen Position zugeordnet',
    UNSIGNED: () => 'der Stundenzettel für diesen Tag ist nicht von der Bauleitung unterschrieben',
    PARTIAL: ({ proven, claimed, unit }) => `nur ${proven} von ${claimed} ${unit} sind nachgewiesen`,
    RATE_ABOVE_CONTRACT: ({ invoiced, contract }) => `der Satz ${invoiced} liegt über dem Vertragssatz ${contract}, vergütet wird der Vertragssatz`,
    MATH_ERROR: ({ written, correct }) => `der Positionsbetrag ${written} müsste ${correct} lauten`,
    OVER_CAP: ({ cap }) => `die vertragliche Zahlungsobergrenze von ${cap} je Rechnung ist überschritten`,
  },
  pl: {
    DUPLICATE: ({ duplicateOf }) => `pozycja zdublowana (jak poz. ${duplicateOf})`,
    NO_EVIDENCE_LABOUR: () => 'brak wpisu w karcie pracy za ten dzień',
    NO_EVIDENCE_MATERIAL: () => 'brak dokumentu dostawy',
    NO_RATE: () => 'brak uzgodnionej stawki w umowie',
    UNIT_MISMATCH: () => 'jednostka jest niezgodna z umową',
    EVIDENCE_USED: () => 'dokument potwierdzający został już przypisany do innej pozycji',
    UNSIGNED: () => 'karta pracy za ten dzień nie jest podpisana przez kierownika budowy',
    PARTIAL: ({ proven, claimed, unit }) => `potwierdzono tylko ${proven} z ${claimed} ${unit}`,
    RATE_ABOVE_CONTRACT: ({ invoiced, contract }) => `stawka ${invoiced} jest wyższa niż umowna ${contract}, rozliczono według stawki umownej`,
    MATH_ERROR: ({ written, correct }) => `wartość pozycji ${written} powinna wynosić ${correct}`,
    OVER_CAP: ({ cap }) => `przekroczony umowny limit płatności ${cap} na fakturę`,
  },
  uk: {
    DUPLICATE: ({ duplicateOf }) => `дублікат позиції ${duplicateOf}`,
    NO_EVIDENCE_LABOUR: () => 'немає запису в табелі за цей день',
    NO_EVIDENCE_MATERIAL: () => 'немає накладної на цю поставку',
    NO_RATE: () => 'у договорі немає погодженої ставки',
    UNIT_MISMATCH: () => 'одиниця виміру не відповідає договору',
    EVIDENCE_USED: () => 'підтвердження вже зараховано до іншої позиції',
    UNSIGNED: () => 'табель за цей день не підписаний керівником будівництва',
    PARTIAL: ({ proven, claimed, unit }) => `підтверджено лише ${proven} з ${claimed} ${unit}`,
    RATE_ABOVE_CONTRACT: ({ invoiced, contract }) => `ставка ${invoiced} вища за договірну ${contract}, тому оплачено за договірною ставкою`,
    MATH_ERROR: ({ written, correct }) => `сума позиції ${written} має становити ${correct}`,
    OVER_CAP: ({ cap }) => `перевищено договірний ліміт оплати ${cap} за рахунок`,
  },
};

const BODIES = {
  en: {
    greeting: (f) => `Dear ${f.subcontractor},`,
    full: (f) => `thank you for invoice ${f.invoiceNumber}. All ${f.lineCount} lines are confirmed by signed timesheets and delivery notes, so we are paying the full ${f.payable} by PayPal.`,
    partial: (f) => `thank you for invoice ${f.invoiceNumber}. We are paying ${f.payable} of the ${f.claimed} invoiced, by PayPal. The difference of ${f.disputed} comes from these lines:`,
    line: (l) => `- Line ${l.id} (${l.subject}, ${l.date}): invoiced ${l.claimed}, paid ${l.payable}. Reason: ${l.reasons}.`,
    closing: 'If you have documents that prove these items, for example a signed timesheet or a delivery note, please send them and we will review the lines again.',
    signoff: (f) => `Kind regards,\nAccounts payable, ${f.mainContractor}`,
  },
  de: {
    greeting: () => 'Sehr geehrte Damen und Herren,',
    full: (f) => `vielen Dank für die Rechnung ${f.invoiceNumber}. Alle ${f.lineCount} Positionen sind durch unterschriebene Stundenzettel und Lieferscheine belegt. Wir zahlen den vollen Betrag von ${f.payable} per PayPal.`,
    partial: (f) => `vielen Dank für die Rechnung ${f.invoiceNumber}. Wir zahlen ${f.payable} der berechneten ${f.claimed} per PayPal. Die Differenz von ${f.disputed} betrifft folgende Positionen:`,
    line: (l) => `- Pos. ${l.id} (${l.subject}, ${l.date}): berechnet ${l.claimed}, gezahlt ${l.payable}. Grund: ${l.reasons}.`,
    closing: 'Wenn Sie Nachweise zu diesen Positionen haben, zum Beispiel einen unterschriebenen Stundenzettel oder einen Lieferschein, senden Sie uns diese bitte. Wir prüfen die Positionen dann erneut.',
    signoff: (f) => `Mit freundlichen Grüßen\nKreditorenbuchhaltung, ${f.mainContractor}`,
  },
  pl: {
    greeting: () => 'Szanowni Państwo,',
    full: (f) => `dziękujemy za fakturę ${f.invoiceNumber}. Wszystkie pozycje (${f.lineCount}) są potwierdzone podpisanymi kartami pracy i dokumentami dostawy, dlatego płacimy pełną kwotę ${f.payable} przez PayPal.`,
    partial: (f) => `dziękujemy za fakturę ${f.invoiceNumber}. Płacimy ${f.payable} z zafakturowanych ${f.claimed} przez PayPal. Różnica ${f.disputed} dotyczy następujących pozycji:`,
    line: (l) => `- Poz. ${l.id} (${l.subject}, ${l.date}): zafakturowano ${l.claimed}, zapłacono ${l.payable}. Powód: ${l.reasons}.`,
    closing: 'Jeśli mają Państwo dokumenty potwierdzające te pozycje, na przykład podpisaną kartę pracy lub dokument dostawy, prosimy o ich przesłanie. Wtedy ponownie sprawdzimy te pozycje.',
    signoff: (f) => `Z poważaniem\nDział księgowości, ${f.mainContractor}`,
  },
  uk: {
    greeting: () => 'Шановні партнери,',
    full: (f) => `дякуємо за рахунок ${f.invoiceNumber}. Усі позиції (${f.lineCount}) підтверджені підписаними табелями та накладними, тому ми сплачуємо повну суму ${f.payable} через PayPal.`,
    partial: (f) => `дякуємо за рахунок ${f.invoiceNumber}. Ми сплачуємо ${f.payable} із виставлених ${f.claimed} через PayPal. Різниця ${f.disputed} стосується таких позицій:`,
    line: (l) => `- Позиція ${l.id} (${l.subject}, ${l.date}): виставлено ${l.claimed}, сплачено ${l.payable}. Причина: ${l.reasons}.`,
    closing: 'Якщо у вас є документи, що підтверджують ці позиції, наприклад підписаний табель або накладна, надішліть їх, будь ласка, і ми повторно перевіримо ці позиції.',
    signoff: (f) => `З повагою\nБухгалтерія, ${f.mainContractor}`,
  },
};

function phraseKey(finding, kind) {
  if (finding.code !== 'UNPROVEN') return finding.code;
  const cause = finding.params?.cause;
  if (cause === 'NO_RATE' || cause === 'UNIT_MISMATCH' || cause === 'EVIDENCE_USED') return cause;
  return kind === 'labour' ? 'NO_EVIDENCE_LABOUR' : 'NO_EVIDENCE_MATERIAL';
}

/**
 * Collect the facts for the message, already formatted for the subcontractor's locale.
 * @param {{contract: object, invoice: object, verification: object}} input
 */
export function buildMessageFacts({ contract, invoice, verification }) {
  const language = LANGUAGE_NAMES[contract.language] ? contract.language : 'en';
  const locale = LOCALES[language];
  const money = (cents) => formatMoney(cents, verification.currency, locale);
  const qty = (milli) => formatQuantity(milli, locale);
  const date = (iso) => new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  const phrases = PHRASES[language];
  const disputedLines = verification.lines
    .filter((line) => line.payableCents < line.claimedCents)
    .map((line) => ({
      id: line.id,
      kind: line.kind,
      subject: line.subject,
      date: date(line.date),
      claimed: money(line.claimedCents),
      payable: money(line.payableCents),
      reasons: line.findings.map((finding) => phrases[phraseKey(finding, line.kind)]({
        duplicateOf: finding.params?.duplicateOf,
        proven: qty(finding.params?.provenMilli ?? 0),
        claimed: qty(finding.params?.claimedMilli ?? 0),
        unit: finding.params?.unit ?? line.unit,
        invoiced: money(finding.params?.invoicedCents ?? 0),
        contract: money(finding.params?.contractCents ?? 0),
        written: money(finding.params?.writtenCents ?? 0),
        correct: money(finding.params?.correctCents ?? 0),
        cap: money(finding.params?.capCents ?? 0),
      })).join('; '),
    }));
  return {
    language,
    languageName: LANGUAGE_NAMES[language],
    subcontractor: contract.subcontractor,
    mainContractor: contract.mainContractor || 'the main contractor',
    invoiceNumber: invoice.invoiceNumber,
    lineCount: verification.lines.length,
    claimed: money(verification.totals.claimedCents),
    payable: money(verification.totals.payableCents),
    disputed: money(verification.totals.disputedCents),
    disputedLines,
  };
}

/**
 * Fixed-template message (no AI).
 * @param {ReturnType<typeof buildMessageFacts>} facts
 * @returns {string}
 */
export function templateMessage(facts) {
  const body = BODIES[facts.language] ?? BODIES.en;
  const parts = [body.greeting(facts), ''];
  if (facts.disputedLines.length === 0) {
    parts.push(body.full(facts));
  } else {
    parts.push(body.partial(facts), '', ...facts.disputedLines.map((line) => body.line(line)), '', body.closing);
  }
  parts.push('', body.signoff(facts));
  return parts.join('\n');
}

const squash = (text) => String(text).replace(/\s+/g, ' ');

/**
 * Check an AI draft against the facts. Returns the list of missing facts (empty = passed).
 * @param {string} text
 * @param {ReturnType<typeof buildMessageFacts>} facts
 * @returns {string[]}
 */
export function factCheckMessage(text, facts) {
  const missing = [];
  const body = squash(text);
  if (!body.trim()) return ['message text'];
  if (body.length > 3000) missing.push('a message under 3000 characters');
  if (!body.includes(squash(facts.payable))) missing.push(`payable total ${facts.payable}`);
  if (facts.disputedLines.length > 0 && !body.includes(squash(facts.claimed))) missing.push(`invoiced total ${facts.claimed}`);
  for (const line of facts.disputedLines) {
    // The id must follow a word such as "Line", "Pos.", "poz." or "Позиція" ("€5,035" is not line 5).
    const idPattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:\\p{L}{2,}\\.?|#)\\s?${line.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u');
    if (!idPattern.test(body)) missing.push(`line ${line.id}`);
    if (!body.includes(squash(line.payable))) missing.push(`paid amount ${line.payable} of line ${line.id}`);
  }
  return missing;
}

/**
 * Draft the message: AI phrasing when available (fact-checked), template otherwise.
 * @param {{provider: object, facts: ReturnType<typeof buildMessageFacts>}} input
 * @returns {Promise<{text: string, source: 'ai'|'template', label: string, note: string|null}>}
 */
export async function draftMessage({ provider, facts }) {
  const template = () => templateMessage(facts);
  if (!provider.isAI) {
    return { text: template(), source: 'template', label: 'Template, no AI used', note: null };
  }
  const system = [
    'You write short payment notices from a main contractor\'s accounts-payable team to a subcontractor.',
    `Write in ${facts.languageName}. Be polite, plain and concrete. At most 170 words. No subject line.`,
    'Use only the facts in the JSON. Copy every amount exactly as written there, including currency symbols.',
    'Mention every disputed line by its line number, with its invoiced and paid amounts and its reasons.',
    'Do not add facts, promises, deadlines, threats or legal claims.',
    'Answer with JSON only: {"message": "<the message text>"}',
  ].join('\n');
  try {
    const output = await provider.generateJson({ system, user: JSON.stringify(facts) });
    const text = typeof output.json.message === 'string' ? output.json.message.trim() : '';
    const missing = factCheckMessage(text, facts);
    if (missing.length === 0) {
      return { text, source: 'ai', label: `AI draft, fact-checked (${provider.label})`, note: null };
    }
    return { text: template(), source: 'template', label: 'Template, no AI used', note: `The AI draft failed the fact check (missing ${missing.slice(0, 3).join(', ')}), so the template was used.` };
  } catch (error) {
    if (!(error instanceof AiError)) throw error;
    return { text: template(), source: 'template', label: 'Template, no AI used', note: `The AI draft failed (${error.message}), so the template was used.` };
  }
}
