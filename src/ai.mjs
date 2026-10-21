/**
 * Language-model providers behind one small interface.
 *
 *   provider = { id, model, isAI, label, generateJson({system, user}) -> {json, text, usage, model} }
 *
 * - nebius:  NVIDIA Nemotron (or any catalog model) on Nebius Token Factory, OpenAI-compatible API.
 * - gemini:  Google Gemini REST generateContent with JSON output.
 * - openai:  any OpenAI-compatible /chat/completions endpoint (OpenAI, Ollama, LM Studio, vLLM ...).
 * - offline: no model at all; callers use the deterministic sample parser and templates.
 *
 * All network access goes through the injected `fetch`, so tests never touch the network.
 * API keys are sent only in request headers and are redacted from every error message.
 */
import { OFFLINE_LABEL } from './offline-parser.mjs';

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const DEFAULT_NEBIUS_MODEL = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';
export const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export class AiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{status?: number, retryable?: boolean}} [options]
   */
  constructor(code, message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export class AiConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AiConfigError';
  }
}

/**
 * Resolve the AI configuration from environment variables.
 * Default: nebius when NEBIUS_API_KEY is set, gemini when GEMINI_API_KEY is set, openai when AI_BASE_URL is set,
 * otherwise offline.
 * @param {Record<string, string|undefined>} env
 */
// Output budget with Nemotron's reasoning on: the reasoning counts toward the output, and one live run
// cut an invoice off at the endpoint's default limit.
export const REASONING_MAX_OUTPUT_TOKENS = 16384;

function readMaxOutputTokens(env) {
  const raw = (env.AI_MAX_OUTPUT_TOKENS ?? '').trim();
  if (raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 256 || value > 131072) throw new AiConfigError('AI_MAX_OUTPUT_TOKENS must be a whole number from 256 to 131072.');
  return value;
}

export function resolveAiConfig(env) {
  const explicit = (env.AI_PROVIDER ?? '').trim().toLowerCase();
  const provider = explicit || (env.NEBIUS_API_KEY ? 'nebius' : env.GEMINI_API_KEY ? 'gemini' : env.AI_BASE_URL ? 'openai' : 'offline');
  const timeoutMs = Number(env.AI_TIMEOUT_MS) > 0 ? Number(env.AI_TIMEOUT_MS) : 60_000;
  if (provider === 'offline') return { provider, model: 'offline-sample-parser', timeoutMs };
  if (provider === 'nebius') {
    if (!env.NEBIUS_API_KEY) throw new AiConfigError('AI_PROVIDER=nebius needs NEBIUS_API_KEY (Nebius Token Factory > API keys).');
    const model = (env.NEBIUS_MODEL || DEFAULT_NEBIUS_MODEL).trim();
    if (!/^[A-Za-z0-9._\/:-]+$/.test(model)) throw new AiConfigError('NEBIUS_MODEL contains unexpected characters.');
    let url;
    try {
      url = new URL(env.NEBIUS_BASE_URL || NEBIUS_BASE_URL);
    } catch {
      throw new AiConfigError('NEBIUS_BASE_URL is not a valid URL.');
    }
    if (url.protocol !== 'https:') throw new AiConfigError('NEBIUS_BASE_URL must be https.');
    const reasoning = (env.NEBIUS_REASONING || 'off').trim().toLowerCase();
    if (!['on', 'off'].includes(reasoning)) throw new AiConfigError('NEBIUS_REASONING must be on or off.');
    return {
      provider,
      model,
      baseUrl: url.href.replace(/\/+$/, ''),
      apiKey: env.NEBIUS_API_KEY,
      jsonMode: env.AI_JSON_MODE !== '0',
      jsonSchema: env.AI_JSON_SCHEMA !== '0',
      reasoning,
      maxOutputTokens: readMaxOutputTokens(env) ?? (reasoning === 'on' ? REASONING_MAX_OUTPUT_TOKENS : null),
      timeoutMs,
    };
  }
  if (provider === 'gemini') {
    if (!env.GEMINI_API_KEY) throw new AiConfigError('AI_PROVIDER=gemini needs GEMINI_API_KEY.');
    const model = (env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).replace(/^models\//, '');
    if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new AiConfigError('GEMINI_MODEL contains unexpected characters.');
    return { provider, model, apiKey: env.GEMINI_API_KEY, timeoutMs };
  }
  if (provider === 'openai') {
    if (!env.AI_BASE_URL) throw new AiConfigError('AI_PROVIDER=openai needs AI_BASE_URL (for example http://127.0.0.1:11434/v1 for Ollama).');
    if (!env.AI_MODEL) throw new AiConfigError('AI_PROVIDER=openai needs AI_MODEL.');
    let url;
    try {
      url = new URL(env.AI_BASE_URL);
    } catch {
      throw new AiConfigError('AI_BASE_URL is not a valid URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new AiConfigError('AI_BASE_URL must be http or https.');
    return {
      provider,
      model: env.AI_MODEL,
      baseUrl: env.AI_BASE_URL.replace(/\/+$/, ''),
      apiKey: env.AI_API_KEY || '',
      jsonMode: env.AI_JSON_MODE !== '0',
      jsonSchema: env.AI_JSON_SCHEMA !== '0',
      maxOutputTokens: readMaxOutputTokens(env),
      timeoutMs,
    };
  }
  throw new AiConfigError('AI_PROVIDER must be nebius, gemini, openai or offline.');
}

function redact(text, secret) {
  const value = String(text ?? '');
  return secret ? value.split(secret).join('[redacted]') : value;
}

async function readBody(response) {
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function networkError(error, timeoutMs, label) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return new AiError('AI_TIMEOUT', `${label} did not answer within ${Math.round(timeoutMs / 1000)} s.`, { retryable: true });
  }
  const code = error?.cause?.code ?? error?.code ?? 'network error';
  return new AiError('AI_NETWORK', `${label} could not be reached (${code}).`, { retryable: true });
}

/** POST and read the whole answer under one timeout; a timeout or a cut connection while the body is still arriving is an AiError too. */
async function send(fetchImpl, url, init, timeoutMs, label) {
  try {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { response, ...(await readBody(response)) };
  } catch (error) {
    throw networkError(error, timeoutMs, label);
  }
}

/**
 * Parse the JSON object a model returned (tolerates code fences and stray text around it).
 * @param {string} text
 * @returns {object}
 */
export function parseModelJson(text) {
  if (typeof text !== 'string' || text.trim() === '') throw new AiError('AI_BAD_JSON', 'The model returned an empty answer.');
  let body = text.trim();
  // Reasoning models (e.g. Nemotron, Qwen) may put their thinking before the answer.
  const thinkEnd = body.lastIndexOf('</think>');
  if (thinkEnd >= 0) body = body.slice(thinkEnd + '</think>'.length).trim();
  else if (/^<think>/i.test(body)) throw new AiError('AI_INCOMPLETE', 'The model stopped while still reasoning.');
  if (body === '') throw new AiError('AI_BAD_JSON', 'The model returned only its reasoning, no answer.');
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fenced) body = fenced[1];
  if (!body.startsWith('{')) {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) body = body.slice(start, end + 1);
  }
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw new AiError('AI_BAD_JSON', 'The model did not return valid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AiError('AI_BAD_JSON', 'The model returned JSON that is not an object.');
  }
  return value;
}

async function callGemini(fetchImpl, config, { system, user }) {
  const url = `${GEMINI_BASE}/${encodeURIComponent(config.model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  };
  const { response, json } = await send(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
    body: JSON.stringify(body),
  }, config.timeoutMs, 'Gemini');
  if (!response.ok) {
    const status = json?.error?.status ? ` ${json.error.status}` : '';
    const detail = json?.error?.message ? `: ${redact(json.error.message, config.apiKey).slice(0, 300)}` : '';
    throw new AiError('AI_HTTP_ERROR', `Gemini returned HTTP ${response.status}${status}${detail}`, {
      status: response.status, retryable: [429, 500, 502, 503, 504].includes(response.status),
    });
  }
  if (json?.promptFeedback?.blockReason) throw new AiError('AI_BLOCKED', `Gemini blocked the request (${json.promptFeedback.blockReason}).`);
  const candidate = json?.candidates?.[0];
  if (!candidate) throw new AiError('AI_EMPTY', 'Gemini returned no answer.');
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    throw new AiError('AI_INCOMPLETE', `Gemini stopped early (${candidate.finishReason}).`);
  }
  const text = (candidate.content?.parts ?? [])
    .filter((part) => typeof part.text === 'string' && !part.thought)
    .map((part) => part.text)
    .join('');
  return {
    text,
    model: json.modelVersion ?? config.model,
    usage: { inputTokens: json.usageMetadata?.promptTokenCount ?? null, outputTokens: json.usageMetadata?.candidatesTokenCount ?? null },
    outputFormat: 'json_object',
  };
}

/**
 * How to ask for the answer: the document's JSON Schema as structured output when the request has one,
 * JSON mode otherwise, plain text when the endpoint refused both. A refusal is remembered per provider.
 */
function answerMode(state, schema) {
  if (!state.jsonMode) return 'text';
  return schema && state.schemaMode !== false ? 'json_schema' : 'json_object';
}

function responseFormat(mode, schema) {
  if (mode === 'json_schema') return { type: 'json_schema', json_schema: { name: schema.name, schema: schema.schema, strict: true } };
  if (mode === 'json_object') return { type: 'json_object' };
  return null;
}

/**
 * What an endpoint said when it refused a request: the error message only. Validation errors may echo
 * the whole request back (input_value=…, 'input': …), which must not look like a refused feature.
 */
function rejectionText({ json, text }) {
  const error = json?.error;
  const message = typeof error?.message === 'string' ? error.message
    : typeof error === 'string' ? error
      : typeof json?.message === 'string' ? json.message
        : Array.isArray(json?.detail) ? json.detail.map((item) => `${(item?.loc ?? []).join('.')} ${item?.msg ?? ''}`).join('; ')
          : typeof json?.detail === 'string' ? json.detail
            : json ? '' : String(text ?? '');
  return message
    .replace(/input_value=[\s\S]*?(?=, input_type=)|input_value=[\s\S]*$/g, '')
    .replace(/'input':[\s\S]*?(?=, '(?:ctx|url)':)|'input':[\s\S]*$/g, '')
    .slice(0, 1000);
}

async function callOpenAi(fetchImpl, config, state, { system, user, schema }) {
  const url = `${config.baseUrl}/chat/completions`;
  // This call's view of what the endpoint accepts. A downgrade is remembered for later calls only when
  // the downgraded request succeeds, so one unrelated error cannot switch a feature off for good.
  const local = { jsonMode: state.jsonMode, schemaMode: state.schemaMode, templateKwargs: state.templateKwargs };
  const sendsTemplateKwargs = () => config.provider === 'nebius' && config.reasoning === 'off' && local.templateKwargs !== false;
  // Without the reasoning switch Nemotron reasons again, and the reasoning counts toward the output.
  const outputBudget = () => config.maxOutputTokens
    ?? (config.provider === 'nebius' && config.reasoning === 'off' && local.templateKwargs === false ? REASONING_MAX_OUTPUT_TOKENS : null);
  const attempt = async (mode) => {
    const format = responseFormat(mode, schema);
    const budget = outputBudget();
    const body = {
      model: config.model,
      temperature: 0,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...(format ? { response_format: format } : {}),
      ...(budget ? { max_tokens: budget } : {}),
      // Nemotron on Token Factory: answer without the hidden reasoning pass (about 2x faster, 3x fewer tokens).
      ...(sendsTemplateKwargs() ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    };
    const headers = { 'content-type': 'application/json' };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    return { mode, ...(await send(fetchImpl, url, { method: 'POST', headers, body: JSON.stringify(body) }, config.timeoutMs, 'The AI endpoint')) };
  };
  let result = await attempt(answerMode(local, schema));
  // An endpoint that refuses an optional request feature gets the request again without it:
  // first the reasoning switch, then structured output (JSON mode instead), then JSON mode itself.
  for (let tries = 0; tries < 3 && !result.response.ok && [400, 422].includes(result.response.status); tries += 1) {
    const reason = rejectionText(result);
    if (sendsTemplateKwargs() && /chat_template_kwargs|enable_thinking/i.test(reason)) local.templateKwargs = false;
    else if (result.mode === 'json_schema' && /json_schema|response_format|schema|guided/i.test(reason)) local.schemaMode = false;
    else if (result.mode === 'json_object' && /response_format|json_object|json mode/i.test(reason)) local.jsonMode = false;
    else break;
    result = await attempt(answerMode(local, schema));
  }
  if (result.response.ok) Object.assign(state, local);
  const { response, json, text } = result;
  if (!response.ok) {
    const message = json?.error?.message ?? (typeof json?.error === 'string' ? json.error : (typeof json?.message === 'string' ? json.message : text));
    throw new AiError('AI_HTTP_ERROR', `The AI endpoint returned HTTP ${response.status}: ${redact(message, config.apiKey).slice(0, 300)}`, {
      status: response.status, retryable: [429, 500, 502, 503, 504].includes(response.status),
    });
  }
  const choice = json?.choices?.[0];
  if (!choice) throw new AiError('AI_EMPTY', 'The AI endpoint returned no answer.');
  if (choice.finish_reason === 'length') throw new AiError('AI_INCOMPLETE', 'The model ran out of output tokens.');
  return {
    text: typeof choice.message?.content === 'string' ? choice.message.content : '',
    model: json.model ?? config.model,
    usage: { inputTokens: json.usage?.prompt_tokens ?? null, outputTokens: json.usage?.completion_tokens ?? null },
    outputFormat: result.mode,
  };
}

/**
 * Create the configured provider.
 * @param {ReturnType<typeof resolveAiConfig>} config
 * @param {{fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>, retryDelayMs?: number}} [deps]
 */
export function createAiProvider(config, { fetch: fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), retryDelayMs = 1500 } = {}) {
  if (config.provider === 'offline') {
    return {
      id: 'offline',
      model: config.model,
      isAI: false,
      label: OFFLINE_LABEL,
      async generateJson() {
        throw new AiError('NO_AI', 'Offline mode has no language model.');
      },
    };
  }
  const state = { jsonMode: config.jsonMode !== false, schemaMode: config.jsonSchema === false ? false : undefined };
  const call = config.provider === 'gemini'
    ? (request) => callGemini(fetchImpl, config, request)
    : (request) => callOpenAi(fetchImpl, config, state, request);
  const label = config.provider === 'gemini'
    ? `Google Gemini (${config.model})`
    : config.provider === 'nebius'
      ? `Nebius Token Factory (${config.model})`
      : `OpenAI-compatible endpoint (${config.model} at ${new URL(config.baseUrl).host})`;
  return {
    id: config.provider,
    model: config.model,
    isAI: true,
    label,
    /**
     * @param {{system: string, user: string, schema?: {name: string, schema: object}}} request
     * @returns {Promise<{json: object, text: string, model: string, usage: object, outputFormat: string}>}
     */
    async generateJson(request) {
      let output;
      try {
        output = await call(request);
      } catch (error) {
        if (!(error instanceof AiError) || !error.retryable) throw error;
        await sleep(retryDelayMs);
        output = await call(request);
      }
      return { ...output, json: parseModelJson(output.text) };
    },
  };
}
