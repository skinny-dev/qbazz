import { formatMoney, toMinor } from '../util/money.js';
import { LOCALES, normalizeLocale, translate } from '../i18n/index.js';
import { telegramFetch } from '../util/telegramFetch.js';
import { toLatinDigits } from '../util/digits.js';

/**
 * A provider's own overload response ("high demand", 429, 503) says outright
 * that it is temporary — worth one or two short waits before giving up to the
 * template, rather than degrading a seller's very first attempt over a blip
 * that would have cleared in a couple of seconds.
 */
const RETRYABLE_ERROR = /high demand|overloaded|rate.?limit|try again|503|429/i;

async function withRetry(fn, { attempts = 3, delayMs = 1200 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !RETRYABLE_ERROR.test(err.message)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

/**
 * Listing generation: turns a bare product into something worth posting.
 *
 * Given a title, a price and whatever else the seller bothered to type, it
 * writes the channel caption, proposes structured properties (size, material,
 * weight — the things buyers ask in DMs), and returns a short analysis the
 * seller can act on.
 *
 * Four providers:
 *   anthropic — Claude, via the Messages API.
 *   openai    — GPT, via the Chat Completions API.
 *   gemini    — Gemini, via the generateContent REST API. Its `responseSchema`
 *               dialect does not support `additionalProperties` or a `type`
 *               array for nullable fields, so its schema is derived from the
 *               shared one via `toGeminiSchema` rather than written by hand.
 *               It also cannot fetch an external image URL itself, unlike the
 *               other two — the photo is downloaded and sent as inline base64.
 *   template  — deterministic, offline, no key. Always available.
 *
 * Whichever real provider is picked, an explicit setting wins; otherwise
 * whichever key (or injected test client) is present decides, in the order
 * anthropic, openai, gemini.
 *
 * All three real providers are asked for exactly the same JSON shape
 * (`LISTING_SCHEMA` / `EXTRACT_SCHEMA` below) and normalised through the same
 * functions, so everything downstream — credit metering, the merge logic in
 * the bot, the tests — is provider-agnostic. Only the `call*` functions know
 * that the request/response envelope differs between them.
 *
 * The template provider is not a stub: a seller with no API key still gets a
 * formatted post. The AI ones make it better, neither is load-bearing.
 */
export function createAiService(ctx) {
  const { config, log, services } = ctx;
  const settings = config.ai || {};
  let anthropicClient = null;
  let anthropicClientPromise = null;
  const aiFetch = telegramFetch(settings.proxy);

  // An explicit `provider` wins. Otherwise, whichever key (or injected test
  // client) is actually present decides — Anthropic first if more than one
  // is set, since that is what this codebase was originally built against.
  const provider = settings.provider
    || (settings.apiKey || settings.client ? 'anthropic'
      : (settings.apiKeyOpenAI || settings.clientOpenAI) ? 'openai'
        : (settings.apiKeyGemini || settings.clientGemini) ? 'gemini'
          : 'template');

  /** Loaded on first use — the SDK is an optional dependency. */
  async function getAnthropicClient() {
    // A caller may inject a client (tests, or a pre-configured SDK instance).
    if (settings.client) return settings.client;
    if (anthropicClient) return anthropicClient;
    if (!anthropicClientPromise) {
      anthropicClientPromise = (async () => {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        return new Anthropic({ apiKey: settings.apiKey });
      })();
    }
    anthropicClient = await anthropicClientPromise;
    return anthropicClient;
  }

  /** OpenAI has no required SDK here — a plain `fetch` to Chat Completions, unless a test injects a client. */
  async function callOpenAIChat(payload) {
    if (settings.clientOpenAI) return settings.clientOpenAI.chat.completions.create(payload);
    const res = await aiFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.apiKeyOpenAI}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `OpenAI request failed (${res.status})`);
    return data;
  }

  /**
   * Gemini's `generateContent`, called directly — the key goes in the query
   * string, not a header, which is this provider's own convention. Returns
   * the raw JSON text plus token usage; the caller parses and normalises it.
   */
  async function callGeminiGenerate({ systemPrompt, parts, schema, maxOutputTokens }) {
    if (settings.clientGemini) return settings.clientGemini.generateContent({ model: settings.modelGemini, systemPrompt, parts, schema });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.modelGemini}:generateContent?key=${settings.apiKeyGemini}`;
    const res = await aiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `Gemini request failed (${res.status})`);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error(data.promptFeedback?.blockReason ? `Gemini blocked the request (${data.promptFeedback.blockReason})` : 'No content in Gemini response');
    return { text, usage: { inputTokens: data.usageMetadata?.promptTokenCount, outputTokens: data.usageMetadata?.candidatesTokenCount } };
  }

  /**
   * Unlike Claude and OpenAI, Gemini's `generateContent` cannot fetch an
   * external image URL on its own — the image has to be downloaded and sent
   * as inline base64. A fetch failure here loses the photo, not the whole
   * request: better to extract from the text alone than fail outright.
   */
  async function fetchImageAsInlinePart(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const mimeType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
      return { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } };
    } catch (err) {
      log.warn(`Gemini could not fetch the product photo (${err.message}); continuing on text alone`);
      return null;
    }
  }

  /**
   * `draft` is what the seller has so far; the result is a suggestion they
   * review before anything is posted. Nothing here writes to the product.
   */
  async function generateListing({ product, store, locale = null, language = null, tone = 'friendly', notes = null }) {
    // The listing is written in the shop's language, which is its owner's.
    const loc = normalizeLocale(locale || store?.locale || config.platform.defaultLocale);
    const writeIn = language || LOCALES[loc].aiName;
    const facts = describe(product, store, loc, notes);
    // The product's own photo, when it has one — read alongside the facts so
    // the hook and caption reflect what the item actually looks like, not
    // just what the seller typed. `telegramFileIds` are not fetchable URLs,
    // so only `images` (a resolved `getFile` URL, or a web upload) counts.
    const photo = product.images?.[0] || null;

    if (provider === 'template') return templateListing(product, store, loc);

    // AI credits (the same shared pool a mockup spends from) gate the paid
    // path only. A plan with none left this period still gets a real post —
    // the offline template — never nothing; the credit just decides which
    // writer gets to try first.
    if (store?.ownerAccountId && services?.subscriptions) {
      const allowed = await services.subscriptions.checkLimit(store.ownerAccountId, 'aiCredits').then(() => true, () => false);
      if (!allowed) return { ...templateListing(product, store, loc), degraded: true, error: 'AI credits exhausted' };
    }

    try {
      const result = await withRetry(() => provider === 'openai' ? callOpenAIListing({ facts, photo, language: writeIn, locale: loc, tone, product })
        : provider === 'gemini' ? callGeminiListing({ facts, photo, language: writeIn, locale: loc, tone, product })
          : callClaudeListing({ facts, photo, language: writeIn, locale: loc, tone, product }));
      // Spent only on a listing that actually came back — a failed call
      // already falls through to the free template below, so it should
      // never cost the seller a credit.
      if (store?.ownerAccountId && services?.subscriptions) {
        await services.subscriptions.consume(store.ownerAccountId, 'aiCredits').catch(() => null);
      }
      const modelUsed = provider === 'openai' ? settings.modelOpenAI : provider === 'gemini' ? settings.modelGemini : settings.model;
      return { ...result, provider, model: modelUsed, locale: loc };
    } catch (err) {
      // A seller waiting to post should never be blocked by our API bill.
      log.warn(`AI listing generation failed (${err.message}); using template`);
      return { ...templateListing(product, store, loc), degraded: true, error: err.message };
    }
  }

  function listingSystemPrompt(language, tone, locale) {
    return [
      'You write product listings for Qbazz, a marketplace where shops sell through Telegram channels.',
      `Write in ${language}. Tone: ${tone}. Keep it plain and concrete — a shopkeeper describing their own goods, not marketing copy.`,
      'Never invent facts, in the hook, the caption or the properties. If a material, size, origin or color was not stated or clearly visible in the photo, either omit it or mark the property confident: false. A hook may frame what is genuinely there (a trend, a look, a use) — it may never claim a fact that is not.',
      'Write for search as well as for reading: work the product\'s real category, material, use case and audience naturally into the hook and caption, the way a well-optimised e-commerce listing does — never as a stuffed keyword list, and never a fact that is not actually true of this item.',
      'Read the photo (and the facts) for the standard attributes a real online store lists, and add any you can actually determine as properties — typically brand, category, material, color, size/fit and condition (new/used) — alongside whatever else is specific to this kind of product. Skip any you cannot determine; do not guess a brand or size that is not visible or stated.',
      'Caption: a real product description, not a one-liner — a short paragraph or a couple of scannable sentences covering what it is, what it is made of or how it is used, and who it suits. Grounded in the facts and photo only.',
      'Write it, do not quote it: never copy the seller\'s own lines into the caption verbatim, and never just restate a fact that is already its own property or already in the price line (color, price, sizing) — the caption\'s job is what the properties and price cannot say: the item\'s character, look and use. If the seller left description empty, read it entirely from the photo — a bare title and a photo is enough to write one.',
      'Do not mention the price, discounts, shipping or "click here" in the hook or caption — the app adds those separately.',
      'No hashtags and no emoji inside the caption or hook text itself — the app adds the hashtag line and its own icons around what you write.',
      'Tags are the searchable keywords customers would actually type to find this item — brand, model, category, material, style, use case, audience — the same words a shopper searches, not generic filler.',
      'Everything you return is shown to the shopkeeper and their customers, so write the hook, caption, property names and values, tags and the analysis in that same language.',
      ...(locale === 'fa' ? PERSIAN_STYLE : []),
    ].join('\n');
  }

  async function callClaudeListing({ facts, photo, language, locale, tone, product }) {
    const anthropic = await getAnthropicClient();
    const content = [{ type: 'text', text: facts }];
    // The Messages API fetches an image given as a URL directly — no download
    // or base64 step needed here, same as `callClaudeExtract`.
    if (photo) content.unshift({ type: 'image', source: { type: 'url', url: photo } });

    const response = await anthropic.messages.create({
      model: settings.model,
      max_tokens: 2000,
      // A product caption is a short, well-specified task: low effort is the
      // right trade, and it keeps the seller's wait down.
      output_config: { effort: 'low', format: { type: 'json_schema', schema: LISTING_SCHEMA } },
      system: listingSystemPrompt(language, tone, locale),
      messages: [{ role: 'user', content }],
    });

    // output_config.format guarantees the first text block is valid JSON.
    const text = response.content.find((block) => block.type === 'text')?.text;
    if (!text) throw new Error('No text block in response');
    return normalizeListingResult(JSON.parse(text), product, {
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });
  }

  async function callOpenAIListing({ facts, photo, language, locale, tone, product }) {
    const content = [{ type: 'text', text: facts }];
    if (photo) content.push({ type: 'image_url', image_url: { url: photo } });

    const data = await callOpenAIChat({
      model: settings.modelOpenAI,
      max_tokens: 2000,
      response_format: { type: 'json_schema', json_schema: { name: 'product_listing', strict: true, schema: LISTING_SCHEMA } },
      messages: [
        { role: 'system', content: listingSystemPrompt(language, tone, locale) },
        { role: 'user', content },
      ],
    });

    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('No content in OpenAI response');
    return normalizeListingResult(JSON.parse(text), product, {
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
    });
  }

  async function callGeminiListing({ facts, photo, language, locale, tone, product }) {
    const parts = [{ text: facts }];
    if (photo) {
      const imagePart = await fetchImageAsInlinePart(photo);
      if (imagePart) parts.unshift(imagePart);
    }
    const { text, usage } = await callGeminiGenerate({
      systemPrompt: listingSystemPrompt(language, tone, locale),
      parts,
      schema: GEMINI_LISTING_SCHEMA,
      maxOutputTokens: 2000,
    });
    return normalizeListingResult(JSON.parse(text), product, usage);
  }

  /**
   * A channel's own post, turned into a product — the reverse of
   * `generateListing`. Returns `null` when the post plainly is not a single
   * product for sale (a greeting, an announcement, "back in stock soon"), so
   * a shop's ordinary chatter never litters its catalogue.
   *
   * A post with real content but no readable price is *not* null: it comes
   * back with `price: null`, which the caller lists as "price on request"
   * rather than skipping it or blocking on the seller. A wrong price is the
   * one thing worth pausing for; everything else is worth listing as-is and
   * fixing later.
   */
  async function extractProductFromPost({ text = '', photo = null, store, locale = null }) {
    const loc = normalizeLocale(locale || store?.locale || config.platform.defaultLocale);
    const cleanText = String(text || '').trim();
    if (!cleanText && !photo) return null;

    if (provider === 'template') return templateExtraction(cleanText, photo, store, loc);

    try {
      const result = await withRetry(() => provider === 'openai' ? callOpenAIExtract({ text: cleanText, photo, store, locale: loc })
        : provider === 'gemini' ? callGeminiExtract({ text: cleanText, photo, store, locale: loc })
          : callClaudeExtract({ text: cleanText, photo, store, locale: loc }));
      return result && { ...result, provider };
    } catch (err) {
      log.warn(`AI post extraction failed (${err.message}); using the offline reader`);
      return templateExtraction(cleanText, photo, store, loc);
    }
  }

  /**
   * The same reading, but never through AI — for a seller who wants to type
   * the replacement themselves and have it taken at face value, not
   * rewritten. Always the deterministic template reader, key or no key.
   */
  function extractProductManually({ text = '', store, locale = null }) {
    const loc = normalizeLocale(locale || store?.locale || config.platform.defaultLocale);
    const cleanText = String(text || '').trim();
    if (!cleanText) return null;
    return templateExtraction(cleanText, null, store, loc);
  }

  function extractSystemPrompt(writeIn) {
    return [
      `You read a shop's Telegram channel post and decide whether it is selling one specific item.`,
      `Extract in ${writeIn}, the post's own language — do not translate it.`,
      'Never invent a price: only report one that the post actually states or clearly implies (a number next to a currency word). Vague wording ("negotiable", "DM me", no number at all) means price: null, not a guess.',
      'Never invent facts for the description or properties either — reflect only what the post (and, if given, the photo) actually shows or says.',
    ].join('\n');
  }

  async function callClaudeExtract({ text, photo, store, locale }) {
    const anthropic = await getAnthropicClient();
    const writeIn = LOCALES[locale].aiName;

    const content = [{ type: 'text', text: text || '(no caption — judge from the photo alone)' }];
    // The Messages API fetches an image given as a URL directly — no download
    // or base64 step needed here.
    if (photo) content.unshift({ type: 'image', source: { type: 'url', url: photo } });

    const response = await anthropic.messages.create({
      model: settings.model,
      max_tokens: 1500,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: EXTRACT_SCHEMA } },
      system: extractSystemPrompt(writeIn),
      messages: [{ role: 'user', content }],
    });

    const block = response.content.find((b) => b.type === 'text')?.text;
    if (!block) throw new Error('No text block in response');
    return normalizeExtractResult(JSON.parse(block), store);
  }

  async function callOpenAIExtract({ text, photo, store, locale }) {
    const writeIn = LOCALES[locale].aiName;
    const content = [{ type: 'text', text: text || '(no caption — judge from the photo alone)' }];
    if (photo) content.push({ type: 'image_url', image_url: { url: photo } });

    const data = await callOpenAIChat({
      model: settings.modelOpenAI,
      max_tokens: 1500,
      response_format: { type: 'json_schema', json_schema: { name: 'product_extraction', strict: true, schema: EXTRACT_SCHEMA } },
      messages: [
        { role: 'system', content: extractSystemPrompt(writeIn) },
        { role: 'user', content },
      ],
    });

    const text2 = data.choices?.[0]?.message?.content;
    if (!text2) throw new Error('No content in OpenAI response');
    return normalizeExtractResult(JSON.parse(text2), store);
  }

  async function callGeminiExtract({ text, photo, store, locale }) {
    const writeIn = LOCALES[locale].aiName;
    const parts = [{ text: text || '(no caption — judge from the photo alone)' }];
    if (photo) {
      const imagePart = await fetchImageAsInlinePart(photo);
      if (imagePart) parts.unshift(imagePart);
    }
    const { text: resultText } = await callGeminiGenerate({
      systemPrompt: extractSystemPrompt(writeIn),
      parts,
      schema: GEMINI_EXTRACT_SCHEMA,
      maxOutputTokens: 1500,
    });
    return normalizeExtractResult(JSON.parse(resultText), store);
  }

  /**
   * Rewrites a product's title and description the way a search engine - and a buyer who arrives from one - wants to
   * read it, and prepares the page metadata (title tag, meta description, keywords, image alt text).
   *
   * It never invents: a material, size or origin that was not given stays unsaid. With no AI available, or no credits
   * left, the offline "rules" writer still produces a clean, structured version from what is known.
   */
  async function optimizeListing({ product, store, categoryName = '', locale = null }) {
    const loc = normalizeLocale(locale || store?.locale || config.platform.defaultLocale);
    const writeIn = LOCALES[loc].aiName;
    const facts = [describe(product, store, loc), categoryName ? `Category: ${categoryName}` : null].filter(Boolean).join('\n');
    const rules = () => rulesSeo(product, store, loc, categoryName);
    if (provider === 'template') return rules();

    if (store?.ownerAccountId && services?.subscriptions) {
      const allowed = await services.subscriptions.checkLimit(store.ownerAccountId, 'aiCredits').then(() => true, () => false);
      if (!allowed) return { ...rules(), degraded: true, error: 'AI credits exhausted' };
    }
    try {
      const photo = product.images?.[0] || null;
      const raw = await withRetry(() => callStructured({ system: seoSystemPrompt(writeIn, loc), text: facts, photo, schema: SEO_SCHEMA, geminiSchema: GEMINI_SEO_SCHEMA, name: 'seo_listing', maxTokens: 2500 }));
      if (store?.ownerAccountId && services?.subscriptions) await services.subscriptions.consume(store.ownerAccountId, 'aiCredits').catch(() => null);
      const modelUsed = provider === 'openai' ? settings.modelOpenAI : provider === 'gemini' ? settings.modelGemini : settings.model;
      return { ...normalizeSeoResult(raw, product), provider, model: modelUsed, locale: loc };
    } catch (err) {
      log.warn(`AI SEO optimisation failed (${err.message}); using the offline rules`);
      return { ...rules(), degraded: true, error: err.message };
    }
  }

  function seoSystemPrompt(language, locale) {
    return [
      'You are an e-commerce SEO editor for Qbazz, an online shop builder. You rewrite one product listing so it ranks well on Google and converts the people who arrive from it.',
      `Write in ${language}. Plain, concrete, helpful - the way a good shop describes goods, not hype.`,
      'Follow Google\'s guidance for product pages: original, helpful, people-first copy that answers what a buyer wants to know; a title that names the product first (type, key attribute) and is readable on its own; no keyword stuffing, no ALL CAPS, no emoji, no "best/cheapest" claims, no price or shipping promises in titles or descriptions.',
      'NEVER invent facts. Material, size, color, origin, warranty, brand, or use that the seller did not state (or that is not clearly visible in the photo) must not appear. If something important is missing, leave it out and list it in "missing" so the seller can add it.',
      'title: at most 70 characters; the primary search phrase near the start (what the product is + its main attribute), no shop name unless it is the brand.',
      'description: structured plain text. 1) an opening paragraph of 2-3 sentences that states what the product is and who/what it suits, with the main phrase within the first 100 characters; 2) a blank line; 3) a short heading line, then 3-6 scannable bullet lines each starting with "• " covering only stated or visible facts (material, sizes, colors, fit, care, use); 4) optionally one closing sentence on use or care if facts allow. Roughly 350-1100 characters; shorter if few facts exist - never pad.',
      'metaTitle: at most 60 characters, for the search-result title (product + key attribute + shop or category). metaDescription: at most 155 characters, one sentence naming the product, its main benefit and a soft invitation, no price.',
      'keywords: 3-8 lowercase phrases a shopper would really type (product type, material, style, use, audience). imageAlt: at most 125 characters describing the photo/product literally for accessibility and image search.',
      'changes: 2-5 short notes (in the same language) saying what you improved. missing: facts that would make the page rank and sell better, most important first (empty if complete).',
      ...(locale === 'fa' ? PERSIAN_STYLE : []),
    ].join('\n');
  }

  /** One structured-JSON call to whichever provider is configured. */
  async function callStructured({ system, text, photo, schema, geminiSchema, name, maxTokens }) {
    if (provider === 'openai') {
      const content = [{ type: 'text', text }];
      if (photo) content.push({ type: 'image_url', image_url: { url: photo } });
      const data = await callOpenAIChat({
        model: settings.modelOpenAI,
        max_tokens: maxTokens,
        response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
        messages: [{ role: 'system', content: system }, { role: 'user', content }],
      });
      const out = data.choices?.[0]?.message?.content;
      if (!out) throw new Error('No content in OpenAI response');
      return JSON.parse(out);
    }
    if (provider === 'gemini') {
      const parts = [{ text }];
      if (photo) { const image = await fetchImageAsInlinePart(photo); if (image) parts.unshift(image); }
      const { text: out } = await callGeminiGenerate({ systemPrompt: system, parts, schema: geminiSchema, maxOutputTokens: maxTokens });
      return JSON.parse(out);
    }
    const anthropic = await getAnthropicClient();
    const content = [{ type: 'text', text }];
    if (photo) content.unshift({ type: 'image', source: { type: 'url', url: photo } });
    const response = await anthropic.messages.create({
      model: settings.model,
      max_tokens: maxTokens,
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content }],
    });
    const out = response.content.find((block) => block.type === 'text')?.text;
    if (!out) throw new Error('No text block in response');
    return JSON.parse(out);
  }

  return {
    optimizeListing, generateListing, extractProductFromPost, extractProductManually, provider,
    get enabled() { return provider === 'anthropic' || provider === 'openai' || provider === 'gemini'; },
  };
}

// ---------------------------------------------------------------------------
// Shared request/response shapes — identical for whichever real provider is
// asked, so the schema and its normalisation are written once.

const LISTING_SCHEMA = {
  type: 'object',
  properties: {
    hook: { type: 'string', description: 'One short attention-grabbing opening line — a trend, a use case, a standout trait. Empty string if the item genuinely has nothing hook-worthy; never force excitement onto something ordinary.' },
    caption: { type: 'string', description: 'A real, SEO-aware product description — a short paragraph or a couple of scannable sentences, not one line: what it is, what it is made of or how it is used, and who it suits, working in the product\'s real category and use case naturally. No price, no call to action, no hashtags — those are added separately.' },
    headline: { type: 'string', description: 'A punchier version of the product title, 60 characters or fewer.' },
    properties: {
      type: 'array',
      description: 'Structured specifications a buyer would ask about, in the standard shape a real online store lists — brand, category, material, color, size/fit and condition (new/used) where determinable, plus anything else specific to this kind of product. Only include ones supported by the facts (and the photo, if given); skip the rest rather than guessing.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          value: { type: 'string' },
          confident: { type: 'boolean', description: 'False when inferred (e.g. from the photo) rather than stated outright.' },
        },
        required: ['name', 'value', 'confident'],
        additionalProperties: false,
      },
    },
    tags: { type: 'array', items: { type: 'string' }, description: 'SEO/discovery keywords for the post\'s hashtag line — the actual words a shopper would search: brand, model, category, material, style, use case, audience. Lowercase, 3-8 of them, one or two words each.' },
    analysis: {
      type: 'object',
      properties: {
        missing: { type: 'array', items: { type: 'string' }, description: 'What the listing still lacks, most important first.' },
        note: { type: 'string', description: 'One sentence of advice for the seller.' },
      },
      required: ['missing', 'note'],
      additionalProperties: false,
    },
  },
  required: ['hook', 'caption', 'headline', 'properties', 'tags', 'analysis'],
  additionalProperties: false,
};

function normalizeListingResult(data, product, usage) {
  return {
    hook: String(data.hook || '').trim().slice(0, 120),
    caption: String(data.caption || '').trim(),
    headline: String(data.headline || product.title).trim().slice(0, 140),
    properties: (data.properties || []).slice(0, 12).map((p) => ({
      name: String(p.name).slice(0, 40),
      value: String(p.value).slice(0, 80),
      confident: p.confident !== false,
    })),
    tags: (data.tags || []).slice(0, 8).map((t) => String(t).toLowerCase().slice(0, 30)),
    analysis: {
      missing: (data.analysis?.missing || []).slice(0, 5).map((m) => String(m).slice(0, 120)),
      note: String(data.analysis?.note || '').slice(0, 300),
    },
    usage,
  };
}

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    isProduct: { type: 'boolean', description: 'True only if this post is offering one specific item for sale. False for a greeting, an announcement, a repost, a "coming soon", or anything without a clear single item.' },
    title: { type: 'string', description: 'A short product title, in the post\'s own language.' },
    description: { type: 'string', description: 'The rest of what the post says about the item, cleaned up. Do not invent facts.' },
    price: { type: ['number', 'null'], description: 'The price as a plain number in the shop\'s major unit (e.g. Toman, not Rial), or null if none is stated or it is only "DM for price" / negotiable.' },
    stock: { type: ['integer', 'null'], description: 'How many units are available, only if a specific count is stated (e.g. "5 left", "موجودی: ۳ عدد"). Null if not mentioned — never guess a number, and "in stock" with no count is still null.' },
    properties: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, value: { type: 'string' } },
        required: ['name', 'value'],
        additionalProperties: false,
      },
    },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['isProduct', 'title', 'description', 'price', 'stock', 'properties', 'tags'],
  additionalProperties: false,
};

/**
 * Gemini's `responseSchema` is a restricted OpenAPI-style dialect: no
 * `additionalProperties`, and a nullable field is `{type: X, nullable: true}`
 * rather than `type: [X, 'null']`. Deriving it from the shared schema means
 * the three providers can never quietly drift out of sync with each other.
 */
function toGeminiSchema(schema) {
  if (Array.isArray(schema.type)) {
    const real = schema.type.find((t) => t !== 'null');
    const { type, ...rest } = schema;
    return { ...toGeminiSchema({ ...rest, type: real }), nullable: schema.type.includes('null') };
  }
  const { additionalProperties, ...rest } = schema;
  if (rest.properties) rest.properties = Object.fromEntries(Object.entries(rest.properties).map(([key, value]) => [key, toGeminiSchema(value)]));
  if (rest.items) rest.items = toGeminiSchema(rest.items);
  return rest;
}

const GEMINI_LISTING_SCHEMA = toGeminiSchema(LISTING_SCHEMA);

const SEO_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Product title for the page, at most 70 characters, main search phrase first.' },
    description: { type: 'string', description: 'Structured plain-text description: opening paragraph, blank line, a heading line, then bullet lines starting with "• ". Facts only.' },
    metaTitle: { type: 'string', description: 'Search-result title, at most 60 characters.' },
    metaDescription: { type: 'string', description: 'Search-result snippet, at most 155 characters, no price.' },
    keywords: { type: 'array', items: { type: 'string' }, description: '3-8 lowercase phrases shoppers type.' },
    imageAlt: { type: 'string', description: 'Literal alt text for the main photo, at most 125 characters.' },
    changes: { type: 'array', items: { type: 'string' }, description: 'What was improved, in short notes.' },
    missing: { type: 'array', items: { type: 'string' }, description: 'Facts that would help the page and are not yet known.' },
  },
  required: ['title', 'description', 'metaTitle', 'metaDescription', 'keywords', 'imageAlt', 'changes', 'missing'],
  additionalProperties: false,
};
const GEMINI_SEO_SCHEMA = toGeminiSchema(SEO_SCHEMA);

const clip = (text, max) => {
  const value = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), Math.floor(max * 0.6))).trim()}…`;
};

function normalizeSeoResult(raw, product) {
  const keywords = [...new Set((raw.keywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean))].slice(0, 8);
  const description = String(raw.description || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    title: clip(raw.title, 70) || product.title,
    // A reply with an empty description must not wipe the seller's own words.
    description: description.slice(0, 3900) || product.description || '',
    seo: {
      metaTitle: clip(raw.metaTitle || raw.title, 60),
      metaDescription: clip(raw.metaDescription, 155),
      keywords,
      imageAlt: clip(raw.imageAlt, 125),
    },
    changes: (raw.changes || []).map((c) => clip(c, 160)).slice(0, 6),
    missing: (raw.missing || []).map((c) => clip(c, 160)).slice(0, 6),
  };
}

/**
 * The offline writer: tidies what the seller typed and lays it out the same way the AI does - an opening, then the
 * known facts as bullets - without adding a word of its own about the product.
 */
function rulesSeo(product, store, locale, categoryName) {
  const t = (key, params) => translate(locale, key, params);
  const tidy = (text) => String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const title = clip(tidy(product.title).replace(/\s+/g, ' '), 70);
  const intro = tidy(product.description);
  const facts = (product.properties || []).filter((p) => p?.name && p?.value).map((p) => `• ${p.name}: ${p.value}`);
  const description = [intro, facts.length ? `${t('ai.seo.features')}\n${facts.join('\n')}` : ''].filter(Boolean).join('\n\n');
  const shop = store?.name ? ` | ${store.name}` : '';
  const first = intro.split(/(?<=[.!؟?])\s/)[0] || '';
  const missing = [];
  if (!intro) missing.push(t('ai.missing.description'));
  if (!product.images?.length) missing.push(t('ai.missing.photo'));
  if (!facts.length) missing.push(t('ai.seo.missing_facts'));
  return {
    title,
    description,
    seo: {
      metaTitle: clip(`${title}${shop}`, 60),
      metaDescription: clip(first || `${title}${categoryName ? ` — ${categoryName}` : ''}${store?.name ? ` · ${store.name}` : ''}`, 155),
      keywords: [...new Set([...(product.tags || []), categoryName, ...title.split(' ').filter((w) => w.length > 2)].filter(Boolean).map((k) => String(k).toLowerCase()))].slice(0, 8),
      imageAlt: clip(title, 125),
    },
    changes: [t('ai.seo.rules_note')],
    missing,
    provider: 'rules',
    locale,
  };
}
const GEMINI_EXTRACT_SCHEMA = toGeminiSchema(EXTRACT_SCHEMA);

function normalizeExtractResult(data, store) {
  if (!data.isProduct) return null;
  return {
    title: String(data.title || '').trim().slice(0, 140) || null,
    description: String(data.description || '').trim().slice(0, 4000),
    price: typeof data.price === 'number' && Number.isFinite(data.price) ? toMinor(data.price, store?.currency) : null,
    stock: typeof data.stock === 'number' && Number.isInteger(data.stock) && data.stock >= 0 ? data.stock : null,
    properties: (data.properties || []).slice(0, 12).map((p) => ({ name: String(p.name).slice(0, 40), value: String(p.value).slice(0, 80), confident: true })),
    tags: (data.tags || []).slice(0, 8).map((t) => String(t).toLowerCase().slice(0, 30)),
  };
}

function describe(product, store, locale = 'en', notes = null) {
  const lines = [
    `Product: ${product.title}`,
    product.price != null ? `Price: ${formatMoney(product.price, product.currency, locale)}` : 'Price: not set yet (price on request) — do not mention a price.',
    product.description ? `Seller's description: ${product.description}` : 'Seller wrote no description.',
    product.tags?.length ? `Tags: ${product.tags.join(', ')}` : null,
    product.stock !== null && product.stock !== undefined ? `Stock: ${product.stock}` : null,
    product.properties?.length ? `Known properties: ${product.properties.map((p) => `${p.name}: ${p.value}`).join('; ')}` : null,
    store ? `Shop: ${store.name}${store.tagline ? ` — ${store.tagline}` : ''}` : null,
    store?.description ? `Shop description: ${store.description}` : null,
    store?.location?.city ? `Located in: ${store.location.city}` : null,
    // The seller's own follow-up, asked for on purpose (the "add detail"
    // button) — treat it as authoritative, the same as their own description.
    notes ? `Additional details from the seller, to fold in: ${notes}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * Offline fallback. Deliberately conservative: it reformats what the seller
 * gave us and points out what is missing, rather than inventing prose. Its own
 * wording (the "missing" list, the note) is in the shop's language; the
 * seller's text is passed through untouched, in whatever language they wrote.
 */
function templateListing(product, store, locale = 'en') {
  const t = (key, params) => translate(locale, key, params);
  const description = (product.description || '').trim();
  // No description to reformat and nothing to invent — leave the caption
  // empty rather than filling it with the shop's city, which says nothing
  // about the product and is already shown on the shop's own row.
  const caption = description ? description.split(/\n+/).slice(0, 3).join('\n') : '';

  const missing = [];
  if (!description) missing.push(t('ai.missing.description'));
  if (!product.images?.length) missing.push(t('ai.missing.photo'));
  if (!product.tags?.length) missing.push(t('ai.missing.tags'));
  if (product.stock === null || product.stock === undefined) missing.push(t('ai.missing.stock'));

  return {
    // No AI, no invented enthusiasm — a formulaic "trending now!" on every
    // offline-generated post would be a claim the template cannot back up.
    hook: null,
    caption,
    headline: product.title,
    properties: product.properties || [],
    tags: product.tags || [],
    analysis: {
      missing,
      note: missing.length
        ? t('ai.note.missing')
        : t('ai.note.ok'),
    },
    provider: 'template',
  };
}

/**
 * Offline fallback for `extractProductFromPost`. No vision, so a photo with no
 * caption cannot be read at all — it is skipped rather than titled with a
 * guess. Text is read with a small, deliberately narrow heuristic: a currency
 * word next to a number is a price, a first line with real content is a
 * title. It would rather miss a price than invent one.
 */
const NON_PRODUCT_PHRASES = [
  /^سلام/, /^خوش\s?آمدید/, /به\s?زودی/, /بزودی/, /تعطیل/, /اطلاعیه/, /^ممنون/, /^تشکر/,
  /^hi\b/i, /^hello\b/i, /coming soon/i, /welcome/i, /thank you/i, /closed\b/i,
];
const PRICE_WORD = /تومان|تومن|ریال|﷼|\btoman\b|\brial\b|\$/i;
const STOCK_WORD = /موجودی|تعداد|عدد موجود|باقی\s?مانده|\bstock\b|\bqty\b|\bunits?\s+left\b|\bleft\b/i;
// "۳۰۰ هزار تومان" is 300,000, not 300 — a seller writing a price this way
// (extremely common in Persian) must not be read as one-thousandth of what
// they meant. "میلیون" (million) is the same trap one order of magnitude up.
const THOUSAND_WORD = /هزار/;
const MILLION_WORD = /میلیون/;

function templateExtraction(text, photo, store, locale) {
  if (!text) return null; // a bare photo needs vision to read — nothing to guess from offline

  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;

  const looksLikeChatter = lines.length === 1 && lines[0].length < 40 && NON_PRODUCT_PHRASES.some((rx) => rx.test(lines[0]));
  if (looksLikeChatter) return null;

  let price = null;
  let priceLineIndex = -1;
  lines.forEach((line, index) => {
    if (price !== null || !PRICE_WORD.test(line)) return;
    const digits = line.match(/[\d۰-۹٠-٩][\d۰-۹٠-٩٬،,.\s]*[\d۰-۹٠-٩]|[\d۰-۹٠-٩]/);
    if (!digits) return;
    let amount = Number(toLatinDigits(digits[0]).replace(/[٬،,\s]/g, ''));
    if (!Number.isFinite(amount)) return;
    if (THOUSAND_WORD.test(line)) amount *= 1000;
    else if (MILLION_WORD.test(line)) amount *= 1_000_000;
    price = toMinor(amount, store?.currency);
    priceLineIndex = index;
  });

  let stock = null;
  let stockLineIndex = -1;
  lines.forEach((line, index) => {
    if (stock !== null || !STOCK_WORD.test(line) || PRICE_WORD.test(line)) return; // a price line's number is not a count
    const digits = line.match(/[\d۰-۹٠-٩]+/);
    if (!digits) return;
    stock = Number(toLatinDigits(digits[0]));
    stockLineIndex = index;
  });

  const title = lines[0].replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s•\-–—]+/gu, '').trim().slice(0, 140);
  if (!title || title.length < 2) return null;

  // The price and stock lines are already structured fields — repeating them
  // verbatim in the description too just reads as broken, not thorough.
  const description = lines
    .filter((_line, index) => index !== 0 && index !== priceLineIndex && index !== stockLineIndex)
    .join('\n')
    .slice(0, 4000);

  return {
    title,
    description,
    price,
    stock,
    properties: [],
    tags: [],
    provider: 'template',
  };
}

/**
 * Persian is easy to get subtly wrong, and the failure is not an error — it is
 * copy that reads as machine-translated to the people it is meant to sell to.
 */
const PERSIAN_STYLE = [
  'Write natural, modern Iranian Persian as a shopkeeper would speak it — not a translation from English, and not stiff or bureaucratic.',
  'Use the half-space (نیم‌فاصله, U+200C) correctly in compounds and verb prefixes: می‌کنم، کیف‌پول، دست‌دوز.',
  'Use Persian punctuation (، ؛ ؟) and Persian digits (۰-۹).',
  'Keep brand names and model codes in their original Latin form, and write measurements the way Iranians do (سانتی‌متر، گرم، لیتر).',
  'Name properties the way a buyer would ask about them: جنس، اندازه، رنگ، وزن، گارانتی.',
];
