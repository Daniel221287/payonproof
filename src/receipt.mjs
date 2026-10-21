/**
 * Payout receipt built from PayPal's own readback.
 *
 * "PAID & VERIFIED" requires PayPal to report batch SUCCESS and item SUCCESS
 * AND the readback to match what the human approved (amount, currency,
 * receiver, sender_batch_id, sender_item_id). UNCLAIMED and PENDING are shown
 * as such, never as paid.
 */
import { hashCanonical } from './canonical.mjs';
import { centsToDecimalString } from './money.mjs';

export const RECEIPT_SCHEMA = 'payonproof.receipt.v1';

const FAILED_ITEM = ['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED'];
const FAILED_BATCH = ['DENIED', 'CANCELED'];

/**
 * Compare a readback with the approved proposal.
 * @param {object} core approved proposal core
 * @param {string} senderBatchId
 * @param {ReturnType<import('./paypal.mjs').normalizeBatch>} batch
 * @returns {{amount: boolean|null, currency: boolean|null, receiver: boolean|null, senderBatchId: boolean|null, senderItemId: boolean|null}}
 */
export function compareWithApproval(core, senderBatchId, batch) {
  const item = batch.items[0];
  const check = (available, ok) => (available ? ok : null);
  return {
    amount: check(Boolean(item?.amount), item?.amount?.value === centsToDecimalString(core.payableCents)),
    currency: check(Boolean(item?.amount), item?.amount?.currency === core.currency),
    receiver: check(Boolean(item?.receiver), String(item?.receiver).toLowerCase() === core.payee.email),
    senderBatchId: check(Boolean(batch.senderBatchId), batch.senderBatchId === senderBatchId),
    senderItemId: check(Boolean(item?.senderItemId), item?.senderItemId === core.caseId),
  };
}

/**
 * Overall verdict of a readback.
 * @returns {'PAID_VERIFIED'|'UNCLAIMED'|'PENDING'|'FAILED'|'MISMATCH'}
 */
export function receiptVerdict(batchStatus, itemStatus, checks) {
  if (Object.values(checks).some((value) => value === false)) return 'MISMATCH';
  if (FAILED_ITEM.includes(itemStatus) || FAILED_BATCH.includes(batchStatus)) return 'FAILED';
  if (itemStatus === 'UNCLAIMED') return 'UNCLAIMED';
  const complete = Object.values(checks).every((value) => value === true);
  if (batchStatus === 'SUCCESS' && itemStatus === 'SUCCESS' && complete) return 'PAID_VERIFIED';
  return 'PENDING';
}

/**
 * Build the receipt and its SHA-256.
 * @param {{core: object, previewHash: string, senderBatchId: string, environment: string, batch: object, readAt: string, attempts: number, sentAt: string, duplicateDetected?: boolean}} input
 * @returns {{receipt: object, sha256: string}}
 */
export function buildReceipt({ core, previewHash, senderBatchId, environment, batch, readAt, attempts, sentAt, duplicateDetected = false }) {
  const item = batch.items[0] ?? null;
  const checks = compareWithApproval(core, senderBatchId, batch);
  const receipt = {
    schema: RECEIPT_SCHEMA,
    environment,
    verdict: receiptVerdict(batch.batchStatus, item?.transactionStatus ?? null, checks),
    caseId: core.caseId,
    invoiceNumber: core.invoiceNumber,
    previewHash,
    senderBatchId,
    payoutBatchId: batch.batchId,
    batchStatus: batch.batchStatus,
    itemStatus: item?.transactionStatus ?? null,
    payoutItemId: item?.payoutItemId ?? null,
    transactionId: item?.transactionId ?? null,
    receiver: item?.receiver ?? null,
    amount: item?.amount ?? null,
    fee: item?.fee ?? null,
    itemError: item?.error ?? null,
    approved: { receiver: core.payee.email, amount: { value: centsToDecimalString(core.payableCents), currency: core.currency } },
    checks,
    duplicateDetected,
    paypalTimeCreated: batch.timeCreated,
    paypalTimeCompleted: batch.timeCompleted,
    sentAt,
    readbackAt: readAt,
    readbackAttempts: attempts,
  };
  return { receipt, sha256: hashCanonical(receipt) };
}
