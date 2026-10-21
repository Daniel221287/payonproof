/**
 * Case service: the one place that runs the flow, shared by the HTTP API and the MCP server.
 *
 *   analyze -> (edit message) -> approve (human UI only) -> pay -> read back -> receipt
 *
 * Invariants:
 *  - Payment needs a single-use approval token bound to the exact previewHash.
 *  - Any change to a case (message edit) revokes its approvals and changes the previewHash.
 *  - A case sends at most one payout batch; retries and reconciliation reuse the same
 *    sender_batch_id, which PayPal processes at most once.
 *  - An invoice is paid through at most one case: the paid-invoice ledger reserves it before the
 *    payout leaves and blocks every other case for it (released only when nothing was paid).
 *  - "Paid" is only ever claimed from PayPal's readback.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AiError, createAiProvider } from './ai.mjs';
import { ApprovalError } from './approval.mjs';
import { hashCanonical } from './canonical.mjs';
import { assembleCaseInput, createExtractionCache, describeIssues, extractDocuments } from './extract.mjs';
import { createLedger, invoiceKey, LedgerError } from './ledger.mjs';
import { buildMessageFacts, draftMessage, factCheckMessage, LANGUAGE_NAMES } from './message.mjs';
import { centsToDecimalString } from './money.mjs';
import { buildPayoutBody, senderBatchIdFromPreviewHash } from './paypal.mjs';
import { buildProposal, messageSha256 } from './proposal.mjs';
import { buildReceipt } from './receipt.mjs';
import { DOCUMENT_TYPES } from './schema.mjs';
import { verifyCase } from './verify.mjs';

export const LIMITS = Object.freeze({ maxDocuments: 12, maxDocumentChars: 60_000, maxMessageChars: 4_000, maxCases: 500 });

/**
 * Approver passcode lockout. It is global, not per client: after 20 wrong passcodes within 15 minutes
 * approvals are refused for everyone for 15 minutes, so changing IP addresses gains an attacker nothing.
 * With a passcode of at least 8 characters that allows about 2,000 guesses a day; 20 (not fewer) keeps a
 * stranger or a few typos from locking the person out too easily. The per-IP limits still apply.
 */
export const PASSCODE_LOCKOUT = Object.freeze({ maxFailures: 20, windowMs: 15 * 60_000, lockMs: 15 * 60_000 });

/** A payout read back from PayPal less than this long ago is not read again on GET /api/payout/:id. */
export const READBACK_REUSE_MS = 10_000;

export class ServiceError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code machine-readable code
   * @param {string} message human-readable message
   * @param {object} [extra]
   */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const ascii = (text) => String(text).normalize('NFKD').replace(/[^\x20-\x7e]/g, '');

/** Constant-time comparison; hashing first means not even the length of the secret leaks. */
/** Short reasons for falling back from a failed AI provider to the offline parser (bundled samples only). */
const AI_FALLBACK_REASONS = {
  AI_NETWORK: 'the AI endpoint could not be reached',
  AI_TIMEOUT: 'the model did not answer in time',
  AI_BUDGET: 'the AI budget of this server is used up',
  AI_BAD_JSON: 'the model returned no usable JSON',
  AI_EMPTY: 'the model returned no answer',
  AI_INCOMPLETE: 'the model answer was cut off',
  AI_BLOCKED: 'the provider blocked the request',
};

function fallbackReason(doc) {
  if (doc.errorCode === 'AI_HTTP_ERROR') return `the AI endpoint answered HTTP ${doc.errorStatus ?? 'with an error'}`;
  return AI_FALLBACK_REASONS[doc.errorCode] ?? 'the model answer did not pass validation';
}

const LEDGER_STATE_WORDS = {
  SENDING: 'being sent right now',
  SENT: 'pending at PayPal',
  UNKNOWN_AFTER_SEND: 'outcome unknown: reconcile that case',
  PAID_VERIFIED: 'paid and verified',
  UNCLAIMED: 'sent, not yet claimed',
  FAILED: 'reported failed by PayPal: check that case first',
  MISMATCH: 'readback mismatch: check that case first',
};

/** Why a case for an invoice that is already reserved or paid cannot be paid. */
function alreadyPaidReason(entry) {
  const when = (entry.sentAt ?? entry.reservedAt ?? '').replace('T', ' ').slice(0, 16);
  const batch = entry.batchId ? `PayPal batch ${entry.batchId}` : `sender_batch_id ${String(entry.senderBatchId).slice(0, 20)}…`;
  return `Invoice ${entry.invoiceNumber} from ${entry.payee} was already sent to PayPal in case ${entry.caseId} on ${when} UTC `
    + `(${batch}, ${LEDGER_STATE_WORDS[entry.state] ?? entry.state}). An invoice is paid once; a new invoice needs its own number.`;
}

function sameSecret(given, expected) {
  const digest = (value) => createHash('sha256').update(String(value ?? '')).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * @param {{
 *   config: object, samples: object[], aiProvider: object, payPalClient: object|null, approvals: object,
 *   ledger?: ReturnType<typeof createLedger>, now?: () => number, readbackDelaysMs?: number[], log?: (event: object) => void
 * }} deps
 */
export function createService({ config, samples, aiProvider, payPalClient, approvals, ledger = createLedger(), now = Date.now, readbackDelaysMs = [0, 1000, 2000, 4000], log = () => {} }) {
  const cases = new Map();
  const cache = createExtractionCache(100);
  const aiCalls = [];
  const aiCallsToday = [];

  const provider = aiProvider.isAI
    ? {
      ...aiProvider,
      async generateJson(request) {
        const hourCutoff = now() - 3_600_000;
        while (aiCalls.length && aiCalls[0] < hourCutoff) aiCalls.shift();
        const dayCutoff = now() - 86_400_000;
        while (aiCallsToday.length && aiCallsToday[0] < dayCutoff) aiCallsToday.shift();
        if (aiCalls.length >= config.aiMaxCallsPerHour) {
          throw new AiError('AI_BUDGET', 'The hourly AI budget of this server is used up. Try again later or use a sample case.');
        }
        if (config.aiMaxCallsPerDay && aiCallsToday.length >= config.aiMaxCallsPerDay) {
          throw new AiError('AI_BUDGET', 'The daily AI budget of this server is used up. Try again tomorrow or use a sample case.');
        }
        aiCalls.push(now());
        if (config.aiMaxCallsPerDay) aiCallsToday.push(now());
        return aiProvider.generateJson(request);
      },
    }
    : aiProvider;
  const offlineProvider = aiProvider.isAI ? createAiProvider({ provider: 'offline', model: 'offline-sample-parser' }) : aiProvider;

  const paypalEnvironment = config.paypal.mode === 'mock' ? 'mock' : config.paypal.environment;
  const iso = () => new Date(now()).toISOString();

  /** Times of recent wrong approver passcodes (all clients together) and the end of the current lock. */
  const passcodeFailures = [];
  let approvalsLockedUntil = 0;

  function lockedError() {
    const reopensAt = new Date(approvalsLockedUntil).toISOString();
    const retryAfterSeconds = Math.max(1, Math.ceil((approvalsLockedUntil - now()) / 1000));
    const minutes = Math.ceil(retryAfterSeconds / 60);
    return new ServiceError(429, 'APPROVALS_LOCKED',
      `Approvals are locked for everyone after ${PASSCODE_LOCKOUT.maxFailures} wrong approver passcodes within ${PASSCODE_LOCKOUT.windowMs / 60_000} minutes. `
      + `They reopen at ${reopensAt.slice(11, 16)} UTC, in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      { retryAfterSeconds, reopensAt });
  }

  /** Throws unless the approver passcode is right; counts wrong guesses toward the global lockout. */
  function checkPasscode(passcode) {
    if (!config.approverPasscode) return;
    if (typeof passcode !== 'string' || passcode === '') {
      throw new ServiceError(403, 'PASSCODE_REQUIRED', 'Enter the approver passcode to approve this payment.');
    }
    if (sameSecret(passcode, config.approverPasscode)) return;
    const cutoff = now() - PASSCODE_LOCKOUT.windowMs;
    while (passcodeFailures.length && passcodeFailures[0] <= cutoff) passcodeFailures.shift();
    passcodeFailures.push(now());
    log({ event: 'approval.passcode_wrong', recentFailures: passcodeFailures.length });
    if (passcodeFailures.length >= PASSCODE_LOCKOUT.maxFailures) {
      passcodeFailures.length = 0;
      approvalsLockedUntil = now() + PASSCODE_LOCKOUT.lockMs;
      log({ event: 'approval.locked', until: new Date(approvalsLockedUntil).toISOString() });
      throw lockedError();
    }
    const left = PASSCODE_LOCKOUT.maxFailures - passcodeFailures.length;
    throw new ServiceError(403, 'PASSCODE_INVALID',
      `The approver passcode is not correct. ${left} more wrong ${left === 1 ? 'attempt locks' : 'attempts lock'} approvals for everyone for ${PASSCODE_LOCKOUT.lockMs / 60_000} minutes.`);
  }

  function requireCase(caseId) {
    const record = typeof caseId === 'string' ? cases.get(caseId) : undefined;
    if (!record) throw new ServiceError(404, 'CASE_NOT_FOUND', 'No case with this id. Cases live in memory and disappear when the server restarts.');
    return record;
  }

  function remember(record) {
    cases.set(record.id, record);
    while (cases.size > LIMITS.maxCases) {
      const oldest = cases.keys().next().value;
      cases.delete(oldest);
    }
  }

  function touch(record, event, detail = {}) {
    record.version += 1;
    record.updatedAt = iso();
    record.history.push({ at: record.updatedAt, event, ...detail });
  }

  function normalizeDocuments(documents) {
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new ServiceError(400, 'DOCUMENTS_REQUIRED', 'Send at least a contract and an invoice.');
    }
    if (documents.length > LIMITS.maxDocuments) throw new ServiceError(400, 'TOO_MANY_DOCUMENTS', `At most ${LIMITS.maxDocuments} documents per case.`);
    return documents.map((doc, position) => {
      if (!doc || typeof doc !== 'object') throw new ServiceError(400, 'BAD_DOCUMENT', `Document ${position + 1} is not an object.`);
      if (!DOCUMENT_TYPES.includes(doc.type)) {
        throw new ServiceError(400, 'BAD_DOCUMENT_TYPE', `Document ${position + 1} needs a type: ${DOCUMENT_TYPES.join(', ')}.`);
      }
      if (typeof doc.text !== 'string' || doc.text.trim() === '') throw new ServiceError(400, 'EMPTY_DOCUMENT', `Document ${position + 1} is empty.`);
      if (doc.text.length > LIMITS.maxDocumentChars) {
        throw new ServiceError(413, 'DOCUMENT_TOO_LONG', `Document ${position + 1} is longer than ${LIMITS.maxDocumentChars} characters.`);
      }
      const name = typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim().slice(0, 120) : `${doc.type.replace('_', ' ')} ${position + 1}`;
      return { id: `doc-${position + 1}`, type: doc.type, name, text: doc.text.replace(/\r\n?/g, '\n') };
    });
  }

  async function draftMessageCached(facts, writer = provider) {
    const key = `msg|${writer.id}|${writer.model}|${hashCanonical(facts)}`;
    const hit = cache.get(key);
    if (hit) return { ...hit };
    const message = await draftMessage({ provider: writer, facts });
    if (message.source === 'ai' || !writer.isAI) cache.set(key, { ...message });
    return message;
  }

  function proposalFor(record, messageText) {
    return buildProposal({
      caseId: record.id,
      contract: record.input.contract,
      invoice: record.input.invoice,
      verification: record.verification,
      messageText,
      documentsSha256: record.extraction.inputSha256,
      payeeOverride: config.payeeOverride,
    });
  }

  /** The ledger entry of another case that has sent this case's invoice to PayPal since it was analysed. */
  function ledgerConflict(record) {
    const entry = ledger.get(record.invoiceKey);
    return entry && entry.caseId !== record.id ? entry : null;
  }

  function proposalStatus(record, approval) {
    if (!record.proposal) return null;
    if (record.payout && !['NOT_SENT', 'REJECTED'].includes(record.payout.state)) return 'PAYMENT_SENT';
    if (record.proposal.status === 'BLOCKED' || ledgerConflict(record)) return 'BLOCKED';
    if (approval?.state === 'active' && approval.previewHash === record.proposal.previewHash) return 'APPROVED';
    return 'AWAITING_HUMAN_APPROVAL';
  }

  /**
   * Public, secret-free view of a case.
   * @param {object} record
   */
  function view(record) {
    const approval = approvals.statusFor(record.id);
    const conflict = record.proposal ? ledgerConflict(record) : null;
    const conflictBlocker = conflict && !record.blockers.some((blocker) => blocker.code === 'INVOICE_ALREADY_PAID')
      ? { code: 'INVOICE_ALREADY_PAID', severity: 'blocker', reason: alreadyPaidReason(conflict), earlierCaseId: conflict.caseId }
      : null;
    const docStatus = new Map(record.extraction.documents.map((doc) => [doc.id, doc]));
    const contract = record.input?.contract ?? null;
    const invoice = record.input?.invoice ?? null;
    return {
      id: record.id,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      source: record.source,
      documents: record.documents.map((doc) => ({
        id: doc.id,
        type: doc.type,
        name: doc.name,
        text: doc.text,
        status: docStatus.get(doc.id)?.status ?? 'rejected',
        errors: docStatus.get(doc.id)?.errors ?? [],
        warnings: docStatus.get(doc.id)?.warnings ?? [],
      })),
      extraction: {
        provider: record.extraction.provider,
        model: record.extraction.model,
        isAI: record.extraction.isAI,
        label: record.extraction.label,
        promptVersion: record.extraction.promptVersion,
        fallback: record.extraction.fallback ?? null,
        startedAt: record.extraction.startedAt,
        durationMs: record.extraction.durationMs,
        inputSha256: record.extraction.inputSha256,
        cached: record.extraction.cached,
      },
      contract: contract && {
        contractId: contract.contractId,
        mainContractor: contract.mainContractor,
        subcontractor: contract.subcontractor,
        payeeEmail: contract.payeeEmail,
        currency: contract.currency,
        language: contract.language,
        languageName: LANGUAGE_NAMES[contract.language],
        paymentCapCents: contract.paymentCapCents,
        rates: contract.rates.map((rate) => ({ kind: rate.kind, name: rate.name, aliases: rate.aliases, code: rate.code, unit: rate.unitAsWritten, priceCents: rate.priceCents })),
      },
      invoice: invoice && {
        invoiceNumber: invoice.invoiceNumber,
        issuer: invoice.issuer,
        issueDate: invoice.issueDate,
        contractRef: invoice.contractRef,
        currency: invoice.currency,
        payeeEmail: invoice.payeeEmail,
        totalCents: invoice.totalCents,
      },
      unreadable: record.unreadable,
      verification: record.verification,
      blockers: conflictBlocker ? [...record.blockers, conflictBlocker] : record.blockers,
      message: record.message,
      proposal: record.proposal && {
        status: proposalStatus(record, approval),
        previewHash: record.proposal.previewHash,
        core: record.proposal.core,
        blockers: conflictBlocker ? [...record.proposal.blockers, conflictBlocker.reason] : record.proposal.blockers,
        summary: record.proposal.summary,
      },
      approval,
      payout: record.payout && {
        state: record.payout.state,
        environment: record.payout.environment,
        senderBatchId: record.payout.senderBatchId,
        batchId: record.payout.batchId ?? null,
        duplicateDetected: Boolean(record.payout.duplicateDetected),
        sentAt: record.payout.sentAt,
        error: record.payout.error ?? null,
        readbackError: record.payout.readbackError ?? null,
        receipt: record.payout.receipt ?? null,
        receiptSha256: record.payout.receiptSha256 ?? null,
        lastReadbackAt: record.payout.lastReadbackAt ? new Date(record.payout.lastReadbackAt).toISOString() : null,
        attempts: record.payout.attempts,
      },
      paypal: { mode: config.paypal.mode, environment: paypalEnvironment },
    };
  }

  async function readBackInto(record, delaysMs) {
    const payout = record.payout;
    // Marked before the call, so status requests that arrive meanwhile reuse this readback.
    payout.lastReadbackAt = now();
    try {
      const { batch, attempts, readAt } = await payPalClient.readBack(payout.batchId, { delaysMs });
      const { receipt, sha256 } = buildReceipt({
        core: payout.core,
        previewHash: payout.previewHash,
        senderBatchId: payout.senderBatchId,
        environment: paypalEnvironment,
        batch,
        readAt,
        attempts,
        sentAt: payout.sentAt,
        duplicateDetected: Boolean(payout.duplicateDetected),
      });
      payout.receipt = receipt;
      payout.receiptSha256 = sha256;
      payout.readbackError = null;
      payout.state = receipt.verdict === 'PENDING' ? 'SENT' : receipt.verdict;
    } catch (error) {
      payout.readbackError = error.message;
      log({ event: 'paypal.readback_failed', caseId: record.id, message: error.message });
    }
  }

  /** Mirror the payout state into the paid-invoice ledger (NOT_SENT and REJECTED release the invoice). */
  function syncLedger(record) {
    if (!record.invoiceKey || !record.payout) return;
    try {
      ledger.record(record.invoiceKey, record.id, { state: record.payout.state, batchId: record.payout.batchId ?? null, sentAt: record.payout.sentAt });
    } catch (error) {
      log({ event: 'ledger.write_failed', caseId: record.id, message: error.message });
    }
  }

  async function applyCreateResult(record, result, { reconciling = false } = {}) {
    const payout = record.payout;
    payout.attempts.push({ at: iso(), outcome: result.outcome, debugId: result.debugId ?? null, error: result.error ?? null });
    payout.error = result.error ?? null;
    switch (result.outcome) {
      case 'CREATED':
        payout.batchId = result.batchId;
        payout.state = 'SENT';
        await readBackInto(record, readbackDelaysMs);
        break;
      case 'DUPLICATE':
        payout.duplicateDetected = true;
        if (result.batchId) {
          payout.batchId = result.batchId;
          payout.state = 'SENT';
          payout.error = null;
          await readBackInto(record, readbackDelaysMs);
        } else {
          payout.state = 'UNKNOWN_AFTER_SEND';
          payout.error = { code: 'DUPLICATE_WITHOUT_LINK', message: 'PayPal says a batch with this sender_batch_id exists but did not link it. Check the PayPal dashboard; nothing new was sent.' };
        }
        break;
      case 'UNKNOWN_AFTER_SEND':
        payout.state = 'UNKNOWN_AFTER_SEND';
        break;
      case 'NOT_SENT':
        // A reconcile attempt that did not reach PayPal leaves the first request's outcome unknown.
        payout.state = reconciling ? 'UNKNOWN_AFTER_SEND' : 'NOT_SENT';
        if (reconciling) {
          payout.error = { code: 'RECONCILE_NOT_SENT', message: 'The reconcile request could not reach PayPal, so the outcome of the first request is still unknown. Try Reconcile with PayPal again.' };
        }
        break;
      default:
        payout.state = 'REJECTED';
    }
    touch(record, `PAYOUT_${result.outcome}`, { batchId: payout.batchId ?? null });
    syncLedger(record);
  }

  return {
    /** Configuration the UI may see (no secrets). */
    publicConfig() {
      return {
        ai: { provider: aiProvider.id, model: aiProvider.model, isAI: aiProvider.isAI, label: aiProvider.label },
        paypal: { mode: config.paypal.mode, environment: paypalEnvironment, baseUrl: config.paypal.baseUrl },
        approval: { passcodeRequired: Boolean(config.approverPasscode), ttlSeconds: Math.round(approvals.ttlMs / 1000) },
        ledger: { persistent: Boolean(ledger.filePath) },
        payeeOverride: Boolean(config.payeeOverride),
        limits: { maxDocuments: LIMITS.maxDocuments, maxDocumentChars: LIMITS.maxDocumentChars, maxMessageChars: LIMITS.maxMessageChars },
      };
    },

    /** Bundled sample cases with their document texts. */
    listSamples() {
      return samples.map((sample) => ({ id: sample.id, title: sample.title, summary: sample.summary, documents: sample.documents }));
    },

    sampleIds() {
      return samples.map((sample) => sample.id);
    },

    /**
     * Read documents, verify every line, draft the message and build the proposal.
     * @param {{sampleId?: string, documents?: Array<{type: string, name?: string, text: string}>}} request
     */
    async analyze({ sampleId, documents } = {}) {
      let docs;
      let source;
      if (sampleId !== undefined && sampleId !== null) {
        const sample = samples.find((candidate) => candidate.id === sampleId);
        if (!sample) throw new ServiceError(404, 'SAMPLE_NOT_FOUND', `No sample case "${String(sampleId).slice(0, 40)}".`);
        docs = sample.documents.map((doc) => ({ ...doc }));
        source = { kind: 'sample', sampleId: sample.id, title: sample.title };
      } else {
        docs = normalizeDocuments(documents);
        source = { kind: 'pasted', title: 'Your documents' };
      }
      let extraction = await extractDocuments(docs, { provider, cache, now });
      let writer = provider;
      if (source.kind === 'sample' && provider.isAI && extraction.documents.some((doc) => doc.status !== 'ok')) {
        // The bundled samples follow the offline parser's layout, so a failed AI provider (network, HTTP
        // error, budget, bad JSON) does not take the demo down. Pasted documents never fall back.
        const failed = extraction.documents.find((doc) => doc.status !== 'ok');
        const reason = fallbackReason(failed);
        log({ event: 'ai.fallback_offline', sampleId: source.sampleId, provider: provider.id, code: failed.errorCode ?? 'VALIDATION' });
        const offline = await extractDocuments(docs, { provider: offlineProvider, cache, now });
        extraction = {
          ...offline,
          label: `AI unavailable (${reason}) — offline sample parser used for this sample`,
          fallback: { provider: provider.id, model: provider.model, reason, detail: describeIssues(failed.errors, 1) },
        };
        writer = offlineProvider;
      }
      const { input, blockers } = assembleCaseInput(extraction);
      // A document that could not be read is missing evidence of unknown content: nothing is verified,
      // so no verdict, payable figure or message is built from it.
      const unreadable = extraction.documents
        .filter((doc) => doc.status !== 'ok')
        .map((doc) => ({ id: doc.id, name: doc.name, type: doc.type, reason: describeIssues(doc.errors) }));
      const record = {
        id: `case_${randomBytes(8).toString('hex')}`,
        version: 1,
        createdAt: iso(),
        updatedAt: iso(),
        source,
        documents: docs,
        extraction,
        input,
        unreadable,
        invoiceKey: null,
        verification: null,
        blockers,
        message: null,
        proposal: null,
        payout: null,
        history: [{ at: iso(), event: 'ANALYZED' }],
      };
      if (input && unreadable.length === 0) {
        const verification = verifyCase(input);
        verification.blockers = [...blockers, ...verification.blockers];
        verification.caseFindings = [...blockers, ...verification.caseFindings];
        if (extraction.fallback) {
          verification.caseFindings.unshift({
            code: 'AI_FALLBACK', severity: 'warning',
            reason: `AI unavailable (${extraction.fallback.reason}): this bundled sample was read by the offline sample parser instead. Detail: ${extraction.fallback.detail}.`,
          });
        }
        // Paid-invoice ledger: an invoice that another case already sent to PayPal is never paid again.
        record.invoiceKey = invoiceKey({ payeeEmail: input.contract.payeeEmail, subcontractor: input.contract.subcontractor, invoiceNumber: input.invoice.invoiceNumber });
        const earlier = ledger.get(record.invoiceKey);
        if (!record.invoiceKey || earlier) {
          const blocker = record.invoiceKey
            ? { code: 'INVOICE_ALREADY_PAID', severity: 'blocker', reason: alreadyPaidReason(earlier), earlierCaseId: earlier.caseId }
            : { code: 'INVOICE_NUMBER_UNUSABLE', severity: 'blocker', reason: `The invoice number "${input.invoice.invoiceNumber}" has no letters or digits, so it cannot be checked against invoices paid before.` };
          verification.blockers.push(blocker);
          verification.caseFindings.unshift(blocker);
        }
        record.verification = verification;
        record.blockers = verification.blockers;
        const facts = buildMessageFacts({ contract: input.contract, invoice: input.invoice, verification });
        const message = await draftMessageCached(facts, writer);
        record.message = { ...message, language: facts.language, languageName: facts.languageName, sha256: messageSha256(message.text) };
        record.proposal = proposalFor(record, message.text);
      }
      remember(record);
      log({ event: 'case.analyzed', caseId: record.id, provider: extraction.provider, cached: extraction.cached });
      return view(record);
    },

    /** @param {string} caseId */
    getCase(caseId) {
      return view(requireCase(caseId));
    },

    /**
     * Replace the message text. Changes the previewHash and revokes approvals.
     * A person's edit is stored as written and labelled as such. An agent's text (MCP) must pass the
     * same fact check as an AI draft; if it does not, nothing is stored and nothing changes.
     * @param {string} caseId
     * @param {string} text
     * @param {{author?: 'person'|'agent'}} [options]
     */
    updateMessage(caseId, text, { author = 'person' } = {}) {
      const record = requireCase(caseId);
      if (record.payout && !['NOT_SENT', 'REJECTED'].includes(record.payout.state)) {
        throw new ServiceError(409, 'ALREADY_PAID', 'This case was already sent to PayPal and can no longer change.');
      }
      if (!record.proposal) throw new ServiceError(409, 'NOT_PAYABLE', 'This case has no payment proposal.');
      if (typeof text !== 'string' || text.trim() === '') throw new ServiceError(400, 'MESSAGE_REQUIRED', 'The message cannot be empty.');
      if (text.length > LIMITS.maxMessageChars) throw new ServiceError(400, 'MESSAGE_TOO_LONG', `Keep the message under ${LIMITS.maxMessageChars} characters.`);
      const clean = text.replace(/\r\n?/g, '\n');
      if (author === 'agent') {
        const facts = buildMessageFacts({ contract: record.input.contract, invoice: record.input.invoice, verification: record.verification });
        const missing = factCheckMessage(clean, facts);
        if (missing.length > 0) {
          throw new ServiceError(422, 'MESSAGE_FACT_CHECK_FAILED',
            `The message was not saved. Like an AI draft, a message written by an agent must state ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' and more' : ''}, with the amounts written exactly as in the current message.`,
            { missing });
        }
        record.message = { ...record.message, text: clean, source: 'agent', label: 'Written by an AI agent over MCP, fact-checked', note: null, sha256: messageSha256(clean) };
      } else {
        record.message = { ...record.message, text: clean, source: 'human', label: 'Edited by a person', note: null, sha256: messageSha256(clean) };
      }
      record.proposal = proposalFor(record, clean);
      approvals.revokeCase(caseId);
      touch(record, author === 'agent' ? 'MESSAGE_WRITTEN_BY_AGENT' : 'MESSAGE_EDITED', { previewHash: record.proposal.previewHash });
      return view(record);
    },

    /**
     * Human approval (HTTP UI only; no MCP tool calls this, and MCP never accepts a passcode).
     * With APPROVER_PASSCODE set, the passcode is what makes this a person's approval.
     * @param {string} caseId
     * @param {{previewHash: string, confirm: boolean, passcode?: string}} request
     */
    approve(caseId, { previewHash, confirm, passcode } = {}) {
      if (now() < approvalsLockedUntil) throw lockedError();
      const record = requireCase(caseId);
      if (record.payout && !['NOT_SENT', 'REJECTED'].includes(record.payout.state)) {
        throw new ServiceError(409, 'ALREADY_PAID', 'This case was already sent to PayPal.');
      }
      if (!record.proposal) throw new ServiceError(409, 'NOT_PAYABLE', 'This case has no payment proposal.');
      if (record.proposal.status === 'BLOCKED') {
        throw new ServiceError(409, 'PROPOSAL_BLOCKED', record.proposal.blockers.join(' '), { blockers: record.proposal.blockers });
      }
      const conflict = ledgerConflict(record);
      if (conflict) throw new ServiceError(409, 'INVOICE_ALREADY_PAID', alreadyPaidReason(conflict));
      if (confirm !== true) throw new ServiceError(400, 'CONFIRMATION_REQUIRED', 'Confirm that you checked the payee, the amount and the lines.');
      if (previewHash !== record.proposal.previewHash) {
        throw new ServiceError(409, 'PREVIEW_CHANGED', 'The payment changed since it was shown. Review the new preview and approve again.', { previewHash: record.proposal.previewHash });
      }
      checkPasscode(passcode);
      const approval = approvals.issue({ caseId, previewHash });
      record.history.push({ at: iso(), event: 'APPROVED', previewHash });
      return { approval, case: view(record) };
    },

    /**
     * Pay an approved proposal through PayPal and read the result back.
     * @param {string} caseId
     * @param {{approvalToken?: string, previewHash?: string}} request
     */
    async pay(caseId, { approvalToken, previewHash } = {}) {
      const record = requireCase(caseId);
      if (record.payout?.state === 'SENDING') throw new ServiceError(409, 'PAYMENT_IN_PROGRESS', 'This payment is being sent right now.');
      if (record.payout && !['NOT_SENT', 'REJECTED'].includes(record.payout.state)) {
        throw new ServiceError(409, 'ALREADY_PAID', `This case was already sent to PayPal (sender_batch_id ${record.payout.senderBatchId}). Check its status instead of paying again.`, { case: view(record) });
      }
      if (!record.proposal || record.proposal.status === 'BLOCKED') throw new ServiceError(409, 'NOT_PAYABLE', 'This case cannot be paid.');
      if (!payPalClient) {
        throw new ServiceError(503, 'PAYPAL_NOT_CONFIGURED', 'PayPal is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox) or PAYPAL_MOCK=1.');
      }
      if (previewHash !== undefined && previewHash !== record.proposal.previewHash) {
        throw new ApprovalError('APPROVAL_HASH_MISMATCH', 'The payment changed after it was approved. Review and approve it again.');
      }
      const claim = { token: approvalToken, caseId, previewHash: record.proposal.previewHash };
      approvals.check(claim);

      const { core, previewHash: approvedHash } = record.proposal;
      const senderBatchId = senderBatchIdFromPreviewHash(approvedHash);
      const invoice = ascii(core.invoiceNumber).slice(0, 60);
      // Built first: if the body is invalid, nothing is reserved and the approval is not used up.
      const body = buildPayoutBody({
        senderBatchId,
        receiver: core.payee.email,
        amountCents: core.payableCents,
        currency: core.currency,
        senderItemId: core.caseId,
        note: `PayOnProof invoice ${invoice}: paid ${core.paidLines.length} proven line(s). Ref ${approvedHash.slice(0, 16)}`,
        emailSubject: `Payment for invoice ${invoice}`.slice(0, 255),
        emailMessage: `Payment of ${centsToDecimalString(core.payableCents)} ${core.currency} for invoice ${invoice}: ${core.paidLines.length} proven line(s). An explanation of any deductions is sent separately.`,
      });
      // Reserve the invoice before anything leaves. This runs synchronously (no await since the checks
      // above), so two requests for the same invoice cannot both pass it.
      let reservation;
      try {
        reservation = ledger.reserve(record.invoiceKey, {
          caseId, invoiceNumber: core.invoiceNumber, payee: core.payee.contractEmail, amountCents: core.payableCents, currency: core.currency, senderBatchId,
        });
      } catch (error) {
        if (error instanceof LedgerError) throw new ServiceError(503, 'LEDGER_UNAVAILABLE', `${error.message} Nothing was sent.`);
        throw error;
      }
      if (!reservation.ok) throw new ServiceError(409, 'INVOICE_ALREADY_PAID', `${alreadyPaidReason(reservation.entry)} Nothing was sent.`);
      approvals.consume(claim);

      record.payout = {
        state: 'SENDING',
        environment: paypalEnvironment,
        senderBatchId,
        previewHash: approvedHash,
        core,
        body,
        sentAt: iso(),
        attempts: [...(record.payout?.attempts ?? [])],
      };
      try {
        const result = await payPalClient.createPayout(body);
        await applyCreateResult(record, result);
      } catch (error) {
        record.payout.state = 'UNKNOWN_AFTER_SEND';
        record.payout.error = { code: 'CLIENT_ERROR', message: error.message };
        touch(record, 'PAYOUT_ERROR');
        syncLedger(record);
      }
      return view(record);
    },

    /**
     * Read the payout back from PayPal (GET only, never sends money). A readback younger than
     * READBACK_REUSE_MS is reused, so repeated status requests cannot flood the PayPal app.
     * @param {string} caseId
     */
    async refreshPayout(caseId) {
      const record = requireCase(caseId);
      if (!record.payout) throw new ServiceError(409, 'NOT_SENT', 'Nothing was sent to PayPal for this case yet.');
      const recent = record.payout.lastReadbackAt !== undefined && now() - record.payout.lastReadbackAt < READBACK_REUSE_MS;
      if (record.payout.batchId && payPalClient && record.payout.state !== 'SENDING' && !recent) {
        await readBackInto(record, [0]);
        touch(record, 'READBACK', { state: record.payout.state });
        syncLedger(record);
      }
      return view(record);
    },

    /**
     * Resolve UNKNOWN_AFTER_SEND: re-present the identical approved request with the same
     * sender_batch_id. PayPal processes a sender_batch_id at most once, so this either
     * creates the single approved batch (if the first request never arrived) or reports
     * the existing one, which is then read back.
     * @param {string} caseId
     */
    async reconcile(caseId) {
      const record = requireCase(caseId);
      if (!record.payout || record.payout.state !== 'UNKNOWN_AFTER_SEND') {
        throw new ServiceError(409, 'NOTHING_TO_RECONCILE', 'Only a payout whose outcome is unknown needs reconciliation.');
      }
      if (!payPalClient) throw new ServiceError(503, 'PAYPAL_NOT_CONFIGURED', 'PayPal is not configured.');
      if (record.payout.batchId) {
        await readBackInto(record, readbackDelaysMs);
        touch(record, 'RECONCILED', { batchId: record.payout.batchId });
        syncLedger(record);
        return view(record);
      }
      record.payout.state = 'SENDING';
      try {
        const result = await payPalClient.createPayout(record.payout.body);
        await applyCreateResult(record, result, { reconciling: true });
      } catch (error) {
        record.payout.state = 'UNKNOWN_AFTER_SEND';
        record.payout.error = { code: 'CLIENT_ERROR', message: error.message };
        syncLedger(record);
      }
      return view(record);
    },
  };
}
