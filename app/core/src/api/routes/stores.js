import { Router } from '../router.js';
import { requireAuth, status } from '../http.js';
import { pageParams } from '../../util/paginate.js';
import { NotFoundError, ValidationError } from '../../errors.js';

/**
 * The store owner dashboard API. Every handler passes `actorAccountId` into the
 * service, which is where the role check happens — the route layer never
 * decides permissions on its own.
 */
export function registerStoreRoutes(root, core) {
  const { services } = core;
  const router = new Router();

  router.post('/', async (ctx) => status(201, await services.stores.create(requireAuth(ctx).id, ctx.body)));

  router.get('/:id', async (ctx) => {
    const record = await services.stores.resolve(ctx.params.id);
    const actor = ctx.accountId;
    const own = actor ? await services.stores.roleOf(record.id, actor) : null;
    const role = own || (actor ? await services.stores.effectiveRole(record.id, actor) : null);
    // `viaAdmin`: a platform admin looking after a shop that is not theirs
    return { ...record, membership: role ? { role, ...(own ? {} : { viaAdmin: true }) } : null };
  });

  /** What a new product of this shop starts as: how it is sold by custom in its category. */
  router.get('/:id/product-defaults', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'products.manage');
    return { saleUnit: await services.catalog.saleUnitFor(record.categoryIds?.[0] || null) };
  });

  router.patch('/:id', async (ctx) => services.stores.update(ctx.params.id, ctx.body, { actorAccountId: requireAuth(ctx).id }));

  router.post('/:id/submit', async (ctx) => services.stores.submitForReview(ctx.params.id, requireAuth(ctx).id));

  // -- Products --------------------------------------------------------------

  router.get('/:id/products', async (ctx) => {
    const record = await services.stores.resolve(ctx.params.id);
    const { limit, offset } = pageParams(ctx.query);
    // Staff see drafts; the public sees live items only.
    const isStaff = ctx.accountId ? await services.stores.can(record.id, ctx.accountId, 'products.view') : false;
    return services.catalog.listProducts({
      storeId: record.id,
      status: isStaff ? ctx.query.status : ['active', 'out_of_stock'],
      categoryId: ctx.query.category || null,
      limit,
      offset,
    });
  });

  router.post('/:id/products', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    const { aiPolish, ...input } = ctx.body;
    let product = await services.catalog.createProduct(record.id, input, { actorAccountId: account.id });
    // "Improve with AI" is a tick the seller leaves on or off; it must never cost them the product itself.
    if (aiPolish) product = (await services.catalog.optimizeProduct(product.id, { actorAccountId: account.id }).catch(() => ({ product }))).product;
    return status(201, product);
  });

  /** A search-ready rewrite of a product that does not exist yet - shown to the seller, not saved. */
  router.post('/:id/products/optimize', async (ctx) => services.catalog.previewOptimization(ctx.params.id, ctx.body, { actorAccountId: requireAuth(ctx).id }));
  /** The same, applied to a saved product. */
  router.post('/:id/products/:productId/optimize', async (ctx) => services.catalog.optimizeProduct(ctx.params.productId, { actorAccountId: requireAuth(ctx).id, apply: ctx.body.apply !== false }));
  router.post('/:id/products/:productId/optimize/revert', async (ctx) => services.catalog.revertOptimization(ctx.params.productId, { actorAccountId: requireAuth(ctx).id }));

  /**
   * Creates a product the seller already reviewed (the one-message AI-drafted
   * listing flow) and, in the same call, decides where it goes — the seller's
   * own choice here, not the shop's usual "queue every new product" reaction,
   * which this explicitly opts out of so the two can never both fire for one
   * product.
   */
  router.post('/:id/products/publish', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    const { telegram, ...productInput } = ctx.body;
    const product = await services.catalog.createProduct(record.id, productInput, { actorAccountId: account.id, skipChannelSync: true });
    if (telegram) await services.channels.queueProduct(product.id, { force: true, reason: 'manual_publish' }).catch(() => null);
    return status(201, { product });
  });

  /** The seller's own raw record — unlike `/products/:id`, this is the management view (a plain `status`, a plain `price`), not the shopper-facing card. */
  /** "Send this product to my channel now" — also the way to repost after a deletion. */
  router.post('/:id/products/:productId/channel', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'products.manage');
    const post = await services.channels.queueProduct(ctx.params.productId, { force: true, reason: 'manual_publish' });
    return { queued: Boolean(post) };
  });

  router.get('/:id/products/:productId', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'products.manage');
    return services.catalog.getProductOrFail(ctx.params.productId, { storeId: record.id });
  });

  router.patch('/:id/products/:productId', async (ctx) => services.catalog.updateProduct(ctx.params.productId, ctx.body, {
    actorAccountId: requireAuth(ctx).id,
  }));

  router.delete('/:id/products/:productId', async (ctx) => services.catalog.deleteProduct(ctx.params.productId, {
    actorAccountId: requireAuth(ctx).id,
  }));

  router.post('/:id/products/:productId/stock', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'products.manage');
    return services.catalog.adjustStock(ctx.params.productId, Number(ctx.body.delta), { reason: 'manual' });
  });

  // -- Wholesale access requests (private-priced products) --------------------

  router.get('/:id/access-requests', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'products.manage');
    const { limit, offset } = pageParams(ctx.query);
    return services.access.listForStore(record.id, { status: ctx.query.status || null, limit, offset });
  });

  router.post('/:id/access-requests/:reqId/approve', async (ctx) => services.access.decide(requireAuth(ctx).id, ctx.params.reqId, 'approved'));

  router.post('/:id/access-requests/:reqId/decline', async (ctx) => services.access.decide(requireAuth(ctx).id, ctx.params.reqId, 'declined'));

  router.post('/:id/access-requests/:reqId/revoke', async (ctx) => services.access.revoke(requireAuth(ctx).id, ctx.params.reqId));

  /**
   * Reads a title/price/stock/specs listing out of one message's worth of
   * text and photo — before any product exists. Same reader `channels.js`
   * uses for a synced channel post; here the result is only ever a preview
   * the seller confirms, never something created on its own.
   */
  router.post('/:id/products/extract', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'products.manage');
    const extracted = await services.ai.extractProductFromPost({
      text: ctx.body.text || '',
      photo: ctx.body.photo || null,
      store: record,
      locale: ctx.locale,
    });
    return { extracted };
  });

  /** The same listing-generation AI uses for an existing product, run over a
   * not-yet-created draft instead — the seller's "write it for me" button on
   * a product they have not confirmed yet. */
  router.post('/:id/products/journal', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'products.manage');
    const generated = await services.ai.generateListing({
      product: {
        title: ctx.body.title || '',
        description: ctx.body.description || '',
        price: ctx.body.price ?? null,
        currency: record.currency,
        stock: ctx.body.stock ?? null,
        properties: ctx.body.properties || [],
        tags: ctx.body.tags || [],
      },
      store: record,
      locale: ctx.locale,
      notes: ctx.body.notes || null,
    });
    return { generated };
  });

  // -- Bringing a public Telegram channel's history in, reviewed before anything goes live ----------------

  router.post('/:id/channel-import', async (ctx) => status(201, await services.channelImport.start(requireAuth(ctx).id, ctx.params.id, { channel: ctx.body?.channel })));
  router.get('/:id/channel-import/current', async (ctx) => ({ job: await services.channelImport.current(requireAuth(ctx).id, ctx.params.id) }));
  router.get('/:id/channel-import/:jobId', async (ctx) => services.channelImport.get(requireAuth(ctx).id, ctx.params.id, ctx.params.jobId));
  router.post('/:id/channel-import/:jobId/commit', async (ctx) => services.channelImport.commit(requireAuth(ctx).id, ctx.params.id, ctx.params.jobId, { items: ctx.body?.items }));
  router.delete('/:id/channel-import/:jobId', async (ctx) => services.channelImport.discard(requireAuth(ctx).id, ctx.params.id, ctx.params.jobId));

  /**
   * A flat photo turned into a photo of it worn — reviewed, not applied
   * automatically. No `productId` yet: this is what the quick-add review
   * screen calls before the product exists at all.
   */
  router.post('/:id/products/mockup', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'products.manage');
    const make = ctx.body?.async === true ? services.mockups.start : services.mockups.generateFromImage;
    const mockup = await make({
      image: ctx.body?.image,
      // no prompt written: the one the platform keeps for this shop's category
      prompt: ctx.body?.prompt || await services.mockups.defaultPromptFor(ctx.body?.categoryId || record.categoryIds?.[0] || null),
      count: ctx.body?.count || 1,
      accountId: record.ownerAccountId,
      storeId: record.id,
      actorAccountId: account.id,
    });
    return status(201, { mockup });
  });

  /** The shop's own photo prompts, and the one the platform uses for its category. */
  router.get('/:id/mockup-prompts', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'products.manage');
    return {
      default: { prompt: await services.mockups.defaultPromptFor(record.categoryIds?.[0] || null) },
      enabled: services.mockups.enabled,
      ...(await services.mockups.listSaved(record.id)),
    };
  });

  router.post('/:id/mockup-prompts', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'products.manage');
    return status(201, await services.mockups.saveSaved(record.id, ctx.body || {}));
  });

  router.patch('/:id/mockup-prompts/:promptId', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'products.manage');
    return services.mockups.saveSaved(record.id, { ...(ctx.body || {}), id: ctx.params.promptId });
  });

  router.delete('/:id/mockup-prompts/:promptId', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'products.manage');
    return services.mockups.removeSaved(record.id, ctx.params.promptId);
  });

  /** Same thing for a product that already exists — picks the category's own default prompt. */
  router.post('/:id/products/:productId/mockup', async (ctx) => {
    const account = requireAuth(ctx);
    await services.stores.assertCan(ctx.params.id, account.id, 'products.manage');
    const make = ctx.body?.async === true ? services.mockups.startForProduct : services.mockups.generateForProduct;
    const mockup = await make(ctx.params.productId, {
      prompt: ctx.body?.prompt || null,
      count: ctx.body?.count || 1,
      image: ctx.body?.image || null,
      actorAccountId: account.id,
    });
    return status(201, { mockup });
  });

  /** A job as it stands now - the page asks again until it is completed or failed. */
  router.get('/:id/mockups/:mockupId', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'products.manage');
    const mockup = await services.mockups.get(ctx.params.mockupId);
    if (!mockup || mockup.storeId !== record.id) throw new NotFoundError('Mockup', ctx.params.mockupId);
    return { mockup: await services.mockups.refresh(mockup.id) };
  });

  /** What a product's photo maker needs on opening: a job still running, photos made but not used, photos that were made. */
  router.get('/:id/products/:productId/mockups', async (ctx) => {
    const account = requireAuth(ctx);
    await services.stores.assertCan(ctx.params.id, account.id, 'products.manage');
    const jobs = await services.mockups.listForProduct(ctx.params.productId, { limit: 5 });
    const running = jobs.find((j) => j.status === 'processing' && Date.now() - new Date(j.createdAt).getTime() < 5 * 60 * 1000) || null;
    return {
      running,
      unused: await services.mockups.unusedFor(ctx.params.productId),
      made: [...(await services.mockups.madeImages(ctx.params.productId))],
    };
  });

  router.post('/:id/products/:productId/mockup/:mockupId/attach', async (ctx) => {
    const account = requireAuth(ctx);
    await services.stores.assertCan(ctx.params.id, account.id, 'products.manage');
    const product = await services.mockups.attachToProduct(ctx.params.mockupId, Number(ctx.body?.resultIndex) || 0, { actorAccountId: account.id });
    return { product };
  });

  /**
   * Rewrites an already-published product's copy with AI — reviewed, not
   * applied automatically. For a product that came in rough (a channel post's
   * own wording, synced as-is), rather than something the seller wrote fresh.
   */
  router.post('/:id/products/:productId/improve', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'products.manage');
    const product = await services.catalog.getProductOrFail(ctx.params.productId, { storeId: record.id });
    const generated = await services.ai.generateListing({ product, store: record, locale: ctx.locale });
    return { generated };
  });

  /** The seller's own replacement text, read the same way a quick-add message is — but never through AI. */
  router.post('/:id/products/:productId/edit-preview', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'products.manage');
    const extracted = services.ai.extractProductManually({ text: ctx.body?.text || '', store: record, locale: ctx.locale });
    return { extracted };
  });

  // -- Orders ----------------------------------------------------------------

  router.get('/:id/orders', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    const { limit, offset } = pageParams(ctx.query);
    return services.orders.listForStore(record.id, {
      status: ctx.query.status ? ctx.query.status.split(',') : null,
      actorAccountId: account.id,
      limit,
      offset,
    });
  });

  router.post('/:id/orders/:orderId/status', async (ctx) => services.orders.updateStatus(ctx.params.orderId, ctx.body.status, {
    actorAccountId: requireAuth(ctx).id,
    note: ctx.body.note || '',
    shipment: ctx.body.shipment || null,
  }));

  /** Tracking details: carrier, code, expected date. */
  router.post('/:id/orders/:orderId/shipment', async (ctx) => services.orders.setShipment(ctx.params.orderId, ctx.body, { actorAccountId: requireAuth(ctx).id }));

  router.post('/:id/orders/:orderId/payment', async (ctx) => services.orders.setPaymentStatus(ctx.params.orderId, ctx.body.paymentStatus, {
    actorAccountId: requireAuth(ctx).id,
    reference: ctx.body.reference || null,
  }));

  /** Card-to-card: approve or decline the receipt the buyer sent. */
  router.post('/:id/orders/:orderId/payment/review', async (ctx) => services.orders.reviewPayment(ctx.params.orderId, ctx.body.decision, {
    actorAccountId: requireAuth(ctx).id,
    reason: ctx.body.reason || '',
  }));

  // -- Discounts -------------------------------------------------------------

  router.post('/:id/products/:productId/discount', async (ctx) => {
    const actorAccountId = requireAuth(ctx).id;
    return Number(ctx.body.percent) > 0
      ? services.catalog.applyDiscount(ctx.params.productId, ctx.body.percent, { actorAccountId })
      : services.catalog.clearDiscount(ctx.params.productId, { actorAccountId });
  });

  /** One offer across the shop: every live product, or just the listed ones. A percent of 0 ends it. */
  router.post('/:id/discount', async (ctx) => services.catalog.discountStore(ctx.params.id, ctx.body.percent, {
    actorAccountId: requireAuth(ctx).id,
    productIds: ctx.body.productIds,
  }));

  // -- Customers -------------------------------------------------------------

  router.get('/:id/customers', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    const { limit, offset } = pageParams(ctx.query);
    return services.customers.listForStore(record.id, { actorAccountId: account.id, limit, offset, search: ctx.query.q || '' });
  });

  router.patch('/:id/customers/:accountId', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    return services.customers.annotate(record.id, ctx.params.accountId, ctx.body, { actorAccountId: account.id });
  });

  // -- Analytics -------------------------------------------------------------

  router.get('/:id/analytics', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    const days = Number(ctx.query.days) || 30;
    return {
      overview: await services.analytics.storeOverview(record.id, { days, actorAccountId: account.id }),
      series: await services.analytics.storeTimeSeries(record.id, { days, actorAccountId: account.id }),
      topProducts: await services.analytics.topProducts(record.id, { actorAccountId: account.id }),
    };
  });

  // -- Price requests: the shop's inbox ----------------------------------------

  router.get('/:id/price-requests', async (ctx) => {
    const { limit, offset } = pageParams(ctx.query);
    return services.priceRequests.listForStore(ctx.params.id, { actorAccountId: requireAuth(ctx).id, status: ctx.query.status || null, limit, offset, locale: ctx.locale });
  });

  router.post('/:id/price-requests/:rid/quote', async (ctx) => services.priceRequests.quote(requireAuth(ctx).id, ctx.params.rid, {
    price: ctx.body.price,
    validHours: ctx.body.validHours,
    note: ctx.body.note,
  }));

  router.post('/:id/price-requests/:rid/decline', async (ctx) => services.priceRequests.decline(requireAuth(ctx).id, ctx.params.rid, ctx.body.reason || ''));

  // -- Card-to-card cards: a shop may hold several ---------------------------------

  router.get('/:id/payment-cards', async (ctx) => services.storeCards.list(ctx.params.id, { actorAccountId: requireAuth(ctx).id }));

  router.post('/:id/payment-cards', async (ctx) => status(201, await services.storeCards.add(ctx.params.id, ctx.body, { actorAccountId: requireAuth(ctx).id })));

  router.patch('/:id/payment-cards/:cardId', async (ctx) => services.storeCards.update(ctx.params.id, ctx.params.cardId, ctx.body, { actorAccountId: requireAuth(ctx).id }));

  router.delete('/:id/payment-cards/:cardId', async (ctx) => services.storeCards.remove(ctx.params.id, ctx.params.cardId, { actorAccountId: requireAuth(ctx).id }));

  // -- Team ------------------------------------------------------------------

  router.get('/:id/members', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'store.view');
    return { items: await services.stores.listMembers(record.id) };
  });

  router.post('/:id/members', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    // A seller knows a person by phone number, not by an internal account id.
    await services.stores.assertCan(record.id, account.id, 'staff.manage'); // before creating any account
    const accountId = ctx.body.accountId || (ctx.body.phone ? (await services.accounts.findOrCreateByPhone(ctx.body.phone)).id : null);
    if (!accountId) throw ValidationError.of('phone', 'validation.required', { field: 'Phone' });
    return services.stores.addMember(record.id, accountId, ctx.body.role || 'staff', { actorAccountId: account.id });
  });

  router.delete('/:id/members/:accountId', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    return services.stores.removeMember(record.id, ctx.params.accountId, { actorAccountId: account.id });
  });

  // -- Telegram channel ------------------------------------------------------

  router.get('/:id/channel', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'store.view');
    return (await services.channels.get(record.id)) || { connected: false };
  });

  /**
   * Connecting needs proof that the bot can post there and that the caller administers the channel.
   * The bot (a trusted service) gathers that proof inside Telegram and sends it; a browser sends
   * only the channel's name, and the core asks Telegram itself - a browser's word is never enough.
   */
  router.post('/:id/channel', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'store.update');
    const trusted = Boolean(ctx.auth?.service);
    const proof = trusted ? ctx.body : await services.telegram.verifiedChannelAnswer(ctx.body.reference, { accountId: account.id });
    return status(201, await services.channels.connect(record.id, proof, { actorAccountId: account.id, syncPosts: trusted ? Boolean(ctx.body.syncPosts) : ctx.body.syncPosts !== false }));
  });

  /** The web's live "check" button for a channel: where the person stands, and what to do next. */
  /** The shop's logo from the connected channel's current photo, kept in our own storage. */
  router.post('/:id/logo/from-channel', async (ctx) => services.channels.useChannelPhotoAsLogo(ctx.params.id, { actorAccountId: requireAuth(ctx).id }));

  router.post('/:id/channel/check', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'store.update');
    return services.telegram.inspectChannel(ctx.body.reference, { accountId: account.id });
  });

  router.patch('/:id/channel', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    return services.channels.setAutoPost(record.id, ctx.body.autoPost !== false, { actorAccountId: account.id });
  });

  router.delete('/:id/channel', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    return services.channels.disconnect(record.id, { actorAccountId: account.id });
  });

  router.post('/:id/channel/backfill', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    return services.channels.backfill(record.id, { actorAccountId: account.id, limit: Number(ctx.body.limit) || 20 });
  });

  /**
   * Drafts: the pre-posting preview. A product queued for the channel waits
   * here until someone approves the copy, and can be run through listing
   * generation any number of times first.
   */
  router.get('/:id/channel/drafts', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    return { items: await services.channels.listDrafts(record.id, { actorAccountId: account.id }) };
  });

  router.get('/:id/channel/drafts/:postId', async (ctx) => services.channels.getDraft(ctx.params.postId, {
    actorAccountId: requireAuth(ctx).id,
  }));

  /** The "generate with AI" button behind the preview screen. */
  router.post('/:id/channel/drafts/:postId/generate', async (ctx) => services.channels.generateDraft(ctx.params.postId, {
    actorAccountId: requireAuth(ctx).id,
    tone: ctx.body.tone || 'friendly',
    language: ctx.body.language || null,
  }));

  router.patch('/:id/channel/drafts/:postId', async (ctx) => services.channels.setDraftCaption(
    ctx.params.postId,
    ctx.body.caption,
    { actorAccountId: requireAuth(ctx).id },
  ));

  /** Writes generated properties and tags onto the product itself. */
  router.post('/:id/channel/drafts/:postId/apply', async (ctx) => services.channels.applySuggestions(ctx.params.postId, {
    actorAccountId: requireAuth(ctx).id,
    properties: ctx.body.properties !== false,
    tags: ctx.body.tags !== false,
  }));

  router.post('/:id/channel/drafts/:postId/approve', async (ctx) => services.channels.approveDraft(ctx.params.postId, {
    actorAccountId: requireAuth(ctx).id,
  }));

  router.delete('/:id/channel/drafts/:postId', async (ctx) => services.channels.discardDraft(ctx.params.postId, {
    actorAccountId: requireAuth(ctx).id,
  }));

  router.post('/:id/channel/buttons', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    return services.channels.setButtons(record.id, ctx.body.buttons, { actorAccountId: account.id });
  });

  router.post('/:id/channel/review', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    return services.channels.setReviewBeforePost(record.id, ctx.body.review !== false, { actorAccountId: account.id });
  });

  router.post('/:id/channel/sync', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    return services.channels.setSyncPosts(record.id, ctx.body.sync !== false, { actorAccountId: account.id });
  });

  // -- Integrations ----------------------------------------------------------

  router.get('/:id/integrations', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'store.update');
    return { items: await services.integrations.listForStore(record.id) };
  });

  router.post('/:id/integrations', async (ctx) => {
    const account = requireAuth(ctx);
    const record = await services.stores.resolve(ctx.params.id);
    await services.stores.assertCan(record.id, account.id, 'store.update');
    return services.integrations.register({ ...ctx.body, storeId: record.id, actorAccountId: account.id });
  });

  root.use('/stores', router);
}
