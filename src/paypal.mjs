/**
 * PayPal Payouts client (REST v1), sandbox by default.
 *
 * - OAuth2 client credentials: POST /v1/oauth2/token (Basic auth), token cached until shortly before expiry.
 * - Create payout: POST /v1/payments/payouts with sender_batch_id derived from the previewHash, so
 *   PayPal itself refuses a second batch for the same approved payment (30-day uniqueness).
 * - Read back: GET /v1/payments/payouts/{payout_batch_id}, polled with backoff.
 * - 401 -> refresh the token once and repeat. Duplicate sender_batch_id -> report the existing batch.
 *   Timeout or lost response -> UNKNOWN_AFTER_SEND: never retried blindly, reconciled instead.
 *
 * Secrets and tokens are never logged or put into error messages.
 */
import { centsToDecimalString } from './money.mjs';

export const PAYPAL_SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';
export const PAYPAL_LIVE_BASE_URL = 'https://api-m.paypal.com';
export const LIVE_OPT_IN_VALUE = 'I_UNDERSTAND';

export const TERMINAL_BATCH_STATUSES = Object.freeze(['SUCCESS', 'DENIED', 'CANCELED']);
export const TERMINAL_ITEM_STATUSES = Object.freeze(['SUCCESS', 'FAILED', 'UNCLAIMED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED']);

export class PayPalConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PayPalConfigError';
  }
}

/** A call that did not produce an HTTP response. kind: 'timeout' | 'not_sent' | 'unknown'. */
export class PayPalNetworkError extends Error {
  constructor(kind, message, stage) {
    super(message);
    this.name = 'PayPalNetworkError';
    this.kind = kind;
    this.stage = stage;
  }
}

/** PayPal answered with an error status. */
export class PayPalApiError extends Error {
  constructor({ code, status, name, message, debugId, stage }) {
    super(message);
    this.name = 'PayPalApiError';
    this.code = code;
    this.status = status;
    this.paypalName = name ?? null;
    this.debugId = debugId ?? null;
    this.stage = stage;
  }
}

/**
 * Resolve PayPal settings from the environment and refuse unsafe ones.
 * - PAYPAL_MOCK=1 -> in-process fake PayPal (no network, clearly labelled).
 * - PAYPAL_BASE_URL must be the sandbox. Live needs PAYPAL_ALLOW_LIVE=I_UNDERSTAND and the exact live URL.
 * @param {Record<string, string|undefined>} env
 * @returns {{mode: 'mock'|'sandbox'|'live'|'unconfigured', environment: 'sandbox'|'live', baseUrl: string, clientId?: string, clientSecret?: string}}
 */
export function resolvePayPalConfig(env) {
  const baseUrl = (env.PAYPAL_BASE_URL ?? '').trim().replace(/\/+$/, '') || PAYPAL_SANDBOX_BASE_URL;
  let environment;
  if (baseUrl === PAYPAL_SANDBOX_BASE_URL) {
    environment = 'sandbox';
  } else if (baseUrl === PAYPAL_LIVE_BASE_URL) {
    if (env.PAYPAL_ALLOW_LIVE !== LIVE_OPT_IN_VALUE) {
      throw new PayPalConfigError(`Refusing to start: PAYPAL_BASE_URL is LIVE PayPal (real money). PayOnProof pays in the sandbox only; live would need PAYPAL_ALLOW_LIVE=${LIVE_OPT_IN_VALUE}.`);
    }
    environment = 'live';
  } else {
    throw new PayPalConfigError(`Refusing to start: PAYPAL_BASE_URL must be ${PAYPAL_SANDBOX_BASE_URL}.`);
  }
  if (['1', 'true', 'yes'].includes(String(env.PAYPAL_MOCK ?? '').trim().toLowerCase())) {
    if (environment !== 'sandbox') throw new PayPalConfigError('PAYPAL_MOCK cannot be combined with a live base URL.');
    return { mode: 'mock', environment: 'sandbox', baseUrl, clientId: 'mock-client-id', clientSecret: 'mock-client-secret' };
  }
  const clientId = (env.PAYPAL_CLIENT_ID ?? '').trim();
  const clientSecret = (env.PAYPAL_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return { mode: 'unconfigured', environment, baseUrl };
  return { mode: environment, environment, baseUrl, clientId, clientSecret };
}

/**
 * PayPal sender_batch_id for an approved proposal.
 * @param {string} previewHash 64 hex characters
 * @returns {string}
 */
export function senderBatchIdFromPreviewHash(previewHash) {
  if (!/^[0-9a-f]{64}$/.test(previewHash)) throw new TypeError('previewHash must be 64 lowercase hex characters');
  return `POP-${previewHash}`;
}

const ASCII_ONLY = /^[\x20-\x7e\n]*$/;

/**
 * Exact request body for POST /v1/payments/payouts (one EMAIL item).
 * @param {{senderBatchId: string, receiver: string, amountCents: number, currency: string, note: string, senderItemId: string, emailSubject: string, emailMessage: string}} input
 */
export function buildPayoutBody({ senderBatchId, receiver, amountCents, currency, note, senderItemId, emailSubject, emailMessage }) {
  if (!senderBatchId || senderBatchId.length > 256) throw new RangeError('sender_batch_id must be 1-256 characters');
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new RangeError('payout amount must be a positive number of cents');
  if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError('currency must be an ISO 4217 code');
  if (!receiver || receiver.length > 127) throw new RangeError('receiver must be 1-127 characters');
  if (!senderItemId || senderItemId.length > 63) throw new RangeError('sender_item_id must be 1-63 characters');
  if (!ASCII_ONLY.test(emailSubject) || emailSubject.length > 255) throw new RangeError('email_subject must be ASCII and at most 255 characters');
  if (emailMessage.length > 1000) throw new RangeError('email_message must be at most 1000 characters');
  if (!ASCII_ONLY.test(note) || note.length > 1000) throw new RangeError('note must be ASCII and at most 1000 characters');
  return {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: emailSubject,
      email_message: emailMessage,
    },
    items: [
      {
        recipient_type: 'EMAIL',
        amount: { value: centsToDecimalString(amountCents), currency },
        note,
        sender_item_id: senderItemId,
        receiver,
      },
    ],
  };
}

const NOT_SENT_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN',
]);

function classifyNetworkError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  const code = error?.cause?.code ?? error?.code;
  return NOT_SENT_CODES.has(code) ? 'not_sent' : 'unknown';
}

/**
 * True when PayPal rejected a payout because its sender_batch_id was used before.
 * @param {object|null} json PayPal error body
 */
export function isDuplicateBatchError(json) {
  if (!json || typeof json !== 'object') return false;
  const details = Array.isArray(json.details) ? json.details : [];
  const text = [json.name, json.message, ...details.flatMap((detail) => [detail.field, detail.issue, detail.description])]
    .filter((part) => typeof part === 'string')
    .join(' ');
  return /sender_batch_id/i.test(text) && /(already|exist|duplicate|used)/i.test(text);
}

/**
 * Find the existing payout_batch_id in the HATEOAS links of a duplicate-batch error.
 * @param {object|null} json
 * @returns {string|null}
 */
export function existingBatchIdFrom(json) {
  if (!json || typeof json !== 'object') return null;
  const links = [];
  const collect = (value) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object' && typeof value.href === 'string') links.push(value.href);
  };
  collect(json.links);
  for (const detail of Array.isArray(json.details) ? json.details : []) {
    collect(detail.link);
    collect(detail.links);
  }
  for (const href of links) {
    const match = /\/v1\/payments\/payouts\/([A-Za-z0-9]+)(?:[/?#]|$)/.exec(href);
    if (match) return match[1];
  }
  return null;
}

/**
 * Normalise a GET /v1/payments/payouts/{id} response.
 * @param {object} json
 */
export function normalizeBatch(json) {
  const header = json?.batch_header ?? {};
  return {
    batchId: header.payout_batch_id ?? null,
    batchStatus: header.batch_status ?? null,
    senderBatchId: header.sender_batch_header?.sender_batch_id ?? null,
    timeCreated: header.time_created ?? null,
    timeCompleted: header.time_completed ?? header.time_closed ?? null,
    amount: header.amount ?? null,
    fees: header.fees ?? null,
    items: (Array.isArray(json?.items) ? json.items : []).map((item) => ({
      payoutItemId: item.payout_item_id ?? null,
      transactionId: item.transaction_id ?? null,
      transactionStatus: item.transaction_status ?? null,
      amount: item.payout_item?.amount ?? null,
      receiver: item.payout_item?.receiver ?? null,
      senderItemId: item.payout_item?.sender_item_id ?? null,
      fee: item.payout_item_fee ?? null,
      error: item.errors ? { name: item.errors.name ?? null, message: item.errors.message ?? null } : null,
      timeProcessed: item.time_processed ?? null,
    })),
  };
}

/**
 * True when polling can stop: the batch or its item reached a final state.
 * @param {ReturnType<typeof normalizeBatch>} batch
 */
export function isSettled(batch) {
  const item = batch.items[0];
  return TERMINAL_BATCH_STATUSES.includes(batch.batchStatus) || (item && TERMINAL_ITEM_STATUSES.includes(item.transactionStatus));
}

/**
 * @param {{baseUrl: string, clientId: string, clientSecret: string, environment?: string, fetch?: typeof fetch, now?: () => number, sleep?: (ms: number) => Promise<void>, timeoutMs?: number, log?: (event: object) => void}} options
 */
export function createPayPalClient({
  baseUrl, clientId, clientSecret, environment = 'sandbox',
  fetch: fetchImpl = globalThis.fetch, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 20_000, log = () => {},
}) {
  if (!clientId || !clientSecret) throw new PayPalConfigError('PayPal client id and secret are required.');
  let cached = null;

  async function rawCall(method, path, { headers, body, stage }) {
    const started = now();
    let response;
    let text;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      text = await response.text();
    } catch (error) {
      const kind = classifyNetworkError(error);
      log({ event: 'paypal.network_error', method, path: path.split('?')[0], kind, ms: now() - started });
      throw new PayPalNetworkError(kind, kind === 'timeout'
        ? `PayPal did not answer within ${Math.round(timeoutMs / 1000)} s.`
        : kind === 'not_sent' ? 'PayPal could not be reached; nothing was sent.' : 'The connection to PayPal broke before an answer arrived.', stage);
    }
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const debugId = json?.debug_id ?? response.headers.get('paypal-debug-id') ?? null;
    log({ event: 'paypal.call', method, path: path.split('?')[0], status: response.status, debugId, ms: now() - started });
    return { status: response.status, ok: response.ok, json, debugId };
  }

  /**
   * OAuth2 client-credentials token, cached until 60 s before it expires.
   * @param {{force?: boolean}} [options]
   * @returns {Promise<string>}
   */
  async function getAccessToken({ force = false } = {}) {
    if (!force && cached && cached.expiresAt - 60_000 > now()) return cached.token;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const result = await rawCall('POST', '/v1/oauth2/token', {
      stage: 'token',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: 'grant_type=client_credentials',
    });
    if (!result.ok || typeof result.json?.access_token !== 'string') {
      cached = null;
      throw new PayPalApiError({
        code: 'AUTH_FAILED', status: result.status, name: result.json?.error ?? result.json?.name,
        message: `PayPal rejected the API credentials (HTTP ${result.status}${result.json?.error ? `, ${result.json.error}` : ''}). Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.`,
        debugId: result.debugId, stage: 'token',
      });
    }
    const lifetime = Number(result.json.expires_in) > 0 ? Number(result.json.expires_in) : 300;
    cached = { token: result.json.access_token, expiresAt: now() + lifetime * 1000 };
    return cached.token;
  }

  async function authorizedCall(method, path, { body, headers = {} } = {}) {
    const call = async (token) => rawCall(method, path, {
      stage: 'api',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let result = await call(await getAccessToken());
    if (result.status === 401) {
      cached = null;
      result = await call(await getAccessToken({ force: true }));
    }
    return result;
  }

  /**
   * Create a payout. Never throws for PayPal-side outcomes; returns one of:
   *  CREATED | DUPLICATE (batch already exists for this sender_batch_id) | REJECTED | NOT_SENT | UNKNOWN_AFTER_SEND
   * @param {ReturnType<typeof buildPayoutBody>} body
   */
  async function createPayout(body) {
    const senderBatchId = body.sender_batch_header.sender_batch_id;
    let result;
    try {
      result = await authorizedCall('POST', '/v1/payments/payouts', { body, headers: { 'paypal-request-id': senderBatchId } });
    } catch (error) {
      if (error instanceof PayPalApiError) {
        return { outcome: 'NOT_SENT', senderBatchId, error: { code: error.code, message: error.message, debugId: error.debugId } };
      }
      if (error instanceof PayPalNetworkError) {
        if (error.stage === 'token' || error.kind === 'not_sent') {
          return { outcome: 'NOT_SENT', senderBatchId, error: { code: 'NETWORK', message: error.message } };
        }
        return { outcome: 'UNKNOWN_AFTER_SEND', senderBatchId, error: { code: error.kind === 'timeout' ? 'TIMEOUT' : 'CONNECTION_LOST', message: error.message } };
      }
      throw error;
    }
    if (result.status === 200 || result.status === 201) {
      const header = result.json?.batch_header;
      if (!header?.payout_batch_id) {
        return { outcome: 'UNKNOWN_AFTER_SEND', senderBatchId, error: { code: 'NO_BATCH_ID', message: 'PayPal accepted the request but returned no batch id.' }, debugId: result.debugId };
      }
      return { outcome: 'CREATED', senderBatchId, batchId: header.payout_batch_id, batchStatus: header.batch_status ?? null, debugId: result.debugId };
    }
    if (isDuplicateBatchError(result.json)) {
      return { outcome: 'DUPLICATE', senderBatchId, batchId: existingBatchIdFrom(result.json), debugId: result.debugId };
    }
    if (result.status >= 500) {
      return { outcome: 'UNKNOWN_AFTER_SEND', senderBatchId, error: { code: `HTTP_${result.status}`, message: `PayPal answered HTTP ${result.status}; the payout state is unknown.` }, debugId: result.debugId };
    }
    const details = (Array.isArray(result.json?.details) ? result.json.details : [])
      .slice(0, 3)
      .map((detail) => [detail.field, detail.issue ?? detail.description].filter(Boolean).join(': '))
      .join('; ');
    return {
      outcome: 'REJECTED',
      senderBatchId,
      error: {
        code: result.json?.name ?? `HTTP_${result.status}`,
        message: `${result.json?.message ?? `PayPal answered HTTP ${result.status}`}${details ? ` (${details})` : ''}`,
        httpStatus: result.status,
      },
      debugId: result.debugId,
    };
  }

  /**
   * Read a payout batch.
   * @param {string} batchId
   */
  async function getPayoutBatch(batchId) {
    if (!/^[A-Za-z0-9]{5,40}$/.test(String(batchId))) throw new TypeError('invalid payout batch id');
    const result = await authorizedCall('GET', `/v1/payments/payouts/${batchId}`);
    if (!result.ok) {
      throw new PayPalApiError({
        code: 'READBACK_FAILED', status: result.status, name: result.json?.name,
        message: `PayPal readback failed (HTTP ${result.status}${result.json?.name ? `, ${result.json.name}` : ''}).`,
        debugId: result.debugId, stage: 'api',
      });
    }
    return { ...normalizeBatch(result.json), debugId: result.debugId };
  }

  /**
   * Poll a batch until it settles or the attempts run out.
   * @param {string} batchId
   * @param {{delaysMs?: number[]}} [options] wait before each attempt
   */
  async function readBack(batchId, { delaysMs = [0, 1000, 2000, 4000] } = {}) {
    let batch = null;
    let attempts = 0;
    for (const delay of delaysMs) {
      if (delay > 0) await sleep(delay);
      batch = await getPayoutBatch(batchId);
      attempts += 1;
      if (isSettled(batch)) break;
    }
    return { batch, attempts, settled: batch ? Boolean(isSettled(batch)) : false, readAt: new Date(now()).toISOString() };
  }

  return { environment, baseUrl, getAccessToken, createPayout, getPayoutBatch, readBack };
}
