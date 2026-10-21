/**
 * Verification engine: proves every invoice line against evidence.
 *
 * Pure and deterministic: no AI, no I/O, no clock. Input is validated data
 * (see schema.mjs), output is a per-line verdict with the payable amount in
 * integer cents, the reasons and the evidence ids used.
 *
 * Rules (documented in README "Verification rules"):
 *  - Labour is proven only by timesheet entries for the same worker and date that are SIGNED BY THE
 *    SITE MANAGER named on the sheet (a sign-off by anyone else counts as not signed).
 *  - Material is proven only by delivery notes for the same contract item, date and unit.
 *  - Evidence is consumed line by line, so one signed day or one delivery can
 *    never prove two invoice lines.
 *  - A line identical to an earlier line (same subject, date, quantity, price)
 *    that the remaining evidence cannot cover is a DUPLICATE.
 *  - The unit price is capped at the contract rate (RATE_ABOVE_CONTRACT).
 *  - The printed line total must equal quantity x price to the cent (MATH_ERROR);
 *    the payable amount is always recomputed: proven quantity x allowed rate.
 *  - A contract payment cap limits the cumulative payable amount (OVER_CAP).
 */
import { formatMoney, formatQuantity, isArithmeticallyConsistent, lineAmountCents } from './money.mjs';
import { codeKey, matchKey, signerMatches } from './normalize.mjs';

export const ENGINE_VERSION = 'payonproof-verify/1.1';

export const VERDICTS = Object.freeze([
  'PROVEN', 'PARTIAL', 'UNPROVEN', 'UNSIGNED', 'DUPLICATE', 'RATE_ABOVE_CONTRACT', 'MATH_ERROR', 'OVER_CAP',
]);

/** When a line has several findings, the first one in this list is its verdict. */
const PRECEDENCE = ['DUPLICATE', 'UNPROVEN', 'UNSIGNED', 'PARTIAL', 'RATE_ABOVE_CONTRACT', 'MATH_ERROR', 'OVER_CAP'];

/**
 * @typedef {{code: string, reason: string, params?: object}} Finding
 * @typedef {{id: string, qtyMilli: number, detail: string}} EvidenceUse
 */

function buildRateIndex(rates) {
  const labour = new Map();
  const material = new Map();
  const byCode = new Map();
  rates.forEach((rate, position) => {
    const entry = { ...rate, rateKey: `${rate.kind}:${position}` };
    const names = rate.kind === 'labour' ? labour : material;
    for (const name of [rate.name, ...(rate.aliases ?? [])]) {
      const key = matchKey(name);
      if (key && !names.has(key)) names.set(key, entry);
    }
    if (rate.code) byCode.set(codeKey(rate.code), entry);
  });
  return { labour, material, byCode };
}

function resolveMaterialRate(index, item, itemCode) {
  if (itemCode) {
    const byCode = index.byCode.get(codeKey(itemCode));
    if (byCode && byCode.kind === 'material') return byCode;
  }
  return index.material.get(matchKey(item)) ?? null;
}

/**
 * Assign stable evidence ids: timesheet entries "<sheet>#<n>", delivery notes by their number.
 * An entry counts as signed only when it is signed by the site manager named on its sheet. A sign-off
 * by anyone else makes it unsigned (with the reason in `signerNote`). When the sheet names no site
 * manager, or a sign-off has no name, the signer cannot be checked: the entry still counts as signed
 * and a warning in `signerWarnings` says so.
 * @param {Array<{docId: string, sheetRef?: string|null, siteManager?: string|null, entries: object[]}>} timesheets
 * @param {Array<{docId: string, notes: object[]}>} deliveryNotes
 */
export function buildEvidence(timesheets, deliveryNotes) {
  const entries = [];
  const signerWarnings = [];
  for (const sheet of timesheets) {
    const sheetId = sheet.sheetRef || sheet.docId;
    const manager = sheet.siteManager || null;
    let unchecked = 0;
    sheet.entries.forEach((entry, position) => {
      let signed = entry.signed === true;
      let signerNote = null;
      if (signed && manager && entry.signedBy) {
        if (!signerMatches(entry.signedBy, manager)) {
          signed = false;
          signerNote = `signed by ${entry.signedBy}, not by the site manager ${manager}`;
        }
      } else if (signed) {
        unchecked += 1;
      }
      entries.push({
        ...entry,
        id: `${sheetId}#${entry.ref || position + 1}`,
        signedAsWritten: entry.signed === true,
        signed,
        signerNote,
        workerKey: matchKey(entry.worker),
        remaining: signed ? entry.hoursMilli : 0,
        usedBy: [],
      });
    });
    if (unchecked > 0) {
      const count = `${unchecked} signed ${unchecked === 1 ? 'entry' : 'entries'}`;
      signerWarnings.push({
        code: 'SIGNER_NOT_CHECKED', severity: 'warning',
        reason: manager
          ? `Timesheet ${sheetId}: ${count} ${unchecked === 1 ? 'has' : 'have'} no signer name, so the signer could not be compared with the site manager ${manager}.`
          : `Timesheet ${sheetId} does not name the site manager, so the signer of its ${count} could not be checked.`,
      });
    }
  }
  const notes = [];
  const counts = new Map();
  for (const doc of deliveryNotes) for (const note of doc.notes) counts.set(note.ref, (counts.get(note.ref) ?? 0) + 1);
  for (const doc of deliveryNotes) {
    for (const note of doc.notes) {
      notes.push({
        ...note,
        id: counts.get(note.ref) > 1 ? `${doc.docId}:${note.ref}` : note.ref,
        remaining: note.quantityMilli,
        usedBy: [],
      });
    }
  }
  return { entries, notes, signerWarnings };
}

function listIds(items) {
  return items.map((item) => item.id).join(', ');
}

/**
 * Verify an invoice against contract rates, timesheets and delivery notes.
 * @param {{contract: object, invoice: object, timesheets?: object[], deliveryNotes?: object[]}} input
 * @returns {{engine: string, currency: string, lines: object[], totals: object, caseFindings: object[], blockers: object[], unusedEvidence: object[]}}
 */
export function verifyCase({ contract, invoice, timesheets = [], deliveryNotes = [] }) {
  const currency = contract.currency;
  const money = (cents) => formatMoney(cents, currency);
  const qty = (milli) => formatQuantity(milli);
  const index = buildRateIndex(contract.rates);
  const evidence = buildEvidence(timesheets, deliveryNotes);
  for (const note of evidence.notes) {
    const rate = resolveMaterialRate(index, note.item, note.itemCode);
    note.rateKey = rate ? rate.rateKey : null;
    note.itemKey = matchKey(note.item);
  }

  const caseFindings = [...evidence.signerWarnings];
  if (invoice.currency !== contract.currency) {
    caseFindings.push({
      code: 'CURRENCY_MISMATCH', severity: 'blocker',
      reason: `Invoice currency ${invoice.currency} differs from contract currency ${contract.currency}.`,
    });
  }
  if (invoice.payeeEmail && invoice.payeeEmail !== contract.payeeEmail) {
    caseFindings.push({
      code: 'PAYEE_MISMATCH', severity: 'warning',
      reason: `The invoice asks for payment to ${invoice.payeeEmail}. Only the contract payee ${contract.payeeEmail} can be paid.`,
    });
  }
  if (invoice.contractRef && codeKey(invoice.contractRef) !== codeKey(contract.contractId)) {
    caseFindings.push({
      code: 'CONTRACT_REF_MISMATCH', severity: 'warning',
      reason: `The invoice refers to contract ${invoice.contractRef}, the rate sheet is ${contract.contractId}.`,
    });
  }

  const firstBySignature = new Map();
  const lines = invoice.lines.map((line) => {
    /** @type {Finding[]} */
    const findings = [];
    const add = (code, reason, params = {}) => findings.push({ code, reason, params });
    const isLabour = line.kind === 'labour';
    const subject = isLabour ? line.worker : line.item;
    const unitLabel = line.unitAsWritten;

    const signature = [line.kind, matchKey(subject), codeKey(line.itemCode) ?? '', line.date, line.quantityMilli, line.unit, line.unitPriceCents].join('|');
    const earlierId = firstBySignature.get(signature);
    if (earlierId === undefined) firstBySignature.set(signature, line.id);

    const rate = isLabour ? (index.labour.get(matchKey(line.role)) ?? null) : resolveMaterialRate(index, line.item, line.itemCode);
    let priceable = true;
    if (!rate) {
      priceable = false;
      add('UNPROVEN', isLabour
        ? `Contract ${contract.contractId} has no rate for the role "${line.role}".`
        : `"${line.item}" is not a priced item in contract ${contract.contractId}.`, { cause: 'NO_RATE' });
    } else if (rate.unit !== line.unit) {
      priceable = false;
      add('UNPROVEN', `Invoiced per ${unitLabel}, but the contract rate for ${rate.name} is per ${rate.unitAsWritten}.`, { cause: 'UNIT_MISMATCH' });
    }

    /** @type {EvidenceUse[]} */
    const used = [];
    let provenMilli = 0;
    if (priceable) {
      const candidates = isLabour
        ? evidence.entries.filter((entry) => entry.workerKey === matchKey(line.worker) && entry.date === line.date)
        : evidence.notes.filter((note) => note.date === line.date && note.rateKey === rate.rateKey);
      const usable = isLabour
        ? candidates.filter((entry) => entry.signed)
        : candidates.filter((note) => note.unit === line.unit);
      const available = usable.reduce((sum, item) => sum + item.remaining, 0);

      if (earlierId !== undefined && available < line.quantityMilli) {
        add('DUPLICATE', isLabour
          ? `Repeats line ${earlierId} (same worker, date, hours and rate); the signed timesheet covers only one of them.`
          : `Repeats line ${earlierId} (same item, date, quantity and price); the delivery notes cover only one of them.`,
        { duplicateOf: earlierId });
      } else if (candidates.length === 0) {
        add('UNPROVEN', isLabour
          ? `No timesheet entry for ${line.worker} on ${line.date}.`
          : `No delivery note for ${rate.name} on ${line.date}.`, { cause: 'NO_EVIDENCE' });
      } else if (usable.length === 0) {
        if (isLabour) {
          const problems = [...new Set(candidates.map((entry) => entry.signerNote ?? 'not signed by the site manager'))];
          const wrongSigners = [...new Set(candidates.map((entry) => (entry.signerNote ? entry.signedBy : null)))];
          add('UNSIGNED', `Timesheet entry ${listIds(candidates)} for ${line.worker} on ${line.date} is ${problems.join('; ')}.`, {
            evidence: listIds(candidates),
            signedBy: wrongSigners.length === 1 && wrongSigners[0] ? wrongSigners[0] : null,
          });
        } else {
          add('UNPROVEN', `Delivery note ${listIds(candidates)} records a different unit than the invoice (${unitLabel}).`, { cause: 'UNIT_MISMATCH' });
        }
      } else if (available === 0) {
        const users = [...new Set(usable.flatMap((item) => item.usedBy))].join(', ');
        add('UNPROVEN', `The evidence (${listIds(usable)}) is already used by line ${users}.`, { cause: 'EVIDENCE_USED', usedBy: users });
      } else {
        let need = line.quantityMilli;
        for (const item of usable) {
          if (need === 0) break;
          const take = Math.min(need, item.remaining);
          if (take === 0) continue;
          item.remaining -= take;
          item.usedBy.push(line.id);
          need -= take;
          used.push({
            id: item.id,
            qtyMilli: take,
            detail: isLabour
              ? `${qty(take)} h signed${item.signedBy ? ` by ${item.signedBy}` : ''}`
              : `${qty(take)} ${item.unitAsWritten} delivered${item.receivedBy ? `, received by ${item.receivedBy}` : ''}`,
          });
        }
        provenMilli = line.quantityMilli - need;
        if (provenMilli < line.quantityMilli) {
          const unsignedMilli = isLabour ? candidates.filter((entry) => !entry.signed).reduce((sum, entry) => sum + entry.hoursMilli, 0) : 0;
          add('PARTIAL', isLabour
            ? `Only ${qty(provenMilli)} of ${qty(line.quantityMilli)} h are on a signed timesheet (${listIds(used)})${unsignedMilli ? `; ${qty(unsignedMilli)} h are not signed by the site manager` : ''}.`
            : `Only ${qty(provenMilli)} of ${qty(line.quantityMilli)} ${unitLabel} were delivered (${listIds(used)}).`,
          { provenMilli, claimedMilli: line.quantityMilli, unit: unitLabel });
        }
      }
    }

    let payRateCents = line.unitPriceCents;
    if (priceable && line.unitPriceCents > rate.priceCents) {
      payRateCents = rate.priceCents;
      add('RATE_ABOVE_CONTRACT',
        `Invoiced at ${money(line.unitPriceCents)}/${unitLabel}; the contract rate for ${rate.name} is ${money(rate.priceCents)}/${rate.unitAsWritten}. Paid at the contract rate.`,
        { invoicedCents: line.unitPriceCents, contractCents: rate.priceCents, unit: unitLabel });
    }

    const correctCents = lineAmountCents(line.quantityMilli, line.unitPriceCents);
    const mathOk = isArithmeticallyConsistent(line.lineTotalCents, line.quantityMilli, line.unitPriceCents);
    if (!mathOk) {
      add('MATH_ERROR',
        `Line total ${money(line.lineTotalCents)} does not equal ${qty(line.quantityMilli)} × ${money(line.unitPriceCents)} = ${money(correctCents)}.`,
        { writtenCents: line.lineTotalCents, correctCents });
    }

    let payableCents = 0;
    if (priceable && provenMilli > 0) {
      const exactlyAsInvoiced = provenMilli === line.quantityMilli && payRateCents === line.unitPriceCents && mathOk;
      payableCents = exactlyAsInvoiced ? line.lineTotalCents : lineAmountCents(provenMilli, payRateCents);
    }

    return {
      id: line.id,
      kind: line.kind,
      subject,
      role: line.role,
      item: line.item,
      itemCode: line.itemCode,
      date: line.date,
      unit: unitLabel,
      claimedQtyMilli: line.quantityMilli,
      provenQtyMilli: provenMilli,
      unitPriceCents: line.unitPriceCents,
      contractRateCents: rate ? rate.priceCents : null,
      contractRateName: rate ? rate.name : null,
      payRateCents,
      claimedCents: line.lineTotalCents,
      correctCents,
      payableCents,
      findings,
      evidence: used,
    };
  });

  const cap = contract.paymentCapCents;
  if (cap !== null && cap !== undefined) {
    let remainingCap = cap;
    for (const line of lines) {
      if (line.payableCents > remainingCap) {
        const cut = line.payableCents - remainingCap;
        line.payableCents = remainingCap;
        line.findings.push({
          code: 'OVER_CAP',
          reason: `The contract caps payment at ${money(cap)} per invoice; ${money(cut)} of this line is not paid.`,
          params: { capCents: cap, cutCents: cut },
        });
      }
      remainingCap -= line.payableCents;
    }
  }

  let claimedCents = 0;
  let payableCents = 0;
  let disputedCents = 0;
  let inFavourCents = 0;
  for (const line of lines) {
    line.verdict = PRECEDENCE.find((code) => line.findings.some((finding) => finding.code === code)) ?? 'PROVEN';
    line.disputedCents = Math.max(0, line.claimedCents - line.payableCents);
    line.inFavourCents = Math.max(0, line.payableCents - line.claimedCents);
    line.evidenceIds = line.evidence.map((item) => item.id);
    line.reason = line.findings.length > 0
      ? line.findings.map((finding) => finding.reason).join(' ')
      : `Proven: ${line.evidence.map((item) => `${item.id} (${item.detail})`).join('; ')}.`;
    claimedCents += line.claimedCents;
    payableCents += line.payableCents;
    disputedCents += line.disputedCents;
    inFavourCents += line.inFavourCents;
  }

  if (invoice.totalCents !== null && invoice.totalCents !== undefined && invoice.totalCents !== claimedCents) {
    caseFindings.push({
      code: 'INVOICE_TOTAL_MISMATCH', severity: 'warning',
      reason: `The printed invoice total ${money(invoice.totalCents)} differs from the sum of its lines ${money(claimedCents)}.`,
    });
  }

  const unusedEvidence = [
    ...evidence.entries.filter((entry) => entry.signed && entry.remaining > 0)
      .map((entry) => ({ id: entry.id, remainingMilli: entry.remaining, unit: 'h', subject: entry.worker, date: entry.date })),
    ...evidence.notes.filter((note) => note.remaining > 0)
      .map((note) => ({ id: note.id, remainingMilli: note.remaining, unit: note.unitAsWritten, subject: note.item, date: note.date })),
  ];

  return {
    engine: ENGINE_VERSION,
    currency,
    lines,
    totals: {
      claimedCents,
      payableCents,
      disputedCents,
      inFavourCents,
      lineCount: lines.length,
      provenLineCount: lines.filter((line) => line.verdict === 'PROVEN').length,
    },
    caseFindings,
    blockers: caseFindings.filter((finding) => finding.severity === 'blocker'),
    unusedEvidence,
  };
}
