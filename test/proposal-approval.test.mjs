import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovalError, APPROVAL_TTL_MS, createApprovalRegistry } from '../src/approval.mjs';
import { buildProposal, messageSha256, previewHashOf } from '../src/proposal.mjs';

const contract = { contractId: 'SC-1', payeeEmail: 'crew@example.com', currency: 'EUR' };
const invoice = { invoiceNumber: 'INV-1' };
const verification = {
  engine: 'payonproof-verify/1.0',
  blockers: [],
  totals: { payableCents: 40500 },
  lines: [{ id: '1', payableCents: 36900 }, { id: '2', payableCents: 0 }, { id: '3', payableCents: 3600 }],
};
const base = { caseId: 'case_1', contract, invoice, verification, messageText: 'Hello', documentsSha256: 'a'.repeat(64) };

test('the proposal core holds exactly the approved facts', () => {
  const proposal = buildProposal(base);
  assert.deepEqual(Object.keys(proposal.core).sort(), ['caseId', 'contractId', 'currency', 'documentsSha256', 'engine', 'invoiceNumber', 'messageSha256', 'paidLines', 'payableCents', 'payee', 'schema']);
  assert.deepEqual(proposal.core.paidLines, [{ id: '1', provenCents: 36900 }, { id: '3', provenCents: 3600 }]);
  assert.equal(proposal.core.messageSha256, messageSha256('Hello'));
  assert.equal(proposal.status, 'AWAITING_HUMAN_APPROVAL');
  assert.match(proposal.previewHash, /^[0-9a-f]{64}$/);
  assert.equal(proposal.summary.amount, '405.00');
});

test('previewHash is stable and independent of key order', () => {
  const a = buildProposal(base);
  const b = buildProposal({ ...base });
  assert.equal(a.previewHash, b.previewHash);
  const reordered = Object.fromEntries(Object.entries(a.core).reverse());
  reordered.payee = { sandboxOverride: false, contractEmail: 'crew@example.com', email: 'crew@example.com' };
  assert.equal(previewHashOf(reordered), a.previewHash);
  assert.equal(messageSha256('Hi\r\nthere'), messageSha256('Hi\nthere'), 'line endings do not change the hash');
});

test('any change to amount, lines, payee, message or documents changes previewHash', () => {
  const original = buildProposal(base).previewHash;
  const variants = [
    buildProposal({ ...base, messageText: 'Hello!' }),
    buildProposal({ ...base, payeeOverride: 'sb-test@personal.example.com' }),
    buildProposal({ ...base, documentsSha256: 'b'.repeat(64) }),
    buildProposal({ ...base, caseId: 'case_2' }),
    buildProposal({ ...base, verification: { ...verification, totals: { payableCents: 40501 } } }),
    buildProposal({ ...base, verification: { ...verification, lines: [{ id: '1', payableCents: 36900 }, { id: '3', payableCents: 3601 }] } }),
  ];
  for (const variant of variants) assert.notEqual(variant.previewHash, original);
  assert.equal(variants[1].core.payee.email, 'sb-test@personal.example.com');
  assert.equal(variants[1].core.payee.contractEmail, 'crew@example.com');
});

test('nothing payable or a blocker means the proposal is BLOCKED', () => {
  const none = buildProposal({ ...base, verification: { ...verification, totals: { payableCents: 0 }, lines: [] } });
  assert.equal(none.status, 'BLOCKED');
  assert.match(none.blockers[0], /Nothing is payable/);
  const blocked = buildProposal({ ...base, verification: { ...verification, blockers: [{ reason: 'Invoice currency PLN differs.' }] } });
  assert.equal(blocked.status, 'BLOCKED');
});

const HASH = 'c'.repeat(64);
function clockAt(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('an approval token works exactly once', () => {
  const registry = createApprovalRegistry();
  const { token, expiresAt } = registry.issue({ caseId: 'case_1', previewHash: HASH });
  assert.match(token, /^apv_[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(expiresAt) > Date.now());
  registry.consume({ token, caseId: 'case_1', previewHash: HASH });
  assert.throws(() => registry.consume({ token, caseId: 'case_1', previewHash: HASH }), (e) => e instanceof ApprovalError && e.code === 'APPROVAL_USED');
});

test('an approval expires after 10 minutes', () => {
  const clock = clockAt();
  const registry = createApprovalRegistry({ now: clock.now });
  assert.equal(APPROVAL_TTL_MS, 600_000);
  const first = registry.issue({ caseId: 'case_1', previewHash: HASH });
  clock.advance(APPROVAL_TTL_MS - 1);
  registry.check({ token: first.token, caseId: 'case_1', previewHash: HASH });
  clock.advance(2);
  assert.throws(() => registry.consume({ token: first.token, caseId: 'case_1', previewHash: HASH }), (e) => e.code === 'APPROVAL_EXPIRED');
  assert.equal(registry.statusFor('case_1').state, 'expired');
});

test('an approval is bound to its case and its exact previewHash', () => {
  const registry = createApprovalRegistry();
  const { token } = registry.issue({ caseId: 'case_1', previewHash: HASH });
  assert.throws(() => registry.consume({ token, caseId: 'case_1', previewHash: 'd'.repeat(64) }), (e) => e.code === 'APPROVAL_HASH_MISMATCH');
  assert.throws(() => registry.consume({ token, caseId: 'case_2', previewHash: HASH }), (e) => e.code === 'APPROVAL_CASE_MISMATCH');
  assert.throws(() => registry.consume({ token: undefined, caseId: 'case_1', previewHash: HASH }), (e) => e.code === 'APPROVAL_MISSING');
  assert.throws(() => registry.consume({ token: 'apv_forged', caseId: 'case_1', previewHash: HASH }), (e) => e.code === 'APPROVAL_INVALID');
  registry.consume({ token, caseId: 'case_1', previewHash: HASH });
});

test('changing the case revokes approvals, and a new approval replaces the old one', () => {
  const registry = createApprovalRegistry();
  const first = registry.issue({ caseId: 'case_1', previewHash: HASH });
  const second = registry.issue({ caseId: 'case_1', previewHash: HASH });
  assert.throws(() => registry.consume({ token: first.token, caseId: 'case_1', previewHash: HASH }), (e) => e.code === 'APPROVAL_REVOKED');
  assert.equal(registry.revokeCase('case_1'), 1);
  assert.throws(() => registry.consume({ token: second.token, caseId: 'case_1', previewHash: HASH }), (e) => e.code === 'APPROVAL_REVOKED');
  const status = registry.statusFor('case_1');
  assert.equal(status.state, 'revoked');
  assert.ok(!JSON.stringify(status).includes('apv_'), 'status never contains a token');
  assert.throws(() => registry.issue({ caseId: 'case_1', previewHash: 'not-a-hash' }), TypeError);
});
