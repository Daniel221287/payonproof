import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiConfigError, AiError, createAiProvider, parseModelJson, resolveAiConfig } from '../src/ai.mjs';
import { OFFLINE_LABEL } from '../src/offline-parser.mjs';

const KEY = 'test-gemini-key-123456';

function scriptedFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const geminiOk = (text) => ({ body: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40 }, modelVersion: 'gemini-2.5-flash' } });
const noSleep = async () => {};

test('provider selection: offline by default, gemini with a key, openai with a base URL', () => {
  assert.equal(resolveAiConfig({}).provider, 'offline');
  assert.deepEqual(resolveAiConfig({ GEMINI_API_KEY: KEY }).model, 'gemini-2.5-flash');
  assert.equal(resolveAiConfig({ GEMINI_API_KEY: KEY, GEMINI_MODEL: 'models/gemini-2.5-pro' }).model, 'gemini-2.5-pro');
  const openai = resolveAiConfig({ AI_BASE_URL: 'http://127.0.0.1:11434/v1/', AI_MODEL: 'llama3.1' });
  assert.equal(openai.provider, 'openai');
  assert.equal(openai.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(resolveAiConfig({ AI_PROVIDER: 'offline', GEMINI_API_KEY: KEY }).provider, 'offline');
  assert.throws(() => resolveAiConfig({ AI_PROVIDER: 'gemini' }), AiConfigError);
  assert.throws(() => resolveAiConfig({ AI_PROVIDER: 'openai', AI_BASE_URL: 'ftp://x', AI_MODEL: 'm' }), /http or https/);
  assert.throws(() => resolveAiConfig({ AI_PROVIDER: 'magic' }), /nebius, gemini, openai or offline/);
});

test('the offline provider is labelled as no AI and cannot generate', async () => {
  const provider = createAiProvider(resolveAiConfig({}));
  assert.equal(provider.isAI, false);
  assert.equal(provider.label, OFFLINE_LABEL);
  assert.equal(provider.label, 'Offline sample parser — no AI used');
  await assert.rejects(provider.generateJson({ system: 's', user: 'u' }), AiError);
});

test('Gemini: exact endpoint, key in header (not URL), JSON output at temperature 0', async () => {
  const { fetch, calls } = scriptedFetch([geminiOk('{"invoiceNumber":"INV-1"}')]);
  const provider = createAiProvider(resolveAiConfig({ GEMINI_API_KEY: KEY }), { fetch });
  const output = await provider.generateJson({ system: 'SYSTEM', user: 'USER' });
  assert.deepEqual(output.json, { invoiceNumber: 'INV-1' });
  assert.equal(output.usage.inputTokens, 120);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.ok(!calls[0].url.includes(KEY));
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-goog-api-key'], KEY);
  assert.deepEqual(calls[0].body.generationConfig, { responseMimeType: 'application/json', temperature: 0 });
  assert.deepEqual(calls[0].body.systemInstruction, { parts: [{ text: 'SYSTEM' }] });
  assert.deepEqual(calls[0].body.contents, [{ role: 'user', parts: [{ text: 'USER' }] }]);
  assert.equal(provider.label, 'Google Gemini (gemini-2.5-flash)');
});

test('Gemini errors never echo the API key; 503 is retried once', async () => {
  const leaky = scriptedFetch([{ status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: `API key ${KEY} not valid` } } }]);
  const provider = createAiProvider(resolveAiConfig({ GEMINI_API_KEY: KEY }), { fetch: leaky.fetch, sleep: noSleep });
  await assert.rejects(provider.generateJson({ system: 's', user: 'u' }), (error) => {
    assert.equal(error.code, 'AI_HTTP_ERROR');
    assert.ok(!error.message.includes(KEY));
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
  const flaky = scriptedFetch([{ status: 503, body: { error: { status: 'UNAVAILABLE', message: 'overloaded' } } }, geminiOk('{"ok":true}')]);
  const retrying = createAiProvider(resolveAiConfig({ GEMINI_API_KEY: KEY }), { fetch: flaky.fetch, sleep: noSleep });
  assert.deepEqual((await retrying.generateJson({ system: 's', user: 'u' })).json, { ok: true });
  assert.equal(flaky.calls.length, 2);
});

test('Gemini: truncated or blocked answers are errors, not partial data', async () => {
  const truncated = scriptedFetch([{ body: { candidates: [{ content: { parts: [{ text: '{"a":' }] }, finishReason: 'MAX_TOKENS' }] } }]);
  await assert.rejects(createAiProvider(resolveAiConfig({ GEMINI_API_KEY: KEY }), { fetch: truncated.fetch }).generateJson({ system: 's', user: 'u' }), /stopped early/);
  const blocked = scriptedFetch([{ body: { promptFeedback: { blockReason: 'SAFETY' } } }]);
  await assert.rejects(createAiProvider(resolveAiConfig({ GEMINI_API_KEY: KEY }), { fetch: blocked.fetch }).generateJson({ system: 's', user: 'u' }), /blocked/);
});

test('timeouts become AI_TIMEOUT after one retry', async () => {
  const timeout = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  const { fetch, calls } = scriptedFetch([timeout(), timeout()]);
  const provider = createAiProvider(resolveAiConfig({ GEMINI_API_KEY: KEY, AI_TIMEOUT_MS: '5000' }), { fetch, sleep: noSleep });
  await assert.rejects(provider.generateJson({ system: 's', user: 'u' }), (error) => error.code === 'AI_TIMEOUT');
  assert.equal(calls.length, 2);
});

test('OpenAI-compatible: chat completions with JSON mode, bearer key, fallback when JSON mode is unsupported', async () => {
  const { fetch, calls } = scriptedFetch([
    { status: 400, body: { error: { message: "Unrecognized request argument supplied: response_format" } } },
    { body: { model: 'llama3.1', choices: [{ message: { content: '```json\n{"notes": []}\n```' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } } },
  ]);
  const config = resolveAiConfig({ AI_PROVIDER: 'openai', AI_BASE_URL: 'http://127.0.0.1:11434/v1', AI_MODEL: 'llama3.1', AI_API_KEY: 'sk-test' });
  const provider = createAiProvider(config, { fetch });
  const output = await provider.generateJson({ system: 'S', user: 'U' });
  assert.deepEqual(output.json, { notes: [] });
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.equal(calls[0].body.temperature, 0);
  assert.deepEqual(calls[0].body.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);
  assert.equal(calls[1].body.response_format, undefined, 'retried without JSON mode');
  assert.match(provider.label, /OpenAI-compatible endpoint \(llama3\.1 at 127\.0\.0\.1:11434\)/);
});

test('Nebius Token Factory: NVIDIA Nemotron by default, OpenAI-compatible call, key only in the header', async () => {
  const NKEY = 'test-nebius-key-987654';
  const config = resolveAiConfig({ NEBIUS_API_KEY: NKEY });
  assert.equal(config.provider, 'nebius');
  assert.equal(config.baseUrl, 'https://api.tokenfactory.nebius.com/v1');
  assert.equal(config.model, 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B');
  assert.equal(resolveAiConfig({ NEBIUS_API_KEY: NKEY, GEMINI_API_KEY: KEY }).provider, 'nebius');
  assert.equal(resolveAiConfig({ AI_PROVIDER: 'gemini', NEBIUS_API_KEY: NKEY, GEMINI_API_KEY: KEY }).provider, 'gemini');
  assert.equal(resolveAiConfig({ AI_PROVIDER: 'offline', NEBIUS_API_KEY: NKEY }).provider, 'offline');
  assert.equal(resolveAiConfig({ NEBIUS_API_KEY: NKEY, NEBIUS_MODEL: 'nvidia/Nemotron-3_5-Lightning' }).model, 'nvidia/Nemotron-3_5-Lightning');
  assert.throws(() => resolveAiConfig({ AI_PROVIDER: 'nebius' }), /NEBIUS_API_KEY/);
  assert.throws(() => resolveAiConfig({ NEBIUS_API_KEY: NKEY, NEBIUS_BASE_URL: 'http://api.tokenfactory.nebius.com/v1' }), /https/);
  assert.throws(() => resolveAiConfig({ NEBIUS_API_KEY: NKEY, NEBIUS_MODEL: 'nvidia/x y' }), /unexpected characters/);

  const ok = scriptedFetch([{ body: {
    model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
    choices: [{ message: { content: '<think>Line 3 has {hours} to check.</think>\n{"lines": []}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 50, completion_tokens: 20 },
  } }]);
  const provider = createAiProvider(config, { fetch: ok.fetch });
  assert.equal(provider.isAI, true);
  assert.equal(provider.label, 'Nebius Token Factory (nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B)');
  const output = await provider.generateJson({ system: 'S', user: 'U' });
  assert.deepEqual(output.json, { lines: [] });
  assert.deepEqual(output.usage, { inputTokens: 50, outputTokens: 20 });
  assert.equal(ok.calls[0].url, 'https://api.tokenfactory.nebius.com/v1/chat/completions');
  assert.equal(ok.calls[0].init.headers.authorization, `Bearer ${NKEY}`);
  assert.equal(ok.calls[0].body.model, 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B');
  assert.deepEqual(ok.calls[0].body.response_format, { type: 'json_object' });
  assert.ok(!ok.calls[0].url.includes(NKEY) && !JSON.stringify(ok.calls[0].body).includes(NKEY));

  const rejected = scriptedFetch([{ status: 401, body: { error: { message: `Invalid API key ${NKEY}` } } }]);
  await assert.rejects(
    createAiProvider(config, { fetch: rejected.fetch }).generateJson({ system: 'S', user: 'U' }),
    (error) => error.code === 'AI_HTTP_ERROR' && !error.message.includes(NKEY) && error.message.includes('[redacted]'),
  );
});

test('Nebius reasoning switch: off by default sends enable_thinking=false, on sends nothing, a rejection drops it', async () => {
  const NKEY = 'test-nebius-key-555555';
  const ok = () => ({ body: { model: 'm', choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }] } });
  const off = scriptedFetch([ok()]);
  await createAiProvider(resolveAiConfig({ NEBIUS_API_KEY: NKEY }), { fetch: off.fetch }).generateJson({ system: 'S', user: 'U' });
  assert.deepEqual(off.calls[0].body.chat_template_kwargs, { enable_thinking: false });
  const on = scriptedFetch([ok()]);
  await createAiProvider(resolveAiConfig({ NEBIUS_API_KEY: NKEY, NEBIUS_REASONING: 'on' }), { fetch: on.fetch }).generateJson({ system: 'S', user: 'U' });
  assert.equal(on.calls[0].body.chat_template_kwargs, undefined);
  assert.throws(() => resolveAiConfig({ NEBIUS_API_KEY: NKEY, NEBIUS_REASONING: 'maybe' }), /NEBIUS_REASONING must be on or off/);
  const openai = scriptedFetch([ok()]);
  await createAiProvider(resolveAiConfig({ AI_PROVIDER: 'openai', AI_BASE_URL: 'http://127.0.0.1:11434/v1', AI_MODEL: 'x' }), { fetch: openai.fetch }).generateJson({ system: 'S', user: 'U' });
  assert.equal(openai.calls[0].body.chat_template_kwargs, undefined, 'only the Nebius provider sends it');
  const rejecting = scriptedFetch([{ status: 400, body: { error: { message: 'Unknown field chat_template_kwargs' } } }, ok()]);
  const out = await createAiProvider(resolveAiConfig({ NEBIUS_API_KEY: NKEY }), { fetch: rejecting.fetch }).generateJson({ system: 'S', user: 'U' });
  assert.deepEqual(out.json, { a: 1 });
  assert.equal(rejecting.calls[1].body.chat_template_kwargs, undefined, 'retried without it');
});

test('structured output: a request with a schema sends it as strict json_schema; a refusal falls back to JSON mode and is remembered', async () => {
  const NKEY = 'test-nebius-key-777777';
  const SCHEMA = { name: 'invoice', schema: { type: 'object', additionalProperties: false, properties: { kind: { enum: ['labour', 'material', null] } }, required: ['kind'] } };
  const ok = () => ({ body: { model: 'm', choices: [{ message: { content: '{"kind":"labour"}' }, finish_reason: 'stop' }] } });

  const nebius = scriptedFetch([ok(), ok()]);
  const provider = createAiProvider(resolveAiConfig({ NEBIUS_API_KEY: NKEY }), { fetch: nebius.fetch });
  const output = await provider.generateJson({ system: 'S', user: 'U', schema: SCHEMA });
  assert.deepEqual(nebius.calls[0].body.response_format, { type: 'json_schema', json_schema: { name: 'invoice', schema: SCHEMA.schema, strict: true } });
  assert.equal(output.outputFormat, 'json_schema');
  assert.deepEqual(output.json, { kind: 'labour' });
  const plain = await provider.generateJson({ system: 'S', user: 'U' });
  assert.deepEqual(nebius.calls[1].body.response_format, { type: 'json_object' }, 'no schema: JSON mode');
  assert.equal(plain.outputFormat, 'json_object');

  const refusing = scriptedFetch([{ status: 400, body: { error: { message: 'response_format json_schema is not supported for this model' } } }, ok(), ok()]);
  const fallback = createAiProvider(resolveAiConfig({ NEBIUS_API_KEY: NKEY }), { fetch: refusing.fetch });
  const first = await fallback.generateJson({ system: 'S', user: 'U', schema: SCHEMA });
  assert.deepEqual(refusing.calls[1].body.response_format, { type: 'json_object' });
  assert.equal(first.outputFormat, 'json_object');
  await fallback.generateJson({ system: 'S', user: 'U', schema: SCHEMA });
  assert.equal(refusing.calls.length, 3, 'the refusal is remembered: no second json_schema attempt');
  assert.deepEqual(refusing.calls[2].body.response_format, { type: 'json_object' });

  const both = scriptedFetch([
    { status: 400, body: { error: { message: 'Unsupported response_format type json_schema' } } },
    { status: 400, body: { error: { message: 'Unrecognized request argument supplied: response_format' } } },
    ok(),
  ]);
  const local = createAiProvider(resolveAiConfig({ AI_PROVIDER: 'openai', AI_BASE_URL: 'http://127.0.0.1:11434/v1', AI_MODEL: 'x' }), { fetch: both.fetch });
  const text = await local.generateJson({ system: 'S', user: 'U', schema: SCHEMA });
  assert.equal(both.calls[0].body.response_format.type, 'json_schema', 'OpenAI-compatible endpoints get the schema too');
  assert.equal(both.calls[2].body.response_format, undefined, 'then plain text');
  assert.equal(text.outputFormat, 'text');

  const switched = scriptedFetch([ok()]);
  await createAiProvider(resolveAiConfig({ NEBIUS_API_KEY: NKEY, AI_JSON_SCHEMA: '0' }), { fetch: switched.fetch }).generateJson({ system: 'S', user: 'U', schema: SCHEMA });
  assert.deepEqual(switched.calls[0].body.response_format, { type: 'json_object' }, 'AI_JSON_SCHEMA=0 keeps JSON mode only');

  const other = scriptedFetch([{ status: 400, body: { error: { message: 'messages: too many tokens' } } }]);
  await assert.rejects(createAiProvider(resolveAiConfig({ NEBIUS_API_KEY: NKEY }), { fetch: other.fetch }).generateJson({ system: 'S', user: 'U', schema: SCHEMA }), /HTTP 400/);
  assert.equal(other.calls.length, 1, 'an unrelated 400 is not retried');

  const gemini = scriptedFetch([geminiOk('{"kind":"labour"}')]);
  const g = await createAiProvider(resolveAiConfig({ GEMINI_API_KEY: KEY }), { fetch: gemini.fetch }).generateJson({ system: 'S', user: 'U', schema: SCHEMA });
  assert.equal(g.outputFormat, 'json_object');
  assert.deepEqual(gemini.calls[0].body.generationConfig, { responseMimeType: 'application/json', temperature: 0 }, 'Gemini keeps JSON mode');
});

test('output budget: reasoning on raises max_tokens, off leaves the endpoint default, AI_MAX_OUTPUT_TOKENS wins', async () => {
  const NKEY = 'test-nebius-key-888888';
  const ok = () => ({ body: { model: 'm', choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }] } });
  const run = async (env) => {
    const { fetch, calls } = scriptedFetch([ok()]);
    await createAiProvider(resolveAiConfig({ NEBIUS_API_KEY: NKEY, ...env }), { fetch }).generateJson({ system: 'S', user: 'U' });
    return calls[0].body.max_tokens;
  };
  assert.equal(await run({}), undefined);
  assert.equal(await run({ NEBIUS_REASONING: 'on' }), 16384);
  assert.equal(await run({ NEBIUS_REASONING: 'on', AI_MAX_OUTPUT_TOKENS: '8000' }), 8000);
  assert.equal(await run({ AI_MAX_OUTPUT_TOKENS: '2048' }), 2048);
  assert.throws(() => resolveAiConfig({ NEBIUS_API_KEY: NKEY, AI_MAX_OUTPUT_TOKENS: '12.5' }), /AI_MAX_OUTPUT_TOKENS/);
  assert.throws(() => resolveAiConfig({ AI_PROVIDER: 'openai', AI_BASE_URL: 'http://127.0.0.1:11434/v1', AI_MODEL: 'x', AI_MAX_OUTPUT_TOKENS: '99' }), /256 to 131072/);
  const cut = scriptedFetch([{ body: { model: 'm', choices: [{ message: { content: '{"lines": [' }, finish_reason: 'length' }] } }]);
  await assert.rejects(createAiProvider(resolveAiConfig({ NEBIUS_API_KEY: NKEY, NEBIUS_REASONING: 'on' }), { fetch: cut.fetch }).generateJson({ system: 'S', user: 'U' }),
    (error) => error.code === 'AI_INCOMPLETE');
});

test('a timeout while the answer body is still arriving is an AI timeout, retried once, never a crash', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(init);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"choices": ['));
        init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createAiProvider(resolveAiConfig({ NEBIUS_API_KEY: 'test-nebius-key-999999', AI_TIMEOUT_MS: '50' }), { fetch, sleep: noSleep });
  const keepAlive = setInterval(() => {}, 20); // AbortSignal.timeout does not keep the process alive on its own
  try {
    await assert.rejects(provider.generateJson({ system: 'S', user: 'U' }), (error) => error instanceof AiError && error.code === 'AI_TIMEOUT');
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(calls.length, 2);
});

test('fallbacks: an error that echoes the request is not a refused feature, and a downgrade sticks only when it works', async () => {
  const NKEY = 'test-nebius-key-121212';
  const SCHEMA = { name: 'invoice', schema: { type: 'object', additionalProperties: false, properties: { a: { type: 'number' } }, required: ['a'] } };
  const ok = () => ({ body: { model: 'm', choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }] } });
  // vLLM/pydantic style: the message echoes the whole request, including chat_template_kwargs and json_schema.
  const echo = { status: 400, body: { object: 'error', message: "1 validation error for ChatCompletionRequest\n  Value error, messages too long [type=value_error, input_value={'model': 'm', 'response_format': {'type': 'json_schema'}, 'chat_template_kwargs': {'enable_thinking': False}}, input_type=dict]" } };
  const unrelated = scriptedFetch([echo, ok()]);
  const provider = createAiProvider(resolveAiConfig({ NEBIUS_API_KEY: NKEY }), { fetch: unrelated.fetch });
  await assert.rejects(provider.generateJson({ system: 'S', user: 'U', schema: SCHEMA }), /HTTP 400/);
  assert.equal(unrelated.calls.length, 1, 'no feature was dropped for an unrelated error');
  await provider.generateJson({ system: 'S', user: 'U', schema: SCHEMA });
  assert.equal(unrelated.calls[1].body.response_format.type, 'json_schema');
  assert.deepEqual(unrelated.calls[1].body.chat_template_kwargs, { enable_thinking: false });
  // The same with the echo as JSON and no input_type after it.
  const jsonEcho = (body) => ({ status: 400, body: { object: 'error', message: `1 validation error\n  Value error, temperature not allowed [type=value_error, input_value=${JSON.stringify(body)}]` } });
  const echoed = scriptedFetch([jsonEcho({ messages: [], response_format: { type: 'json_schema' }, chat_template_kwargs: { enable_thinking: false } })]);
  await assert.rejects(createAiProvider(resolveAiConfig({ NEBIUS_API_KEY: NKEY }), { fetch: echoed.fetch }).generateJson({ system: 'S', user: 'U', schema: SCHEMA }), /HTTP 400/);
  assert.equal(echoed.calls.length, 1);

  // The schema is refused, but the JSON-mode retry fails too: nothing is remembered.
  const both = scriptedFetch([
    { status: 400, body: { error: { message: 'response_format json_schema is not supported' } } },
    { status: 400, body: { error: { message: 'messages: too many tokens' } } },
    ok(),
  ]);
  const again = createAiProvider(resolveAiConfig({ NEBIUS_API_KEY: NKEY }), { fetch: both.fetch });
  await assert.rejects(again.generateJson({ system: 'S', user: 'U', schema: SCHEMA }), /too many tokens/);
  await again.generateJson({ system: 'S', user: 'U', schema: SCHEMA });
  assert.equal(both.calls[2].body.response_format.type, 'json_schema', 'the schema is tried again next time');

  // FastAPI-style 422 naming the refused field.
  const fastapi = scriptedFetch([{ status: 422, body: { detail: [{ loc: ['body', 'response_format', 'json_schema'], msg: 'Extra inputs are not permitted', input: { name: 'invoice' } }] } }, ok()]);
  const tgi = await createAiProvider(resolveAiConfig({ AI_PROVIDER: 'openai', AI_BASE_URL: 'http://127.0.0.1:8080/v1', AI_MODEL: 'x' }), { fetch: fastapi.fetch }).generateJson({ system: 'S', user: 'U', schema: SCHEMA });
  assert.equal(tgi.outputFormat, 'json_object');

  // Without the reasoning switch Nemotron reasons again: the larger output budget comes with it.
  const kwargs = scriptedFetch([{ status: 400, body: { error: { message: 'Unknown field chat_template_kwargs' } } }, ok()]);
  await createAiProvider(resolveAiConfig({ NEBIUS_API_KEY: NKEY }), { fetch: kwargs.fetch }).generateJson({ system: 'S', user: 'U' });
  assert.equal(kwargs.calls[0].body.max_tokens, undefined);
  assert.equal(kwargs.calls[1].body.chat_template_kwargs, undefined);
  assert.equal(kwargs.calls[1].body.max_tokens, 16384);
});

test('reasoning models: thinking before the answer is skipped, an answer cut off while reasoning is incomplete', () => {
  assert.deepEqual(parseModelJson('<think>Totals {a} and {b}?</think>\n{"a":1}'), { a: 1 });
  assert.deepEqual(parseModelJson('Check {x} first.</think>{"a":2}'), { a: 2 });
  assert.throws(() => parseModelJson('<think>still counting {hours'), (error) => error.code === 'AI_INCOMPLETE');
  assert.throws(() => parseModelJson('<think>done</think>'), /only its reasoning/);
});

test('model JSON parsing tolerates fences but rejects non-objects and garbage', () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelJson('Here you go: {"a":1} hope it helps'), { a: 1 });
  assert.throws(() => parseModelJson('[1,2]'), /not an object/);
  assert.throws(() => parseModelJson('{"a":'), /valid JSON/);
  assert.throws(() => parseModelJson(''), /empty/);
});
