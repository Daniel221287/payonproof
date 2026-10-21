import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPayoutBody, createPayPalClient, existingBatchIdFrom, isDuplicateBatchError, PayPalConfigError,
  resolvePayPalConfig, senderBatchIdFromPreviewHash,
} from '../src/paypal.mjs';
import { createMockPayPal } from '../src/paypal-mock.mjs';
import { buildReceipt } from '../src/receipt.mjs';

const SANDBOX = 'https://api-m.sandbox.paypal.com';
const ID = 'client-id-abc';
const SECRET = 'client-secret-xyz-987';
const HASH = 'ab'.repeat(32);

function scripted(responses, now = () => 0) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: { ...init.headers }, body: init.body ?? null });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected call ${init.method} ${url}`);
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), {
      status: next.status ?? 200, headers: { 'content-type': 'application/json', 'paypal-debug-id': 'dbg123' },
    });
  };
  return { fetch, calls, now };
}

const token = (value = 'TOKEN-1', expiresIn = 32400) => ({ body: { access_token: value, token_type: 'Bearer', expires_in: expiresIn, scope: 'x', app_id: 'APP' } });
const created = (batchId = 'BATCH12345') => ({ status: 201, body: { batch_header: { payout_batch_id: batchId, batch_status: 'PENDING', sender_batch_header: { sender_batch_id: 'POP-x' } } } });
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

function body(overrides = {}) {
  return buildPayoutBody({
    senderBatchId: senderBatchIdFromPreviewHash(HASH), receiver: 'crew@example.com', amountCents: 503500, currency: 'EUR',
    note: 'PayOnProof invoice NG-1', senderItemId: 'case_1', emailSubject: 'Payment for invoice NG-1', emailMessage: 'Payment of 5035.00 EUR', ...overrides,
  });
}

function client(fetch, extra = {}) {
  return createPayPalClient({ baseUrl: SANDBOX, clientId: ID, clientSecret: SECRET, fetch, sleep: async () => {}, ...extra });
}

test('config: sandbox only; live refused unless PAYPAL_ALLOW_LIVE=I_UNDERSTAND; other hosts refused', () => {
  assert.equal(resolvePayPalConfig({}).mode, 'unconfigured');
  assert.equal(resolvePayPalConfig({}).baseUrl, SANDBOX);
  assert.equal(resolvePayPalConfig({ PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' }).mode, 'sandbox');
  assert.equal(resolvePayPalConfig({ PAYPAL_MOCK: '1' }).mode, 'mock');
  assert.equal(resolvePayPalConfig({ PAYPAL_BASE_URL: `${SANDBOX}/` }).environment, 'sandbox');
  assert.throws(() => resolvePayPalConfig({ PAYPAL_BASE_URL: 'https://api-m.paypal.com' }), PayPalConfigError);
  assert.throws(() => resolvePayPalConfig({ PAYPAL_BASE_URL: 'https://api-m.paypal.com', PAYPAL_ALLOW_LIVE: 'yes' }), /LIVE/);
  assert.throws(() => resolvePayPalConfig({ PAYPAL_BASE_URL: 'https://evil.example/paypal' }), /must be https:\/\/api-m\.sandbox\.paypal\.com/);
  assert.throws(() => resolvePayPalConfig({ PAYPAL_BASE_URL: 'https://api-m.paypal.com', PAYPAL_ALLOW_LIVE: 'I_UNDERSTAND', PAYPAL_MOCK: '1' }), /MOCK/i);
  const live = resolvePayPalConfig({ PAYPAL_BASE_URL: 'https://api-m.paypal.com', PAYPAL_ALLOW_LIVE: 'I_UNDERSTAND', PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' });
  assert.equal(live.mode, 'live');
});

test('OAuth2: client credentials with Basic auth, token cached until shortly before expiry', async () => {
  let t = 0;
  const { fetch, calls } = scripted([token('T1', 3600), created('B1'), created('B2'), token('T2', 3600), created('B3')]);
  const paypal = client(fetch, { now: () => t });
  await paypal.createPayout(body());
  await paypal.createPayout(body({ senderBatchId: 'POP-2' }));
  t += 3600_000 - 59_000;
  await paypal.createPayout(body({ senderBatchId: 'POP-3' }));
  const tokenCalls = calls.filter((call) => call.url.endsWith('/v1/oauth2/token'));
  assert.equal(tokenCalls.length, 2);
  assert.equal(tokenCalls[0].url, `${SANDBOX}/v1/oauth2/token`);
  assert.equal(tokenCalls[0].method, 'POST');
  assert.equal(tokenCalls[0].headers.authorization, `Basic ${Buffer.from(`${ID}:${SECRET}`).toString('base64')}`);
  assert.equal(tokenCalls[0].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(tokenCalls[0].body, 'grant_type=client_credentials');
  assert.equal(calls[4].headers.authorization, 'Bearer T2');
});

test('payout create: exact request body, sender_batch_id from the previewHash, idempotency header', async () => {
  const { fetch, calls } = scripted([token(), created('5UXD2E8A7EBQJ')]);
  const result = await client(fetch).createPayout(body());
  assert.deepEqual(result, { outcome: 'CREATED', senderBatchId: `POP-${HASH}`, batchId: '5UXD2E8A7EBQJ', batchStatus: 'PENDING', debugId: 'dbg123' });
  const post = calls[1];
  assert.equal(post.url, `${SANDBOX}/v1/payments/payouts`);
  assert.equal(post.method, 'POST');
  assert.equal(post.headers.authorization, 'Bearer TOKEN-1');
  assert.equal(post.headers['paypal-request-id'], `POP-${HASH}`);
  assert.deepEqual(JSON.parse(post.body), {
    sender_batch_header: { sender_batch_id: `POP-${HASH}`, email_subject: 'Payment for invoice NG-1', email_message: 'Payment of 5035.00 EUR' },
    items: [{ recipient_type: 'EMAIL', amount: { value: '5035.00', currency: 'EUR' }, note: 'PayOnProof invoice NG-1', sender_item_id: 'case_1', receiver: 'crew@example.com' }],
  });
  assert.throws(() => body({ amountCents: 0 }), RangeError);
  assert.throws(() => body({ note: 'Zażółć' }), /ASCII/);
  assert.throws(() => senderBatchIdFromPreviewHash('xyz'), TypeError);
});

test('duplicate sender_batch_id: PayPal refuses a second batch and the existing one is reported', async () => {
  const duplicate = {
    status: 400,
    body: {
      name: 'USER_BUSINESS_ERROR', message: 'User business error.', debug_id: 'd1',
      details: [{ field: 'SENDER_BATCH_ID', location: 'body', issue: 'Batch with given sender_batch_id already exists', link: [{ href: `${SANDBOX}/v1/payments/payouts/CR9VS2K4X4846`, rel: 'self', method: 'GET' }] }],
      links: [],
    },
  };
  const { fetch, calls } = scripted([token(), duplicate]);
  const result = await client(fetch).createPayout(body());
  assert.equal(result.outcome, 'DUPLICATE');
  assert.equal(result.batchId, 'CR9VS2K4X4846');
  assert.equal(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/payouts')).length, 1, 'never posts again');
  assert.ok(isDuplicateBatchError(duplicate.body));
  assert.ok(!isDuplicateBatchError({ name: 'VALIDATION_ERROR', details: [{ field: 'items[0].receiver', issue: 'invalid' }] }));
  assert.equal(existingBatchIdFrom({ links: [{ href: `${SANDBOX}/v1/payments/payouts/ABCDE12345?page=1` }] }), 'ABCDE12345');
});

test('401 on the API refreshes the token once and repeats the call', async () => {
  const { fetch, calls } = scripted([token('OLD'), { status: 401, body: { name: 'AUTHENTICATION_FAILURE' } }, token('NEW'), created('B9')]);
  const result = await client(fetch).createPayout(body());
  assert.equal(result.outcome, 'CREATED');
  const posts = calls.filter((call) => call.url.endsWith('/v1/payments/payouts'));
  assert.deepEqual(posts.map((post) => post.headers.authorization), ['Bearer OLD', 'Bearer NEW']);
});

test('a timeout after sending is UNKNOWN_AFTER_SEND and is never retried blindly', async () => {
  const { fetch, calls } = scripted([token(), timeoutError()]);
  const result = await client(fetch).createPayout(body());
  assert.equal(result.outcome, 'UNKNOWN_AFTER_SEND');
  assert.equal(result.error.code, 'TIMEOUT');
  assert.equal(calls.filter((call) => call.url.endsWith('/payouts')).length, 1);
});

test('connection refused or failed credentials mean NOT_SENT; 5xx is UNKNOWN; validation errors are REJECTED', async () => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  assert.equal((await client(scripted([token(), refused]).fetch).createPayout(body())).outcome, 'NOT_SENT');
  const badCreds = await client(scripted([{ status: 401, body: { error: 'invalid_client', error_description: 'Client Authentication failed' } }]).fetch).createPayout(body());
  assert.equal(badCreds.outcome, 'NOT_SENT');
  assert.match(badCreds.error.message, /rejected the API credentials/);
  assert.equal((await client(scripted([token(), { status: 503, body: { name: 'SERVICE_UNAVAILABLE' } }]).fetch).createPayout(body())).outcome, 'UNKNOWN_AFTER_SEND');
  const rejected = await client(scripted([token(), { status: 422, body: { name: 'INSUFFICIENT_FUNDS', message: 'Sender does not have sufficient funds.' } }]).fetch).createPayout(body());
  assert.equal(rejected.outcome, 'REJECTED');
  assert.equal(rejected.error.code, 'INSUFFICIENT_FUNDS');
});

test('readback polls with backoff until PayPal reports a final status', async () => {
  const batch = (batchStatus, itemStatus) => ({ body: {
    batch_header: { payout_batch_id: 'BATCH0001', batch_status: batchStatus, sender_batch_header: { sender_batch_id: `POP-${HASH}` }, time_created: '2026-10-21T10:00:00Z' },
    items: [{ payout_item_id: 'I1', transaction_status: itemStatus, ...(itemStatus === 'SUCCESS' ? { transaction_id: 'TX1' } : {}), payout_item: { amount: { value: '5035.00', currency: 'EUR' }, receiver: 'crew@example.com', sender_item_id: 'case_1' } }],
  } });
  const waits = [];
  const { fetch } = scripted([token(), batch('PENDING', 'PENDING'), batch('PROCESSING', 'PENDING'), batch('SUCCESS', 'SUCCESS')]);
  const paypal = client(fetch, { sleep: async (ms) => { waits.push(ms); } });
  const readback = await paypal.readBack('BATCH0001', { delaysMs: [0, 500, 1000, 2000, 4000] });
  assert.equal(readback.attempts, 3);
  assert.equal(readback.settled, true);
  assert.deepEqual(waits, [500, 1000]);
  assert.equal(readback.batch.items[0].transactionId, 'TX1');
  await assert.rejects(paypal.getPayoutBatch('../oauth2/token'), TypeError);
});

test('secrets and tokens never appear in logs or error messages', async () => {
  const events = [];
  const failing = scripted([token('SECRET-ACCESS-TOKEN'), { status: 400, body: { name: 'VALIDATION_ERROR', message: 'Invalid request', details: [{ field: 'items[0].receiver', issue: 'bad' }] } }]);
  const paypal = client(failing.fetch, { log: (event) => events.push(event) });
  const result = await paypal.createPayout(body());
  const dump = JSON.stringify({ events, result });
  for (const secret of [SECRET, 'SECRET-ACCESS-TOKEN', Buffer.from(`${ID}:${SECRET}`).toString('base64')]) assert.ok(!dump.includes(secret));
  assert.ok(events.some((event) => event.event === 'paypal.call' && event.status === 400 && event.debugId === 'dbg123'));
});

test('MOCK PayPal behaves like the sandbox: create, duplicate, readback, receipt', async () => {
  const mock = createMockPayPal();
  const paypal = createPayPalClient({ baseUrl: SANDBOX, clientId: 'mock-client-id', clientSecret: 'mock-client-secret', fetch: mock.fetch });
  const first = await paypal.createPayout(body());
  assert.equal(first.outcome, 'CREATED');
  const again = await paypal.createPayout(body());
  assert.equal(again.outcome, 'DUPLICATE');
  assert.equal(again.batchId, first.batchId);
  assert.equal(mock.batches.size, 1);
  const readback = await paypal.readBack(first.batchId, { delaysMs: [0, 0, 0] });
  assert.equal(readback.batch.batchStatus, 'SUCCESS');
  const core = { caseId: 'case_1', invoiceNumber: 'NG-1', payee: { email: 'crew@example.com' }, currency: 'EUR', payableCents: 503500 };
  const { receipt, sha256 } = buildReceipt({ core, previewHash: HASH, senderBatchId: `POP-${HASH}`, environment: 'mock', ...readback, sentAt: '2026-10-21T10:00:00Z' });
  assert.equal(receipt.verdict, 'PAID_VERIFIED');
  assert.deepEqual(Object.values(receipt.checks), [true, true, true, true, true]);
  assert.match(sha256, /^[0-9a-f]{64}$/);
  const wrong = buildReceipt({ core: { ...core, payableCents: 503400 }, previewHash: HASH, senderBatchId: `POP-${HASH}`, environment: 'mock', ...readback, sentAt: 'x' });
  assert.equal(wrong.receipt.verdict, 'MISMATCH', 'a readback that differs from the approval is never PAID');
});

test('MOCK PayPal reports UNCLAIMED honestly and rejects invalid requests like the sandbox', async () => {
  const mock = createMockPayPal({ readsUntilSuccess: 1 });
  const paypal = createPayPalClient({ baseUrl: SANDBOX, clientId: 'mock-client-id', clientSecret: 'mock-client-secret', fetch: mock.fetch });
  const created = await paypal.createPayout(body({ receiver: 'nobody@unclaimed.example.com' }));
  const readback = await paypal.readBack(created.batchId, { delaysMs: [0] });
  const core = { caseId: 'case_1', invoiceNumber: 'NG-1', payee: { email: 'nobody@unclaimed.example.com' }, currency: 'EUR', payableCents: 503500 };
  assert.equal(buildReceipt({ core, previewHash: HASH, senderBatchId: `POP-${HASH}`, environment: 'mock', ...readback, sentAt: 'x' }).receipt.verdict, 'UNCLAIMED');
  const invalid = JSON.parse(JSON.stringify(body({ senderBatchId: 'POP-other' })));
  invalid.items[0].amount.value = '5035';
  const response = await mock.fetch(`${SANDBOX}/v1/payments/payouts`, { method: 'POST', headers: { authorization: `Bearer ${(await paypal.getAccessToken())}` }, body: JSON.stringify(invalid) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).name, 'VALIDATION_ERROR');
  const noAuth = await mock.fetch(`${SANDBOX}/v1/payments/payouts/${created.batchId}`, { method: 'GET' });
  assert.equal(noAuth.status, 401);
});
