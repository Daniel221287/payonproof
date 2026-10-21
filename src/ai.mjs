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
    return {
      provider,
      model,
      baseUrl: url.href.replace(/\/+$/, ''),
      apiKey: env.NEBIUS_API_KEY,
      jsonMode: env.AI_JSON_MODE !== '0',
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

async function send(fetchImpl, url, init, timeoutMs, label) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new AiError('AI_TIMEOUT', `${label} did not answer within ${Math.round(timeoutMs / 1000)} s.`, { retryable: true });
    }
    const code = error?.cause?.code ?? error?.code ?? 'network error';
    throw new AiError('AI_NETWORK', `${label} could not be reached (${code}).`, { retryable: true });
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
  const response = await send(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
    body: JSON.stringify(body),
  }, config.timeoutMs, 'Gemini');
  const { json } = await readBody(response);
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
  };
}

async function callOpenAi(fetchImpl, config, state, { system, user }) {
  const url = `${config.baseUrl}/chat/completions`;
  const attempt = async (jsonMode) => {
    const body = {
      model: config.model,
      temperature: 0,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };
    const headers = { 'content-type': 'application/json' };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    const response = await send(fetchImpl, url, { method: 'POST', headers, body: JSON.stringify(body) }, config.timeoutMs, 'The AI endpoint');
    return { response, ...(await readBody(response)) };
  };
  let result = await attempt(state.jsonMode);
  if (!result.response.ok && state.jsonMode && result.response.status === 400 && /response_format|json_object|json mode/i.test(result.text)) {
    state.jsonMode = false;
    result = await attempt(false);
  }
  const { response, json, text } = result;
  if (!response.ok) {
    const message = json?.error?.message ?? (typeof json?.error === 'string' ? json.error : text);
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
  const state = { jsonMode: config.jsonMode !== false };
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
     * @param {{system: string, user: string}} request
     * @returns {Promise<{json: object, text: string, model: string, usage: object}>}
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
