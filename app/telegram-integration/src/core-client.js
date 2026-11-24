/**
 * The bot's only door into Qbazz.
 *
 * Two implementations behind one interface:
 *   • direct — imports @qbazz/core into this process (one command in dev)
 *   • http   — talks to a deployed core with a service key (production)
 *
 * The flows never learn which one they got. That is deliberate: it means the
 * bot holds no business logic that the web app would later have to reimplement.
 */
export async function createCoreClient(config, { core = null, log = console } = {}) {
  if (config.coreMode === 'direct') {
    // Relative import so the bot runs from a clone without an npm install.
    const resolved = core || (await import('../../qbazz-core/src/index.js').then((m) => m.createCore()));
    log.info?.('core client: in-process (direct)');
    return directClient(resolved);
  }
  log.info?.(`core client: HTTP ${config.coreUrl}`);
  return httpClient(config);
}

/*
 * Both clients can be *scoped to a language*: `client.withLocale('fa')` returns
 * a client whose results are worded in Persian (category names, feed titles,
 * onboarding prompts, error messages). The bot scopes one per update, from the
 * person's account, so no flow has to pass a language around.
 */

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function httpClient(config, locale = null) {
  async function request(method, path, { accountId = null, body = null, query = null } = {}) {
    const url = new URL(path, config.coreUrl);
    if (query) for (const [key, value] of Object.entries(query)) if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, value);

    const headers = {
      'content-type': 'application/json',
      'x-qbazz-service-key': config.serviceKey,
      'x-qbazz-channel': 'telegram',
    };
    // The core words its answers (and errors) for whoever is asking.
    if (locale) headers['x-qbazz-locale'] = locale;
    // Acting on behalf of a user we have already authenticated by Telegram id.
    if (accountId) headers['x-qbazz-account'] = accountId;

    const response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const err = new Error(data?.error?.message || `Core returned ${response.status}`);
      err.code = data?.error?.code;
      err.status = response.status;
      err.details = data?.error?.details;
      // The message is already in the caller's language; keep the code for logic.
      throw err;
    }
    return data;
  }

  const get = (path, accountId, query) => request('GET', path, { accountId, query });
  const post = (path, accountId, body) => request('POST', path, { accountId, body });
  const patch = (path, accountId, body) => request('PATCH', path, { accountId, body });
  const del = (path, accountId, body) => request('DELETE', path, { accountId, body });

  return {
    mode: 'http',
    withLocale: (next) => httpClient(config, next),
    setLocale: (accountId, next) => patch('/me', accountId, { locale: next }),

    resolveIdentity: (payload) => post('/auth/identity/resolve', null, payload),
    session: (accountId) => get('/auth/session', accountId),
    issueLinkCode: (accountId) => post('/auth/link/code', accountId, {}),
    linkVerifiedPhone: (accountId, phone) => post('/auth/phone/verified', accountId, { phone }),
    redeemLinkCode: (code, identity) => post('/auth/link/redeem', null, { code, ...identity }),
    createHandoff: (accountId, payload) => post('/auth/handoff', accountId, payload),

    getChannelSession: (channel, externalId) => get(`/channels/${channel}/${externalId}`),
    channelSessionsForAccount: (accountId, channel) => get(`/channels/by-account/${accountId}`, null, { channel }),
    touchChannelSession: ({ channel, externalId, ...rest }) => post(`/channels/${channel}/${externalId}`, null, rest),
    clearChannelState: (channel, externalId, keys) => del(`/channels/${channel}/${externalId}/state`, null, { keys }),

    categories: (query = {}) => get('/categories', null, query),
    feed: (accountId, query) => get('/feed', accountId, query),
    search: (accountId, query) => get('/search', accountId, query),
    suggest: (q) => get('/suggest', null, { q }),
    geoReverse: (lat, lng) => get('/geo/reverse', null, { lat, lng }),
    geoSearch: (q) => get('/geo/search', null, { q }),
    storefront: (slug, accountId, query = {}) => get(`/s/${slug}`, accountId, query),
    productDetail: (id, accountId) => get(`/products/${id}`, accountId),
    categoryBrowse: (idOrSlug, accountId, query) => get(`/categories/${idOrSlug}/browse`, accountId, query),
    toggleSaved: (accountId, refId) => post('/me/saved', accountId, { refId }),

    addToCart: (accountId, payload) => post('/me/carts/items', accountId, payload),
    listCarts: (accountId) => get('/me/carts', accountId),
    getCart: (accountId, cartId) => get(`/me/carts/${cartId}`, accountId),
    setCartQuantity: (accountId, cartId, key, quantity) => patch(`/me/carts/${cartId}/items/${encodeURIComponent(key)}`, accountId, { quantity }),
    clearCart: (accountId, cartId) => del(`/me/carts/${cartId}`, accountId),
    checkout: (accountId, cartId, payload) => post(`/me/carts/${cartId}/checkout`, accountId, payload),

    myOrders: (accountId, query) => get('/me/orders', accountId, query),
    getOrder: (accountId, id) => get(`/me/orders/${id}`, accountId),
    submitPaymentReceipt: (accountId, id, payload) => post(`/me/orders/${id}/payment-receipt`, accountId, payload),
    cancelOrder: (accountId, id, reason) => post(`/me/orders/${id}/cancel`, accountId, { reason }),
    rateOrder: (accountId, id, payload) => post(`/me/orders/${id}/rate`, accountId, payload),

    myStores: async (accountId) => (await get('/auth/session', accountId)).stores,
    storeOrders: (accountId, storeId, query) => get(`/stores/${storeId}/orders`, accountId, query),
    setOrderStatus: (accountId, storeId, orderId, status) => post(`/stores/${storeId}/orders/${orderId}/status`, accountId, { status }),
    storeAnalytics: (accountId, storeId, days) => get(`/stores/${storeId}/analytics`, accountId, { days }),
    updateStore: (accountId, storeId, payload) => patch(`/stores/${storeId}`, accountId, payload),
    storeProducts: (accountId, storeId, query) => get(`/stores/${storeId}/products`, accountId, query),
    getStoreProduct: (accountId, storeId, productId) => get(`/stores/${storeId}/products/${productId}`, accountId),
    createProduct: (accountId, storeId, payload) => post(`/stores/${storeId}/products`, accountId, payload),
    extractProductDraft: (accountId, storeId, payload) => post(`/stores/${storeId}/products/extract`, accountId, payload),
    generateProductJournal: (accountId, storeId, payload) => post(`/stores/${storeId}/products/journal`, accountId, payload),
    publishProduct: (accountId, storeId, payload) => post(`/stores/${storeId}/products/publish`, accountId, payload).then((r) => r.product),
    updateProduct: (accountId, storeId, productId, payload) => patch(`/stores/${storeId}/products/${productId}`, accountId, payload),
    deleteProduct: (accountId, storeId, productId) => del(`/stores/${storeId}/products/${productId}`, accountId),
    storeCards: (accountId, storeId) => get(`/stores/${storeId}/payment-cards`, accountId),
    addStoreCard: (accountId, storeId, body) => post(`/stores/${storeId}/payment-cards`, accountId, body),
    updateStoreCard: (accountId, storeId, cardId, body) => patch(`/stores/${storeId}/payment-cards/${cardId}`, accountId, body),
    removeStoreCard: (accountId, storeId, cardId) => request('DELETE', `/stores/${storeId}/payment-cards/${cardId}`, { accountId }),
    discountProduct: (accountId, storeId, productId, percent) => post(`/stores/${storeId}/products/${productId}/discount`, accountId, { percent }),
    discountStore: (accountId, storeId, percent) => post(`/stores/${storeId}/discount`, accountId, { percent }),
    reviewPayment: (accountId, storeId, orderId, decision, reason = '') => post(`/stores/${storeId}/orders/${orderId}/payment/review`, accountId, { decision, reason }),
    submitStore: (accountId, storeId) => post(`/stores/${storeId}/submit`, accountId, {}),
    generateMockup: (accountId, storeId, productId, payload = {}) => post(`/stores/${storeId}/products/${productId}/mockup`, accountId, payload).then((r) => r.mockup),
    generateMockupFromImage: (accountId, storeId, payload) => post(`/stores/${storeId}/products/mockup`, accountId, payload).then((r) => r.mockup),
    attachMockup: (accountId, storeId, productId, mockupId, resultIndex = 0) => post(`/stores/${storeId}/products/${productId}/mockup/${mockupId}/attach`, accountId, { resultIndex }).then((r) => r.product),
    improveProduct: (accountId, storeId, productId) => post(`/stores/${storeId}/products/${productId}/improve`, accountId, {}).then((r) => r.generated),
    editProductPreview: (accountId, storeId, productId, text) => post(`/stores/${storeId}/products/${productId}/edit-preview`, accountId, { text }).then((r) => r.extracted),
    getBilling: (accountId) => get('/me/billing', accountId),
    changePlan: (accountId, planId) => post('/me/billing/plan', accountId, { planId }),
    buyPack: (accountId, packId) => post('/me/billing/packs', accountId, { packId }),
    requestTopup: (accountId, payload) => post('/me/billing/topups', accountId, payload),
    listPlans: () => get('/plans', null, {}).then((r) => r.items),
    adminPayments: (accountId) => get('/admin/payments', accountId),
    adminUpdatePaymentSettings: (accountId, body) => patch('/admin/payments/settings', accountId, body),
    adminUpdatePaymentCard: (accountId, cardId, body) => patch(`/admin/payments/cards/${cardId}`, accountId, body),
    adminTopups: (accountId, query) => get('/admin/topups', accountId, query),
    adminDecideTopup: (accountId, topupId, decision, reason = '') => post(`/admin/topups/${topupId}/${decision}`, accountId, { reason }),

    onboardingStart: (accountId, flow, opts = {}) => post('/onboarding/start', accountId, { flow, ...opts }),
    onboardingState: (accountId, flow) => get('/onboarding', accountId, { flow }),
    onboardingAnswer: (accountId, value, opts = {}) => post('/onboarding/answer', accountId, { value, ...opts }),
    onboardingBack: (accountId, opts = {}) => post('/onboarding/back', accountId, opts),
    onboardingSkip: (accountId, opts = {}) => post('/onboarding/skip', accountId, opts),
    onboardingCancel: (accountId, opts = {}) => post('/onboarding/cancel', accountId, opts),

    getChannel: (accountId, storeId) => get(`/stores/${storeId}/channel`, accountId),
    connectChannel: (accountId, storeId, payload) => post(`/stores/${storeId}/channel`, accountId, payload),
    setChannelAutoPost: (accountId, storeId, autoPost) => patch(`/stores/${storeId}/channel`, accountId, { autoPost }),
    disconnectChannel: (accountId, storeId) => del(`/stores/${storeId}/channel`, accountId),
    backfillChannel: (accountId, storeId, range = {}) => post(`/stores/${storeId}/channel/backfill`, accountId, range),
    listDrafts: (accountId, storeId) => get(`/stores/${storeId}/channel/drafts`, accountId),
    getDraft: (accountId, storeId, postId) => get(`/stores/${storeId}/channel/drafts/${postId}`, accountId),
    generateDraft: (accountId, storeId, postId, opts = {}) => post(`/stores/${storeId}/channel/drafts/${postId}/generate`, accountId, opts),
    setDraftCaption: (accountId, storeId, postId, caption) => patch(`/stores/${storeId}/channel/drafts/${postId}`, accountId, { caption }),
    applyDraftSuggestions: (accountId, storeId, postId) => post(`/stores/${storeId}/channel/drafts/${postId}/apply`, accountId, {}),
    approveDraft: (accountId, storeId, postId) => post(`/stores/${storeId}/channel/drafts/${postId}/approve`, accountId, {}),
    discardDraft: (accountId, storeId, postId) => del(`/stores/${storeId}/channel/drafts/${postId}`, accountId),
    setChannelReview: (accountId, storeId, review) => post(`/stores/${storeId}/channel/review`, accountId, { review }),
    pendingChannelPosts: (limit) => get('/sync/channel-posts/pending', null, { limit }),
    markChannelPosted: (id, payload) => post(`/sync/channel-posts/${id}/posted`, null, payload),
    ingestChannelPost: (payload) => post('/sync/channel-posts/ingest', null, payload),
    ingestChannelEdit: (payload) => post('/sync/channel-posts/edited', null, payload),
    channelBotAdded: (payload) => post('/sync/channel-claims', null, payload),
    setChannelSync: (accountId, storeId, sync) => post(`/stores/${storeId}/channel/sync`, accountId, { sync }),
    channelImportStart: (accountId, storeId, channel, range = {}) => post(`/stores/${storeId}/channel-import`, accountId, { channel, ...range }),
    channelImportGet: (accountId, storeId, jobId) => get(`/stores/${storeId}/channel-import/${jobId}`, accountId),
    channelImportCommit: (accountId, storeId, jobId, items) => post(`/stores/${storeId}/channel-import/${jobId}/commit`, accountId, { items }),

    pendingNotifications: (channel, limit) => get('/sync/notifications/pending', null, { channel, limit }),
    markNotificationDelivered: (id, payload) => post(`/sync/notifications/${id}/delivered`, null, payload),

    adminOverview: (accountId) => get('/admin/overview', accountId),
    adminReviewQueue: (accountId, query) => get('/admin/review-queue', accountId, query),
    adminApprove: (accountId, storeId) => post(`/admin/stores/${storeId}/approve`, accountId, {}),
    adminReject: (accountId, storeId, reason) => post(`/admin/stores/${storeId}/reject`, accountId, { reason }),
  };
}

// ---------------------------------------------------------------------------
// Direct (in-process)
// ---------------------------------------------------------------------------

function directClient(core, locale = null) {
  const s = core.services;

  return {
    mode: 'direct',
    core,
    withLocale: (next) => directClient(core, next),
    setLocale: (accountId, next) => s.accounts.setLocale(accountId, next),

    resolveIdentity: (payload) => s.accounts.resolveChannelIdentity(payload),
    session: async (accountId) => ({
      account: await s.accounts.get(accountId),
      identities: await s.accounts.listIdentities(accountId),
      stores: await s.stores.listForAccount(accountId),
      onboarding: await s.onboarding.state(accountId),
    }),
    issueLinkCode: (accountId) => s.accounts.issueLinkCode(accountId),
    linkVerifiedPhone: (accountId, phone) => s.accounts.linkVerifiedPhone(accountId, phone),
    redeemLinkCode: (code, identity) => s.accounts.redeemLinkCode(code, identity),
    createHandoff: (accountId, payload) => s.integrations.createHandoff({ accountId, ...payload }),

    getChannelSession: async (channel, externalId) => (await s.integrations.getChannelSession(channel, externalId)) || { state: {}, accountId: null },
    channelSessionsForAccount: async (accountId, channel) => ({
      items: (await s.integrations.sessionsForAccount(accountId)).filter((row) => !channel || row.channel === channel),
    }),
    touchChannelSession: (payload) => s.integrations.touchChannelSession(payload),
    clearChannelState: (channel, externalId, keys) => s.integrations.clearChannelState(channel, externalId, keys),

    categories: async (query = {}) => ({
      items: await s.catalog.listCategories({ parentId: query.parent ? undefined : null, parent: query.parent || null, withCounts: true, locale }),
    }),
    feed: (accountId, query = {}) => s.discovery.homeFeed({ accountId, city: query.city || null, channel: 'telegram', locale }),
    search: (accountId, query = {}) => s.discovery.search({
      q: query.q || '',
      type: query.type || 'all',
      categoryId: query.category || null,
      storeId: query.store || null,
      city: query.city || null,
      sort: query.sort || 'relevance',
      limit: Number(query.limit) || 20,
      offset: Number(query.offset) || 0,
      accountId,
      channel: 'telegram',
      locale,
    }),
    suggest: async (q) => ({ items: await s.discovery.suggest(q, { locale }) }),
    geoReverse: async (lat, lng) => (await s.geo.reverse(Number(lat), Number(lng))) || { city: null, label: null, lat, lng },
    geoSearch: async (q) => ({ items: await s.geo.search(q) }),
    storefront: (slug, accountId, query = {}) => s.discovery.storefront(slug, { accountId, channel: 'telegram', locale, categoryId: query.categoryId || null }),
    productDetail: (id, accountId) => s.discovery.productDetail(id, { accountId, channel: 'telegram', locale }),
    categoryBrowse: (idOrSlug, accountId, query = {}) => s.discovery.categoryBrowse(idOrSlug, {
      limit: Number(query.limit) || 20,
      offset: Number(query.offset) || 0,
      sort: query.sort || 'popular',
      locale,
    }),
    toggleSaved: (accountId, refId) => s.discovery.toggleSaved(accountId, { refId }),

    addToCart: (accountId, payload) => s.carts.addItem(accountId, { ...payload, channel: 'telegram' }),
    listCarts: async (accountId) => ({ items: await s.carts.listOpen(accountId) }),
    getCart: (accountId, cartId) => s.carts.get(cartId),
    setCartQuantity: (accountId, cartId, key, quantity) => s.carts.setQuantity(accountId, cartId, key, quantity, { channel: 'telegram' }),
    clearCart: (accountId, cartId) => s.carts.clear(accountId, cartId),
    checkout: (accountId, cartId, payload) => s.orders.checkout(accountId, cartId, { ...payload, channel: 'telegram' }),

    myOrders: (accountId, query = {}) => s.orders.listForBuyer(accountId, { limit: Number(query.limit) || 20, offset: Number(query.offset) || 0, status: query.status }),
    getOrder: async (accountId, id) => {
      const order = await s.orders.getForActor(id, accountId);
      // Same as GET /me/orders/:id — only the buyer is told where to send the money.
      return order.accountId === accountId ? { ...order, payLink: s.gateway.payLink(order), payTo: await s.orders.paymentInstructions(order) } : order;
    },
    submitPaymentReceipt: (accountId, id, payload) => s.orders.submitPaymentReceipt(id, accountId, payload),
    cancelOrder: (accountId, id, reason) => s.orders.updateStatus(id, 'cancelled', { actorAccountId: accountId, byBuyer: true, note: reason || '' }),
    rateOrder: (accountId, id, payload) => s.orders.rate(id, accountId, payload),

    myStores: (accountId) => s.stores.listForAccount(accountId),
    storeOrders: (accountId, storeId, query = {}) => s.orders.listForStore(storeId, {
      actorAccountId: accountId,
      status: query.status ? String(query.status).split(',') : null,
      limit: Number(query.limit) || 20,
      offset: Number(query.offset) || 0,
    }),
    setOrderStatus: (accountId, storeId, orderId, status) => s.orders.updateStatus(orderId, status, { actorAccountId: accountId }),
    updateStore: (accountId, storeId, payload) => s.stores.update(storeId, payload, { actorAccountId: accountId }),
    storeAnalytics: async (accountId, storeId, days = 30) => ({
      overview: await s.analytics.storeOverview(storeId, { days, actorAccountId: accountId }),
      series: await s.analytics.storeTimeSeries(storeId, { days, actorAccountId: accountId }),
      topProducts: await s.analytics.topProducts(storeId, { actorAccountId: accountId }),
    }),
    storeProducts: (accountId, storeId, query = {}) => s.catalog.listProducts({
      storeId,
      status: query.status,
      limit: Number(query.limit) || 20,
      offset: Number(query.offset) || 0,
    }),
    getStoreProduct: async (accountId, storeId, productId) => {
      const record = await s.stores.resolve(storeId);
      await s.stores.assertCan(record.id, accountId, 'products.manage');
      return s.catalog.getProductOrFail(productId, { storeId: record.id });
    },
    createProduct: (accountId, storeId, payload) => s.catalog.createProduct(storeId, payload, { actorAccountId: accountId }),
    extractProductDraft: async (accountId, storeId, payload) => {
      const record = await s.stores.resolve(storeId);
      await s.stores.assertCan(record.id, accountId, 'products.manage');
      return { extracted: await s.ai.extractProductFromPost({ text: payload.text || '', photo: payload.photo || null, store: record, locale }) };
    },
    generateProductJournal: async (accountId, storeId, payload) => {
      const record = await s.stores.resolve(storeId);
      await s.stores.assertCan(record.id, accountId, 'products.manage');
      return {
        generated: await s.ai.generateListing({
          product: {
            title: payload.title || '',
            description: payload.description || '',
            price: payload.price ?? null,
            currency: record.currency,
            stock: payload.stock ?? null,
            properties: payload.properties || [],
            tags: payload.tags || [],
          },
          store: record,
          locale,
          notes: payload.notes || null,
        }),
      };
    },
    publishProduct: async (accountId, storeId, payload) => {
      const { telegram, ...productInput } = payload;
      const product = await s.catalog.createProduct(storeId, productInput, { actorAccountId: accountId, skipChannelSync: true });
      if (telegram) await s.channels.queueProduct(product.id, { force: true, reason: 'manual_publish' }).catch(() => null);
      return product;
    },
    updateProduct: (accountId, storeId, productId, payload) => s.catalog.updateProduct(productId, payload, { actorAccountId: accountId }),
    deleteProduct: (accountId, storeId, productId) => s.catalog.deleteProduct(productId, { actorAccountId: accountId }),
    storeCards: (accountId, storeId) => s.storeCards.list(storeId, { actorAccountId: accountId }),
    addStoreCard: (accountId, storeId, body) => s.storeCards.add(storeId, body, { actorAccountId: accountId }),
    updateStoreCard: (accountId, storeId, cardId, body) => s.storeCards.update(storeId, cardId, body, { actorAccountId: accountId }),
    removeStoreCard: (accountId, storeId, cardId) => s.storeCards.remove(storeId, cardId, { actorAccountId: accountId }),
    discountProduct: (accountId, storeId, productId, percent) => (Number(percent) > 0
      ? s.catalog.applyDiscount(productId, percent, { actorAccountId: accountId })
      : s.catalog.clearDiscount(productId, { actorAccountId: accountId })),
    discountStore: (accountId, storeId, percent) => s.catalog.discountStore(storeId, percent, { actorAccountId: accountId }),
    reviewPayment: (accountId, storeId, orderId, decision, reason = '') => s.orders.reviewPayment(orderId, decision, { actorAccountId: accountId, reason }),
    submitStore: (accountId, storeId) => s.stores.submitForReview(storeId, accountId),
    generateMockup: (accountId, storeId, productId, payload = {}) => s.mockups.generateForProduct(productId, {
      prompt: payload.prompt || null, count: payload.count || 1, actorAccountId: accountId,
    }),
    generateMockupFromImage: async (accountId, storeId, payload) => {
      const record = await s.stores.resolve(storeId);
      return s.mockups.generateFromImage({
        image: payload.image, prompt: payload.prompt || null, count: payload.count || 1,
        accountId: record.ownerAccountId, storeId, actorAccountId: accountId,
      });
    },
    attachMockup: (accountId, storeId, productId, mockupId, resultIndex = 0) => s.mockups.attachToProduct(mockupId, resultIndex, { actorAccountId: accountId }),
    improveProduct: async (accountId, storeId, productId) => {
      const [product, record] = await Promise.all([s.catalog.getProduct(productId), s.stores.resolve(storeId)]);
      return s.ai.generateListing({ product, store: record, locale });
    },
    editProductPreview: async (accountId, storeId, productId, text) => {
      const record = await s.stores.resolve(storeId);
      return s.ai.extractProductManually({ text, store: record, locale });
    },
    getBilling: async (accountId) => ({
      wallet: await s.wallet.getBalance(accountId),
      ...(await s.subscriptions.summary(accountId)),
      packs: s.subscriptions.listPacks(),
      topup: await s.topups.instructions(accountId),
      topups: (await s.topups.listMine(accountId, { limit: 5 })).items,
    }),
    changePlan: (accountId, planId) => s.subscriptions.changePlan(accountId, planId, { actorAccountId: accountId }),
    buyPack: (accountId, packId) => s.subscriptions.buyPack(accountId, packId, { actorAccountId: accountId }),
    requestTopup: (accountId, payload) => s.topups.request(accountId, payload),
    adminPayments: (accountId) => s.admin.getPayments(accountId),
    adminUpdatePaymentSettings: (accountId, body) => s.admin.updatePaymentSettings(accountId, body),
    adminUpdatePaymentCard: (accountId, cardId, body) => s.admin.updatePaymentCard(accountId, cardId, body),
    adminTopups: (accountId, query = {}) => s.admin.listTopups(accountId, { status: query.status || null, limit: Number(query.limit) || 5, offset: Number(query.offset) || 0 }),
    adminDecideTopup: (accountId, topupId, decision, reason = '') => s.admin.decideTopup(accountId, topupId, decision, { reason }),
    listPlans: () => s.subscriptions.listPlans(),

    onboardingStart: (accountId, flow, opts = {}) => s.onboarding.start(accountId, flow, { channel: 'telegram', ...opts }),
    onboardingState: (accountId, flow) => s.onboarding.state(accountId, { flow, channel: 'telegram', locale }),
    // In-process, so the bot is trusted the same way a service-key call is.
    onboardingAnswer: (accountId, value, opts = {}) => s.onboarding.answer(accountId, value, { channel: 'telegram', locale, trusted: true, ...opts }),
    onboardingBack: (accountId, opts = {}) => s.onboarding.back(accountId, { channel: 'telegram', locale, ...opts }),
    onboardingSkip: (accountId, opts = {}) => s.onboarding.skip(accountId, { channel: 'telegram', locale, ...opts }),
    onboardingCancel: (accountId, opts = {}) => s.onboarding.cancel(accountId, opts),

    getChannel: async (accountId, storeId) => (await s.channels.get(storeId)) || { connected: false },
    connectChannel: (accountId, storeId, payload) => s.channels.connect(storeId, payload, { actorAccountId: accountId, syncPosts: payload.syncPosts }),
    setChannelAutoPost: (accountId, storeId, autoPost) => s.channels.setAutoPost(storeId, autoPost, { actorAccountId: accountId }),
    disconnectChannel: (accountId, storeId) => s.channels.disconnect(storeId, { actorAccountId: accountId }),
    backfillChannel: (accountId, storeId, range = {}) => s.channels.backfill(storeId, { actorAccountId: accountId, ...range }),
    channelImportStart: (accountId, storeId, channel, range = {}) => s.channelImport.start(accountId, storeId, { channel, ...range }),
    channelImportGet: (accountId, storeId, jobId) => s.channelImport.get(accountId, storeId, jobId),
    channelImportCommit: (accountId, storeId, jobId, items) => s.channelImport.commit(accountId, storeId, jobId, { items }),
    listDrafts: async (accountId, storeId) => ({ items: await s.channels.listDrafts(storeId, { actorAccountId: accountId }) }),
    getDraft: (accountId, storeId, postId) => s.channels.getDraft(postId, { actorAccountId: accountId }),
    generateDraft: (accountId, storeId, postId, opts = {}) => s.channels.generateDraft(postId, { actorAccountId: accountId, ...opts }),
    setDraftCaption: (accountId, storeId, postId, caption) => s.channels.setDraftCaption(postId, caption, { actorAccountId: accountId }),
    applyDraftSuggestions: (accountId, storeId, postId) => s.channels.applySuggestions(postId, { actorAccountId: accountId }),
    approveDraft: (accountId, storeId, postId) => s.channels.approveDraft(postId, { actorAccountId: accountId }),
    discardDraft: (accountId, storeId, postId) => s.channels.discardDraft(postId, { actorAccountId: accountId }),
    setChannelReview: (accountId, storeId, review) => s.channels.setReviewBeforePost(storeId, review, { actorAccountId: accountId }),
    pendingChannelPosts: async (limit) => ({ items: await s.channels.pending({ limit }) }),
    markChannelPosted: (id, payload) => s.channels.markPosted(id, payload),
    ingestChannelPost: async (payload) => ({ product: await s.channels.ingestChannelPost(payload) }),
    ingestChannelEdit: async (payload) => ({ product: await s.channels.applyChannelEdit(payload) }),
    channelBotAdded: (payload) => s.telegram.botAdded(payload),
    setChannelSync: (accountId, storeId, sync) => s.channels.setSyncPosts(storeId, sync, { actorAccountId: accountId }),

    pendingNotifications: async (channel, limit) => ({ items: await s.notifications.pending({ channel, limit }) }),
    markNotificationDelivered: (id, payload) => s.notifications.markDelivered(id, payload.channel || 'telegram', payload),

    adminOverview: async (accountId) => {
      await s.admin.assertAdmin(accountId, { allowSupport: true });
      return {
        platform: await s.analytics.platformOverview({}),
        topStores: await s.analytics.topStores({}),
        reviewQueueSize: (await s.admin.reviewQueue(accountId, { limit: 1 })).total,
      };
    },
    adminReviewQueue: (accountId, query = {}) => s.admin.reviewQueue(accountId, { limit: Number(query.limit) || 20, offset: Number(query.offset) || 0 }),
    adminApprove: (accountId, storeId) => s.admin.approveStore(accountId, storeId),
    adminReject: (accountId, storeId, reason) => s.admin.rejectStore(accountId, storeId, reason),
  };
}
