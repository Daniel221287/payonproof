/**
 * MOCK PayPal: an in-process fake of the sandbox Payouts API, used when
 * PAYPAL_MOCK=1 and in tests. It answers through a `fetch`-compatible function,
 * so the real PayPal client code runs unchanged. The UI labels it "MOCK PayPal".
 *
 * Behaviour modelled on the sandbox: OAuth2 client credentials, request
 * validation, 201 + PENDING on create, duplicate sender_batch_id rejected with a
 * HATEOAS link to the existing batch, batch moving PENDING -> PROCESSING ->
 * SUCCESS on later reads, UNCLAIMED for receivers whose address contains
 * "unclaimed". Faults (timeouts, lost responses, 401, 5xx) can be injected.
 */
import { randomBytes } from 'node:crypto';
import { PAYPAL_SANDBOX_BASE_URL } from './paypal.mjs';

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function paypalId(length) {
  const bytes = randomBytes(length);
  let id = '';
  for (let i = 0; i < length; i += 1) id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return id;
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'paypal-debug-id': paypalId(13).toLowerCase(), ...extraHeaders },
  });
}

function validationError(field, issue) {
  return json(400, {
    name: 'VALIDATION_ERROR',
    message: 'Invalid request - see details.',
    debug_id: paypalId(13).toLowerCase(),
    details: [{ field, location: 'body', issue }],
  });
}

/**
 * @param {{now?: () => number, baseUrl?: string, clientId?: string, clientSecret?: string, readsUntilSuccess?: number}} [options]
 */
export function createMockPayPal({
  now = Date.now, baseUrl = PAYPAL_SANDBOX_BASE_URL, clientId = 'mock-client-id', clientSecret = 'mock-client-secret', readsUntilSuccess = 2,
} = {}) {
  const tokens = new Map();
  const batches = new Map();
  const bySenderBatchId = new Map();
  const calls = [];
  const faults = [];

  function authorize(headers) {
    const header = headers.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const expiresAt = tokens.get(token);
    return Boolean(expiresAt && expiresAt > now());
  }

  function nextFault(method, path) {
    const index = faults.findIndex((fault) => fault.method === method && path.startsWith(fault.path));
    return index === -1 ? null : faults.splice(index, 1)[0];
  }

  function createBatch(body) {
    const header = body?.sender_batch_header;
    const items = body?.items;
    if (!header || typeof header.sender_batch_id !== 'string' || header.sender_batch_id.length === 0 || header.sender_batch_id.length > 256) {
      return { response: validationError('sender_batch_header.sender_batch_id', 'Required field missing or too long') };
    }
    if (!Array.isArray(items) || items.length === 0 || items.length > 15000) return { response: validationError('items', 'Must contain 1 to 15000 items') };
    for (const [i, item] of items.entries()) {
      if (item.recipient_type !== 'EMAIL') return { response: validationError(`items[${i}].recipient_type`, 'Unsupported recipient type') };
      if (typeof item.receiver !== 'string' || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(item.receiver) || item.receiver.length > 127) {
        return { response: validationError(`items[${i}].receiver`, 'Receiver is invalid or does not match with type') };
      }
      if (!/^\d+\.\d{2}$/.test(item.amount?.value ?? '') || Number(item.amount.value) <= 0) return { response: validationError(`items[${i}].amount.value`, 'Invalid amount') };
      if (!/^[A-Z]{3}$/.test(item.amount?.currency ?? '')) return { response: validationError(`items[${i}].amount.currency`, 'Invalid currency') };
      if (item.sender_item_id !== undefined && String(item.sender_item_id).length > 63) return { response: validationError(`items[${i}].sender_item_id`, 'Too long') };
      if (item.note !== undefined && String(item.note).length > 4000) return { response: validationError(`items[${i}].note`, 'Too long') };
    }
    const existing = bySenderBatchId.get(header.sender_batch_id);
    if (existing) {
      return {
        response: json(400, {
          name: 'USER_BUSINESS_ERROR',
          message: 'User business error.',
          debug_id: paypalId(13).toLowerCase(),
          information_link: 'https://developer.paypal.com/docs/api/payments.payouts-batch/#errors',
          details: [{
            field: 'SENDER_BATCH_ID',
            location: 'body',
            issue: 'Batch with given sender_batch_id already exists',
            link: [{ href: `${baseUrl}/v1/payments/payouts/${existing}`, rel: 'self', method: 'GET', encType: 'application/json' }],
          }],
          links: [],
        }),
      };
    }
    const batchId = paypalId(13);
    const created = now();
    const batch = {
      id: batchId,
      senderBatchHeader: { sender_batch_id: header.sender_batch_id, email_subject: header.email_subject, email_message: header.email_message },
      items: items.map((item) => ({ ...item, payoutItemId: paypalId(13), transactionId: paypalId(17), activityId: paypalId(17) })),
      created,
      reads: 0,
    };
    batches.set(batchId, batch);
    bySenderBatchId.set(header.sender_batch_id, batchId);
    return {
      batch,
      response: json(201, {
        batch_header: { payout_batch_id: batchId, batch_status: 'PENDING', sender_batch_header: batch.senderBatchHeader },
        links: [{ href: `${baseUrl}/v1/payments/payouts/${batchId}`, rel: 'self', method: 'GET', encType: 'application/json' }],
      }),
    };
  }

  function readBatch(batchId) {
    const batch = batches.get(batchId);
    if (!batch) {
      return json(404, { name: 'INVALID_RESOURCE_ID', message: 'Requested resource ID was not found.', debug_id: paypalId(13).toLowerCase() });
    }
    batch.reads += 1;
    const done = batch.reads >= readsUntilSuccess;
    const currency = batch.items[0].amount.currency;
    const total = batch.items.reduce((sum, item) => sum + Math.round(Number(item.amount.value) * 100), 0);
    const statusFor = (item) => {
      if (!done) return 'PENDING';
      return /unclaimed/i.test(item.receiver) ? 'UNCLAIMED' : 'SUCCESS';
    };
    return json(200, {
      batch_header: {
        payout_batch_id: batch.id,
        batch_status: done ? 'SUCCESS' : 'PROCESSING',
        time_created: iso(batch.created),
        ...(done ? { time_completed: iso(batch.created + 2000) } : {}),
        sender_batch_header: batch.senderBatchHeader,
        amount: { currency, value: (total / 100).toFixed(2) },
        fees: { currency, value: '0.00' },
      },
      items: batch.items.map((item) => ({
        payout_item_id: item.payoutItemId,
        ...(done ? { transaction_id: item.transactionId, activity_id: item.activityId } : {}),
        transaction_status: statusFor(item),
        payout_item_fee: { currency, value: '0.00' },
        payout_batch_id: batch.id,
        payout_item: {
          recipient_type: item.recipient_type,
          amount: item.amount,
          note: item.note,
          receiver: item.receiver,
          sender_item_id: item.sender_item_id,
          recipient_wallet: 'PAYPAL',
        },
        time_processed: iso(batch.created + 1500),
        links: [{ href: `${baseUrl}/v1/payments/payouts-item/${item.payoutItemId}`, rel: 'item', method: 'GET', encType: 'application/json' }],
      })),
      links: [{ href: `${baseUrl}/v1/payments/payouts/${batch.id}?page_size=1000&page=1`, rel: 'self', method: 'GET', encType: 'application/json' }],
    });
  }

  /**
   * fetch-compatible entry point.
   * @param {string|URL} input
   * @param {RequestInit} [init]
   */
  async function mockFetch(input, init = {}) {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const path = url.pathname;
    calls.push({ method, path, headers: Object.fromEntries(headers), body: typeof init.body === 'string' ? init.body : null });
    if (url.origin !== baseUrl) throw new TypeError(`MOCK PayPal only answers ${baseUrl}`);

    const fault = nextFault(method, path);
    if (fault?.kind === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    if (fault?.kind === 'refused') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (fault?.kind === 'status') return json(fault.status, fault.body ?? { name: 'INTERNAL_SERVICE_ERROR', message: 'An internal service error occurred.' });

    if (method === 'POST' && path === '/v1/oauth2/token') {
      const expected = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      if (headers.get('authorization') !== expected || init.body !== 'grant_type=client_credentials') {
        return json(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
      }
      const token = `A21AA${paypalId(40)}`;
      tokens.set(token, now() + 32_400_000);
      return json(200, { scope: 'https://uri.paypal.com/services/payments/payouts', access_token: token, token_type: 'Bearer', app_id: 'APP-MOCKPAYONPROOF', expires_in: 32400, nonce: paypalId(20) });
    }
    if (fault?.kind === 'unauthorized' || !authorize(headers)) {
      return json(401, { name: 'AUTHENTICATION_FAILURE', message: 'Authentication failed due to invalid authentication credentials or a missing Authorization header.' });
    }
    if (method === 'POST' && path === '/v1/payments/payouts') {
      let body;
      try {
        body = JSON.parse(init.body);
      } catch {
        return validationError('body', 'MALFORMED_REQUEST_JSON');
      }
      const result = createBatch(body);
      if (fault?.kind === 'lost-response' && result.batch) {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }
      return result.response;
    }
    const match = /^\/v1\/payments\/payouts\/([A-Za-z0-9]+)$/.exec(path);
    if (method === 'GET' && match) return readBatch(match[1]);
    return json(404, { name: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.' });
  }

  return {
    fetch: mockFetch,
    calls,
    batches,
    /**
     * Queue a fault for the next matching call.
     * kind: 'timeout' (no request processed), 'lost-response' (payout created, answer lost),
     * 'refused' (connection refused), 'unauthorized' (401 once), 'status' (custom status/body).
     * @param {{method: string, path: string, kind: string, status?: number, body?: object}} fault
     */
    injectFault(fault) {
      faults.push(fault);
    },
    /** Expire every issued token (to exercise the 401 refresh path). */
    expireTokens() {
      for (const key of tokens.keys()) tokens.set(key, 0);
    },
  };
}
