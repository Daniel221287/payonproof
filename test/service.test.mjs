import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AiError, createAiProvider } from '../src/ai.mjs';
import { ApprovalError, createApprovalRegistry } from '../src/approval.mjs';
import { resolveConfig } from '../src/config.mjs';
import { createPayPalClient } from '../src/paypal.mjs';
import { createMockPayPal } from '../src/paypal-mock.mjs';
import { loadSamples } from '../src/samples.mjs';
import { createService, ServiceError } from '../src/service.mjs';

const samples = loadSamples(fileURLToPath(new URL('../samples', import.meta.url)));

function setup(env = {}) {
  const config = resolveConfig({ PAYPAL_MOCK: '1', ...env });
  const mock = createMockPayPal();
  const payPalClient = config.paypal.mode === 'unconfigured' ? null : createPayPalClient({ ...config.paypal, fetch: mock.fetch });
  const approvals = createApprovalRegistry();
  const service = createService({
    config, samples, approvals, payPalClient, readbackDelaysMs: [0, 0, 0],
    aiProvider: createAiProvider(config.ai),
  });
  return { service, mock, approvals, config };
}

async function approvedCase(service, sampleId = 'overbilled') {
  const caseView = await service.analyze({ sampleId });
  const { approval } = service.approve(caseView.id, { previewHash: caseView.proposal.previewHash, confirm: true });
  return { caseView, token: approval.token };
}

test('happy path: analyze, approve, pay, PayPal readback says PAID_VERIFIED', async () => {
  const { service, mock } = setup();
  const { caseView, token } = await approvedCase(service);
  assert.equal(caseView.extraction.label, 'Offline sample parser — no AI used');
  assert.equal(caseView.proposal.status, 'AWAITING_HUMAN_APPROVAL');
  const paid = await service.pay(caseView.id, { approvalToken: token });
  assert.equal(paid.payout.state, 'PAID_VERIFIED');
  assert.equal(paid.payout.receipt.amount.value, '5035.00');
  assert.equal(paid.payout.senderBatchId, `POP-${caseView.proposal.previewHash}`);
  assert.equal(paid.proposal.status, 'PAYMENT_SENT');
  assert.equal(mock.batches.size, 1);
  assert.ok(!JSON.stringify(paid).includes(token), 'the case view never contains the approval token');
});

test('no approval, no payment: missing, reused or revoked tokens are refused', async () => {
  const { service, mock } = setup();
  const caseView = await service.analyze({ sampleId: 'honest' });
  await assert.rejects(service.pay(caseView.id, {}), (e) => e instanceof ApprovalError && e.code === 'APPROVAL_MISSING');
  const { approval } = service.approve(caseView.id, { previewHash: caseView.proposal.previewHash, confirm: true });
  service.updateMessage(caseView.id, 'Dear crew, we pay in full. Thanks.');
  await assert.rejects(service.pay(caseView.id, { approvalToken: approval.token }), (e) => e instanceof ApprovalError && e.code === 'APPROVAL_REVOKED');
  assert.equal(mock.batches.size, 0);
});

test('approval needs the confirmation and the currently shown previewHash', async () => {
  const { service } = setup();
  const caseView = await service.analyze({ sampleId: 'honest' });
  assert.throws(() => service.approve(caseView.id, { previewHash: caseView.proposal.previewHash }), (e) => e.code === 'CONFIRMATION_REQUIRED');
  assert.throws(() => service.approve(caseView.id, { previewHash: 'f'.repeat(64), confirm: true }), (e) => e.code === 'PREVIEW_CHANGED');
});

test('editing the message changes the previewHash and is recorded as human-edited', async () => {
  const { service } = setup();
  const caseView = await service.analyze({ sampleId: 'overbilled' });
  const edited = service.updateMessage(caseView.id, `${caseView.message.text}\nCall us any time.`);
  assert.notEqual(edited.proposal.previewHash, caseView.proposal.previewHash);
  assert.equal(edited.message.source, 'human');
  assert.equal(edited.version, caseView.version + 1);
});

test('a case pays at most once', async () => {
  const { service, mock } = setup();
  const { caseView, token } = await approvedCase(service);
  await service.pay(caseView.id, { approvalToken: token });
  assert.throws(() => service.approve(caseView.id, { previewHash: caseView.proposal.previewHash, confirm: true }), (e) => e.code === 'ALREADY_PAID');
  await assert.rejects(service.pay(caseView.id, { approvalToken: token }), (e) => e instanceof ServiceError && e.code === 'ALREADY_PAID');
  assert.throws(() => service.updateMessage(caseView.id, 'changed'), (e) => e.code === 'ALREADY_PAID');
  assert.equal(mock.batches.size, 1);
});

test('lost response after PayPal created the batch: UNKNOWN_AFTER_SEND, then reconcile finds it (no second payout)', async () => {
  const { service, mock } = setup();
  const { caseView, token } = await approvedCase(service);
  mock.injectFault({ method: 'POST', path: '/v1/payments/payouts', kind: 'lost-response' });
  const unknown = await service.pay(caseView.id, { approvalToken: token });
  assert.equal(unknown.payout.state, 'UNKNOWN_AFTER_SEND');
  assert.equal(mock.batches.size, 1, 'PayPal did create the batch');
  const refreshed = await service.refreshPayout(caseView.id);
  assert.equal(refreshed.payout.state, 'UNKNOWN_AFTER_SEND', 'a GET never sends anything');
  const reconciled = await service.reconcile(caseView.id);
  assert.equal(reconciled.payout.state, 'PAID_VERIFIED');
  assert.equal(reconciled.payout.duplicateDetected, true);
  assert.equal(mock.batches.size, 1, 'still exactly one payout');
  assert.deepEqual(reconciled.payout.attempts.map((a) => a.outcome), ['UNKNOWN_AFTER_SEND', 'DUPLICATE']);
});

test('timeout before PayPal processed anything: reconcile completes the single approved payout', async () => {
  const { service, mock } = setup();
  const { caseView, token } = await approvedCase(service);
  mock.injectFault({ method: 'POST', path: '/v1/payments/payouts', kind: 'timeout' });
  const unknown = await service.pay(caseView.id, { approvalToken: token });
  assert.equal(unknown.payout.state, 'UNKNOWN_AFTER_SEND');
  assert.equal(mock.batches.size, 0);
  const reconciled = await service.reconcile(caseView.id);
  assert.equal(reconciled.payout.state, 'PAID_VERIFIED');
  assert.equal(mock.batches.size, 1);
  await assert.rejects(service.reconcile(caseView.id), (e) => e.code === 'NOTHING_TO_RECONCILE');
});

test('a token refresh mid-flight (401) still pays exactly once', async () => {
  const { service, mock } = setup();
  const { caseView, token } = await approvedCase(service);
  await service.publicConfig();
  mock.injectFault({ method: 'POST', path: '/v1/payments/payouts', kind: 'unauthorized' });
  const paid = await service.pay(caseView.id, { approvalToken: token });
  assert.equal(paid.payout.state, 'PAID_VERIFIED');
  assert.equal(mock.batches.size, 1);
});

test('PayPal rejection (e.g. insufficient funds) pays nothing and allows a fresh approval', async () => {
  const { service, mock } = setup();
  const { caseView, token } = await approvedCase(service);
  mock.injectFault({ method: 'POST', path: '/v1/payments/payouts', kind: 'status', status: 422, body: { name: 'INSUFFICIENT_FUNDS', message: 'Sender does not have sufficient funds.' } });
  const rejected = await service.pay(caseView.id, { approvalToken: token });
  assert.equal(rejected.payout.state, 'REJECTED');
  assert.equal(rejected.payout.error.code, 'INSUFFICIENT_FUNDS');
  const { approval } = service.approve(caseView.id, { previewHash: caseView.proposal.previewHash, confirm: true });
  const paid = await service.pay(caseView.id, { approvalToken: approval.token });
  assert.equal(paid.payout.state, 'PAID_VERIFIED');
  assert.equal(paid.payout.attempts.length, 2);
});

test('sandbox payee override is visible in the approved preview and the receipt', async () => {
  const { service } = setup({ PAYEE_EMAIL_OVERRIDE: 'sb-buyer@personal.example.com' });
  const { caseView, token } = await approvedCase(service, 'honest');
  assert.equal(caseView.proposal.core.payee.email, 'sb-buyer@personal.example.com');
  assert.equal(caseView.proposal.core.payee.contractEmail, 'crew-birchline@example.com');
  assert.equal(caseView.proposal.core.payee.sandboxOverride, true);
  const paid = await service.pay(caseView.id, { approvalToken: token });
  assert.equal(paid.payout.receipt.receiver, 'sb-buyer@personal.example.com');
  assert.throws(() => resolveConfig({ PAYEE_EMAIL_OVERRIDE: 'nope' }), /valid email/);
});

test('without PayPal configured nothing is consumed and the error is explicit', async () => {
  const { service, approvals } = setup({ PAYPAL_MOCK: '' });
  const caseView = await service.analyze({ sampleId: 'honest' });
  const { approval } = service.approve(caseView.id, { previewHash: caseView.proposal.previewHash, confirm: true });
  await assert.rejects(service.pay(caseView.id, { approvalToken: approval.token }), (e) => e.status === 503 && e.code === 'PAYPAL_NOT_CONFIGURED');
  approvals.check({ token: approval.token, caseId: caseView.id, previewHash: caseView.proposal.previewHash });
});

test('pasted documents are validated before anything is read', async () => {
  const { service } = setup();
  await assert.rejects(service.analyze({ documents: [] }), (e) => e.code === 'DOCUMENTS_REQUIRED');
  await assert.rejects(service.analyze({ documents: [{ type: 'selfie', text: 'x' }] }), (e) => e.code === 'BAD_DOCUMENT_TYPE');
  await assert.rejects(service.analyze({ documents: [{ type: 'invoice', text: 'x'.repeat(60_001) }] }), (e) => e.status === 413);
  await assert.rejects(service.analyze({ sampleId: 'nope' }), (e) => e.status === 404);
  const blocked = await service.analyze({ documents: [{ type: 'invoice', text: 'Pay me 5000 EUR' }, { type: 'contract', text: 'We agreed 40 EUR/h' }] });
  assert.equal(blocked.proposal, null);
  assert.ok(blocked.blockers.length >= 2);
  assert.throws(() => service.approve(blocked.id, { previewHash: 'a'.repeat(64), confirm: true }), (e) => e.code === 'NOT_PAYABLE');
});

test('AI budgets: hourly and daily caps stop model calls before they are sent', async () => {
  let clock = Date.parse('2026-11-01T10:00:00Z');
  let calls = 0;
  const fakeAi = {
    id: 'fake', model: 'fake-1', isAI: true, label: 'Fake AI',
    async generateJson() {
      calls += 1;
      throw new AiError('FAKE_DOWN', 'fake model is down');
    },
  };
  const config = resolveConfig({ PAYPAL_MOCK: '1', AI_MAX_CALLS_PER_HOUR: '3', AI_MAX_CALLS_PER_DAY: '5' });
  assert.equal(config.aiMaxCallsPerDay, 5);
  assert.equal(resolveConfig({ PAYPAL_MOCK: '1' }).aiMaxCallsPerDay, null, 'no daily cap unless configured');
  const service = createService({
    config, samples, approvals: createApprovalRegistry(), payPalClient: null, aiProvider: fakeAi,
    now: () => clock, readbackDelaysMs: [0],
  });
  const analyze = (n) => service.analyze({ documents: [
    { type: 'contract', text: `Contract ${n}` },
    { type: 'invoice', text: `Invoice ${n}` },
  ] });
  const errorsOf = (caseView) => caseView.documents.map((doc) => doc.errors[0]?.message ?? '');

  await analyze(1);
  assert.equal(calls, 2);
  const second = await analyze(2);
  assert.equal(calls, 3, 'the fourth call in the hour is never sent');
  assert.match(errorsOf(second)[1], /hourly AI budget/);

  clock += 61 * 60_000;
  await analyze(3);
  assert.equal(calls, 5);
  const fourth = await analyze(4);
  assert.equal(calls, 5, 'the daily cap holds even with a fresh hour');
  assert.ok(errorsOf(fourth).every((message) => /daily AI budget/.test(message)));

  clock += 24 * 3_600_000;
  await analyze(5);
  assert.equal(calls, 7, 'a new 24-hour window allows calls again');
});

function honestDocuments(edit = {}) {
  const sample = samples.find((candidate) => candidate.id === 'honest');
  return sample.documents.map((doc) => ({ type: doc.type, name: doc.name, text: edit[doc.type] ? edit[doc.type](doc.text) : doc.text }));
}

test('an unreadable document means "cannot verify": no verdicts, no payable figure, no message, nothing to approve', async () => {
  const { service } = setup();
  const caseView = await service.analyze({ documents: honestDocuments({ timesheet: (text) => text.replace('| 8.00  | signed K. Vogelsang', '| 8.00  | OK J.A.') }) });
  assert.deepEqual(caseView.unreadable.map((doc) => doc.name), ['Timesheet TS-BM-38']);
  assert.match(caseView.unreadable[0].reason, /^Cannot read the sign-off "OK J\.A\."\. The offline sample parser reads only the layout of the bundled samples$/);
  assert.equal(caseView.verification, null, 'no line is judged on missing evidence');
  assert.equal(caseView.message, null, 'no message is built from missing evidence');
  assert.equal(caseView.proposal, null);
  assert.equal(caseView.blockers[0].code, 'DOCUMENT_REJECTED');
  assert.equal(caseView.blockers[0].reason, '"Timesheet TS-BM-38" could not be read: Cannot read the sign-off "OK J.A.". The offline sample parser reads only the layout of the bundled samples.');
  assert.doesNotMatch(caseView.blockers[0].reason, /\$|\.\./, 'no JSON path, no double period');
  assert.equal(caseView.invoice.invoiceNumber, 'BM-2026-118', 'what was read is still shown');
  assert.throws(() => service.approve(caseView.id, { previewHash: 'a'.repeat(64), confirm: true }), (e) => e.code === 'NOT_PAYABLE');
  assert.throws(() => service.updateMessage(caseView.id, 'Paying in full.'), (e) => e.code === 'NOT_PAYABLE');
  const readable = await service.analyze({ documents: honestDocuments() });
  assert.deepEqual(readable.unreadable, []);
  assert.equal(readable.verification.totals.payableCents, 227063);
});
