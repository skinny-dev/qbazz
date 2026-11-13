import { COLLECTIONS } from '../models/schemas.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../util/ids.js';
import { translate } from '../i18n/index.js';
import { telegramFetch } from '../util/telegramFetch.js';

/**
 * Product mockups: turns a seller's own flat product photo into a photo of
 * it worn, via fashn.ai's "product-to-model" — an async job (`POST /v1/run`,
 * then poll `GET /v1/status/{id}`), same shape any provider in this family
 * uses. Each fashion category could in principle use a different mockup
 * provider; for now every category shares this one.
 *
 * `generateFromImage` is the primitive — it works on any photo, with or
 * without a product behind it yet, which is what lets the seller generate
 * mockups from the quick-add review screen before the product even exists.
 * `generateForProduct` is a thin wrapper for an existing product: it also
 * picks the right default prompt for the product's own category.
 *
 * Nothing here writes to a product on its own — the seller reviews the
 * results and chooses which (if any) to keep, same as a generated caption. An
 * AI credit — the same shared pool a generated caption spends from — is spent
 * per image actually delivered, never for a failed or timed-out job,
 * mirroring fashn.ai's own billing.
 */
export function createMockupsService(ctx) {
  const { config, log, events, store: db, services } = ctx;
  const settings = config.mockups || {};
  const enabled = Boolean(settings.apiKey || settings.client);
  const jobs = db.collection(COLLECTIONS.mockups);
  const promptsDb = db.collection(COLLECTIONS.platformSettings);
  const PROMPTS_ID = 'mockup-prompts';
  const MAX_PROMPT = 800;

  const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
  const asData = (type, buffer) => `data:${type};base64,${buffer.toString('base64')}`;

  /**
   * The photo as the provider can use it: sent as data, never as a link it would have to reach. A photo kept on this
   * server, one that came from a Telegram post (served through /media/tg, its address holds the bot token) and one on any
   * other site are all read here and handed over whole - a link to localhost, a private address, a hot-link-protected host
   * or an expiring one would otherwise fail on the provider's side with an error nobody can act on.
   */
  async function sourceFor(image) {
    const url = String(image || '');
    if (!url || url.startsWith('data:') || settings.client) return image;

    const own = /\/media\/u\/([A-Za-z0-9]+\.(?:jpg|png|webp))(?:[?#].*)?$/.exec(url);
    if (own) {
      const file = await services.uploads.read(own[1]);
      return file ? asData(file.type, file.buffer) : image;
    }

    let target = url;
    const tg = /\/media\/tg\?p=([^&#]+)/.exec(url);
    if (tg) {
      if (!config.telegram?.botToken) return image;
      target = `${String(config.telegram.apiBase || 'https://api.telegram.org').replace(/\/+$/, '')}/file/bot${config.telegram.botToken}/${decodeURIComponent(tg[1])}`;
    } else if (!/^https?:\/\//i.test(url)) return image;

    try {
      const res = await (tg ? telegramFetch(config.telegram.proxy) : fetch)(target, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return image;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length || buffer.length > MAX_SOURCE_BYTES) return image;
      const type = (res.headers.get('content-type') || '').split(';')[0].trim();
      return asData(/^image\/(jpeg|png|webp)$/.test(type) ? type : 'image/jpeg', buffer);
    } catch (err) {
      log.warn(`mockup source photo not read (${err.message}); the link is sent as it is`);
      return image;
    }
  }

  /** The provider's result links expire; a copy is kept on this server so the product keeps its photo. */
  async function keep(accountId, url) {
    if (settings.client) return url;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return url;
      const saved = await services.uploads.saveImage(accountId, Buffer.from(await res.arrayBuffer()).toString('base64'));
      return saved.url;
    } catch (err) {
      log.warn(`mockup result not kept (${err.message}); the provider's link is used`);
      return url;
    }
  }

  /** A caller may inject a fake client (tests); otherwise this hits fashn.ai for real. */
  function client() {
    if (settings.client) return settings.client;
    const headers = { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' };
    return {
      async run(inputs) {
        const res = await fetch(`${settings.baseUrl}/run`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model_name: 'product-to-model', inputs }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || `fashn.ai run failed (${res.status})`);
        return data.id;
      },
      async status(jobId) {
        const res = await fetch(`${settings.baseUrl}/status/${jobId}`, { headers });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`fashn.ai status failed (${res.status})`);
        return data;
      },
    };
  }

  /** Waits for the provider; one failed look at its status (a dropped connection) is not the end of the job. */
  async function poll(c, jobId) {
    const deadline = Date.now() + settings.timeoutMs;
    let misses = 0;
    while (Date.now() < deadline) {
      let data = null;
      try {
        data = await c.status(jobId);
        misses = 0;
      } catch (err) {
        if (++misses >= 4) throw err;
      }
      if (data?.status === 'completed') return data.output || [];
      if (data?.status === 'failed') throw new Error(data.error?.message || String(data.error) || 'generation failed');
      await new Promise((resolve) => setTimeout(resolve, settings.pollIntervalMs));
    }
    const err = new Error('timed out waiting for the mockup');
    err.timeout = true;
    throw err;
  }

  /** What went wrong, in words a seller can act on (the raw provider message stays in the log). */
  function explain(err) {
    const text = String(err?.message || err || '').toLowerCase();
    let key = 'generic';
    if (err?.timeout || text.includes('timed out')) key = 'timeout';
    else if (/(\b401\b|\b403\b|unauthor|invalid api key|forbidden)/.test(text)) key = 'key';
    else if (/(\b402\b|credit|quota|insufficient|payment)/.test(text)) key = 'provider_credits';
    else if (/(\b429\b|rate limit|too many)/.test(text)) key = 'busy';
    else if (/(image|photo|url|download|decode|format|\b400\b|\b422\b|input)/.test(text)) key = 'photo';
    else if (/(fetch failed|econn|enotfound|network|socket|etimedout|abort)/.test(text)) key = 'network';
    return { key, message: translate(config.platform.defaultLocale, `mockup.fail.${key}`) };
  }

  // -- Jobs: submitted fast, finished in the background, found again by id ----------------------------------------------
  //
  // A photo takes up to a minute or two. Holding one HTTP request open that long is what failed on a slow phone
  // connection: the request dropped, the job carried on and the seller never saw what they had paid for. So a job is a
  // record: it is submitted, then watched in the background, and the page (or a later visit) asks for it by id.

  const watching = new Map();

  async function fail(job, err) {
    const why = explain(err);
    const failed = await jobs.update(job.id, { status: 'failed', error: why.message, errorKey: why.key, errorDetail: String(err?.message || err).slice(0, 300) });
    log.warn(`mockup generation failed (${job.id}): ${err?.message || err}`);
    await events.emit('mockup.failed', { productId: job.productId, storeId: job.storeId, mockupId: job.id, error: why.message });
    return failed;
  }

  async function complete(job, delivered) {
    if (!delivered.length) throw new Error('no image came back');
    const results = await Promise.all(delivered.map((url) => keep(job.accountId, url)));
    const completed = await jobs.update(job.id, { status: 'completed', results, error: null, errorKey: null });
    // Only what actually came back is billed: a batch of 4 that returned 3 costs 3, and a generation that already
    // succeeded is never undone by a credit ledger hiccup.
    await services.subscriptions.consume(job.accountId, 'aiCredits', results.length).catch((err) => {
      log.warn(`mockup credit not recorded for ${job.id}: ${err.message}`);
    });
    await events.emit('mockup.completed', { productId: job.productId, storeId: job.storeId, mockupId: job.id, results });
    return completed;
  }

  /** Follows one submitted job to its end. One watcher per job, however many times it is asked for. */
  function watch(job) {
    if (!watching.has(job.id)) {
      const run = (async () => {
        try {
          return await complete(job, await poll(client(), job.fashnJobId));
        } catch (err) {
          return fail(job, err);
        }
      })().finally(() => watching.delete(job.id));
      watching.set(job.id, run);
    }
    return watching.get(job.id);
  }

  /**
   * Hands one photo to the provider and records the job. Credits are checked for the full `count` before the API is
   * called and spent only for images actually delivered. Returns the job while it is still "processing".
   */
  async function submit({ image, prompt = null, count = 1, accountId, storeId = null, productId = null }) {
    if (!enabled) throw new ConflictError('err.mockup_unavailable');
    if (!image) throw new ConflictError('err.mockup_needs_photo');
    const n = Math.min(4, Math.max(1, Math.round(count)));
    await services.subscriptions.checkLimit(accountId, 'aiCredits', n);

    // One at a time per shop: a second tap (or a second device) while a photo is being made must not pay twice.
    const running = (await jobs.find({ where: storeId ? { storeId, status: 'processing' } : { accountId, status: 'processing' } }))
      .filter((j) => Date.now() - new Date(j.createdAt).getTime() < (settings.timeoutMs || 90000) + 30000);
    if (running.length) throw new ConflictError('err.mockup_busy');

    const job = await jobs.insert({
      id: newId('mck'),
      storeId,
      productId,
      accountId,
      status: 'processing',
      sourceImage: image,
      prompt: prompt || DEFAULT_MOCKUP_PROMPT,
      requested: n,
      results: [],
      fashnJobId: null,
      error: null,
    });
    try {
      const fashnJobId = await client().run({ product_image: await sourceFor(image), prompt: job.prompt, num_images: n });
      return await jobs.update(job.id, { fashnJobId });
    } catch (err) {
      return fail(job, err);
    }
  }

  /** Submit and wait for the end: for callers that can hold on (the bot, tests, a script). */
  async function generateFromImage(options) {
    const job = await submit(options);
    return job.status === 'processing' ? watch(job) : job;
  }

  /** Submit and return at once; the job finishes in the background and is read back with `refresh`. */
  async function start(options) {
    const job = await submit(options);
    if (job.status === 'processing') watch(job);
    return job;
  }

  /**
   * The job as it stands now. One that is still running but has nobody watching it (the server restarted) is picked
   * up again, and one that timed out is looked at once more: the provider often finishes after our patience ran out.
   */
  async function refresh(mockupId) {
    let job = await jobs.get(mockupId);
    if (!job) throw new NotFoundError('Mockup', mockupId);
    if (job.status === 'processing' && job.fashnJobId && !watching.has(job.id)) watch(job);
    if (job.status === 'failed' && job.errorKey === 'timeout' && job.fashnJobId && !job.recheckedAt) {
      job = await jobs.update(job.id, { recheckedAt: new Date().toISOString() });
      try {
        const data = await client().status(job.fashnJobId);
        if (data.status === 'completed' && data.output?.length) return await complete(job, data.output);
      } catch { /* still not there */ }
    }
    return job;
  }

  /** At boot: jobs that were running when the server stopped are followed again, or ended if they never reached the provider. */
  async function recover() {
    for (const job of await jobs.find({ where: { status: 'processing' } })) {
      if (job.fashnJobId) watch(job);
      else await fail(job, new Error('interrupted before it was submitted'));
    }
  }

  /** The product's photos that were themselves made by this service: never offered as the source of another. */
  async function madeImages(productId) {
    const done = await jobs.find({ where: { productId, status: 'completed' } });
    return new Set(done.flatMap((j) => j.results || []));
  }

  /**
   * What a job for an existing product needs. `image` chooses which of the product's photos to start from (it must be
   * one of them); left out, it is the first photo that is the seller's own, not one this service made.
   */
  async function productInputs(productId, { prompt = null, image = null, actorAccountId = null } = {}) {
    const product = await services.catalog.getProduct(productId);
    if (!product) throw new NotFoundError('Product', productId);
    if (actorAccountId) await services.stores.assertCan(product.storeId, actorAccountId, 'products.manage');
    const parent = await services.stores.resolve(product.storeId);
    const photos = product.images || [];
    if (image && !photos.includes(image)) throw ValidationError.of('image', 'err.mockup_photo_not_in_product');
    const made = await madeImages(productId);
    return {
      image: image || photos.find((url) => !made.has(url)) || photos[0],
      prompt: prompt || await defaultPromptFor(product.categoryId),
      accountId: parent.ownerAccountId,
      storeId: product.storeId,
      productId,
    };
  }

  async function generateForProduct(productId, { prompt = null, count = 1, image = null, actorAccountId = null } = {}) {
    return generateFromImage({ ...(await productInputs(productId, { prompt, image, actorAccountId })), count, actorAccountId });
  }

  async function startForProduct(productId, { prompt = null, count = 1, image = null, actorAccountId = null } = {}) {
    return start({ ...(await productInputs(productId, { prompt, image, actorAccountId })), count, actorAccountId });
  }

  const custom = async () => {
    const row = await promptsDb.get(PROMPTS_ID);
    return { default: String(row?.default || ''), groups: row?.groups || {} };
  };

  /** The category group's prompt: what the platform admin wrote, else the built-in for that garment, else the generic one. */
  async function promptForGroup(slug) {
    const mine = await custom();
    return mine.groups[slug] || GROUP_MOCKUP_PROMPTS[slug] || mine.default || DEFAULT_MOCKUP_PROMPT;
  }

  async function defaultPromptFor(categoryId) {
    if (!categoryId) return promptForGroup(null);
    const category = await services.catalog.getCategory(categoryId).catch(() => null);
    if (!category) return promptForGroup(null);
    const group = category.parentId ? await services.catalog.getCategory(category.parentId).catch(() => null) : category;
    return promptForGroup(group?.slug || null);
  }

  // -- A shop's own prompts: written once, titled, used again ---------------------------------------------------------
  //
  // Kept per shop in a private document (never part of the public store record) and capped, so a shop cannot grow it forever.

  const MAX_SAVED = 20;
  const savedId = (storeId) => `photo-prompts:${storeId}`;
  const savedRows = async (storeId) => (await promptsDb.get(savedId(storeId)))?.items || [];

  function cleanSaved({ title, prompt }) {
    const t = String(title ?? '').trim();
    const p = String(prompt ?? '').trim();
    if (!t) throw ValidationError.of('title', 'validation.required', { field: 'Title' });
    if (t.length > 40) throw ValidationError.of('title', 'validation.max_chars', { field: 'Title', max: 40 });
    if (!p) throw ValidationError.of('prompt', 'validation.required', { field: 'Prompt' });
    if (p.length > MAX_PROMPT) throw new ConflictError('err.mockup_prompt_long', { max: MAX_PROMPT });
    return { title: t, prompt: p };
  }

  async function listSaved(storeId) {
    return { items: await savedRows(storeId), max: MAX_SAVED };
  }

  /** Adds a prompt, or - given an `id` of one of the shop's own - rewrites it. */
  async function saveSaved(storeId, input = {}) {
    const rows = await savedRows(storeId);
    const clean = cleanSaved(input);
    let next;
    if (input.id) {
      if (!rows.some((r) => r.id === input.id)) throw new NotFoundError('Prompt', input.id);
      next = rows.map((r) => (r.id === input.id ? { ...r, ...clean } : r));
    } else {
      if (rows.length >= MAX_SAVED) throw new ConflictError('err.mockup_prompts_many', { max: MAX_SAVED });
      next = [...rows, { id: newId('pmt'), ...clean, createdAt: new Date().toISOString() }];
    }
    await promptsDb.upsert(savedId(storeId), { items: next });
    return { items: next, max: MAX_SAVED };
  }

  async function removeSaved(storeId, id) {
    const rows = await savedRows(storeId);
    if (!rows.some((r) => r.id === id)) throw new NotFoundError('Prompt', id);
    const next = rows.filter((r) => r.id !== id);
    await promptsDb.upsert(savedId(storeId), { items: next });
    return { items: next, max: MAX_SAVED };
  }

  /** Every category group with the prompt it uses now and whether the admin wrote it, for the admin editor. */
  async function listPrompts({ locale = 'fa' } = {}) {
    const mine = await custom();
    const groups = await services.catalog.listCategories({ parentId: null, locale });
    return {
      default: { prompt: mine.default || DEFAULT_MOCKUP_PROMPT, custom: Boolean(mine.default), builtIn: DEFAULT_MOCKUP_PROMPT },
      groups: groups.map((g) => ({
        slug: g.slug,
        name: g.name,
        prompt: mine.groups[g.slug] || GROUP_MOCKUP_PROMPTS[g.slug] || mine.default || DEFAULT_MOCKUP_PROMPT,
        custom: Boolean(mine.groups[g.slug]),
        builtIn: GROUP_MOCKUP_PROMPTS[g.slug] || null,
      })),
      enabled,
    };
  }

  /**
   * `{ default?: string, groups?: { [slug]: string|null } }` - a text sets that prompt, an empty one goes back to the
   * built-in. Only groups that exist are accepted.
   */
  async function setPrompts(patch = {}) {
    const mine = await custom();
    const clean = (value) => {
      const text = String(value ?? '').trim();
      if (text.length > MAX_PROMPT) throw new ConflictError('err.mockup_prompt_long', { max: MAX_PROMPT });
      return text;
    };
    if (patch.default !== undefined) mine.default = clean(patch.default);
    if (patch.groups) {
      const known = new Set((await services.catalog.listCategories({ parentId: null })).map((g) => g.slug));
      for (const [slug, value] of Object.entries(patch.groups)) {
        if (!known.has(slug)) throw new NotFoundError('Category', slug);
        const text = clean(value);
        if (text) mine.groups[slug] = text; else delete mine.groups[slug];
      }
    }
    await promptsDb.upsert(PROMPTS_ID, { default: mine.default, groups: mine.groups });
    return listPrompts();
  }

  /** Pushes one of a completed mockup's results onto the product — alongside the original, not over it. */
  async function attachToProduct(mockupId, resultIndex = 0, { actorAccountId = null } = {}) {
    const job = await jobs.get(mockupId);
    if (!job) throw new NotFoundError('Mockup', mockupId);
    const resultUrl = job.status === 'completed' ? job.results?.[resultIndex] : null;
    if (!resultUrl) throw new ConflictError('err.mockup_not_ready');
    if (actorAccountId) await services.stores.assertCan(job.storeId, actorAccountId, 'products.manage');

    const product = await services.catalog.getProduct(job.productId);
    if (!product) throw new NotFoundError('Product', job.productId);
    const images = [resultUrl, ...(product.images || []).filter((url) => url !== resultUrl)];
    return services.catalog.updateProduct(job.productId, { images }, { actorAccountId });
  }

  async function listForProduct(productId, { limit = 10 } = {}) {
    return jobs.find({ where: { productId }, sort: [['createdAt', 'desc']], limit });
  }

  /** Photos made for a product that the seller has not put on it (or has taken off): what they paid for stays reachable. */
  async function unusedFor(productId) {
    const product = await services.catalog.getProduct(productId);
    const on = new Set(product?.images || []);
    const done = await jobs.find({ where: { productId, status: 'completed' }, sort: [['createdAt', 'desc']], limit: 10 });
    return done.flatMap((j) => (j.results || []).map((url) => ({ url, mockupId: j.id, at: j.createdAt }))).filter((r) => !on.has(r.url)).slice(0, 12);
  }

  async function get(mockupId) {
    return jobs.get(mockupId);
  }

  return { generateFromImage, generateForProduct, start, startForProduct, refresh, recover, madeImages, unusedFor, attachToProduct, listForProduct, get, defaultPromptFor, listPrompts, setPrompts, listSaved, saveSaved, removeSaved, get enabled() { return enabled; } };
}

// ---------------------------------------------------------------------------

const DEFAULT_MOCKUP_PROMPT = 'professional studio photo of a person wearing this garment, natural standing pose, clean neutral background, realistic lighting';

/** One prompt per garment group — framing/pose/setting a buyer would expect for that kind of clothing. */
const GROUP_MOCKUP_PROMPTS = {
  'upper-body': 'professional studio photo of a person wearing this garment, upper body framing, natural standing pose, clean neutral background',
  'lower-body': 'professional studio photo of a person wearing this garment, full body framing showing fit and length, natural standing pose, clean neutral background',
  'one-piece': 'professional studio photo of a person wearing this garment, full body framing, elegant natural pose, clean neutral background',
  'at-home': 'relaxed lifestyle photo of a person wearing this garment at home, cozy indoor setting, natural casual pose',
  sportswear: 'dynamic photo of a person wearing this garment, active athletic pose, gym or outdoor sports setting',
  'autumn-winter': 'outdoor lifestyle photo of a person wearing this garment, cool-weather setting, natural standing pose',
  scarves: 'editorial fashion photo of a woman wearing this scarf or shawl, elegantly draped, upper body framing, soft studio light, clean neutral background',
  underwear: 'tasteful studio photo of a person wearing this garment, modest professional pose, plain neutral background',
};
