/**
 * The explanation sent to the subcontractor, in their language (en/de/pl/uk).
 *
 * Facts (line ids, amounts, reasons) always come from the verification engine.
 * With an AI provider the model only phrases those facts; its draft is
 * fact-checked (totals, every disputed line, every under-billed line and a
 * mismatching invoice total must appear) and replaced by the fixed template if
 * the check fails. Offline mode always uses the template and labels it as such.
 * A person can edit the text before approving; text an agent sends over MCP
 * must pass the same fact check (see service.updateMessage).
 */
import { AiError } from './ai.mjs';
import { formatMoney, formatQuantity } from './money.mjs';
import { INFORMATIONAL_FINDINGS } from './verify.mjs';

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
    UNSIGNED: ({ signedBy }) => (signedBy
      ? `the timesheet for this day is signed by ${signedBy}, not by the site manager`
      : 'the timesheet for this day is not signed by the site manager'),
    PARTIAL: ({ proven, claimed, unit }) => `only ${proven} of ${claimed} ${unit} are proven`,
    ROLE_NO_RATE: ({ evidencedRole }) => `the signed timesheet shows the trade ${evidencedRole}, which has no agreed rate in the contract`,
    ROLE_MISMATCH: ({ invoicedRole, evidencedRole, evidencedRate, rateApplied }) => (rateApplied
      ? `invoiced as ${invoicedRole}, but the signed timesheet shows ${evidencedRole}, so the ${evidencedRole} rate of ${evidencedRate} is paid`
      : `invoiced as ${invoicedRole}, but the signed timesheet shows ${evidencedRole}`),
    RATE_ABOVE_CONTRACT: ({ invoiced, contract, paidAtContract }) => (paidAtContract
      ? `the rate ${invoiced} is above the contract rate ${contract}, so the contract rate is paid`
      : `the rate ${invoiced} is above the contract rate ${contract}`),
    MATH_ERROR: ({ written, correct }) => `the line total ${written} should be ${correct}`,
    OVER_CAP: ({ cap }) => `it exceeds the contract payment cap of ${cap} per invoice`,
    OVER_INVOICE_TOTAL: ({ total }) => `the invoice total ${total} is below the sum of the lines, so no more than ${total} is paid in total`,
  },
  de: {
    DUPLICATE: ({ duplicateOf }) => `doppelt berechnet (wie Pos. ${duplicateOf})`,
    NO_EVIDENCE_LABOUR: () => 'kein Stundenzettel für diesen Tag',
    NO_EVIDENCE_MATERIAL: () => 'kein Lieferschein für diese Lieferung',
    NO_RATE: () => 'kein vereinbarter Preis im Vertrag',
    UNIT_MISMATCH: () => 'die Einheit entspricht nicht dem Vertrag',
    EVIDENCE_USED: () => 'der Nachweis ist bereits einer anderen Position zugeordnet',
    UNSIGNED: ({ signedBy }) => (signedBy
      ? `der Stundenzettel für diesen Tag ist von ${signedBy} unterschrieben, nicht von der Bauleitung`
      : 'der Stundenzettel für diesen Tag ist nicht von der Bauleitung unterschrieben'),
    PARTIAL: ({ proven, claimed, unit }) => `nur ${proven} von ${claimed} ${unit} sind nachgewiesen`,
    ROLE_NO_RATE: ({ evidencedRole }) => `laut unterschriebenem Stundenzettel als ${evidencedRole} tätig; dafür gibt es im Vertrag keinen vereinbarten Satz`,
    ROLE_MISMATCH: ({ invoicedRole, evidencedRole, evidencedRate, rateApplied }) => (rateApplied
      ? `berechnet als ${invoicedRole}, laut unterschriebenem Stundenzettel aber ${evidencedRole}, daher wird der Satz für ${evidencedRole} von ${evidencedRate} vergütet`
      : `berechnet als ${invoicedRole}, laut unterschriebenem Stundenzettel aber ${evidencedRole}`),
    RATE_ABOVE_CONTRACT: ({ invoiced, contract, paidAtContract }) => (paidAtContract
      ? `der Satz ${invoiced} liegt über dem Vertragssatz ${contract}, vergütet wird der Vertragssatz`
      : `der Satz ${invoiced} liegt über dem Vertragssatz ${contract}`),
    MATH_ERROR: ({ written, correct }) => `der Positionsbetrag ${written} müsste ${correct} lauten`,
    OVER_CAP: ({ cap }) => `die vertragliche Zahlungsobergrenze von ${cap} je Rechnung ist überschritten`,
    OVER_INVOICE_TOTAL: ({ total }) => `die Rechnungssumme ${total} liegt unter der Summe der Positionen, daher zahlen wir insgesamt höchstens ${total}`,
  },
  pl: {
    DUPLICATE: ({ duplicateOf }) => `pozycja zdublowana (jak poz. ${duplicateOf})`,
    NO_EVIDENCE_LABOUR: () => 'brak wpisu w karcie pracy za ten dzień',
    NO_EVIDENCE_MATERIAL: () => 'brak dokumentu dostawy',
    NO_RATE: () => 'brak uzgodnionej stawki w umowie',
    UNIT_MISMATCH: () => 'jednostka jest niezgodna z umową',
    EVIDENCE_USED: () => 'dokument potwierdzający został już przypisany do innej pozycji',
    UNSIGNED: ({ signedBy }) => (signedBy
      ? `karta pracy za ten dzień jest podpisana przez ${signedBy}, a nie przez kierownika budowy`
      : 'karta pracy za ten dzień nie jest podpisana przez kierownika budowy'),
    PARTIAL: ({ proven, claimed, unit }) => `potwierdzono tylko ${proven} z ${claimed} ${unit}`,
    ROLE_NO_RATE: ({ evidencedRole }) => `podpisana karta pracy wskazuje stanowisko ${evidencedRole}, dla którego umowa nie przewiduje stawki`,
    ROLE_MISMATCH: ({ invoicedRole, evidencedRole, evidencedRate, rateApplied }) => (rateApplied
      ? `zafakturowano jako ${invoicedRole}, ale podpisana karta pracy wskazuje ${evidencedRole}, dlatego rozliczono według stawki dla stanowiska ${evidencedRole} (${evidencedRate})`
      : `zafakturowano jako ${invoicedRole}, ale podpisana karta pracy wskazuje ${evidencedRole}`),
    RATE_ABOVE_CONTRACT: ({ invoiced, contract, paidAtContract }) => (paidAtContract
      ? `stawka ${invoiced} jest wyższa niż umowna ${contract}, rozliczono według stawki umownej`
      : `stawka ${invoiced} jest wyższa niż umowna ${contract}`),
    MATH_ERROR: ({ written, correct }) => `wartość pozycji ${written} powinna wynosić ${correct}`,
    OVER_CAP: ({ cap }) => `przekroczony umowny limit płatności ${cap} na fakturę`,
    OVER_INVOICE_TOTAL: ({ total }) => `suma faktury ${total} jest niższa niż suma pozycji, dlatego płacimy łącznie najwyżej ${total}`,
  },
  uk: {
    DUPLICATE: ({ duplicateOf }) => `дублікат позиції ${duplicateOf}`,
    NO_EVIDENCE_LABOUR: () => 'немає запису в табелі за цей день',
    NO_EVIDENCE_MATERIAL: () => 'немає накладної на цю поставку',
    NO_RATE: () => 'у договорі немає погодженої ставки',
    UNIT_MISMATCH: () => 'одиниця виміру не відповідає договору',
    EVIDENCE_USED: () => 'підтвердження вже зараховано до іншої позиції',
    UNSIGNED: ({ signedBy }) => (signedBy
      ? `табель за цей день підписав ${signedBy}, а не керівник будівництва`
      : 'табель за цей день не підписаний керівником будівництва'),
    PARTIAL: ({ proven, claimed, unit }) => `підтверджено лише ${proven} з ${claimed} ${unit}`,
    ROLE_NO_RATE: ({ evidencedRole }) => `у підписаному табелі зазначено посаду ${evidencedRole}, для якої в договорі немає погодженої ставки`,
    ROLE_MISMATCH: ({ invoicedRole, evidencedRole, evidencedRate, rateApplied }) => (rateApplied
      ? `виставлено як ${invoicedRole}, але в підписаному табелі зазначено ${evidencedRole}, тому оплачено за ставкою для ${evidencedRole} (${evidencedRate})`
      : `виставлено як ${invoicedRole}, але в підписаному табелі зазначено ${evidencedRole}`),
    RATE_ABOVE_CONTRACT: ({ invoiced, contract, paidAtContract }) => (paidAtContract
      ? `ставка ${invoiced} вища за договірну ${contract}, тому оплачено за договірною ставкою`
      : `ставка ${invoiced} вища за договірну ${contract}`),
    MATH_ERROR: ({ written, correct }) => `сума позиції ${written} має становити ${correct}`,
    OVER_CAP: ({ cap }) => `перевищено договірний ліміт оплати ${cap} за рахунок`,
    OVER_INVOICE_TOTAL: ({ total }) => `загальна сума рахунку ${total} менша за суму позицій, тому загалом сплачуємо не більше ${total}`,
  },
};

const BODIES = {
  en: {
    greeting: (f) => `Dear ${f.subcontractor},`,
    full: (f) => `thank you for invoice ${f.invoiceNumber}. All ${f.lineCount} lines are confirmed by signed timesheets and delivery notes, so we are paying the full ${f.payable} by PayPal.`,
    partial: (f) => `thank you for invoice ${f.invoiceNumber}. We are paying ${f.payable} of the ${f.claimed} invoiced, by PayPal. The difference of ${f.disputed} comes from these lines:`,
    line: (l) => `- Line ${l.id} (${l.subject}, ${l.date}): invoiced ${l.claimed}, paid ${l.payable}. Reason: ${l.reasons}.`,
    totalNote: (f) => `The invoice total ${f.totalNote.printed} does not match the sum of its lines ${f.claimed}; we checked the invoice line by line.`,
    noteHeading: 'These lines are worth more than you invoiced. We pay them as invoiced; you may invoice the difference:',
    noteLine: (l) => `- Line ${l.id} (${l.subject}, ${l.date}): invoiced ${l.written}, proven ${l.proven}, difference ${l.difference}.`,
    closing: 'If you have documents that prove these items, for example a signed timesheet or a delivery note, please send them and we will review the lines again.',
    signoff: (f) => `Kind regards,\nAccounts payable, ${f.mainContractor}`,
  },
  de: {
    greeting: () => 'Sehr geehrte Damen und Herren,',
    full: (f) => `vielen Dank für die Rechnung ${f.invoiceNumber}. Alle ${f.lineCount} Positionen sind durch unterschriebene Stundenzettel und Lieferscheine belegt. Wir zahlen den vollen Betrag von ${f.payable} per PayPal.`,
    partial: (f) => `vielen Dank für die Rechnung ${f.invoiceNumber}. Wir zahlen ${f.payable} der berechneten ${f.claimed} per PayPal. Die Differenz von ${f.disputed} betrifft folgende Positionen:`,
    line: (l) => `- Pos. ${l.id} (${l.subject}, ${l.date}): berechnet ${l.claimed}, gezahlt ${l.payable}. Grund: ${l.reasons}.`,
    totalNote: (f) => `Die Rechnungssumme ${f.totalNote.printed} stimmt nicht mit der Summe der Positionen ${f.claimed} überein; wir haben die Rechnung Position für Position geprüft.`,
    noteHeading: 'Diese Positionen sind mehr wert als berechnet. Wir zahlen sie wie berechnet; die Differenz können Sie nachberechnen:',
    noteLine: (l) => `- Pos. ${l.id} (${l.subject}, ${l.date}): berechnet ${l.written}, nachgewiesen ${l.proven}, Differenz ${l.difference}.`,
    closing: 'Wenn Sie Nachweise zu diesen Positionen haben, zum Beispiel einen unterschriebenen Stundenzettel oder einen Lieferschein, senden Sie uns diese bitte. Wir prüfen die Positionen dann erneut.',
    signoff: (f) => `Mit freundlichen Grüßen\nKreditorenbuchhaltung, ${f.mainContractor}`,
  },
  pl: {
    greeting: () => 'Szanowni Państwo,',
    full: (f) => `dziękujemy za fakturę ${f.invoiceNumber}. Wszystkie pozycje (${f.lineCount}) są potwierdzone podpisanymi kartami pracy i dokumentami dostawy, dlatego płacimy pełną kwotę ${f.payable} przez PayPal.`,
    partial: (f) => `dziękujemy za fakturę ${f.invoiceNumber}. Płacimy ${f.payable} z zafakturowanych ${f.claimed} przez PayPal. Różnica ${f.disputed} dotyczy następujących pozycji:`,
    line: (l) => `- Poz. ${l.id} (${l.subject}, ${l.date}): zafakturowano ${l.claimed}, zapłacono ${l.payable}. Powód: ${l.reasons}.`,
    totalNote: (f) => `Suma faktury ${f.totalNote.printed} nie zgadza się z sumą pozycji ${f.claimed}; sprawdziliśmy fakturę pozycja po pozycji.`,
    noteHeading: 'Te pozycje są warte więcej, niż Państwo zafakturowali. Płacimy kwoty z faktury; różnicę mogą Państwo zafakturować osobno:',
    noteLine: (l) => `- Poz. ${l.id} (${l.subject}, ${l.date}): zafakturowano ${l.written}, potwierdzono ${l.proven}, różnica ${l.difference}.`,
    closing: 'Jeśli mają Państwo dokumenty potwierdzające te pozycje, na przykład podpisaną kartę pracy lub dokument dostawy, prosimy o ich przesłanie. Wtedy ponownie sprawdzimy te pozycje.',
    signoff: (f) => `Z poważaniem\nDział księgowości, ${f.mainContractor}`,
  },
  uk: {
    greeting: () => 'Шановні партнери,',
    full: (f) => `дякуємо за рахунок ${f.invoiceNumber}. Усі позиції (${f.lineCount}) підтверджені підписаними табелями та накладними, тому ми сплачуємо повну суму ${f.payable} через PayPal.`,
    partial: (f) => `дякуємо за рахунок ${f.invoiceNumber}. Ми сплачуємо ${f.payable} із виставлених ${f.claimed} через PayPal. Різниця ${f.disputed} стосується таких позицій:`,
    line: (l) => `- Позиція ${l.id} (${l.subject}, ${l.date}): виставлено ${l.claimed}, сплачено ${l.payable}. Причина: ${l.reasons}.`,
    totalNote: (f) => `Загальна сума рахунку ${f.totalNote.printed} не збігається із сумою позицій ${f.claimed}; ми перевірили рахунок попозиційно.`,
    noteHeading: 'Ці позиції коштують більше, ніж ви виставили. Ми сплачуємо їх за сумами з рахунку; різницю ви можете виставити окремо:',
    noteLine: (l) => `- Позиція ${l.id} (${l.subject}, ${l.date}): виставлено ${l.written}, підтверджено ${l.proven}, різниця ${l.difference}.`,
    closing: 'Якщо у вас є документи, що підтверджують ці позиції, наприклад підписаний табель або накладна, надішліть їх, будь ласка, і ми повторно перевіримо ці позиції.',
    signoff: (f) => `З повагою\nБухгалтерія, ${f.mainContractor}`,
  },
};

function phraseKey(finding, kind) {
  if (finding.code !== 'UNPROVEN') return finding.code;
  const cause = finding.params?.cause;
  if (['NO_RATE', 'UNIT_MISMATCH', 'EVIDENCE_USED', 'ROLE_NO_RATE'].includes(cause)) return cause;
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
      reasons: line.findings.filter((finding) => !INFORMATIONAL_FINDINGS.includes(finding.code)).map((finding) => phrases[phraseKey(finding, line.kind)]({
        duplicateOf: finding.params?.duplicateOf,
        proven: qty(finding.params?.provenMilli ?? 0),
        claimed: qty(finding.params?.claimedMilli ?? 0),
        unit: finding.params?.unit ?? line.unit,
        invoiced: money(finding.params?.invoicedCents ?? 0),
        contract: money(finding.params?.contractCents ?? 0),
        written: money(finding.params?.writtenCents ?? 0),
        correct: money(finding.params?.correctCents ?? 0),
        cap: money(finding.params?.capCents ?? 0),
        signedBy: finding.params?.signedBy ?? null,
        paidAtContract: finding.params?.paidAtContract !== false,
        invoicedRole: finding.params?.invoicedRole ?? line.role,
        evidencedRole: finding.params?.evidencedRole ?? null,
        evidencedRate: money(finding.params?.evidencedRateCents ?? 0),
        rateApplied: Boolean(finding.params?.rateApplied),
        total: money(finding.params?.totalCents ?? 0),
      })).join('; '),
    }));
  // Lines whose proven work is worth more than their printed amount: paid as printed, never more.
  const noteLines = verification.lines.flatMap((line) => line.findings
    .filter((finding) => finding.code === 'UNDERBILLED')
    .map((finding) => ({
      id: line.id,
      subject: line.subject,
      date: date(line.date),
      written: money(finding.params.writtenCents),
      proven: money(finding.params.provenCents),
      difference: money(finding.params.differenceCents),
    })));
  const printedTotal = invoice.totalCents;
  const totalNote = printedTotal !== null && printedTotal !== undefined && printedTotal !== verification.totals.claimedCents
    ? { printed: money(printedTotal) }
    : null;
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
    noteLines,
    totalNote,
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
    parts.push(body.partial(facts), '', ...facts.disputedLines.map((line) => body.line(line)));
  }
  if (facts.totalNote) parts.push('', body.totalNote(facts));
  if (facts.noteLines?.length) parts.push('', body.noteHeading, ...facts.noteLines.map((line) => body.noteLine(line)));
  if (facts.disputedLines.length > 0) parts.push('', body.closing);
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
  // The id must follow a word such as "Line", "Pos.", "poz." or "Позиція" ("€5,035" is not line 5).
  const mentions = (id) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:\\p{L}{2,}\\.?|#)\\s?${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(body);
  for (const line of facts.disputedLines) {
    if (!mentions(line.id)) missing.push(`line ${line.id}`);
    if (!body.includes(squash(line.payable))) missing.push(`paid amount ${line.payable} of line ${line.id}`);
  }
  for (const line of facts.noteLines ?? []) {
    if (!mentions(line.id)) missing.push(`line ${line.id}`);
    if (!body.includes(squash(line.difference))) missing.push(`difference ${line.difference} of line ${line.id} that may be invoiced`);
  }
  if (facts.totalNote && !body.includes(squash(facts.totalNote.printed))) missing.push(`printed invoice total ${facts.totalNote.printed}`);
  return missing;
}

// Structured output for the draft: one string, nothing else.
const MESSAGE_SCHEMA = Object.freeze({
  name: 'payment_message',
  schema: { type: 'object', additionalProperties: false, properties: { message: { type: 'string' } }, required: ['message'] },
});

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
    'Mention every line in noteLines by its line number: it is paid as invoiced, and the subcontractor may invoice the difference shown.',
    'If totalNote is present, say that the invoice total it shows does not match the sum of the lines.',
    'Do not add facts, promises, deadlines, threats or legal claims.',
    'Answer with JSON only: {"message": "<the message text>"}',
  ].join('\n');
  try {
    const output = await provider.generateJson({ system, user: JSON.stringify(facts), schema: MESSAGE_SCHEMA });
    const text = typeof output.json.message === 'string' ? output.json.message.trim() : '';
    const missing = factCheckMessage(text, facts);
    if (missing.length === 0) {
      return { text, source: 'ai', label: `AI draft, fact-checked (${provider.label})`, note: null };
    }
    return { text: template(), source: 'template', label: 'Template, no AI used', note: `The AI draft failed the fact check (missing ${missing.slice(0, 3).join(', ')}), so the template was used.` };
  } catch (error) {
    if (!(error instanceof AiError)) throw error;
    return { text: template(), source: 'template', label: 'Template, no AI used', note: `The AI draft failed (${error.message.replace(/\.+$/, '')}), so the template was used.` };
  }
}
