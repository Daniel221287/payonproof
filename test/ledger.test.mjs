import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { createAiProvider } from '../src/ai.mjs';
import { createApprovalRegistry } from '../src/approval.mjs';
import { resolveConfig } from '../src/config.mjs';
import { createLedger, invoiceKey, LedgerError } from '../src/ledger.mjs';
import { createPayPalClient } from '../src/paypal.mjs';
import { createMockPayPal } from '../src/paypal-mock.mjs';
import { loadSamples } from '../src/samples.mjs';
import { createService } from '../src/service.mjs';

const samples = loadSamples(fileURLToPath(new URL('../samples', import.meta.url)));
const scratch = mkdtempSync(path.join(tmpdir(), 'payonproof-ledger-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function setup({ ledger = createLedger() } = {}) {
  const config = resolveConfig({ PAYPAL_MOCK: '1' });
  const mock = createMockPayPal();
  const service = createService({
    config, samples, ledger, approvals: createApprovalRegistry(), readbackDelaysMs: [0, 0, 0],
    payPalClient: createPayPalClient({ ...config.paypal, fetch: mock.fetch }), aiProvider: createAiProvider(config.ai),
  });
  return { service, mock, ledger };
}

async function approved(service, sampleId) {
  const caseView = await service.analyze({ sampleId });
  const { approval } = service.approve(caseView.id, { previewHash: caseView.proposal.previewHash, confirm: true });
  return { caseView, token: approval.token };
}

test('the ledger key is the contract payee plus the normalised invoice number', () => {
  assert.equal(invoiceKey({ payeeEmail: 'Crew-North@Example.com', invoiceNumber: 'NG-2026-0917' }), 'crew-north@example.com|NG20260917');
  assert.equal(invoiceKey({ payeeEmail: 'crew-north@example.com', invoiceNumber: 'ng 2026/0917' }), 'crew-north@example.com|NG20260917');
  assert.notEqual(invoiceKey({ payeeEmail: 'other@example.com', invoiceNumber: 'NG-2026-0917' }), invoiceKey({ payeeEmail: 'crew-north@example.com', invoiceNumber: 'NG-2026-0917' }));
  assert.equal(invoiceKey({ payeeEmail: null, subcontractor: 'Northgate Steel Crew', invoiceNumber: '7' }), 'name:crew northgate steel|7');
  assert.equal(invoiceKey({ payeeEmail: 'a@example.com', invoiceNumber: '/-/' }), null);
});

test('a reservation is held by one case; NOT_SENT and REJECTED release it, every other state keeps it', () => {
  const ledger = createLedger();
  const details = (caseId) => ({ caseId, invoiceNumber: 'INV-1', payee: 'a@example.com', amountCents: 100, currency: 'EUR', senderBatchId: `POP-${caseId}` });
  assert.equal(ledger.reserve('k', details('case_1')).ok, true);
  const taken = ledger.reserve('k', details('case_2'));
  assert.equal(taken.ok, false);
  assert.equal(taken.entry.caseId, 'case_1');
  assert.equal(ledger.reserve('k', details('case_1')).ok, true, 'the holder may reserve again (a retry after REJECTED)');
  assert.equal(ledger.record('k', 'case_2', { state: 'NOT_SENT' }), null, 'only the holder can change the entry');
  for (const state of ['SENT', 'UNKNOWN_AFTER_SEND', 'PAID_VERIFIED', 'UNCLAIMED', 'FAILED', 'MISMATCH']) {
    assert.equal(ledger.record('k', 'case_1', { state }).state, state);
  }
  for (const state of ['NOT_SENT', 'REJECTED']) {
    ledger.reserve('k', details('case_1'));
    assert.equal(ledger.record('k', 'case_1', { state }), null);
    assert.equal(ledger.get('k'), null, `${state} releases the invoice`);
  }
});

test('the ledger file is written atomically, survives a restart and refuses to load when damaged', () => {
  const filePath = path.join(scratch, 'atomic', 'ledger.json');
  const ledger = createLedger({ filePath, now: () => Date.parse('2026-10-21T20:00:00Z') });
  ledger.reserve('k', { caseId: 'case_1', invoiceNumber: 'INV-1', payee: 'a@example.com', amountCents: 100, currency: 'EUR', senderBatchId: 'POP-1' });
  ledger.record('k', 'case_1', { state: 'PAID_VERIFIED', batchId: 'BATCH1' });
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.equal(data.schema, 'payonproof.ledger.v1');
  assert.deepEqual(data.entries.map((entry) => [entry.key, entry.state, entry.batchId, entry.reservedAt]), [['k', 'PAID_VERIFIED', 'BATCH1', '2026-10-21T20:00:00.000Z']]);
  assert.deepEqual(readdirSync(path.dirname(filePath)), ['ledger.json'], 'no temporary file is left behind');
  assert.equal(createLedger({ filePath }).get('k').caseId, 'case_1', 'a new process sees the paid invoice');

  writeFileSync(filePath, '{"schema": "payonproof.ledger.v1", "entries": [');
  assert.throws(() => createLedger({ filePath }), (e) => e instanceof LedgerError && /cannot be read/.test(e.message));
  writeFileSync(filePath, '{"entries": []}');
  assert.throws(() => createLedger({ filePath }), /is not a payonproof\.ledger\.v1 file/);
});

test('the same invoice in a second case is blocked, naming the earlier case, its date and batch', async () => {
  const { service, mock } = setup();
  const first = await approved(service, 'rate-drift');
  const paid = await service.pay(first.caseView.id, { approvalToken: first.token });
  assert.equal(paid.payout.state, 'PAID_VERIFIED');

  const second = await service.analyze({ sampleId: 'rate-drift' });
  assert.equal(second.proposal.status, 'BLOCKED');
  const blocker = second.blockers.find((b) => b.code === 'INVOICE_ALREADY_PAID');
  assert.equal(blocker.earlierCaseId, first.caseView.id);
  assert.match(blocker.reason, new RegExp(`^Invoice SF-2026-031 from crew-sunflower@example\\.com was already sent to PayPal in case ${first.caseView.id} on \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC \\(PayPal batch ${paid.payout.batchId}, paid and verified\\)\\.`));
  assert.throws(() => service.approve(second.id, { previewHash: second.proposal.previewHash, confirm: true }), (e) => e.code === 'PROPOSAL_BLOCKED');
  assert.equal(mock.batches.size, 1);
});

test('two cases for the same invoice paid at the same moment: exactly one payout leaves', async () => {
  const { service, mock, ledger } = setup();
  const a = await approved(service, 'overbilled');
  const b = await approved(service, 'overbilled');
  assert.equal(b.caseView.proposal.status, 'AWAITING_HUMAN_APPROVAL', 'both were analysed before either was paid');
  const results = await Promise.allSettled([
    service.pay(a.caseView.id, { approvalToken: a.token }),
    service.pay(b.caseView.id, { approvalToken: b.token }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled' && r.value.payout.state === 'PAID_VERIFIED').length, 1);
  const refused = results.find((r) => r.status === 'rejected').reason;
  assert.equal(refused.status, 409);
  assert.equal(refused.code, 'INVOICE_ALREADY_PAID');
  assert.match(refused.message, /Nothing was sent\.$/);
  assert.equal(mock.batches.size, 1, 'one batch at PayPal');
  assert.equal(ledger.list().length, 1);
  const loser = service.getCase(b.caseView.id);
  assert.equal(loser.payout, null);
  assert.equal(loser.proposal.status, 'BLOCKED', 'the open page of the other case now shows it blocked');
  assert.ok(loser.blockers.some((blocker) => blocker.code === 'INVOICE_ALREADY_PAID'));
});

test('a payout PayPal rejected or never received releases the invoice; an unknown outcome keeps it', async () => {
  const { service, mock } = setup();
  const rejected = await approved(service, 'honest');
  mock.injectFault({ method: 'POST', path: '/v1/payments/payouts', kind: 'status', status: 422, body: { name: 'INSUFFICIENT_FUNDS', message: 'Sender does not have sufficient funds.' } });
  assert.equal((await service.pay(rejected.caseView.id, { approvalToken: rejected.token })).payout.state, 'REJECTED');
  const retry = await approved(service, 'honest');
  assert.equal((await service.pay(retry.caseView.id, { approvalToken: retry.token })).payout.state, 'PAID_VERIFIED', 'a new case may pay it');

  const unknown = await approved(service, 'multilingual');
  mock.injectFault({ method: 'POST', path: '/v1/payments/payouts', kind: 'timeout' });
  assert.equal((await service.pay(unknown.caseView.id, { approvalToken: unknown.token })).payout.state, 'UNKNOWN_AFTER_SEND');
  const blocked = await service.analyze({ sampleId: 'multilingual' });
  assert.match(blocked.blockers.find((b) => b.code === 'INVOICE_ALREADY_PAID').reason, /outcome unknown: reconcile that case/);

  mock.injectFault({ method: 'POST', path: '/v1/payments/payouts', kind: 'refused' });
  const stillUnknown = await service.reconcile(unknown.caseView.id);
  assert.equal(stillUnknown.payout.state, 'UNKNOWN_AFTER_SEND', 'a reconcile that cannot reach PayPal leaves the outcome unknown');
  assert.equal((await service.analyze({ sampleId: 'multilingual' })).proposal.status, 'BLOCKED');
  assert.equal((await service.reconcile(unknown.caseView.id)).payout.state, 'PAID_VERIFIED');
  assert.equal(mock.batches.size, 2);
});

test('when the ledger cannot be written, nothing is sent and the approval stays usable', async () => {
  const blockerFile = path.join(scratch, 'not-a-directory');
  writeFileSync(blockerFile, 'x');
  const { service, mock } = setup({ ledger: createLedger({ filePath: path.join(blockerFile, 'ledger.json') }) });
  const { caseView, token } = await approved(service, 'honest');
  await assert.rejects(service.pay(caseView.id, { approvalToken: token }), (e) => e.status === 503 && e.code === 'LEDGER_UNAVAILABLE' && /Nothing was sent/.test(e.message));
  assert.equal(mock.batches.size, 0);
  assert.equal(service.getCase(caseView.id).approval.state, 'active');
});

test('HTTP: LEDGER_PATH keeps paid invoices across a restart; MOCK PayPal alone keeps them in memory', async () => {
  const ledgerPath = path.join(scratch, 'restart', 'ledger.json');
  const start = async (env) => {
    const app = await createApp({ env: { PAYPAL_MOCK: '1', LOG_REQUESTS: '0', ...env }, quiet: true, readbackDelaysMs: [0, 0, 0] });
    const { port } = await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    const post = async (route, body) => (await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) })).json();
    return { app, base, post };
  };
  const first = await start({ LEDGER_PATH: ledgerPath });
  assert.equal((await (await fetch(`${first.base}/health`)).json()).ledger, 'file');
  const { case: caseView } = await first.post('/api/analyze', { sampleId: 'honest' });
  const { approval } = await first.post('/api/approve', { caseId: caseView.id, previewHash: caseView.proposal.previewHash, confirm: true });
  assert.equal((await first.post('/api/pay', { caseId: caseView.id, approvalToken: approval.token })).case.payout.state, 'PAID_VERIFIED');
  await first.app.close();
  assert.ok(existsSync(ledgerPath));

  const second = await start({ LEDGER_PATH: ledgerPath });
  const again = (await second.post('/api/analyze', { sampleId: 'honest' })).case;
  assert.equal(again.proposal.status, 'BLOCKED');
  assert.match(again.blockers.at(-1).reason, new RegExp(`case ${caseView.id}`), 'the case from before the restart is named');
  await second.app.close();

  const memory = await start({});
  assert.equal((await (await fetch(`${memory.base}/health`)).json()).ledger, 'memory');
  assert.equal((await memory.post('/api/analyze', { sampleId: 'honest' })).case.proposal.status, 'AWAITING_HUMAN_APPROVAL');
  await memory.app.close();
});
