import { parseDateInput } from '../util/jalali.js';
import { COLLECTIONS } from '../models/schemas.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../util/ids.js';
import { telegramFetch } from '../util/telegramFetch.js';
import { validate } from '../util/validate.js';

/**
 * A shop's Telegram channel.
 *
 * Most sellers on Telegram already have a channel with an audience — that
 * channel *is* their shop. Connecting it means a product listed on Qbazz is
 * posted there automatically, with a Buy button that deep-links back into the
 * bot, so the audience they already built can order without leaving Telegram.
 *
 * The split of work matches the rest of the system: the core decides *what*
 * should be posted and *when*; the bot makes the actual Telegram call and
 * reports back. The core still never talks to Telegram.
 *
 * Verification is the bot's job too, because only it can ask Telegram who
 * administers a channel — but the *rule* is enforced here: a channel is only
 * connected with proof that the bot can post and that the person connecting it
 * administers it. Without that, anyone could claim anyone's channel.
 */
/**
 * Inline buttons under a channel post. A channel is a broadcast, so every
 * button has to be a URL - callback buttons only work where someone can be
 * "pressing" in a chat the bot can answer. Each entry resolves to a deep link
 * into the bot, which is what turns a passive channel audience into orders.
 */
// No labels on purpose: an unlabelled button is worded in the shop's language
// when the post is rendered. A shop that sets its own label keeps it as typed.
// `cart` is the default lead button: it adds the item straight to the buyer's
// cart in one tap rather than just opening the product page. `shop` ("view
// shop") is deliberately not in the default layout any more — a buyer coming
// from a specific post wants that product, not a detour to the storefront;
// it is still a supported type for a seller who wants to add it back.
export const DEFAULT_POST_BUTTONS = [
  [{ type: 'cart' }, { type: 'save' }],
  [{ type: 'contact' }],
];

export const POST_BUTTON_TYPES = ['buy', 'cart', 'save', 'shop', 'contact', 'share', 'web'];

export function createChannelsService(ctx) {
  const { store: db, config, events, services, log } = ctx;
  const stores = db.collection(COLLECTIONS.stores);
  const posts = db.collection(COLLECTIONS.channelPosts);

  const connectionSchema = {
    chatId: { type: 'string', required: true, max: 32, label: 'Channel' },
    username: { type: 'string', max: 64, nullable: true },
    title: { type: 'string', required: true, max: 128, label: 'Channel name' },
    // The channel's own photo and bio, offered to fill in a blank shop logo
    // and description — never to overwrite one the seller already set.
    logoUrl: { type: 'string', max: 500, nullable: true },
    description: { type: 'string', max: 2000, nullable: true },
    memberCount: { type: 'int', min: 0 },
    canPost: { type: 'bool', required: true },
    verifiedUserIsAdmin: { type: 'bool', required: true },
  };

  async function connect(storeId, input, { actorAccountId, syncPosts = false } = {}) {
    const record = await services.stores.resolve(storeId);
    if (actorAccountId) await services.stores.assertCan(record.id, actorAccountId, 'store.update');

    const data = validate(input, connectionSchema);
    if (!data.canPost) throw ValidationError.of('channel', 'err.bot_not_admin');
    if (!data.verifiedUserIsAdmin) throw new ForbiddenError('err.channel_admin');

    // Fill in what's blank, from the channel — a logo and a description the
    // seller was never asked for beat none at all. Anything already set stays.
    const fillIn = {};
    if (data.logoUrl && !record.logoUrl) fillIn.logoUrl = data.logoUrl;
    // Onboarding writes a one-line placeholder ("Name — Category"); the channel's own bio beats it.
    const placeholder = !record.description || record.description === record.name || record.description.startsWith(`${record.name} — `);
    if (data.description && placeholder) fillIn.description = data.description;
    if (Object.keys(fillIn).length) await services.stores.update(record.id, fillIn);

    // A channel belongs to one shop — otherwise two shops post into the same
    // audience and neither owner can tell which listing came from where.
    const taken = await stores.findOne((doc) => doc.channels?.telegram?.chatId === data.chatId && doc.id !== record.id);
    if (taken) throw new ConflictError('err.channel_taken', { name: taken.name });

    const channel = {
      chatId: data.chatId,
      username: data.username || null,
      title: data.title,
      memberCount: data.memberCount ?? null,
      autoPost: record.channels?.telegram?.autoPost ?? true,
      // Drafts are previewed by default; sellers can opt into posting straight away.
      reviewBeforePost: record.channels?.telegram?.reviewBeforePost ?? true,
      // `null` here, not `DEFAULT_POST_BUTTONS` — a shop that never customised
      // its buttons should keep tracking the *current* default forever, not a
      // frozen copy of whatever the default happened to be on connection day.
      // Wherever buttons are actually read for a post, `null` falls back to
      // the live constant (see `pending()`); only an explicit `setButtons`
      // call should ever put a concrete array here.
      buttons: record.channels?.telegram?.buttons ?? null,
      // The other direction: does a post the seller sends to the channel
      // itself become a product? Off by default for a channel connected to an
      // already-curated shop; the channel-first onboarding turns it on, since
      // there the channel *is* the shop's whole catalogue.
      syncPosts: record.channels?.telegram?.syncPosts ?? Boolean(syncPosts),
      lastSyncedMessageId: record.channels?.telegram?.lastSyncedMessageId ?? null,
      connectedAt: new Date().toISOString(),
      connectedBy: actorAccountId || null,
      lastPostAt: null,
    };

    const updated = await stores.update(record.id, { channels: { ...record.channels, telegram: channel } });
    await services.integrations.register({
      type: 'telegram_channel',
      storeId: record.id,
      name: data.title,
      credentials: {},
      settings: { chatId: data.chatId, username: data.username || null },
      actorAccountId,
    });

    await events.emit('store.channel_connected', { storeId: record.id, channel, store: updated });
    log.info(`store ${record.slug} connected channel ${data.username ? `@${data.username}` : data.chatId}`);
    return channel;
  }

  async function disconnect(storeId, { actorAccountId } = {}) {
    const record = await services.stores.resolve(storeId);
    if (actorAccountId) await services.stores.assertCan(record.id, actorAccountId, 'store.update');
    if (!record.channels?.telegram) throw new NotFoundError('Connected channel');

    const { telegram, ...rest } = record.channels;
    await stores.update(record.id, { channels: rest });
    // Anything not yet posted is pointless now.
    await posts.deleteWhere({ storeId: record.id, status: { $in: ['draft', 'queued'] } });
    await events.emit('store.channel_disconnected', { storeId: record.id });
    return { disconnected: true };
  }

  async function get(storeId) {
    const record = await services.stores.resolve(storeId);
    const channel = record.channels?.telegram || null;
    if (!channel) return null;
    const [queued, posted, drafts, failed, linked] = await Promise.all([
      posts.count({ storeId: record.id, status: 'queued' }),
      posts.count({ storeId: record.id, status: 'posted' }),
      posts.count({ storeId: record.id, status: 'draft' }),
      posts.count({ storeId: record.id, status: 'failed' }),
      db.collection(COLLECTIONS.products).find({ where: { storeId: record.id } }),
    ]);
    // Which way each product travelled: written in the channel and read by us, or written here and posted there.
    const fromChannel = linked.filter((p) => p.channelLink?.origin === 'channel_sync').length;
    const toChannel = linked.filter((p) => p.channelLink?.origin === 'qbazz').length;
    return { ...channel, stats: { queued, posted, drafts, failed, fromChannel, toChannel } };
  }

  async function setAutoPost(storeId, enabled, { actorAccountId } = {}) {
    const record = await services.stores.resolve(storeId);
    if (actorAccountId) await services.stores.assertCan(record.id, actorAccountId, 'store.update');
    if (!record.channels?.telegram) throw new NotFoundError('Connected channel');

    const channel = { ...record.channels.telegram, autoPost: Boolean(enabled) };
    await stores.update(record.id, { channels: { ...record.channels, telegram: channel } });
    if (!enabled) await posts.deleteWhere({ storeId: record.id, status: 'queued' });
    return channel;
  }

  async function setSyncPosts(storeId, enabled, { actorAccountId } = {}) {
    const record = await services.stores.resolve(storeId);
    if (actorAccountId) await services.stores.assertCan(record.id, actorAccountId, 'store.update');
    if (!record.channels?.telegram) throw new NotFoundError('Connected channel');

    const channel = { ...record.channels.telegram, syncPosts: Boolean(enabled) };
    await stores.update(record.id, { channels: { ...record.channels, telegram: channel } });
    return channel;
  }

  /**
   * A post the seller sent to their own channel, turned into a product. The
   * bot hands us the raw text/photo for whichever chat the update came from;
   * everything else — is this channel even synced, is this a product at all,
   * what to do with the answer — lives here, same split as the rest of the app.
   *
   * `messageId` guards against Telegram redelivering the same update: ids are
   * monotonically increasing per chat, so anything not newer is a repeat.
   */
  /**
   * Remembers which channel message a product lives in — the thread that makes
   * two-way sync possible. Written straight to the record: it is bookkeeping,
   * not something a seller edits, so it bypasses product validation. `origin`
   * says who wrote the post: 'qbazz' (we posted it, so we may edit it later)
   * or 'channel_sync' (the seller wrote it, so we only ever read it).
   */
  async function linkProduct(productId, link) {
    const products = db.collection(COLLECTIONS.products);
    const current = await products.get(productId);
    if (!current) return null;
    return products.update(productId, { channelLink: { ...(current.channelLink || {}), ...link, linkedAt: new Date().toISOString() } });
  }

  /**
   * "Sold out" / "back in stock", as sellers actually write it: "ناموجود شد", "تمام شد", "اتمام موجودی", "شارژ شد".
   * `out` is recognised near the top of a post or in a short message; `in` only in a short message (a long product
   * description says "موجود" for plenty of other reasons).
   */
  const OUT = /(نا\s*موجود|تمام\s*شد|تموم\s*شد|تمام\s*شده|اتمام\s*(موجودی|شد)|موجود\s*نیست|موجودی\s*(تمام|نداریم)|فروخته\s*شد|sold\s*out)/i;
  const BACK = /(شارژ(\s*مجدد)?\s*شد|(مجدداً?|دوباره)\s*موجود|موجود\s*شد|موجود\s*است|^موجود$|رسید(\s*شد)?$)/i;
  function availabilitySignal(text) {
    const plain = String(text || '').replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    const short = plain.length <= 80;
    if (OUT.test(short ? plain : plain.slice(0, 90))) return 'out';
    if (short && BACK.test(plain)) return 'in';
    return null;
  }

  /** The product a channel message belongs to - whoever wrote the post (the seller by hand, or us). */
  async function productOfMessage(record, messageId) {
    const [product] = await db.collection(COLLECTIONS.products).find({
      where: (doc) => doc.storeId === record.id && doc.channelLink
        && (doc.channelLink.messageIds || [doc.channelLink.messageId]).map(String).includes(String(messageId)),
      limit: 1,
    });
    return product || null;
  }

  /** Sold out from the channel (a reply, or a note added to the post), or back in stock. Nothing else about the product changes. */
  async function applyAvailability(product, signal) {
    if (signal === 'out' && product.status === 'active') {
      const updated = await services.catalog.updateProduct(product.id, { status: 'out_of_stock' });
      await linkProduct(product.id, { unavailableByChannel: true });
      await events.emit('product.availability_from_channel', { storeId: product.storeId, productId: product.id, available: false });
      return updated;
    }
    if (signal === 'in' && product.status === 'out_of_stock') {
      const updated = await services.catalog.updateProduct(product.id, { status: 'active', ...(product.stock === 0 ? { stock: null } : {}) });
      await linkProduct(product.id, { unavailableByChannel: false });
      await events.emit('product.availability_from_channel', { storeId: product.storeId, productId: product.id, available: true });
      return updated;
    }
    return product;
  }

  async function ingestChannelPost({ chatId, text = '', photo = null, photos = null, fileIds = null, messageId = null, messageIds = null, replyToMessageId = null }) {
    // An album is one post with several photos; a lone photo is just a list of one.
    const gallery = photos?.length ? photos : photo ? [photo] : [];
    const record = await stores.findOne((doc) => doc.channels?.telegram?.chatId === String(chatId));
    const channel = record?.channels?.telegram;
    // Not `status !== 'active'`: a channel-first shop is created in 'draft'
    // (it has no product yet, so it cannot even be submitted) and its very
    // first channel post is what's supposed to supply that product. Syncing
    // never exposes anything new to buyers either way — an ingested product
    // still needs its *shop* to be live before anyone can see or order it —
    // so only a shop an admin explicitly shut down is left alone.
    if (!record || !channel?.syncPosts || record.status === 'suspended') return null;
    if (messageId && channel.lastSyncedMessageId && Number(messageId) <= Number(channel.lastSyncedMessageId)) return null;

    const markSeen = () => stores.update(record.id, {
      channels: { ...record.channels, telegram: { ...channel, lastSyncedMessageId: messageId ?? channel.lastSyncedMessageId, lastInAt: new Date().toISOString() } },
    });

    // A reply under a product post is the seller talking about that product ("ناموجود شد"), never a new product.
    if (replyToMessageId) {
      await markSeen();
      const target = await productOfMessage(record, replyToMessageId);
      const signal = target ? availabilitySignal(text) : null;
      return signal ? applyAvailability(target, signal) : null;
    }

    const extracted = await services.ai.extractProductFromPost({ text, photo, store: record, locale: record.locale });
    if (!extracted?.title) {
      await markSeen();
      return null;
    }

    let product;
    try {
      product = await services.catalog.createProduct(record.id, {
        title: extracted.title,
        description: extracted.description || '',
        price: extracted.price,
        priceVisibility: extracted.price == null ? 'inquire' : 'public',
        stock: extracted.stock ?? null,
        images: gallery,
        telegramFileIds: fileIds?.length ? fileIds : [],
        properties: extracted.properties || [],
        tags: extracted.tags || [],
        status: 'active',
        // Where this product came from — so the reaction that echoes new
        // products back to a channel knows not to post this one back where it
        // just came from.
        source: 'channel_sync',
      });
    } catch (err) {
      // The plan's product quota is full: this path has nobody to show an
      // error to (it is a channel post, not a bot button), so it just stops
      // here rather than throwing into the update handler. The seller still
      // sees the real reason on the dashboard when they go to add one by hand.
      if (err.key === 'err.plan_products_limit') {
        await markSeen();
        return null;
      }
      throw err;
    }
    await markSeen();
    await linkProduct(product.id, { chatId: String(chatId), messageId: messageId ? String(messageId) : null, messageIds: (messageIds || (messageId ? [messageId] : [])).map(String), origin: 'channel_sync' });

    // A channel-first shop starts in 'draft' with nothing to submit; its
    // first synced product is usually exactly what was missing. Silently a
    // no-op once the shop is past 'draft', and just as silently skipped again
    // if something else (a category, still) is still needed — the dashboard
    // surfaces that the normal way.
    if (record.status === 'draft') {
      await services.stores.submitForReview(record.id, record.ownerAccountId).catch(() => {});
    }

    await services.notifications.queueForStoreTeam(record.id, {
      type: 'product.synced_from_channel',
      render: (t) => ({
        title: t('notif.channel.synced.title'),
        body: t('notif.channel.synced.body', { title: product.title }),
      }),
      data: { storeId: record.id, productId: product.id },
    });

    return product;
  }

  /**
   * A post the seller edited in their channel: the product it became follows.
   * Only products that came *from* the channel are touched — a post we wrote
   * ourselves also shows up as "edited" when we change it, and must not loop.
   * Photos are left alone (an edit does not resend them); the words and the
   * numbers are re-read the same way a new post is.
   */
  async function applyChannelEdit({ chatId, messageId, text = '' }) {
    const record = await stores.findOne((doc) => doc.channels?.telegram?.chatId === String(chatId));
    if (!record || !record.channels.telegram.syncPosts || record.status === 'suspended') return null;
    const products = db.collection(COLLECTIONS.products);
    const [product] = await products.find({
      where: (doc) => doc.storeId === record.id && doc.channelLink?.origin === 'channel_sync'
        && (doc.channelLink.messageIds || [doc.channelLink.messageId]).map(String).includes(String(messageId)),
      limit: 1,
    });
    if (!product) return null;

    // "❌ناموجود❌" added to the top of the post: sold out, and nothing else to read from it. Taking the note off again
    // (only if the note is what made it unavailable) puts the product back on sale.
    const signal = availabilitySignal(text);
    if (signal === 'out') return applyAvailability(product, 'out');
    const restock = product.status === 'out_of_stock' && product.channelLink?.unavailableByChannel;

    const extracted = await services.ai.extractProductFromPost({ text, photo: null, store: record, locale: record.locale });
    if (!extracted?.title) return restock ? applyAvailability(product, 'in') : null;

    const patch = {
      title: extracted.title,
      description: extracted.description || '',
      properties: extracted.properties || product.properties || [],
      tags: extracted.tags || product.tags || [],
    };
    if (extracted.price != null) { patch.price = extracted.price; patch.priceVisibility = product.priceVisibility === 'private' ? 'private' : 'public'; }
    if (extracted.stock != null) patch.stock = extracted.stock;
    const updated = await services.catalog.updateProduct(product.id, patch);
    const result = restock ? await applyAvailability(updated, 'in') : updated;
    await events.emit('product.synced_from_channel_edit', { storeId: record.id, productId: product.id });
    return result;
  }

  /**
   * A product we posted changed (price, discount, stock, availability, words).
   * Queue ONE edit for its post; if one is already waiting, it will carry the
   * latest state anyway, so nothing is queued twice.
   */
  async function queueEdit(productId) {
    const product = await services.catalog.getProduct(productId);
    const link = product?.channelLink;
    if (!product || link?.origin !== 'qbazz' || !link.messageId) return null;
    const record = await stores.get(product.storeId);
    const channel = record?.channels?.telegram;
    if (!channel || channel.chatId !== link.chatId || record.status !== 'active') return null;
    const waiting = await posts.findOne({ productId, kind: 'edit', status: 'queued' });
    if (waiting) return waiting;
    return posts.insert({
      id: newId('cpt'), storeId: record.id, chatId: link.chatId, kind: 'edit', productId, reason: 'product_changed', status: 'queued',
      caption: null, suggested: null, attempts: 0, messageId: link.messageId, hasPhoto: Boolean(link.hasPhoto), error: null, postedAt: null,
    });
  }

  /**
   * A product left the shop: queue the removal of the post WE made for it. A post the seller wrote in the channel
   * themselves (origin 'channel') is theirs and stays, whatever happens on the site.
   */
  async function queueRemoval(storeId, productId, link) {
    if (!link || link.origin !== 'qbazz' || !link.messageId) return null;
    const record = await stores.get(storeId);
    const channel = record?.channels?.telegram;
    if (!channel || channel.chatId !== link.chatId) return null;
    // anything still waiting to be posted or edited for this product is pointless now
    await posts.deleteWhere({ productId, status: { $in: ['draft', 'queued'] } });
    return posts.insert({
      id: newId('cpt'), storeId, chatId: link.chatId, kind: 'delete', productId, reason: 'product_removed', status: 'queued',
      caption: null, suggested: null, attempts: 0, messageId: String(link.messageId), hasPhoto: Boolean(link.hasPhoto), error: null, postedAt: null,
    });
  }

  // -- The post queue --------------------------------------------------------

  /**
   * Enqueues one product. Idempotent per product unless forced, so a product
   * edited five times does not spam the channel five times.
   */
  async function queueProduct(productId, { force = false, reason = 'new_product' } = {}) {
    const product = await services.catalog.getProduct(productId);
    if (!product || product.status !== 'active') return null;

    const record = await stores.get(product.storeId);
    const channel = record?.channels?.telegram;
    if (!channel) return null;
    if (!channel.autoPost && !force) return null;
    if (record.status !== 'active') return null; // nothing goes out before approval

    if (!force) {
      const already = await posts.findOne({ productId, status: { $in: ['draft', 'queued', 'posted'] } });
      if (already) return null;
    }

    // With review on, the post waits as a draft until the seller approves the
    // copy. That is the point of the preview screen - nothing reaches an
    // audience of thousands on an automatic trigger alone.
    const needsReview = channel.reviewBeforePost !== false && !force;

    const post = await posts.insert({
      id: newId('cpt'),
      storeId: record.id,
      chatId: channel.chatId,
      kind: 'product',
      productId,
      reason,
      status: needsReview ? 'draft' : 'queued',
      caption: null,
      suggested: null,
      attempts: 0,
      messageId: null,
      error: null,
      postedAt: null,
    });
    await events.emit(needsReview ? 'channel.draft_created' : 'channel.post_queued', {
      storeId: record.id,
      postId: post.id,
      productId,
    });

    // Write the copy in the background so a seller opening the review screen
    // never finds it bare — a post with just a title and a price is what
    // happens when nobody remembers to tap "write it for me". Not awaited:
    // `queueProduct` runs on the same request that creates the product, and a
    // slow or unreachable AI call must not hold that up. `generateDraft` only
    // ever *proposes* a caption onto the draft, never onto the live product,
    // so a failed or slow generation leaves nothing half-applied to clean up.
    generateDraft(post.id, {}).catch((err) => {
      log?.warn?.(`background listing generation for ${post.id} failed: ${err.message}`);
    });

    return post;
  }

  /** "Post everything I already have" — used right after connecting. */
  async function backfill(storeId, { actorAccountId, limit = 20, from = null, to = null } = {}) {
    const record = await services.stores.resolve(storeId);
    if (actorAccountId) await services.stores.assertCan(record.id, actorAccountId, 'products.manage');
    if (!record.channels?.telegram) throw new NotFoundError('Connected channel');

    // a range of dates (whole days) narrows it to the products added then; no range keeps the old "the first few"
    const day = (v) => (v ? (/^\d{4}-\d{2}-\d{2}/.test(v) ? String(v).slice(0, 10) : parseDateInput(v)) : null);
    const [a, b] = [day(from), day(to)];
    if ((from && !a) || (to && !b)) throw ValidationError.of('from', 'validation.invalid', { field: 'Date' });
    let { items } = await services.catalog.listProducts({ storeId: record.id, status: 'active', limit: a || b ? 500 : limit, sort: [['createdAt', 'asc']] });
    if (a || b) {
      const lo = a ? Date.parse(`${a}T00:00:00Z`) : -Infinity;
      const hi = b ? Date.parse(`${b}T23:59:59Z`) : Infinity;
      items = items.filter((p) => { const t = Date.parse(p.createdAt); return t >= lo && t <= hi; });
    }
    let queued = 0;
    for (const product of items) {
      const post = await queueProduct(product.id, { reason: 'backfill' });
      if (post) queued += 1;
    }
    return { queued, skipped: items.length - queued };
  }

  // -- Drafts (the pre-posting preview) -------------------------------------

  /** A draft plus everything a preview screen needs to render it. */
  async function getDraft(postId, { actorAccountId } = {}) {
    const post = await posts.get(postId);
    if (!post) throw new NotFoundError('Channel post', postId);
    if (actorAccountId) await services.stores.assertCan(post.storeId, actorAccountId, 'products.manage');

    const product = post.productId ? await services.catalog.getProduct(post.productId) : null;
    const record = await stores.get(post.storeId);
    return {
      ...post,
      product,
      store: record ? { id: record.id, name: record.name, slug: record.slug, currency: record.currency, locale: record.locale || config.platform.defaultLocale } : null,
      caption: post.caption ?? product?.description ?? '',
    };
  }

  async function listDrafts(storeId, { actorAccountId, limit = 10 } = {}) {
    if (actorAccountId) await services.stores.assertCan(storeId, actorAccountId, 'products.manage');
    return posts.find({ where: { storeId, status: 'draft' }, sort: [['createdAt', 'asc']], limit });
  }

  /**
   * Runs listing generation over the draft's product and stores the result on
   * the draft. Suggested properties and tags are *proposed*, not applied - the
   * seller accepts them separately, so a generated guess never silently
   * becomes a product fact.
   */
  async function generateDraft(postId, { actorAccountId, tone = 'friendly', language = null } = {}) {
    const draft = await getDraft(postId, { actorAccountId });
    if (!draft.product) throw new ConflictError('err.draft_gone');
    const record = await stores.get(draft.storeId);

    const generated = await services.ai.generateListing({
      product: draft.product,
      store: record,
      tone,
      // Written in the shop's language unless the caller asks for another.
      locale: record?.locale || config.platform.defaultLocale,
      language,
    });

    const updated = await posts.update(postId, {
      caption: generated.caption,
      hook: generated.hook || null,
      suggested: {
        headline: generated.headline,
        properties: generated.properties,
        tags: generated.tags,
        analysis: generated.analysis,
        provider: generated.provider,
        at: new Date().toISOString(),
      },
    });
    await events.emit('channel.draft_generated', { storeId: draft.storeId, postId, provider: generated.provider });
    return { ...updated, product: draft.product, generated };
  }

  async function setDraftCaption(postId, caption, { actorAccountId } = {}) {
    await getDraft(postId, { actorAccountId });
    return posts.update(postId, { caption: String(caption || '').slice(0, 1000) });
  }

  /** Writes the generated properties and tags onto the product itself. */
  async function applySuggestions(postId, { actorAccountId, properties = true, tags = true } = {}) {
    const draft = await getDraft(postId, { actorAccountId });
    if (!draft.suggested) throw new ConflictError('err.draft_empty');
    if (!draft.product) throw new NotFoundError('Product', draft.productId);

    const patch = {};
    if (properties && draft.suggested.properties?.length) {
      const existing = draft.product.properties || [];
      const known = new Set(existing.map((entry) => entry.name.toLowerCase()));
      patch.properties = [...existing, ...draft.suggested.properties.filter((entry) => !known.has(entry.name.toLowerCase()))];
    }
    if (tags && draft.suggested.tags?.length) {
      patch.tags = [...new Set([...(draft.product.tags || []), ...draft.suggested.tags])];
    }
    if (!Object.keys(patch).length) return draft.product;

    return services.catalog.updateProduct(draft.productId, patch, { actorAccountId });
  }

  /** Seller signs off: the draft joins the send queue. */
  async function approveDraft(postId, { actorAccountId } = {}) {
    const draft = await getDraft(postId, { actorAccountId });
    if (draft.status !== 'draft') throw new ConflictError('err.draft_sent');
    const updated = await posts.update(postId, {
      status: 'queued',
      approvedBy: actorAccountId || null,
      approvedAt: new Date().toISOString(),
    });
    await events.emit('channel.post_queued', { storeId: draft.storeId, postId, productId: draft.productId });
    return updated;
  }

  async function discardDraft(postId, { actorAccountId } = {}) {
    const draft = await getDraft(postId, { actorAccountId });
    await posts.update(postId, { status: 'discarded' });
    return { discarded: true, storeId: draft.storeId };
  }

  async function setButtons(storeId, buttons, { actorAccountId } = {}) {
    const record = await services.stores.resolve(storeId);
    if (actorAccountId) await services.stores.assertCan(record.id, actorAccountId, 'store.update');
    if (!record.channels?.telegram) throw new NotFoundError('Connected channel');

    const rows = (Array.isArray(buttons) ? buttons : [])
      .map((row) => (Array.isArray(row) ? row : [row])
        .filter((entry) => POST_BUTTON_TYPES.includes(entry?.type))
        .map((entry) => ({ type: entry.type, ...(entry.label ? { label: String(entry.label).slice(0, 32) } : {}) })))
      .filter((row) => row.length)
      .slice(0, 4);
    if (!rows.length) throw ValidationError.of('buttons', 'err.buttons_min');

    const channel = { ...record.channels.telegram, buttons: rows };
    await stores.update(record.id, { channels: { ...record.channels, telegram: channel } });
    return channel;
  }

  async function setReviewBeforePost(storeId, enabled, { actorAccountId } = {}) {
    const record = await services.stores.resolve(storeId);
    if (actorAccountId) await services.stores.assertCan(record.id, actorAccountId, 'store.update');
    if (!record.channels?.telegram) throw new NotFoundError('Connected channel');
    const channel = { ...record.channels.telegram, reviewBeforePost: Boolean(enabled) };
    await stores.update(record.id, { channels: { ...record.channels, telegram: channel } });
    return channel;
  }

  /**
   * Claimed by the channel poster. Rows come enriched with everything the
   * message needs, so the bot does not make a second round trip per post.
   */
  async function pending({ limit = 20 } = {}) {
    const rows = await posts.find({ where: { status: 'queued' }, sort: [['createdAt', 'asc']], limit });
    const out = [];
    for (const row of rows) {
      const product = row.productId ? await services.catalog.getProduct(row.productId) : null;
      // a removal has no product any more: the message to take down is all it needs
      if (row.kind === 'delete') { out.push({ ...row, product: null, store: null }); continue; }
      // The product was archived between queueing and posting.
      if (row.kind === 'product' && (!product || product.status !== 'active')) {
        await posts.update(row.id, { status: 'cancelled', error: 'product no longer active' });
        continue;
      }
      const record = await stores.get(row.storeId);
      out.push({
        ...row,
        caption: row.kind === 'edit' ? '' : (row.caption || product?.description || ''),
        locale: record?.locale || config.platform.defaultLocale,
        buttons: record?.channels?.telegram?.buttons || DEFAULT_POST_BUTTONS,
        contact: record?.contact || {},
        product: product ? await services.discovery.productCard(product, { full: true }) : null,
        store: record ? { id: record.id, name: record.name, slug: record.slug } : null,
      });
    }
    return out;
  }

  async function markPosted(postId, { ok = true, messageId = null, error = null, hasPhoto = false, gone = false } = {}) {
    const post = await posts.get(postId);
    if (!post) throw new NotFoundError('Channel post', postId);

    if (ok) {
      const record = await stores.get(post.storeId);
      if (record?.channels?.telegram) {
        await stores.update(record.id, {
          channels: { ...record.channels, telegram: { ...record.channels.telegram, lastPostAt: new Date().toISOString() } },
        });
      }
      if (post.kind === 'product' && post.productId && messageId) {
        await linkProduct(post.productId, { chatId: post.chatId, messageId: String(messageId), messageIds: [String(messageId)], hasPhoto: Boolean(hasPhoto), origin: 'qbazz' });
      }
      // taken down: the product no longer points at a message that is not there
      if (post.kind === 'delete' && post.productId) await db.collection(COLLECTIONS.products).update(post.productId, { channelLink: null }).catch(() => null);
      const updated = await posts.update(postId, { status: 'posted', ...(post.kind === 'edit' || post.kind === 'delete' ? {} : { messageId }), postedAt: new Date().toISOString(), error: null });
      await events.emit('channel.posted', { storeId: post.storeId, postId, productId: post.productId, messageId });
      return updated;
    }

    // The message was deleted in the channel: forget the link and stop, there is nothing left to edit.
    if (gone && post.productId) {
      await db.collection(COLLECTIONS.products).update(post.productId, { channelLink: null });
      return posts.update(postId, { status: 'cancelled', error: 'post deleted in channel' });
    }

    // Three strikes: a channel the bot was removed from should stop retrying.
    const attempts = (post.attempts || 0) + 1;
    return posts.update(postId, {
      attempts,
      status: attempts >= 3 ? 'failed' : 'queued',
      error,
    });
  }

  async function listForStore(storeId, { limit = 20, offset = 0 } = {}) {
    const [items, total] = await Promise.all([
      posts.find({ where: { storeId }, sort: [['createdAt', 'desc']], limit, offset }),
      posts.count({ storeId }),
    ]);
    return { items, total };
  }

  // The shape `connect()` used to bake into every channel's `buttons` field
  // before it started leaving unset ones as `null`. A shop still carrying
  // exactly this — and no bot flow ever let a seller set anything else — was
  // never a real customisation, just yesterday's default frozen in place; a
  // later change to `DEFAULT_POST_BUTTONS` would otherwise never reach it.
  const OLD_BAKED_IN_DEFAULT = JSON.stringify([[{ type: 'buy' }], [{ type: 'shop' }, { type: 'contact' }]]);

  /** Run once at boot. Idempotent: nothing left to migrate is a fast no-op. */
  async function migrateFrozenDefaultButtons() {
    const rows = await stores.find({ where: (doc) => Boolean(doc.channels?.telegram?.buttons) });
    let migrated = 0;
    for (const record of rows) {
      if (JSON.stringify(record.channels.telegram.buttons) !== OLD_BAKED_IN_DEFAULT) continue;
      await stores.update(record.id, { channels: { ...record.channels, telegram: { ...record.channels.telegram, buttons: null } } });
      migrated++;
    }
    if (migrated) log.info(`unfroze the default channel-post buttons for ${migrated} shop(s)`);
    return migrated;
  }

  /**
   * Takes the connected channel's current photo as the shop's logo, kept in our own storage (so it does not depend on
   * Telegram's link, and nothing with the bot token is stored). Replaces the logo the shop has now - the seller asked.
   */
  async function useChannelPhotoAsLogo(storeId, { actorAccountId } = {}) {
    const record = await services.stores.resolve(storeId);
    if (actorAccountId) await services.stores.assertCan(record.id, actorAccountId, 'store.update');
    const channel = record.channels?.telegram;
    if (!channel?.chatId) throw new ConflictError('err.channel_not_connected');
    const url = await services.telegram.channelPhotoUrl(channel.chatId);
    if (!url) throw new ConflictError('err.channel_no_photo');
    const res = await telegramFetch(config.telegram?.proxy)(String(url).replace('https://api.telegram.org', config.telegram?.apiBase || 'https://api.telegram.org'), { signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (!res?.ok) throw new ConflictError('err.channel_no_photo');
    const saved = await services.uploads.saveImage(record.ownerAccountId, Buffer.from(await res.arrayBuffer()).toString('base64'));
    return services.stores.update(record.id, { logoUrl: saved.url });
  }

  return {
    useChannelPhotoAsLogo,
    connect,
    disconnect,
    get,
    setAutoPost,
    setSyncPosts,
    ingestChannelPost,
    migrateFrozenDefaultButtons,
    setReviewBeforePost,
    setButtons,
    queueProduct,
    queueEdit,
    queueRemoval,
    applyChannelEdit,
    availabilitySignal,
    linkProduct,
    backfill,
    pending,
    markPosted,
    listForStore,
    getDraft,
    listDrafts,
    generateDraft,
    setDraftCaption,
    applySuggestions,
    approveDraft,
    discardDraft,
  };
}
