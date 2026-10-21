/**
 * Payment proposal: the exact thing a human approves.
 *
 * The proposal core is canonical JSON of payee, currency, payable cents, case
 * id, the paid line ids with their proven cents and the message hash (plus the
 * invoice number, contract id, input-documents hash and engine version).
 * previewHash = SHA-256(canonical core). Approval tokens are bound to this
 * hash, and the PayPal sender_batch_id is derived from it, so a payment can
 * only ever go out for exactly what was shown.
 */
import { hashCanonical, sha256Hex } from './canonical.mjs';
import { centsToDecimalString } from './money.mjs';

export const PROPOSAL_SCHEMA = 'payonproof.proposal.v1';

/**
 * SHA-256 of the message text as approved (UTF-8, line endings normalised to \n).
 * @param {string} text
 * @returns {string}
 */
export function messageSha256(text) {
  return sha256Hex(String(text).replace(/\r\n?/g, '\n'));
}

/**
 * previewHash of a proposal core. Key order does not matter.
 * @param {object} core
 * @returns {string}
 */
export function previewHashOf(core) {
  return hashCanonical(core);
}

/**
 * Build the payment proposal for a verified case.
 * @param {{caseId: string, contract: object, invoice: object, verification: object, messageText: string, documentsSha256: string, payeeOverride?: string|null}} input
 * @returns {{core: object, previewHash: string, status: 'AWAITING_HUMAN_APPROVAL'|'BLOCKED', blockers: string[], summary: object}}
 */
export function buildProposal({ caseId, contract, invoice, verification, messageText, documentsSha256, payeeOverride = null }) {
  const payeeEmail = payeeOverride || contract.payeeEmail;
  const paidLines = verification.lines
    .filter((line) => line.payableCents > 0)
    .map((line) => ({ id: line.id, provenCents: line.payableCents }));
  const core = {
    schema: PROPOSAL_SCHEMA,
    caseId,
    invoiceNumber: invoice.invoiceNumber,
    contractId: contract.contractId,
    payee: { email: payeeEmail, contractEmail: contract.payeeEmail, sandboxOverride: Boolean(payeeOverride) },
    currency: contract.currency,
    payableCents: verification.totals.payableCents,
    paidLines,
    messageSha256: messageSha256(messageText),
    documentsSha256,
    engine: verification.engine,
  };
  const blockers = verification.blockers.map((blocker) => blocker.reason);
  if (core.payableCents <= 0) blockers.push('Nothing is payable: no invoice line is proven.');
  return {
    core,
    previewHash: previewHashOf(core),
    status: blockers.length > 0 ? 'BLOCKED' : 'AWAITING_HUMAN_APPROVAL',
    blockers,
    summary: {
      payeeEmail,
      amount: centsToDecimalString(core.payableCents),
      currency: core.currency,
      paidLineCount: paidLines.length,
      lineCount: verification.lines.length,
    },
  };
}
