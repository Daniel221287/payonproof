#!/usr/bin/env node
/**
 * PayOnProof HTTP server: plain node:http, no framework.
 *
 * Serves the UI from public/ with a strict Content-Security-Policy (no inline
 * scripts; styles only from 'self' or with a per-request nonce for the grid),
 * the JSON API under /api, the MCP endpoint at /mcp and /health.
 * Host header allow-list, same-origin checks for state-changing requests
 * (they stop other websites; the approver passcode is the approval boundary),
 * request size limits and a small per-IP rate limit protect it.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { handleMcpRequest, MCP_PROTOCOL_VERSION } from './mcp.mjs';
import { createAiProvider } from './src/ai.mjs';
import { ApprovalError, createApprovalRegistry } from './src/approval.mjs';
import { resolveConfig } from './src/config.mjs';
import { loadDotEnv } from './src/env.mjs';
import { createPayPalClient } from './src/paypal.mjs';
import { createMockPayPal } from './src/paypal-mock.mjs';
import { loadSamples } from './src/samples.mjs';
import { createService, ServiceError } from './src/service.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const MAX_BODY_BYTES = 768 * 1024;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt', '.webmanifest']);

class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/**
 * Content-Security-Policy for a response. Scripts only ever load from this origin (no inline
 * scripts). <style> elements need the per-request nonce (the grid injects its theme with it);
 * inline style attributes are allowed because the grid positions rows with them.
 * @param {string|null} nonce
 */
export function contentSecurityPolicy(nonce) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    nonce ? `style-src 'self' 'nonce-${nonce}'` : "style-src 'self'",
    nonce ? `style-src-elem 'self' 'nonce-${nonce}'` : "style-src-elem 'self'",
    // The data grid positions rows and cells with style attributes; attributes cannot run script.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * Fixed-window rate limiter keyed by client and bucket.
 * @param {{now?: () => number}} [options]
 */
export function createRateLimiter({ now = Date.now } = {}) {
  const windows = new Map();
  return {
    /**
     * @param {string} key
     * @param {{max: number, windowMs: number}} rule
     */
    take(key, { max, windowMs }) {
      const t = now();
      let entry = windows.get(key);
      if (!entry || entry.resetAt <= t) {
        entry = { count: 0, resetAt: t + windowMs };
        windows.set(key, entry);
      }
      entry.count += 1;
      if (windows.size > 20_000) {
        for (const [k, value] of windows) if (value.resetAt <= t) windows.delete(k);
      }
      return { ok: entry.count <= max, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - t) / 1000)) };
    },
  };
}

function hostnameOf(hostHeader) {
  if (!hostHeader || typeof hostHeader !== 'string') return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Constant-time comparison; hashing first means not even the length of the secret leaks. */
function sameSecret(given, expected) {
  const digest = (value) => createHash('sha256').update(String(value ?? '')).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

async function readJsonBody(req) {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', `Requests are limited to ${MAX_BODY_BYTES / 1024} KB.`, { connection: 'close' });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', `Requests are limited to ${MAX_BODY_BYTES / 1024} KB.`, { connection: 'close' });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'BAD_JSON', 'The request body is not valid JSON.');
  }
}

/**
 * Build the application (not listening yet).
 * @param {{env?: Record<string, string|undefined>, argv?: string[], fetchImpl?: typeof fetch, quiet?: boolean, rateLimits?: object, readbackDelaysMs?: number[], now?: () => number}} [options]
 */
export async function createApp({ env = process.env, argv = [], fetchImpl = globalThis.fetch, quiet = false, rateLimits = {}, readbackDelaysMs, now = Date.now } = {}) {
  const config = resolveConfig(env, argv);
  const log = quiet ? () => {} : (event) => console.log(JSON.stringify({ t: new Date().toISOString(), ...event }));

  const aiProvider = createAiProvider(config.ai, { fetch: fetchImpl });
  let mockPayPal = null;
  let payPalClient = null;
  if (config.paypal.mode === 'mock') {
    mockPayPal = createMockPayPal({ now });
    payPalClient = createPayPalClient({ ...config.paypal, fetch: mockPayPal.fetch, now, log });
  } else if (config.paypal.mode !== 'unconfigured') {
    payPalClient = createPayPalClient({ ...config.paypal, fetch: fetchImpl, now, log });
  }

  const approvals = createApprovalRegistry({ now });
  const samples = loadSamples(path.join(ROOT, 'samples'));
  const service = createService({
    config,
    samples,
    aiProvider,
    payPalClient,
    approvals,
    now,
    log,
    readbackDelaysMs: readbackDelaysMs ?? (config.paypal.mode === 'mock' ? [0, 300, 600] : [0, 1000, 2000, 4000]),
  });

  const limits = {
    api: { max: 300, windowMs: 60_000 },
    analyze: config.ai.provider === 'offline' ? { max: 60, windowMs: 600_000 } : { max: 30, windowMs: 600_000 },
    money: { max: 60, windowMs: 600_000 },
    mcp: { max: 120, windowMs: 60_000 },
    ...rateLimits,
  };
  const limiter = createRateLimiter({ now });
  const indexTemplate = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const staticCache = new Map();

  /**
   * The client address used for per-IP limits. Behind a trusted proxy it is the right-most
   * X-Forwarded-For entry: the one our own proxy appended. Every entry to its left was sent by the
   * client and can be forged, so it is never used.
   * @param {import('node:http').IncomingMessage} req
   */
  function clientIp(req) {
    if (config.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((part) => part.trim()).filter(Boolean);
      if (forwarded.length) return forwarded[forwarded.length - 1];
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function baseUrlFor(req) {
    if (config.publicBaseUrl) return config.publicBaseUrl;
    const proto = config.trustProxy && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    return `${proto}://${req.headers.host}`;
  }

  function securityHeaders(req, nonce = null) {
    const headers = {
      'content-security-policy': contentSecurityPolicy(nonce),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    };
    if (config.trustProxy && req.headers['x-forwarded-proto'] === 'https') headers['strict-transport-security'] = 'max-age=31536000';
    return headers;
  }

  function sendJson(req, res, status, payload, extra = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      ...securityHeaders(req),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
      ...extra,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function rateLimit(req, bucket) {
    const verdict = limiter.take(`${bucket}:${clientIp(req)}`, limits[bucket]);
    if (!verdict.ok) {
      throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please wait a moment.', { 'retry-after': String(verdict.retryAfterSeconds) });
    }
  }

  /**
   * Refuse cross-site requests. This stops other websites from acting through a visitor's browser.
   * It is not authentication: any program can send whatever Origin header it likes. The approval
   * boundary is the approver passcode (see config.mjs and service.approve).
   */
  function requireSameOrigin(req, { originRequired }) {
    const site = req.headers['sec-fetch-site'];
    if (site && !['same-origin', 'none'].includes(site)) throw new HttpError(403, 'CROSS_SITE', 'Cross-site requests are not allowed.');
    const origin = req.headers.origin;
    if (!origin) {
      if (originRequired) throw new HttpError(403, 'ORIGIN_REQUIRED', 'Send approvals from the PayOnProof page: this endpoint needs a same-origin Origin header.');
      return;
    }
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new HttpError(403, 'BAD_ORIGIN', 'Invalid Origin header.');
    }
    if (parsed.host !== req.headers.host) throw new HttpError(403, 'BAD_ORIGIN', 'Requests from other origins are not allowed.');
  }

  function requireJson(req) {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new HttpError(415, 'JSON_REQUIRED', 'Send the request body as application/json.');
  }

  async function serveStatic(req, res, pathname) {
    if (pathname === '/' || pathname === '/index.html') {
      const nonce = randomBytes(16).toString('base64');
      const html = indexTemplate.replaceAll('{{CSP_NONCE}}', nonce);
      res.writeHead(200, {
        ...securityHeaders(req, nonce),
        'content-type': CONTENT_TYPES['.html'],
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(html),
      });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'BAD_PATH', 'Malformed path.');
    }
    if (decoded.includes('\0') || decoded.split('/').some((segment) => segment === '..' || segment.startsWith('.'))) {
      throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    }
    const filePath = path.join(PUBLIC_DIR, path.normalize(decoded));
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    const ext = path.extname(filePath).toLowerCase();
    const type = CONTENT_TYPES[ext];
    if (!type) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    let entry = staticCache.get(filePath);
    if (!entry) {
      let raw;
      try {
        raw = await readFile(filePath);
      } catch {
        throw new HttpError(404, 'NOT_FOUND', 'Not found.');
      }
      entry = { raw, etag: `"${createHash('sha256').update(raw).digest('base64url').slice(0, 27)}"`, gzip: null, br: null };
      if (COMPRESSIBLE.has(ext) && raw.length > 1024) {
        entry.gzip = gzipSync(raw, { level: 9 });
        entry.br = brotliCompressSync(raw);
      }
      staticCache.set(filePath, entry);
    }
    const longLived = decoded.startsWith('/vendor/') || decoded.startsWith('/fonts/');
    const headers = {
      ...securityHeaders(req),
      'content-type': type,
      etag: entry.etag,
      'cache-control': longLived ? 'public, max-age=86400' : 'no-cache',
      vary: 'accept-encoding',
    };
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const accepts = String(req.headers['accept-encoding'] ?? '');
    let body = entry.raw;
    if (entry.br && /\bbr\b/.test(accepts)) {
      body = entry.br;
      headers['content-encoding'] = 'br';
    } else if (entry.gzip && /\bgzip\b/.test(accepts)) {
      body = entry.gzip;
      headers['content-encoding'] = 'gzip';
    }
    headers['content-length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function handleApi(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    rateLimit(req, 'api');
    if (method === 'GET' && pathname === '/api/config') {
      return sendJson(req, res, 200, { version: VERSION, ...service.publicConfig() });
    }
    if (method === 'GET' && pathname === '/api/cases') {
      return sendJson(req, res, 200, { note: 'All companies, people and addresses in the samples are fictional.', samples: service.listSamples() });
    }
    let match = /^\/api\/cases\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
    if (method === 'GET' && match) return sendJson(req, res, 200, { case: service.getCase(match[1]) });
    match = /^\/api\/payout\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
    if (method === 'GET' && match) return sendJson(req, res, 200, { case: await service.refreshPayout(match[1]) });

    if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', { allow: 'GET, POST' });
    requireSameOrigin(req, { originRequired: pathname === '/api/approve' });
    requireJson(req);
    const body = await readJsonBody(req);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'BAD_BODY', 'Send a JSON object.');

    switch (pathname) {
      case '/api/analyze':
        rateLimit(req, 'analyze');
        return sendJson(req, res, 201, { case: await service.analyze({ sampleId: body.sampleId, documents: body.documents }) });
      case '/api/message':
        rateLimit(req, 'money');
        return sendJson(req, res, 200, { case: service.updateMessage(body.caseId, body.text) });
      case '/api/approve':
        rateLimit(req, 'money');
        return sendJson(req, res, 200, service.approve(body.caseId, { previewHash: body.previewHash, confirm: body.confirm, passcode: body.passcode }));
      case '/api/pay':
        rateLimit(req, 'money');
        return sendJson(req, res, 200, { case: await service.pay(body.caseId, { approvalToken: body.approvalToken, previewHash: body.previewHash }) });
      default: {
        match = /^\/api\/payout\/([A-Za-z0-9_-]{1,64})\/reconcile$/.exec(pathname);
        if (match) {
          rateLimit(req, 'money');
          return sendJson(req, res, 200, { case: await service.reconcile(match[1]) });
        }
        throw new HttpError(404, 'NOT_FOUND', 'Unknown API route.');
      }
    }
  }

  async function handleMcp(req, res) {
    rateLimit(req, 'mcp');
    if (config.mcpBearerToken) {
      const auth = String(req.headers.authorization ?? '');
      if (!auth.startsWith('Bearer ') || !sameSecret(auth.slice(7), config.mcpBearerToken)) {
        throw new HttpError(401, 'MCP_AUTH_REQUIRED', 'This MCP endpoint needs Authorization: Bearer <MCP_BEARER_TOKEN>.', { 'www-authenticate': 'Bearer' });
      }
    }
    let body;
    if (req.method === 'POST') {
      requireSameOrigin(req, { originRequired: false });
      body = await readJsonBody(req);
    }
    await handleMcpRequest(req, res, body, {
      service,
      approvalUrlFor: (caseId) => `${baseUrlFor(req)}/?case=${encodeURIComponent(caseId)}#approve`,
    });
  }

  async function handle(req, res) {
    const started = performance.now();
    const url = new URL(req.url ?? '/', 'http://placeholder.invalid');
    res.on('finish', () => {
      if (config.logRequests && !quiet) {
        console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${res.statusCode} ${Math.round(performance.now() - started)}ms`);
      }
    });
    try {
      const host = hostnameOf(req.headers.host);
      if (!host || !config.allowedHosts.has(host)) {
        throw new HttpError(421, 'HOST_NOT_ALLOWED', 'This host name is not allowed. Add it to ALLOWED_HOSTS.');
      }
      if (url.pathname === '/health') {
        return sendJson(req, res, 200, {
          ok: true, version: VERSION, ai: config.ai.provider, paypal: config.paypal.mode,
          mcp: { endpoint: '/mcp', protocolVersion: MCP_PROTOCOL_VERSION },
        });
      }
      if (url.pathname === '/mcp') return await handleMcp(req, res);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', { allow: 'GET, HEAD' });
      return await serveStatic(req, res, url.pathname);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return undefined;
      }
      if (error instanceof HttpError) return sendJson(req, res, error.status, { error: { code: error.code, message: error.message } }, error.headers);
      if (error instanceof ApprovalError) {
        return sendJson(req, res, 403, { error: { code: 'HUMAN_APPROVAL_REQUIRED', detail: error.code, message: error.message } });
      }
      if (error instanceof ServiceError) {
        const headers = error.extra?.retryAfterSeconds ? { 'retry-after': String(error.extra.retryAfterSeconds) } : {};
        return sendJson(req, res, error.status, { error: { code: error.code, message: error.message, ...error.extra } }, headers);
      }
      log({ event: 'error', path: url.pathname, message: error?.message, stack: error?.stack?.split('\n').slice(0, 4).join(' | ') });
      return sendJson(req, res, 500, { error: { code: 'INTERNAL', message: 'Something went wrong on the server.' } });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;

  return {
    server,
    service,
    config,
    mockPayPal,
    /**
     * @param {number} port
     * @param {string} host
     * @returns {Promise<{port: number, host: string}>}
     */
    listen(port = config.listen.port, host = config.listen.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          resolve({ port: address.port, host });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

async function main() {
  const dotenv = loadDotEnv(path.join(ROOT, '.env'));
  let app;
  try {
    app = await createApp({ env: process.env, argv: process.argv.slice(2) });
  } catch (error) {
    console.error(`PayOnProof did not start: ${error.message}`);
    process.exit(1);
  }
  const { host, port } = await app.listen();
  const shown = host === '0.0.0.0' ? `0.0.0.0:${port}` : `http://${host}:${port}`;
  const paypal = { mock: 'MOCK PayPal (in-process, no network)', sandbox: 'PayPal sandbox', live: 'PayPal LIVE', unconfigured: 'PayPal not configured' }[app.config.paypal.mode];
  console.log(`PayOnProof ${VERSION} listening on ${shown}`);
  console.log(`  extraction: ${app.service.publicConfig().ai.label}`);
  console.log(`  payments:   ${paypal}`);
  if (dotenv.found) console.log(`  .env:       ${dotenv.loaded.length} variable(s) loaded`);
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
