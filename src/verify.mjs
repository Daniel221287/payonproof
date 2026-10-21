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
 *  - The trade on the signed timesheet must be the invoiced role (contract aliases count as
 *    the same role). Otherwise the line is paid at the contract rate of the trade on the
 *    timesheet (ROLE_MISMATCH), or not at all when that trade has no contract rate.
 *  - The unit price is capped at the contract rate (RATE_ABOVE_CONTRACT).
 *  - The printed line total must equal quantity x price to the cent (MATH_ERROR);
 *    the payable amount is always recomputed: proven quantity x allowed rate.
 *  - Never more than invoiced: a line pays at most its printed amount (work worth more is
 *    reported as UNDERBILLED, not paid), and the case pays at most the printed invoice
 *    total (OVER_INVOICE_TOTAL).
 *  - A contract payment cap limits the cumulative payable amount (OVER_CAP).
 */
import { formatMoney, formatQuantity, isArithmeticallyConsistent, lineAmountCents } from './money.mjs';
import { codeKey, matchKey, signerMatches } from './normalize.mjs';

export const ENGINE_VERSION = 'payonproof-verify/1.1';

export const VERDICTS = Object.freeze([
  'PROVEN', 'PARTIAL', 'UNPROVEN', 'UNSIGNED', 'DUPLICATE', 'ROLE_MISMATCH', 'RATE_ABOVE_CONTRACT', 'MATH_ERROR', 'OVER_INVOICE_TOTAL', 'OVER_CAP',
]);

/** When a line has several findings, the first one in this list is its verdict. */
const PRECEDENCE = ['DUPLICATE', 'UNPROVEN', 'UNSIGNED', 'ROLE_MISMATCH', 'PARTIAL', 'RATE_ABOVE_CONTRACT', 'MATH_ERROR', 'OVER_INVOICE_TOTAL', 'OVER_CAP'];

/** Findings that inform but never decide a verdict or reduce a payment. */
export const INFORMATIONAL_FINDINGS = Object.freeze(['UNDERBILLED']);

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
    /** Signed entries with another priced trade than the invoiced role, and the contract rate of that trade. */
    const tradeRates = new Map();
    const otherTradeUsed = [];
    const unpricedTrades = [];
    if (priceable) {
      const candidates = isLabour
        ? evidence.entries.filter((entry) => entry.workerKey === matchKey(line.worker) && entry.date === line.date)
        : evidence.notes.filter((note) => note.date === line.date && note.rateKey === rate.rateKey);
      let usable;
      if (isLabour) {
        // Signed entries whose trade is the invoiced role come first, then entries with another priced
        // trade (paid at that trade's rate). A trade without a contract rate proves nothing.
        const sameRole = [];
        const otherRole = [];
        for (const entry of candidates.filter((candidate) => candidate.signed)) {
          const entryTrade = entry.role ? (index.labour.get(matchKey(entry.role)) ?? null) : rate;
          if (entryTrade && entryTrade.rateKey === rate.rateKey) sameRole.push(entry);
          else if (entryTrade && entryTrade.unit === line.unit) {
            otherRole.push(entry);
            tradeRates.set(entry, entryTrade);
          } else {
            unpricedTrades.push(entry);
          }
        }
        usable = [...sameRole, ...otherRole];
      } else {
        usable = candidates.filter((note) => note.unit === line.unit);
      }
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
        if (isLabour && unpricedTrades.length > 0) {
          const trades = [...new Set(unpricedTrades.map((entry) => entry.role))].join(', ');
          add('UNPROVEN', `Invoiced as ${line.role}, but the signed timesheet (${listIds(unpricedTrades)}) says ${line.worker} worked as ${trades}, and contract ${contract.contractId} has no rate per ${unitLabel} for that trade.`,
            { cause: 'ROLE_NO_RATE', invoicedRole: line.role, evidencedRole: trades });
        } else if (isLabour) {
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
          if (tradeRates.has(item)) otherTradeUsed.push(item);
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

    // The allowed rate never exceeds the invoiced price, the contract rate of the invoiced role or the
    // contract rate of the trade on the signed timesheet (the lowest one when the hours used carry several).
    let payRateCents = line.unitPriceCents;
    const aboveContract = priceable && line.unitPriceCents > rate.priceCents;
    if (aboveContract) payRateCents = rate.priceCents;
    let tradeEntry = null;
    for (const entry of otherTradeUsed) if (!tradeEntry || tradeRates.get(entry).priceCents < tradeRates.get(tradeEntry).priceCents) tradeEntry = entry;
    const trade = tradeEntry ? tradeRates.get(tradeEntry) : null;
    const tradeLowers = Boolean(trade && trade.priceCents < payRateCents);
    if (trade) {
      if (tradeLowers) payRateCents = trade.priceCents;
      add('ROLE_MISMATCH',
        `Invoiced as ${line.role} (${money(rate.priceCents)}/${rate.unitAsWritten}); the signed timesheet (${listIds(otherTradeUsed)}) says ${tradeEntry.role} (${money(trade.priceCents)}/${trade.unitAsWritten}).${tradeLowers ? ` Paid at the ${trade.name} rate.` : ''}`,
        { invoicedRole: line.role, evidencedRole: tradeEntry.role, invoicedRateCents: rate.priceCents, evidencedRateCents: trade.priceCents, rateApplied: tradeLowers, unit: unitLabel });
    }
    if (aboveContract) {
      add('RATE_ABOVE_CONTRACT',
        `Invoiced at ${money(line.unitPriceCents)}/${unitLabel}; the contract rate for ${rate.name} is ${money(rate.priceCents)}/${rate.unitAsWritten}.${tradeLowers ? '' : ' Paid at the contract rate.'}`,
        { invoicedCents: line.unitPriceCents, contractCents: rate.priceCents, unit: unitLabel, paidAtContract: !tradeLowers });
    }

    const correctCents = lineAmountCents(line.quantityMilli, line.unitPriceCents);
    const mathOk = isArithmeticallyConsistent(line.lineTotalCents, line.quantityMilli, line.unitPriceCents);
    if (!mathOk) {
      add('MATH_ERROR',
        `Line total ${money(line.lineTotalCents)} does not equal ${qty(line.quantityMilli)} × ${money(line.unitPriceCents)} = ${money(correctCents)}.`,
        { writtenCents: line.lineTotalCents, correctCents });
    }

    let provenValueCents = 0;
    let payableCents = 0;
    if (priceable && provenMilli > 0) {
      const exactlyAsInvoiced = provenMilli === line.quantityMilli && payRateCents === line.unitPriceCents && mathOk;
      provenValueCents = exactlyAsInvoiced ? line.lineTotalCents : lineAmountCents(provenMilli, payRateCents);
      // Never more than the line as printed: proven work worth more is reported, not paid.
      payableCents = Math.min(provenValueCents, line.lineTotalCents);
      if (provenValueCents > line.lineTotalCents) {
        const differenceCents = provenValueCents - line.lineTotalCents;
        add('UNDERBILLED',
          `Paid as printed (${money(line.lineTotalCents)}): the proven work comes to ${money(provenValueCents)}, so ${money(differenceCents)} more could be invoiced.`,
          { writtenCents: line.lineTotalCents, provenCents: provenValueCents, differenceCents });
      }
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
      timesheetRole: tradeEntry ? tradeEntry.role : null,
      timesheetRateCents: trade ? trade.priceCents : null,
      payRateCents,
      claimedCents: line.lineTotalCents,
      correctCents,
      provenValueCents,
      payableCents,
      findings,
      evidence: used,
    };
  });

  // Never more than the printed invoice total: the lines that cross it are cut, in invoice order.
  const linesPayableCents = lines.reduce((sum, line) => sum + line.payableCents, 0);
  const printedTotal = invoice.totalCents;
  const cappedAtPrinted = printedTotal !== null && printedTotal !== undefined && printedTotal < linesPayableCents;
  if (cappedAtPrinted) {
    let remainingTotal = printedTotal;
    for (const line of lines) {
      if (line.payableCents > remainingTotal) {
        const cut = line.payableCents - remainingTotal;
        line.payableCents = remainingTotal;
        line.findings.push({
          code: 'OVER_INVOICE_TOTAL',
          reason: `The printed invoice total ${money(printedTotal)} is below the ${money(linesPayableCents)} the proven lines come to; ${money(cut)} of this line is not paid.`,
          params: { totalCents: printedTotal, cutCents: cut },
        });
      }
      remainingTotal -= line.payableCents;
    }
  }

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

  // Every line pays at most its claim, so claimed = payable + disputed holds per line and in total.
  let claimedCents = 0;
  let payableCents = 0;
  let disputedCents = 0;
  for (const line of lines) {
    line.verdict = PRECEDENCE.find((code) => line.findings.some((finding) => finding.code === code)) ?? 'PROVEN';
    line.disputedCents = line.claimedCents - line.payableCents;
    line.evidenceIds = line.evidence.map((item) => item.id);
    const decisive = line.findings.filter((finding) => !INFORMATIONAL_FINDINGS.includes(finding.code));
    line.reason = decisive.length > 0
      ? line.findings.map((finding) => finding.reason).join(' ')
      : [`Proven: ${line.evidence.map((item) => `${item.id} (${item.detail})`).join('; ')}.`, ...line.findings.map((finding) => finding.reason)].join(' ');
    claimedCents += line.claimedCents;
    payableCents += line.payableCents;
    disputedCents += line.disputedCents;
  }

  if (printedTotal !== null && printedTotal !== undefined && printedTotal !== claimedCents) {
    caseFindings.push({
      code: 'INVOICE_TOTAL_MISMATCH', severity: 'warning',
      reason: `The printed invoice total ${money(printedTotal)} differs from the sum of its lines ${money(claimedCents)}.${cappedAtPrinted ? ' No more than the printed total is paid.' : ''}`,
      params: { totalCents: printedTotal, linesCents: claimedCents, capped: cappedAtPrinted },
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
      lineCount: lines.length,
      provenLineCount: lines.filter((line) => line.verdict === 'PROVEN').length,
    },
    caseFindings,
    blockers: caseFindings.filter((finding) => finding.severity === 'blocker'),
    unusedEvidence,
  };
}
