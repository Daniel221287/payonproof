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
