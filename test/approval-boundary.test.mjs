import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server.mjs';
import { createAiProvider } from '../src/ai.mjs';
import { createApprovalRegistry } from '../src/approval.mjs';
import { ConfigError, MIN_PASSCODE_LENGTH, resolveConfig } from '../src/config.mjs';
import { createPayPalClient } from '../src/paypal.mjs';
import { createMockPayPal } from '../src/paypal-mock.mjs';
import { loadSamples } from '../src/samples.mjs';
import { createService, PASSCODE_LOCKOUT } from '../src/service.mjs';

const samples = loadSamples(fileURLToPath(new URL('../samples', import.meta.url)));
const PASSCODE = 'correct-horse-7';

test('a server reachable beyond loopback refuses to start without an approver passcode of 8+ characters', () => {
  assert.equal(MIN_PASSCODE_LENGTH, 8);
  const exposed = [
    { PORT: '10000' },
    { RENDER: 'true' },
    { ALLOWED_HOSTS: 'pay.example.com' },
    { RENDER_EXTERNAL_HOSTNAME: 'payonproof.onrender.com' },
    { PUBLIC_BASE_URL: 'https://pay.example.com' },
  ];
  for (const env of exposed) {
    assert.throws(() => resolveConfig(env), (e) => e instanceof ConfigError && /APPROVER_PASSCODE is missing/.test(e.message), JSON.stringify(env));
    assert.throws(() => resolveConfig({ ...env, APPROVER_PASSCODE: '1234567' }), /APPROVER_PASSCODE is too short/, JSON.stringify(env));
    const config = resolveConfig({ ...env, APPROVER_PASSCODE: '12345678' });
    assert.equal(config.exposed, true);
    assert.equal(config.approverPasscode, '12345678');
  }
  const local = resolveConfig({ ALLOWED_HOSTS: 'localhost,127.0.0.1', PUBLIC_BASE_URL: 'http://127.0.0.1:4410' });
  assert.equal(local.exposed, false, 'loopback-only stays usable without a passcode');
  assert.equal(local.approverPasscode, null);
  assert.equal(resolveConfig({}).listen.host, '127.0.0.1');
});

function serviceWithPasscode(clock) {
  const config = resolveConfig({ PAYPAL_MOCK: '1', APPROVER_PASSCODE: PASSCODE });
  const mock = createMockPayPal();
  return createService({
    config, samples, approvals: createApprovalRegistry({ now: clock.now }), now: clock.now, readbackDelaysMs: [0, 0, 0],
    payPalClient: createPayPalClient({ ...config.paypal, fetch: mock.fetch }), aiProvider: createAiProvider(config.ai),
  });
}

test('five wrong passcodes lock approvals for everyone for 15 minutes; the right passcode then waits too', async () => {
  let t = Date.parse('2026-10-21T20:00:00Z');
  const clock = { now: () => t };
  const service = serviceWithPasscode(clock);
  const caseView = await service.analyze({ sampleId: 'honest' });
  const attempt = (passcode) => () => service.approve(caseView.id, { previewHash: caseView.proposal.previewHash, confirm: true, passcode });

  assert.throws(attempt(undefined), (e) => e.status === 403 && e.code === 'PASSCODE_REQUIRED', 'a missing passcode is not a guess');
  for (let i = 1; i < PASSCODE_LOCKOUT.maxFailures; i += 1) {
    assert.throws(attempt(`wrong-${i}`), (e) => e.status === 403 && e.code === 'PASSCODE_INVALID' && /more wrong/.test(e.message));
  }
  assert.throws(attempt('wrong-5'), (e) => e.status === 429 && e.code === 'APPROVALS_LOCKED' && e.extra.retryAfterSeconds === 900);
  assert.throws(attempt(PASSCODE), (e) => e.code === 'APPROVALS_LOCKED', 'even the right passcode is refused while locked');

  t += PASSCODE_LOCKOUT.lockMs - 1000;
  assert.throws(attempt(PASSCODE), (e) => e.code === 'APPROVALS_LOCKED' && e.extra.retryAfterSeconds === 1);
  t += 1000;
  const { approval } = service.approve(caseView.id, { previewHash: caseView.proposal.previewHash, confirm: true, passcode: PASSCODE });
  assert.match(approval.token, /^apv_/);
});

test('wrong passcodes older than 15 minutes no longer count toward the lockout', async () => {
  let t = Date.parse('2026-10-21T20:00:00Z');
  const service = serviceWithPasscode({ now: () => t });
  const caseView = await service.analyze({ sampleId: 'honest' });
  const attempt = (passcode) => () => service.approve(caseView.id, { previewHash: caseView.proposal.previewHash, confirm: true, passcode });
  for (let i = 0; i < 4; i += 1) assert.throws(attempt('nope-nope'), (e) => e.code === 'PASSCODE_INVALID');
  t += PASSCODE_LOCKOUT.windowMs + 1;
  for (let i = 0; i < 4; i += 1) assert.throws(attempt('nope-nope'), (e) => e.code === 'PASSCODE_INVALID');
  assert.ok(service.approve(caseView.id, { previewHash: caseView.proposal.previewHash, confirm: true, passcode: PASSCODE }).approval);
});

test('HTTP: a forged Origin is not enough, and the lockout is global across client addresses', async () => {
  const app = await createApp({ env: { PAYPAL_MOCK: '1', TRUST_PROXY: '1', APPROVER_PASSCODE: PASSCODE, LOG_REQUESTS: '0' }, quiet: true, readbackDelaysMs: [0, 0, 0] });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const post = (path, body, ip) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-forwarded-for': ip }, body: JSON.stringify(body),
    });
    const { case: caseView } = await (await post('/api/analyze', { sampleId: 'honest' }, '198.51.100.1')).json();
    const body = { caseId: caseView.id, previewHash: caseView.proposal.previewHash, confirm: true };

    const forged = await post('/api/approve', body, '198.51.100.2');
    assert.equal(forged.status, 403, 'an Origin header without the passcode approves nothing');
    assert.equal((await forged.json()).error.code, 'PASSCODE_REQUIRED');

    const statuses = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await post('/api/approve', { ...body, passcode: `guess-${i}` }, `203.0.113.${i}`)).status);
    assert.deepEqual(statuses, [403, 403, 403, 403, 429, 429], 'rotating addresses does not reset the global counter');
    const locked = await post('/api/approve', { ...body, passcode: PASSCODE }, '192.0.2.50');
    assert.equal(locked.status, 429);
    assert.equal(locked.headers.get('retry-after'), '900');
    assert.equal((await locked.json()).error.code, 'APPROVALS_LOCKED');
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.approval.passcodeRequired, true);
  } finally {
    await app.close();
  }
});

test('MCP has no approval tool and no tool takes a passcode', async () => {
  const app = await createApp({ env: { PAYPAL_MOCK: '1', APPROVER_PASSCODE: PASSCODE, LOG_REQUESTS: '0' }, quiet: true });
  const { port } = await app.listen(0, '127.0.0.1');
  const client = new Client({ name: 'boundary-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.ok(!/^payonproof_approve/.test(tool.name), tool.name);
      assert.ok(!JSON.stringify(tool.inputSchema).toLowerCase().includes('passcode'), `${tool.name} takes no passcode`);
    }
    const instructions = client.getInstructions();
    assert.match(instructions, /no tool accepts the approver passcode/);
    assert.match(instructions, /Never ask for, guess or use the approver passcode/);
  } finally {
    await client.close();
    await app.close();
  }
});
