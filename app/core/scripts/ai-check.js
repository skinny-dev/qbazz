/**
 * Checks the AI keys with the smallest possible calls, the way the running core would make them (through the proxy when
 * one is configured):
 *
 *   node --env-file=../.env scripts/ai-check.js
 *
 * fashn.ai: asks for the credit balance (free, makes no image). Gemini / OpenAI: one tiny text request.
 * Keys are never printed.
 */
import { createCore } from '../src/index.js';
import { telegramFetch } from '../src/util/telegramFetch.js';

const core = await createCore();
const { ai, mockups } = core.config;
const aiFetch = telegramFetch(ai.proxy);
const say = (name, ok, detail) => console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${detail}`);
const brief = (text) => String(text).replace(/\s+/g, ' ').replace(/(AIza|sk-)[\w-]+/g, '<key>').slice(0, 140);

console.log(`provider: ${ai.provider || '(auto)'} | proxy for AI: ${ai.proxy || 'none'}`);

if (mockups.apiKey) {
  try {
    const res = await fetch(`${mockups.baseUrl}/credits`, { headers: { authorization: `Bearer ${mockups.apiKey}` }, signal: AbortSignal.timeout(20000) });
    const data = await res.json().catch(() => ({}));
    say('fashn.ai (mockups)', res.ok, res.ok ? `${data.credits?.total ?? '?'} credits left` : `HTTP ${res.status}`);
  } catch (err) { say('fashn.ai (mockups)', false, err.message); }
} else say('fashn.ai (mockups)', false, 'FASHN_API_KEY is not set');

if (ai.apiKeyGemini) {
  try {
    const res = await aiFetch(`https://generativelanguage.googleapis.com/v1beta/models/${ai.modelGemini}:generateContent?key=${ai.apiKeyGemini}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with the single word: ok' }] }] }),
    });
    const text = await res.text();
    say(`Gemini (${ai.modelGemini})`, res.ok, res.ok ? 'answered' : `HTTP ${res.status} ${brief(text)}${text.trimStart().startsWith('<') ? '  <- a web page, not an API answer: the request is blocked from this network (use the proxy)' : ''}`);
  } catch (err) { say('Gemini', false, err.message); }
} else say('Gemini', false, 'GEMINI_API_KEY is not set');

if (ai.apiKeyOpenAI) {
  try {
    const res = await aiFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${ai.apiKeyOpenAI}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ model: ai.modelOpenAI, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 5 }),
    });
    const text = await res.text();
    say(`OpenAI (${ai.modelOpenAI})`, res.ok, res.ok ? 'answered' : `HTTP ${res.status} ${brief(text)}`);
  } catch (err) { say('OpenAI', false, err.message); }
}
await core.close();
