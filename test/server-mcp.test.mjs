import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server.mjs';

let app;
let base;

before(async () => {
  app = await createApp({ env: { PAYPAL_MOCK: '1', AI_PROVIDER: 'offline', LOG_REQUESTS: '0' }, quiet: true, readbackDelaysMs: [0, 0, 0] });
  const { port } = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
});
after(() => app.close());

const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

function raw(path, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function mcpClient() {
  const client = new Client({ name: 'payonproof-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return client;
}

test('GET /health answers with the configured modes', async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(health.paypal, 'mock');
  assert.equal(health.ai, 'offline');
  assert.equal(health.mcp.protocolVersion, '2025-11-25');
});

test('the page is served with a strict CSP whose nonce matches the page', async () => {
  const response = await fetch(base);
  const csp = response.headers.get('content-security-policy');
  const html = await response.text();
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'(;|$)/, 'no inline or eval scripts');
  assert.match(csp, /frame-ancestors 'none'/);
  const nonce = /<meta name="csp-nonce" content="([^"]+)">/.exec(html)[1];
  assert.ok(csp.includes(`'nonce-${nonce}'`));
  assert.ok(!html.includes('{{CSP_NONCE}}'));
  assert.notEqual(nonce, /<meta name="csp-nonce" content="([^"]+)">/.exec(await (await fetch(base)).text())[1], 'fresh nonce per request');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('POST /api/analyze with a sample returns the verified case', async () => {
  const response = await post('/api/analyze', { sampleId: 'overbilled' });
  assert.equal(response.status, 201);
  const { case: caseView } = await response.json();
  assert.equal(caseView.verification.totals.payableCents, 503500);
  assert.equal(caseView.extraction.label, 'Offline sample parser — no AI used');
  assert.ok(response.headers.get('content-security-policy'));
  const samples = await (await fetch(`${base}/api/cases`)).json();
  assert.equal(samples.samples.length, 4);
});

test('full HTTP flow: approve from the page origin, pay with MOCK PayPal, read back', async () => {
  const { case: caseView } = await (await post('/api/analyze', { sampleId: 'honest' })).json();
  const approveResponse = await post('/api/approve', { caseId: caseView.id, previewHash: caseView.proposal.previewHash, confirm: true });
  assert.equal(approveResponse.status, 200);
  const { approval } = await approveResponse.json();
  const payResponse = await post('/api/pay', { caseId: caseView.id, approvalToken: approval.token });
  const paid = (await payResponse.json()).case;
  assert.equal(paid.payout.state, 'PAID_VERIFIED');
  assert.equal(paid.payout.receipt.amount.value, '2270.63');
  const again = await post('/api/pay', { caseId: caseView.id, approvalToken: approval.token });
  assert.equal(again.status, 409);
  const status = await (await fetch(`${base}/api/payout/${caseView.id}`)).json();
  assert.equal(status.case.payout.state, 'PAID_VERIFIED');
});

test('approvals only come from the page: no Origin, a foreign Origin or a cross-site fetch is refused', async () => {
  // "honest" was paid above, so the paid-invoice ledger would block it; use an invoice not paid in this app.
  const { case: caseView } = await (await post('/api/analyze', { sampleId: 'overbilled' })).json();
  const body = { caseId: caseView.id, previewHash: caseView.proposal.previewHash, confirm: true };
  const noOrigin = await fetch(`${base}/api/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(noOrigin.status, 403);
  assert.equal((await noOrigin.json()).error.code, 'ORIGIN_REQUIRED');
  assert.equal((await post('/api/approve', body, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/approve', body, { 'sec-fetch-site': 'cross-site' })).status, 403);
  const payWithoutApproval = await post('/api/pay', { caseId: caseView.id });
  assert.equal(payWithoutApproval.status, 403);
  assert.equal((await payWithoutApproval.json()).error.code, 'HUMAN_APPROVAL_REQUIRED');
});

test('Host allow-list, JSON-only bodies, size limit and path traversal are enforced', async () => {
  assert.equal((await raw('/health', { headers: { host: 'evil.example' } })).status, 421);
  assert.equal((await post('/api/analyze', 'sampleId=honest', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await post('/api/analyze', '{not json')).status, 400);
  const big = await post('/api/analyze', { documents: [{ type: 'invoice', text: 'x'.repeat(800 * 1024) }] });
  assert.equal(big.status, 413);
  for (const path of ['/.env', '/%2e%2e/package.json', '/../server.mjs', '/vendor/../../package.json', '/src/service.mjs']) {
    assert.equal((await raw(path)).status, 404, path);
  }
  assert.equal((await raw('/api/cases/does-not-exist')).status, 404);
  assert.equal((await raw('/api/analyze', { method: 'PUT' })).status, 405);
});

test('static assets are compressed and cacheable; UI files are served', async () => {
  const js = await raw('/app.js', { headers: { 'accept-encoding': 'br, gzip' } });
  assert.equal(js.status, 200);
  assert.equal(js.headers['content-encoding'], 'br');
  assert.match(js.headers['content-type'], /text\/javascript/);
  const grid = await raw('/vendor/ag-grid-community.min.noStyle.js', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(grid.headers['content-encoding'], 'gzip');
  assert.equal(grid.headers['cache-control'], 'public, max-age=86400');
  const notModified = await raw('/styles.css', { headers: { 'if-none-match': (await raw('/styles.css')).headers.etag } });
  assert.equal(notModified.status, 304);
});

test('per-IP rate limit answers 429 with Retry-After', async () => {
  const limited = await createApp({ env: { PAYPAL_MOCK: '1', LOG_REQUESTS: '0' }, quiet: true, rateLimits: { api: { max: 3, windowMs: 60_000 } } });
  const { port } = await limited.listen(0, '127.0.0.1');
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await fetch(`http://127.0.0.1:${port}/api/config`)).status);
  await limited.close();
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
});

test('behind a trusted proxy the right-most X-Forwarded-For entry counts, so a forged left part changes nothing', async () => {
  const proxied = await createApp({ env: { PAYPAL_MOCK: '1', TRUST_PROXY: '1', LOG_REQUESTS: '0' }, quiet: true, rateLimits: { api: { max: 3, windowMs: 60_000 } } });
  const { port } = await proxied.listen(0, '127.0.0.1');
  const get = (forwardedFor) => fetch(`http://127.0.0.1:${port}/api/config`, { headers: { 'x-forwarded-for': forwardedFor } });
  const spoofed = [];
  // The client rotates what it sends; the proxy appends the real address (203.0.113.9) at the end.
  for (let i = 0; i < 5; i += 1) spoofed.push((await get(`198.51.100.${i}, 203.0.113.9`)).status);
  const otherClient = (await get('198.51.100.1, 203.0.113.10')).status;
  await proxied.close();
  assert.deepEqual(spoofed, [200, 200, 200, 429, 429]);
  assert.equal(otherClient, 200, 'a different proxy-appended address has its own bucket');
});

test('MCP: protocol 2025-11-25 is negotiated over Streamable HTTP', async () => {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } }),
  });
  assert.equal(response.status, 200);
  const message = await response.json();
  assert.equal(message.result.protocolVersion, '2025-11-25');
  assert.equal(message.result.serverInfo.name, 'payonproof');
  assert.equal((await fetch(`${base}/mcp`)).status, 405, 'stateless endpoint: POST only');
});

test('MCP: four tools, none of them can approve', async () => {
  const client = await mcpClient();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['payonproof_pay_approved', 'payonproof_payout_status', 'payonproof_propose_payment', 'payonproof_verify_case']);
  assert.ok(!tools.some((tool) => /approv/.test(tool.name) && tool.name !== 'payonproof_pay_approved'));
  assert.equal(tools.find((tool) => tool.name === 'payonproof_pay_approved').annotations.destructiveHint, true);
  await client.close();
});

test('MCP: pay without a human approval returns HUMAN_APPROVAL_REQUIRED', async () => {
  const client = await mcpClient();
  const verified = await client.callTool({ name: 'payonproof_verify_case', arguments: { sampleId: 'overbilled' } });
  assert.equal(verified.isError, undefined);
  const { caseId, totals, lines } = verified.structuredContent;
  assert.equal(totals.payableCents, 503500);
  assert.equal(lines.find((line) => line.id === '4').verdict, 'DUPLICATE');
  const proposal = await client.callTool({ name: 'payonproof_propose_payment', arguments: { caseId } });
  assert.equal(proposal.structuredContent.status, 'AWAITING_HUMAN_APPROVAL');
  assert.match(proposal.structuredContent.approvalUrl, new RegExp(`^${base}/\\?case=${caseId}#approve$`));
  const noToken = await client.callTool({ name: 'payonproof_pay_approved', arguments: { caseId, previewHash: proposal.structuredContent.previewHash } });
  assert.equal(noToken.isError, true);
  assert.equal(noToken.structuredContent.error.code, 'HUMAN_APPROVAL_REQUIRED');
  const forged = await client.callTool({ name: 'payonproof_pay_approved', arguments: { caseId, previewHash: proposal.structuredContent.previewHash, approvalToken: 'apv_forged' } });
  assert.equal(forged.structuredContent.error.code, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(app.mockPayPal.batches.size, 1, 'only the earlier HTTP-flow payout exists');
  await client.close();
});

test('MCP: after a human approves in the page, the agent can pay and read the receipt', async () => {
  const client = await mcpClient();
  const { caseId } = (await client.callTool({ name: 'payonproof_verify_case', arguments: { sampleId: 'rate-drift' } })).structuredContent;
  const { previewHash } = (await client.callTool({ name: 'payonproof_propose_payment', arguments: { caseId } })).structuredContent;
  const { approval } = await (await post('/api/approve', { caseId, previewHash, confirm: true })).json();
  const paid = await client.callTool({ name: 'payonproof_pay_approved', arguments: { caseId, previewHash, approvalToken: approval.token } });
  assert.equal(paid.structuredContent.payout.state, 'PAID_VERIFIED');
  assert.equal(paid.structuredContent.payout.receipt.amount.value, '1741.50');
  const reused = await client.callTool({ name: 'payonproof_pay_approved', arguments: { caseId, previewHash, approvalToken: approval.token } });
  assert.equal(reused.isError, true);
  const status = await client.callTool({ name: 'payonproof_payout_status', arguments: { caseId } });
  assert.equal(status.structuredContent.payout.receipt.verdict, 'PAID_VERIFIED');
  await client.close();
});

test('MCP: an optional bearer token protects the endpoint', async () => {
  const guarded = await createApp({ env: { PAYPAL_MOCK: '1', MCP_BEARER_TOKEN: 'agent-secret', LOG_REQUESTS: '0' }, quiet: true });
  const { port } = await guarded.listen(0, '127.0.0.1');
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } };
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const denied = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers, body: JSON.stringify(init) });
  const allowed = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { ...headers, authorization: 'Bearer agent-secret' }, body: JSON.stringify(init) });
  await guarded.close();
  assert.equal(denied.status, 401);
  assert.equal(allowed.status, 200);
});

test('MCP: an unreadable document gives "cannot verify" and nothing to propose', async () => {
  const client = await mcpClient();
  const { samples } = await (await fetch(`${base}/api/cases`)).json();
  const documents = samples.find((sample) => sample.id === 'honest').documents.map((doc) => ({
    type: doc.type, name: doc.name, text: doc.type === 'timesheet' ? doc.text.replace('| 8.00  | signed K. Vogelsang', '| 8.00  | OK J.A.') : doc.text,
  }));
  const verified = await client.callTool({ name: 'payonproof_verify_case', arguments: { documents } });
  const { caseId, totals, lines, unreadable, nextStep } = verified.structuredContent;
  assert.equal(totals, null);
  assert.deepEqual(lines, []);
  assert.equal(unreadable[0].name, 'Timesheet TS-BM-38');
  assert.match(nextStep, /^Cannot verify/);
  const proposal = await client.callTool({ name: 'payonproof_propose_payment', arguments: { caseId } });
  assert.equal(proposal.structuredContent.error.code, 'NOT_PAYABLE');
  await client.close();
});

test('MCP: an agent-written message is fact-checked, labelled as agent-written, and the tool is not idempotent', async () => {
  const client = await mcpClient();
  const { tools } = await client.listTools();
  assert.equal(tools.find((tool) => tool.name === 'payonproof_propose_payment').annotations.idempotentHint, false);
  const { caseId } = (await client.callTool({ name: 'payonproof_verify_case', arguments: { sampleId: 'overbilled' } })).structuredContent;
  const before = (await client.callTool({ name: 'payonproof_propose_payment', arguments: { caseId } })).structuredContent;
  const lie = await client.callTool({ name: 'payonproof_propose_payment', arguments: { caseId, messageText: 'Dear Northgate, all 8 lines are confirmed and we are paying your invoice in full. Kind regards.' } });
  assert.equal(lie.isError, true);
  assert.equal(lie.structuredContent.error.code, 'MESSAGE_FACT_CHECK_FAILED');
  assert.ok(lie.structuredContent.error.missing.includes('invoiced total €6,338.00'));
  const after = (await client.callTool({ name: 'payonproof_propose_payment', arguments: { caseId } })).structuredContent;
  assert.equal(after.previewHash, before.previewHash, 'nothing was stored');
  const good = await client.callTool({ name: 'payonproof_propose_payment', arguments: { caseId, messageText: before.message.replace('Kind regards,', 'Best regards,') } });
  assert.equal(good.isError, undefined);
  assert.notEqual(good.structuredContent.previewHash, before.previewHash);
  const { case: shown } = await (await fetch(`${base}/api/cases/${caseId}`)).json();
  assert.equal(shown.message.label, 'Written by an AI agent over MCP, fact-checked', 'the person sees who wrote it');
  await client.close();
});
