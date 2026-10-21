import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AiError, createAiProvider } from '../src/ai.mjs';
import { assembleCaseInput, extractDocuments } from '../src/extract.mjs';
import { buildMessageFacts, draftMessage, factCheckMessage, templateMessage } from '../src/message.mjs';
import { loadSamples } from '../src/samples.mjs';
import { verifyCase } from '../src/verify.mjs';

const samples = loadSamples(fileURLToPath(new URL('../samples', import.meta.url)));
const offline = createAiProvider({ provider: 'offline', model: 'offline-sample-parser' });

async function factsFor(sampleId, language) {
  const sample = samples.find((s) => s.id === sampleId);
  const { input } = assembleCaseInput(await extractDocuments(sample.documents, { provider: offline }));
  const contract = language ? { ...input.contract, language } : input.contract;
  return buildMessageFacts({ contract, invoice: input.invoice, verification: verifyCase(input) });
}

const fakeAi = (message) => ({ id: 'gemini', model: 'm', isAI: true, label: 'Google Gemini (m)', async generateJson() { return { json: { message } }; } });

test('templates exist for en, de, pl and uk and carry every disputed line with exact amounts', async () => {
  const greetings = { en: /^Dear Northgate/, de: /^Sehr geehrte Damen und Herren/, pl: /^Szanowni Państwo/, uk: /^Шановні партнери/ };
  for (const [language, greeting] of Object.entries(greetings)) {
    const facts = await factsFor('overbilled', language);
    const text = templateMessage(facts);
    assert.match(text, greeting, language);
    assert.deepEqual(factCheckMessage(text, facts), [], `${language} template passes its own fact check`);
    assert.equal(facts.disputedLines.length, 4);
  }
});

test('the overbilled message explains the duplicate, the unsigned day and the short delivery', async () => {
  const facts = await factsFor('overbilled');
  const text = templateMessage(facts);
  assert.match(text, /We are paying €5,035\.00 of the €6,338\.00 invoiced/);
  assert.match(text, /Line 4 \(Adam Kordecki, 15\/09\/2026\): invoiced €369\.00, paid €0\.00\. Reason: duplicate of line 3\./);
  assert.match(text, /not signed by the site manager/);
  assert.match(text, /only 18 of 22 m3 are proven/);
});

test('the Polish message uses Polish number formats and the cap reason', async () => {
  const facts = await factsFor('multilingual');
  assert.equal(facts.language, 'pl');
  const text = templateMessage(facts);
  assert.match(text, /Płacimy 1800,00\s€ z zafakturowanych 2090,00\s€/);
  assert.match(text, /przekroczony umowny limit płatności/);
});

test('a fully proven invoice gets a short full-payment note', async () => {
  const text = templateMessage(await factsFor('honest'));
  assert.match(text, /All 5 lines are confirmed/);
  assert.match(text, /full €2,270\.63/);
});

test('offline drafting is labelled as a template, never as AI', async () => {
  const draft = await draftMessage({ provider: offline, facts: await factsFor('overbilled') });
  assert.equal(draft.source, 'template');
  assert.equal(draft.label, 'Template, no AI used');
});

test('an AI draft that keeps every fact is used and labelled as AI', async () => {
  const facts = await factsFor('rate-drift');
  const good = templateMessage(facts).replace('Шановні партнери,', 'Добрий день,');
  const draft = await draftMessage({ provider: fakeAi(good), facts });
  assert.equal(draft.source, 'ai');
  assert.match(draft.label, /AI draft, fact-checked/);
});

test('an AI draft that drops or changes a fact is replaced by the template', async () => {
  const facts = await factsFor('overbilled');
  const invented = templateMessage(facts).replace('€5,035.00', '€5,300.00');
  const draft = await draftMessage({ provider: fakeAi(invented), facts });
  assert.equal(draft.source, 'template');
  assert.match(draft.note, /failed the fact check \(missing payable total €5,035\.00/);
  const missingLine = factCheckMessage('We pay €5,035.00 of €6,338.00. Line 4: €0.00.', facts);
  assert.ok(missingLine.includes('line 5'));
  const failing = { ...fakeAi(''), async generateJson() { throw new AiError('AI_TIMEOUT', 'Gemini did not answer within 60 s.'); } };
  const fallback = await draftMessage({ provider: failing, facts });
  assert.equal(fallback.source, 'template');
  assert.match(fallback.note, /did not answer/);
});

test('a sign-off by the wrong person is named in the message, in all four languages', async () => {
  const sample = samples.find((s) => s.id === 'honest');
  const documents = sample.documents.map((doc) => (doc.type === 'timesheet'
    ? { ...doc, text: doc.text.replace('| 8.00  | signed K. Vogelsang', '| 8.00  | signed T. Brzezina') }
    : doc));
  const { input } = assembleCaseInput(await extractDocuments(documents, { provider: offline }));
  const expected = {
    en: 'the timesheet for this day is signed by T. Brzezina, not by the site manager',
    de: 'der Stundenzettel für diesen Tag ist von T. Brzezina unterschrieben, nicht von der Bauleitung',
    pl: 'karta pracy za ten dzień jest podpisana przez T. Brzezina, a nie przez kierownika budowy',
    uk: 'табель за цей день підписав T. Brzezina, а не керівник будівництва',
  };
  for (const [language, phrase] of Object.entries(expected)) {
    const facts = buildMessageFacts({ contract: { ...input.contract, language }, invoice: input.invoice, verification: verifyCase(input) });
    const text = templateMessage(facts);
    assert.ok(text.includes(phrase), `${language}: ${text}`);
    assert.deepEqual(factCheckMessage(text, facts), []);
  }
});
