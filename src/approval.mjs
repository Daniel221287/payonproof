/**
 * Human approval tokens.
 *
 * A token is issued only by the human-facing UI endpoint (never by an MCP
 * tool), is bound to one case and one exact previewHash, expires after a
 * short TTL (10 minutes) and can be used once. Only SHA-256(token) is kept in
 * memory, so the registry itself never holds a usable token.
 */
import { randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from './canonical.mjs';

export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export class ApprovalError extends Error {
  /**
   * @param {'APPROVAL_MISSING'|'APPROVAL_INVALID'|'APPROVAL_EXPIRED'|'APPROVAL_USED'|'APPROVAL_REVOKED'|'APPROVAL_HASH_MISMATCH'|'APPROVAL_CASE_MISMATCH'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

const sameHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * @param {{ttlMs?: number, now?: () => number, randomBytes?: (n: number) => Buffer}} [options]
 */
export function createApprovalRegistry({ ttlMs = APPROVAL_TTL_MS, now = Date.now, randomBytes = nodeRandomBytes } = {}) {
  /** @type {Map<string, {caseId: string, previewHash: string, issuedAt: number, expiresAt: number, state: 'active'|'used'|'revoked'}>} */
  const records = new Map();

  function prune() {
    const cutoff = now() - ttlMs * 6;
    for (const [key, record] of records) if (record.expiresAt < cutoff) records.delete(key);
  }

  return {
    ttlMs,
    /**
     * Issue a single-use token for one exact proposal. Earlier active tokens of the case are revoked.
     * @param {{caseId: string, previewHash: string}} binding
     * @returns {{token: string, caseId: string, previewHash: string, issuedAt: string, expiresAt: string}}
     */
    issue({ caseId, previewHash }) {
      if (!caseId || !/^[0-9a-f]{64}$/.test(previewHash)) throw new TypeError('approval needs a case id and a 64-hex previewHash');
      prune();
      for (const record of records.values()) if (record.caseId === caseId && record.state === 'active') record.state = 'revoked';
      const token = `apv_${randomBytes(32).toString('base64url')}`;
      const issuedAt = now();
      const record = { caseId, previewHash, issuedAt, expiresAt: issuedAt + ttlMs, state: 'active' };
      records.set(sha256Hex(token), record);
      return { token, caseId, previewHash, issuedAt: new Date(issuedAt).toISOString(), expiresAt: new Date(record.expiresAt).toISOString() };
    },

    /**
     * Check a token without using it.
     * @param {{token: string, caseId: string, previewHash: string}} claim
     */
    check({ token, caseId, previewHash }) {
      if (!token || typeof token !== 'string') throw new ApprovalError('APPROVAL_MISSING', 'A human approval token is required.');
      const record = records.get(sha256Hex(token));
      if (!record) throw new ApprovalError('APPROVAL_INVALID', 'This approval token is not valid.');
      if (record.state === 'used') throw new ApprovalError('APPROVAL_USED', 'This approval was already used. Approve again to pay again.');
      if (record.state === 'revoked') throw new ApprovalError('APPROVAL_REVOKED', 'This approval was revoked because the case changed.');
      if (now() > record.expiresAt) throw new ApprovalError('APPROVAL_EXPIRED', 'This approval expired. Approve the payment again.');
      if (record.caseId !== caseId) throw new ApprovalError('APPROVAL_CASE_MISMATCH', 'This approval belongs to another case.');
      if (!sameHex(record.previewHash, previewHash)) {
        throw new ApprovalError('APPROVAL_HASH_MISMATCH', 'The payment changed after it was approved. Review and approve it again.');
      }
      return record;
    },

    /**
     * Use a token once. Throws ApprovalError when it is missing, unknown, used, revoked, expired or bound elsewhere.
     * @param {{token: string, caseId: string, previewHash: string}} claim
     */
    consume(claim) {
      const record = this.check(claim);
      record.state = 'used';
      return { caseId: record.caseId, previewHash: record.previewHash, usedAt: new Date(now()).toISOString() };
    },

    /** Revoke every active approval of a case (called whenever the case changes). */
    revokeCase(caseId) {
      let count = 0;
      for (const record of records.values()) {
        if (record.caseId === caseId && record.state === 'active') {
          record.state = 'revoked';
          count += 1;
        }
      }
      return count;
    },

    /** Public status of the newest approval of a case (never the token). */
    statusFor(caseId) {
      let latest = null;
      for (const record of records.values()) if (record.caseId === caseId && (!latest || record.issuedAt >= latest.issuedAt)) latest = record;
      if (!latest) return null;
      const state = latest.state === 'active' && now() > latest.expiresAt ? 'expired' : latest.state;
      return { state, previewHash: latest.previewHash, expiresAt: new Date(latest.expiresAt).toISOString() };
    },
  };
}
