/**
 * Paid-invoice ledger: which invoices were sent to PayPal, across cases and server restarts.
 *
 * Key: the contract payee (email, lower case) and the normalised invoice number. A case reserves the
 * key synchronously before its payout leaves, so no other request can slip in between the check and
 * the reservation. The key is kept while money may have moved (SENDING, SENT, UNKNOWN_AFTER_SEND,
 * PAID_VERIFIED, UNCLAIMED, FAILED, MISMATCH) and released only when PayPal provably paid nothing
 * (NOT_SENT, REJECTED). Any other case for the same invoice is then blocked.
 *
 * With a file path, every change is written to a temporary file, flushed and renamed over the
 * ledger, so the file is always either the old or the new version. Without one it lives in memory.
 * One ledger file belongs to one server process; several instances would need a shared database.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';
import { codeKey, matchKey } from './normalize.mjs';

export const LEDGER_SCHEMA = 'payonproof.ledger.v1';

/** Payout states in which PayPal provably paid nothing, so the invoice may be paid again. */
export const RELEASING_STATES = Object.freeze(['NOT_SENT', 'REJECTED']);

export class LedgerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerError';
  }
}

/**
 * Ledger key of an invoice: contract payee (or, without one, the subcontractor) + invoice number,
 * both normalised ("NG-2026-0917" and "ng 2026 0917" are the same invoice).
 * @param {{payeeEmail?: string|null, subcontractor?: string|null, invoiceNumber: string}} invoice
 * @returns {string|null} null when the invoice number has no letters or digits at all
 */
export function invoiceKey({ payeeEmail, subcontractor, invoiceNumber }) {
  const number = codeKey(invoiceNumber);
  if (!number) return null;
  const party = payeeEmail ? String(payeeEmail).trim().toLowerCase() : `name:${matchKey(subcontractor)}`;
  return `${party}|${number}`;
}

function readLedgerFile(filePath) {
  let data;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new LedgerError(`The paid-invoice ledger ${filePath} cannot be read (${error.message}). Fix or move it: PayOnProof does not start without knowing which invoices were paid.`);
  }
  const valid = data && data.schema === LEDGER_SCHEMA && Array.isArray(data.entries)
    && data.entries.every((entry) => entry && typeof entry.key === 'string' && typeof entry.caseId === 'string' && typeof entry.state === 'string');
  if (!valid) throw new LedgerError(`The paid-invoice ledger ${filePath} is not a ${LEDGER_SCHEMA} file. Fix or move it: PayOnProof does not start without knowing which invoices were paid.`);
  return data.entries;
}

/**
 * @param {{filePath?: string|null, now?: () => number}} [options]
 */
export function createLedger({ filePath = null, now = Date.now } = {}) {
  const entries = new Map();
  if (filePath && existsSync(filePath)) for (const entry of readLedgerFile(filePath)) entries.set(entry.key, entry);

  function persist() {
    if (!filePath) return;
    mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    const fd = openSync(temporary, 'w');
    try {
      writeSync(fd, `${JSON.stringify({ schema: LEDGER_SCHEMA, entries: [...entries.values()] }, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, filePath);
  }

  /** Apply one change and write it; if the write fails, undo the change and throw. */
  function commit(key, next) {
    const previous = entries.get(key);
    if (next) entries.set(key, next);
    else entries.delete(key);
    try {
      persist();
    } catch (error) {
      if (previous) entries.set(key, previous);
      else entries.delete(key);
      throw new LedgerError(`The paid-invoice ledger could not be written (${error.code ?? error.message}).`);
    }
  }

  return {
    filePath,

    /** @param {string|null} key */
    get(key) {
      return key ? entries.get(key) ?? null : null;
    },

    /**
     * Reserve an invoice for one case before its payout leaves. Synchronous, so it is atomic within this
     * process. Another case holding the key wins: the result is {ok: false, entry} with its entry.
     * @param {string} key
     * @param {{caseId: string, invoiceNumber: string, payee: string, amountCents: number, currency: string, senderBatchId: string}} details
     * @returns {{ok: boolean, entry: object}}
     */
    reserve(key, details) {
      const existing = entries.get(key);
      if (existing && existing.caseId !== details.caseId) return { ok: false, entry: existing };
      const at = new Date(now()).toISOString();
      const entry = { key, ...details, state: 'SENDING', batchId: null, reservedAt: existing?.reservedAt ?? at, updatedAt: at };
      commit(key, entry);
      return { ok: true, entry };
    },

    /**
     * Record the payout state of the case holding the key. NOT_SENT and REJECTED release the key.
     * @param {string} key
     * @param {string} caseId
     * @param {{state: string, batchId?: string|null}} update
     * @returns {object|null} the entry, or null when released or not held by this case
     */
    record(key, caseId, update) {
      const existing = entries.get(key);
      if (!existing || existing.caseId !== caseId) return null;
      if (RELEASING_STATES.includes(update.state)) {
        commit(key, null);
        return null;
      }
      const entry = { ...existing, ...update, updatedAt: new Date(now()).toISOString() };
      commit(key, entry);
      return entry;
    },

    /** Every entry (copies). */
    list() {
      return [...entries.values()].map((entry) => ({ ...entry }));
    },
  };
}
