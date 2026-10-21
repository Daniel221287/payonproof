/**
 * MCP server for agentic commerce, served over Streamable HTTP at /mcp.
 *
 * Tools let an AI agent verify a case, propose a payment and pay it, but no
 * tool can approve: payonproof_pay_approved needs a single-use approval token,
 * bound to the exact previewHash, that the approval page issues. There is
 * deliberately no approval tool and no tool accepts the approver passcode,
 * which is what makes an approval a person's approval on a reachable server.
 */
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ApprovalError } from './src/approval.mjs';
import { formatMoney } from './src/money.mjs';
import { DOCUMENT_TYPES } from './src/schema.mjs';
import { ServiceError } from './src/service.mjs';

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

export const MCP_PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;
export const TOOL_NAMES = Object.freeze(['payonproof_verify_case', 'payonproof_propose_payment', 'payonproof_pay_approved', 'payonproof_payout_status']);

const INSTRUCTIONS = [
  'PayOnProof pays construction subcontractors only for invoice lines proven by signed timesheets and delivery notes.',
  'Flow: payonproof_verify_case -> payonproof_propose_payment -> a HUMAN opens approvalUrl and approves the exact payment -> payonproof_pay_approved with the approval token the human gives you -> payonproof_payout_status.',
  'No tool can approve a payment and no tool accepts the approver passcode. The person approves in the PayOnProof page, entering the approver passcode when the server has one, and gives you a single-use approval token.',
  'Never ask for, guess or use the approver passcode, and never call the approval endpoint yourself; ask the human to approve in the page.',
].join('\n');

function result(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

function failure(code, message, extra = {}) {
  const payload = { error: { code, message, ...extra } };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

function summarizeCase(caseView) {
  const verification = caseView.verification;
  const currency = verification?.currency ?? 'EUR';
  return {
    caseId: caseView.id,
    extraction: { provider: caseView.extraction.provider, model: caseView.extraction.model, isAI: caseView.extraction.isAI, label: caseView.extraction.label },
    invoiceNumber: caseView.invoice?.invoiceNumber ?? null,
    subcontractor: caseView.contract?.subcontractor ?? null,
    totals: verification ? {
      currency,
      claimedCents: verification.totals.claimedCents,
      payableCents: verification.totals.payableCents,
      disputedCents: verification.totals.disputedCents,
      claimed: formatMoney(verification.totals.claimedCents, currency),
      payable: formatMoney(verification.totals.payableCents, currency),
      disputed: formatMoney(verification.totals.disputedCents, currency),
    } : null,
    lines: (verification?.lines ?? []).map((line) => ({
      id: line.id,
      subject: line.subject,
      date: line.date,
      verdict: line.verdict,
      claimedCents: line.claimedCents,
      payableCents: line.payableCents,
      reason: line.reason,
      evidence: line.evidenceIds,
    })),
    warnings: (verification?.caseFindings ?? []).filter((finding) => finding.severity === 'warning').map((finding) => finding.reason),
    blockers: caseView.blockers.map((blocker) => blocker.reason),
    unreadable: caseView.unreadable ?? [],
  };
}

function errorResult(error) {
  if (error instanceof ApprovalError) {
    return failure('HUMAN_APPROVAL_REQUIRED', `${error.message} A human must approve this exact payment in the PayOnProof page.`, { detail: error.code });
  }
  if (error instanceof ServiceError) return failure(error.code, error.message);
  throw error;
}

/**
 * Build an MCP server bound to the case service.
 * @param {{service: ReturnType<import('./src/service.mjs').createService>, approvalUrlFor: (caseId: string) => string}} deps
 */
export function createMcpServer({ service, approvalUrlFor }) {
  const server = new McpServer({ name: 'payonproof', version: VERSION }, { instructions: INSTRUCTIONS });
  const sampleIds = service.sampleIds();

  server.registerTool('payonproof_verify_case', {
    title: 'Verify a subcontractor invoice against evidence',
    description: 'Reads the contract, invoice, timesheets and delivery notes (AI extraction or the offline sample parser), then proves every invoice line with a deterministic engine. Returns verdicts, payable amounts and a caseId. Give either sampleId or documents.',
    inputSchema: {
      sampleId: z.enum(sampleIds).optional().describe('A bundled fictional sample case.'),
      documents: z.array(z.object({
        type: z.enum(DOCUMENT_TYPES).describe('contract | invoice | timesheet | delivery_notes'),
        name: z.string().max(120).optional(),
        text: z.string().min(1).max(60000),
      })).max(12).optional().describe('Your own documents as plain text.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ sampleId, documents }) => {
    if ((sampleId === undefined) === (documents === undefined)) return failure('BAD_REQUEST', 'Give exactly one of sampleId or documents.');
    try {
      const caseView = await service.analyze({ sampleId, documents });
      const nextStep = caseView.unreadable?.length
        ? 'Cannot verify: at least one document could not be read (see unreadable). Nothing was checked and nothing can be paid; send readable documents again.'
        : 'Call payonproof_propose_payment with this caseId.';
      return result({ ...summarizeCase(caseView), nextStep });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('payonproof_propose_payment', {
    title: 'Propose the payment for human approval',
    description: 'Returns the exact payment preview (payee, currency, amount, paid lines, message hash) and its previewHash. Status is AWAITING_HUMAN_APPROVAL: a human must open approvalUrl and approve. Optionally replaces the explanation message first (this changes the previewHash).',
    inputSchema: {
      caseId: z.string().min(1).max(64),
      messageText: z.string().min(1).max(4000).optional().describe('Replacement text of the message to the subcontractor.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ caseId, messageText }) => {
    try {
      const caseView = messageText === undefined ? service.getCase(caseId) : service.updateMessage(caseId, messageText);
      if (!caseView.proposal) return failure('NOT_PAYABLE', 'This case has no payment proposal.', { blockers: caseView.blockers.map((b) => b.reason) });
      const { proposal } = caseView;
      return result({
        caseId,
        status: proposal.status,
        previewHash: proposal.previewHash,
        preview: proposal.core,
        amount: formatMoney(proposal.core.payableCents, proposal.core.currency),
        blockers: proposal.blockers,
        message: caseView.message?.text ?? null,
        approvalUrl: approvalUrlFor(caseId),
        note: proposal.status === 'BLOCKED'
          ? 'This payment is blocked; nothing can be approved until the blockers are resolved.'
          : 'A human must open approvalUrl, review and approve this exact payment. No tool can approve it.',
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('payonproof_pay_approved', {
    title: 'Pay a human-approved payment through PayPal',
    description: 'Sends the approved payout through PayPal Payouts and reads it back from PayPal. Requires the single-use approval token that a human created in the PayOnProof page for this exact previewHash; without it the result is HUMAN_APPROVAL_REQUIRED.',
    inputSchema: {
      caseId: z.string().min(1).max(64),
      previewHash: z.string().regex(/^[0-9a-f]{64}$/).describe('The previewHash the human approved.'),
      approvalToken: z.string().max(200).optional().describe('Single-use token from the human approval.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ caseId, previewHash, approvalToken }) => {
    if (!approvalToken) {
      return failure('HUMAN_APPROVAL_REQUIRED', 'A human must approve this exact payment first. Ask them to open approvalUrl and give you the approval token.', { approvalUrl: approvalUrlFor(caseId) });
    }
    try {
      const caseView = await service.pay(caseId, { approvalToken, previewHash });
      return result({ caseId, payout: caseView.payout });
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'ALREADY_PAID') return failure(error.code, error.message);
      return errorResult(error);
    }
  });

  server.registerTool('payonproof_payout_status', {
    title: 'Read a payout back from PayPal',
    description: 'Reads the payout batch of a case back from PayPal and returns the receipt: batch status, item status, transaction id and whether it matches the approval.',
    inputSchema: { caseId: z.string().min(1).max(64) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ caseId }) => {
    try {
      const caseView = await service.refreshPayout(caseId);
      return result({ caseId, payout: caseView.payout });
    } catch (error) {
      return errorResult(error);
    }
  });

  return server;
}

/**
 * Handle one HTTP request to /mcp (stateless Streamable HTTP, JSON responses).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} body parsed JSON body (POST)
 * @param {{service: object, approvalUrlFor: (caseId: string) => string}} deps
 */
export async function handleMcpRequest(req, res, body, deps) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This MCP endpoint is stateless: use POST.' }, id: null }));
    return;
  }
  const server = createMcpServer(deps);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
