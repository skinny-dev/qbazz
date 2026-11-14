import { COLLECTIONS } from '../models/schemas.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../util/ids.js';
import { normalizeText } from '../util/text.js';
import { toMinor } from '../util/money.js';
import { boilerplate, readPost } from '../util/postReader.js';
import { channelName, crawlChannel, isTelegramPhoto } from '../util/telegramPublic.js';
import { telegramFetch } from '../util/telegramFetch.js';

const PHOTOS_PER_PRODUCT = 8;
const MAX_ITEMS = 600;

/**
 * Bringing a channel's history in: the seller names a public channel, the core reads everything posted there
 * (see util/telegramPublic.js), turns each post into a draft product (util/postReader.js) and hands the drafts back
 * for review. Nothing becomes a product until the seller has looked at the list and said which ones to add.
 *
 *   start -> status "reading" (progress while it walks the pages) -> "ready" (the drafts) -> commit -> "importing" -> "done"
 */
export function createChannelImportService(ctx) {
  const { store: db, services, events, config, log } = ctx;
  const jobs = db.collection(COLLECTIONS.channelImports);
  // t.me is as unreachable from some servers as the Bot API is: it travels the Telegram proxy when one is set
  const fetchImpl = config.channelImport?.fetch || telegramFetch(config.telegram?.proxy);
  const delayMs = config.channelImport?.delayMs ?? 350;

  const IN_PROGRESS = ['reading', 'importing'];

  async function loadFor(accountId, storeId, jobId) {
    const record = await services.stores.resolve(storeId);
    await services.stores.assertCan(record.id, accountId, 'products.manage');
    const job = await jobs.get(jobId);
    if (!job || job.storeId !== record.id) throw new NotFoundError('Channel import', jobId);
    return { record, job };
  }

  /** The category a product title most plausibly belongs to: the leaf whose name is in the title (longest name wins). */
  function categoryGuesser(leaves) {
    const named = leaves.map((c) => ({ id: c.id, name: normalizeText(c.name) })).filter((c) => c.name.length >= 3).sort((a, b) => b.name.length - a.name.length);
    return (title) => {
      const hay = normalizeText(title);
      return named.find((c) => hay.includes(c.name))?.id || null;
    };
  }

  async function start(accountId, storeId, { channel } = {}) {
    const record = await services.stores.resolve(storeId);
    await services.stores.assertCan(record.id, accountId, 'products.manage');
    const username = channelName(channel);
    if (!username) throw ValidationError.of('channel', 'err.import_channel_name');
    const busy = await jobs.findOne((j) => j.storeId === record.id && IN_PROGRESS.includes(j.status));
    if (busy) throw new ConflictError('err.import_busy');

    const job = await jobs.insert({
      id: newId('cim'), storeId: record.id, accountId, channel: username, status: 'reading', error: null,
      progress: { pages: 0, posts: 0, imported: 0, total: 0 }, items: [], skipped: {}, truncated: false, result: null,
    });
    // Reading takes a while (a page every moment or so): the request returns now and the screen polls.
    run(job.id).catch(async (err) => {
      log?.warn?.(`channel import ${job.id} failed: ${err.message}`);
      await jobs.update(job.id, { status: 'failed', error: err.code || 'failed', errorMessage: err.message });
    });
    return view(job, { items: false });
  }

  async function run(jobId) {
    const job = await jobs.get(jobId);
    const record = await services.stores.get(job.storeId);
    let last = 0;
    const crawl = await crawlChannel(job.channel, {
      fetchImpl, delayMs,
      onPage: ({ pages, posts }) => { if (pages - last >= 1) { last = pages; jobs.update(jobId, { progress: { ...job.progress, pages, posts } }).catch(() => {}); } },
    });

    const boiler = boilerplate(crawl.posts.map((p) => p.text));
    const leaves = (await services.catalog.listCategories({ tree: true, locale: 'fa' })).flatMap((g) => g.children || []);
    const guess = categoryGuesser(leaves);
    const have = new Set((await db.collection(COLLECTIONS.products).find({ where: { storeId: record.id } })).map((p) => normalizeText(p.title)));
    const skipped = {};
    const bump = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };

    // Newest first: that is what a seller expects to see at the top of the list.
    const merged = new Map();
    for (const post of [...crawl.posts].reverse()) {
      if (post.replyTo) { bump('reply'); continue; }
      const read = readPost(post.text, { boiler, hasPhoto: post.photos.length > 0 });
      if (!read.usable) { bump(read.reason); continue; }
      // the same model posted again in other colours: one draft, all its photos
      const sig = `${normalizeText(read.title)}|${read.price ?? ''}`;
      const seen = merged.get(sig);
      if (seen) { seen.photos = [...new Set([...seen.photos, ...post.photos])].slice(0, PHOTOS_PER_PRODUCT); seen.postIds.push(post.id); bump('same_again'); continue; }
      const duplicate = have.has(normalizeText(read.title));
      merged.set(sig, {
        id: newId('cii'), postIds: [post.id], date: post.date, title: read.title, description: read.description,
        price: read.price == null ? null : toMinor(read.price, record.currency), compareAtPrice: read.compareAtPrice == null ? null : toMinor(read.compareAtPrice, record.currency),
        properties: read.properties, tags: read.tags, photos: post.photos.slice(0, PHOTOS_PER_PRODUCT), categoryId: guess(read.title), soldOut: read.soldOut, confidence: read.confidence,
        duplicate, selected: !duplicate && read.confidence !== 'low',
      });
      if (merged.size >= MAX_ITEMS) break;
    }
    await jobs.update(jobId, { status: 'ready', items: [...merged.values()], skipped, truncated: crawl.truncated, progress: { pages: crawl.pages, posts: crawl.posts.length, imported: 0, total: merged.size } });
  }

  function view(job, { items = true } = {}) {
    const { items: rows, ...rest } = job;
    return { ...rest, itemCount: rows?.length || 0, ...(items ? { items: rows } : {}) };
  }

  async function get(accountId, storeId, jobId) {
    const { job } = await loadFor(accountId, storeId, jobId);
    return view(job);
  }

  /** The seller's last unfinished import for this shop, so a closed tab does not lose the review. */
  async function current(accountId, storeId) {
    const record = await services.stores.resolve(storeId);
    await services.stores.assertCan(record.id, accountId, 'products.manage');
    const rows = await jobs.find({ where: (j) => j.storeId === record.id && j.status !== 'done' && j.status !== 'discarded', sort: [['createdAt', 'desc']], limit: 1 });
    return rows[0] ? view(rows[0], { items: false }) : null;
  }

  async function download(url) {
    if (!isTelegramPhoto(url)) return null;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch { return null; }
  }

  /**
   * The seller's decision: which drafts to add, with whatever they corrected (name, price, category, description).
   * Photos are downloaded now and kept in the app's own storage, so the shop works even if the channel disappears.
   */
  async function commit(accountId, storeId, jobId, { items: chosen = [] } = {}) {
    const { record, job } = await loadFor(accountId, storeId, jobId);
    if (job.status !== 'ready') throw new ConflictError('err.import_not_ready');
    const byId = new Map(job.items.map((i) => [i.id, i]));
    const todo = chosen.map((c) => ({ draft: byId.get(c.id), edit: c })).filter((x) => x.draft);
    if (!todo.length) throw ValidationError.of('items', 'validation.required', { field: 'Products' });
    await jobs.update(jobId, { status: 'importing', progress: { ...job.progress, imported: 0, total: todo.length }, result: null });

    (async () => {
      const result = { created: 0, failed: 0, stopped: null };
      for (const { draft, edit } of todo) {
        try {
          const urls = [];
          for (const src of draft.photos.slice(0, PHOTOS_PER_PRODUCT)) {
            const buffer = await download(src);
            if (!buffer) continue;
            try { urls.push((await services.uploads.saveImage(record.ownerAccountId, buffer.toString('base64'))).url); } catch (err) {
              // the account's picture allowance is used up: stop here, rather than add products with no photos
              if (err.key === 'err.upload_limit') throw err;
              /* too large or not a picture: skip this photo */
            }
          }
          const title = String(edit.title ?? draft.title).trim().slice(0, 140) || draft.title;
          const price = edit.price === undefined ? draft.price : (edit.price === null || edit.price === '' ? null : Number(edit.price));
          await services.catalog.createProduct(record.id, {
            title,
            description: edit.description ?? draft.description,
            price: Number.isFinite(price) && price > 0 ? price : null,
            priceVisibility: Number.isFinite(price) && price > 0 ? 'public' : 'inquire',
            ...(draft.compareAtPrice && Number(price) < draft.compareAtPrice && edit.price === undefined ? { compareAtPrice: draft.compareAtPrice } : {}),
            currency: record.currency,
            images: urls,
            categoryId: edit.categoryId || draft.categoryId || undefined,
            tags: draft.tags,
            properties: draft.properties,
            status: draft.soldOut ? 'out_of_stock' : 'active',
            source: 'channel_sync',
          }, { actorAccountId: accountId });
          result.created += 1;
        } catch (err) {
          // the plan's product limit ends the import; anything else only costs that one product
          if (err.key === 'err.plan_products_limit') { result.stopped = 'products_limit'; break; }
          if (err.key === 'err.upload_limit') { result.stopped = 'uploads_limit'; break; }
          result.failed += 1;
          log?.warn?.(`channel import ${jobId}: "${draft.title}" skipped: ${err.message}`);
        }
        await jobs.update(jobId, { progress: { ...job.progress, imported: result.created + result.failed, total: todo.length } }).catch(() => {});
      }
      await jobs.update(jobId, { status: 'done', result, items: [] });
      await events.emit('channel.imported', { storeId: record.id, jobId, created: result.created });
    })().catch(async (err) => {
      log?.warn?.(`channel import ${jobId} commit failed: ${err.message}`);
      await jobs.update(jobId, { status: 'failed', error: 'failed', errorMessage: err.message });
    });

    return view(await jobs.get(jobId), { items: false });
  }

  async function discard(accountId, storeId, jobId) {
    const { job } = await loadFor(accountId, storeId, jobId);
    if (job.status === 'importing') throw new ConflictError('err.import_busy');
    await jobs.update(jobId, { status: 'discarded', items: [] });
    return { discarded: true };
  }

  /** A server that stopped mid-import leaves jobs nobody is working on any more: say so, so the seller can start again. */
  async function recover() {
    const stuck = await jobs.find({ where: (j) => IN_PROGRESS.includes(j.status) });
    for (const job of stuck) await jobs.update(job.id, { status: 'failed', error: 'interrupted' });
    return stuck.length;
  }

  return { start, get, current, commit, discard, recover };
}
