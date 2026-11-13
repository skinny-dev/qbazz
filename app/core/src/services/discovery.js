import { COLLECTIONS } from '../models/schemas.js';
import { NotFoundError } from '../errors.js';
import { newId } from '../util/ids.js';
import { formatMoney } from '../util/money.js';
import { paged } from '../util/paginate.js';
import { normalizeText } from '../util/text.js';
import { translate } from '../i18n/index.js';

/**
 * Discovery: search, browse, feeds and store/product detail.
 *
 * Everything here returns *surfaces* — plain data shaped for presentation but
 * with no presentation in it. The Telegram bot turns a section into a message
 * with inline buttons; the web storefront turns the same section into a row of
 * cards. Ranking, filtering and the "what's on the home screen" decision live
 * here once, so the two surfaces can never drift apart.
 */
export function createDiscoveryService(ctx) {
  const { store: db, config, events, services } = ctx;
  const products = db.collection(COLLECTIONS.products);
  const stores = db.collection(COLLECTIONS.stores);
  const savedItems = db.collection(COLLECTIONS.savedItems);
  const searchLogs = db.collection(COLLECTIONS.searchLogs);

  const liveStore = { status: 'active', discoverable: true };
  const liveProduct = { status: 'active' };

  /**
   * Product status alone is not enough to be publicly visible — the parent
   * store has to be live too. Every product-listing path filters through this,
   * so a draft, paused or suspended shop disappears from discovery at once
   * without having to rewrite each of its products.
   */
  async function liveStoreIds() {
    const rows = await stores.find({ where: liveStore });
    return new Set(rows.map((row) => row.id));
  }

  // -- Search ----------------------------------------------------------------

  /**
   * One search entry point for both surfaces. `type` selects products, stores
   * or both; the bot's inline mode and the web search bar pass identical args.
   */
  async function search(input = {}) {
    const {
      q = '',
      type = 'all',
      categoryId = null,
      storeId = null,
      city = null,
      priceMin = null,
      priceMax = null,
      tags = null,
      onSale = false,
      sort = 'relevance',
      limit = 20,
      offset = 0,
      accountId = null,
      locale = null,
    } = input;

    const terms = tokenize(q);
    const wantProducts = type === 'all' || type === 'products';
    const wantStores = type === 'all' || type === 'stores';

    const categoryRecord = categoryId ? await services.catalog.getCategory(categoryId) : null;
    const resolvedCategoryId = categoryRecord?.id || null;
    // A group holds its sub-categories' products and shops: browsing "tops"
    // shows the t-shirts and the hoodies, not an empty shelf.
    const categoryScope = categoryRecord ? await services.catalog.descendantIds(categoryRecord.id) : null;

    let productHits = [];
    if (wantProducts) {
      const live = await liveStoreIds();
      const rows = await products.find({ where: { ...liveProduct, ...(storeId ? { storeId } : {}), ...(categoryScope ? { categoryId: { $in: categoryScope } } : {}) } });
      productHits = rows
        .filter((row) => live.has(row.storeId))
        .filter((row) => (priceMin === null || row.price >= priceMin) && (priceMax === null || row.price <= priceMax))
        .filter((row) => !tags?.length || tags.some((tag) => row.tags?.includes(tag)))
        .filter((row) => !onSale || (row.compareAtPrice > row.price && row.price > 0))
        .map((row) => ({ kind: 'product', row, score: scoreProduct(row, terms) }))
        .filter((hit) => !terms.length || hit.score > 0);
    }

    let storeHits = [];
    if (wantStores && !onSale) {
      const rows = await stores.find({ where: liveStore });
      storeHits = rows
        .filter((row) => !categoryScope || (row.categoryIds || []).some((id) => categoryScope.includes(id)))
        .filter((row) => !city || sameCity(row.location?.city, city))
        .map((row) => ({ kind: 'store', row, score: scoreStore(row, terms) }))
        .filter((hit) => !terms.length || hit.score > 0);
    }

    // City is a soft signal for products: same-city results float up.
    if (city && productHits.length) {
      for (const hit of productHits) {
        const parent = await stores.get(hit.row.storeId);
        if (sameCity(parent?.location?.city, city)) hit.score += 15;
      }
    }

    let hits = [...productHits, ...storeHits];
    hits = applySort(hits, sort);

    const total = hits.length;
    const window = hits.slice(offset, offset + limit);
    const items = await Promise.all(window.map((hit) => (hit.kind === 'product' ? productCard(hit.row, { locale }) : storeCard(hit.row))));

    if (q) {
      await searchLogs.insert({ id: newId('slg'), q: q.slice(0, 120), accountId, resultCount: total, type, channel: input.channel || 'unknown' });
      await events.emit('search.performed', { q, accountId, resultCount: total, channel: input.channel || 'unknown' });
    }

    return { query: { q, type, categoryId: resolvedCategoryId, city, sort }, ...paged(items, total, { limit, offset }) };
  }

  /** Typeahead for the web search bar and the bot's inline query. */
  async function suggest(q, { limit = 8, locale = null } = {}) {
    if (!q || q.length < 2) {
      const trending = await trendingSearches({ limit });
      return trending.map((t) => ({ type: 'query', text: t.q }));
    }
    const needle = normalizeText(q);
    const live = await liveStoreIds();
    const [productMatches, storeRows, categoryRows] = await Promise.all([
      products.find({ where: { ...liveProduct, searchText: { $icontains: needle } }, limit: limit * 3 }),
      stores.find({ where: liveStore, limit: 50 }),
      services.catalog.listCategories({ locale }),
    ]);
    const productRows = productMatches.filter((p) => live.has(p.storeId)).slice(0, limit);
    return [
      ...categoryRows.filter((c) => normalizeText(c.name).includes(needle)).slice(0, 2).map((c) => ({ type: 'category', id: c.id, text: `${c.icon || ''} ${c.name}`.trim(), slug: c.slug })),
      ...storeRows.filter((s) => normalizeText(s.name).includes(needle)).slice(0, 3).map((s) => ({ type: 'store', id: s.id, text: s.name, slug: s.slug })),
      ...productRows.slice(0, limit).map((p) => ({ type: 'product', id: p.id, text: p.title, storeName: p.storeName })),
    ].slice(0, limit);
  }

  async function trendingSearches({ limit = 6, days = 7 } = {}) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = await searchLogs.find({ where: { createdAt: { $gte: since } } });
    const counts = new Map();
    for (const row of rows) {
      if (!row.q || row.resultCount === 0) continue;
      const key = row.q.toLowerCase().trim();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([q, count]) => ({ q, count }));
  }

  // -- Feeds -----------------------------------------------------------------

  /**
   * The home surface. Returns ordered sections; a client renders as many as it
   * has room for. The bot shows 3–4 sections as a message + buttons, the web
   * storefront shows all of them as carousels.
   */
  /** A shop card with a few of its best-selling photos, so a shop reads as a place and not a name. */
  async function withPreview(card) {
    const rows = await products.find({ where: (p) => p.storeId === card.id && p.status === 'active' && p.images?.length, sort: [['stats.orders', 'desc']], limit: 3 });
    return { ...card, preview: rows.map((p) => p.images[0]) };
  }

  /**
   * Every live shop, for the "Shops" screen: filtered by the group it is filed under, its city or a few letters of its
   * name, ordered the way a visitor chooses. Returns what the filters could offer too, so the screen never shows a
   * filter that would come back empty.
   */
  async function shops({ q = '', categoryId = null, city = null, sort = 'popular', limit = 24, offset = 0, locale = null } = {}) {
    const all = await stores.find({ where: liveStore });
    const needle = normalizeText(q);
    const matches = (record, { skipCategory = false, skipCity = false } = {}) => (
      (!needle || normalizeText(`${record.name} ${record.tagline || ''}`).includes(needle))
      && (skipCategory || !categoryId || (record.categoryIds || []).includes(categoryId))
      && (skipCity || !city || record.location?.city === city)
    );
    const rows = all.filter((record) => matches(record));
    const score = (r) => (r.stats?.orders || 0) * 10 + (r.stats?.views || 0) * 0.5 + ratingOf(r.stats) * 4 + (r.featured ? 50 : 0) + (r.verified ? 20 : 0);
    const order = {
      popular: (a, b) => score(b) - score(a),
      new: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
      rating: (a, b) => ratingOf(b.stats) - ratingOf(a.stats) || score(b) - score(a),
      products: (a, b) => (b.stats?.products || 0) - (a.stats?.products || 0),
    }[sort] || ((a, b) => score(b) - score(a));
    rows.sort(order);
    const pageRows = rows.slice(offset, offset + limit);

    const groups = await services.catalog.listCategories({ parentId: null, locale });
    const categories = groups
      .map((g) => ({ id: g.id, name: g.name, icon: g.icon, count: all.filter((r) => matches(r, { skipCategory: true }) && (r.categoryIds || []).includes(g.id)).length }))
      .filter((g) => g.count > 0);
    const cityCounts = {};
    for (const r of all.filter((x) => matches(x, { skipCity: true }))) if (r.location?.city) cityCounts[r.location.city] = (cityCounts[r.location.city] || 0) + 1;
    const cities = Object.entries(cityCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

    return {
      items: await Promise.all(pageRows.map(async (record) => withPreview(await storeCard(record)))),
      page: { total: rows.length, limit, offset, hasMore: offset + pageRows.length < rows.length },
      facets: { categories, cities },
    };
  }

  async function homeFeed({ accountId = null, city = null, limit = 8, channel = 'web', locale = null } = {}) {
    const sections = [];
    const t = (key, params) => translate(locale || config.platform.defaultLocale, key, params);

    const categories = await services.catalog.listCategories({ parentId: null, withCounts: true, locale });
    sections.push({
      id: 'categories',
      title: t('feed.categories'),
      layout: 'chips',
      items: categories.map((c) => ({
        type: 'category',
        id: c.id,
        slug: c.slug,
        title: c.name,
        icon: c.icon,
        subtitle: t('feed.items', { count: c.productCount }),
      })),
    });

    if (accountId) {
      const resumable = await continueShopping(accountId, { locale });
      if (resumable.length) {
        sections.push({ id: 'continue', title: t('feed.continue'), layout: 'list', items: resumable });
      }
    }

    const featured = await stores.find({ where: { ...liveStore, featured: true }, limit, sort: [['stats.orders', 'desc']] });
    if (featured.length) {
      sections.push({ id: 'featured', title: t('feed.featured'), layout: 'carousel', items: await Promise.all(featured.map(async (record) => withPreview(await storeCard(record)))) });
    }

    // Everything currently marked down, biggest saving first.
    const liveForDeals = await liveStoreIds();
    const marked = (await products.find({ where: liveProduct })).filter((p) => liveForDeals.has(p.storeId) && p.compareAtPrice && p.price != null && p.compareAtPrice > p.price);
    const deals = marked.sort((a, b) => (b.compareAtPrice - b.price) / b.compareAtPrice - (a.compareAtPrice - a.price) / a.compareAtPrice).slice(0, limit);
    if (deals.length) sections.push({ id: 'deals', title: t('feed.deals'), layout: 'carousel-products', items: await Promise.all(deals.map((p) => productCard(p, { locale }))) });

    const trending = await trendingProducts({ limit, city, locale });
    if (trending.length) sections.push({ id: 'trending', title: t('feed.trending'), layout: 'grid', items: trending });

    const live = await liveStoreIds();
    const fresh = (await products.find({ where: liveProduct, sort: [['publishedAt', 'desc']], limit: limit * 3 }))
      .filter((p) => live.has(p.storeId))
      .slice(0, limit);
    if (fresh.length) {
      sections.push({ id: 'new', title: t('feed.new'), layout: 'carousel-products', items: await Promise.all(fresh.map((p) => productCard(p, { locale }))) });
    }

    if (city) {
      // Compared normalised, so a city typed with Arabic letters still finds
      // the shops that spelled it with Persian ones.
      const nearby = (await stores.find({ where: liveStore })).filter((record) => sameCity(record.location?.city, city)).slice(0, limit);
      if (nearby.length) {
        sections.push({ id: 'nearby', title: t('feed.nearby', { city }), layout: 'carousel', items: await Promise.all(nearby.map(async (record) => withPreview(await storeCard(record)))) });
      }
    }

    await events.emit('discovery.feed_served', { accountId, channel, sections: sections.length });
    const liveShops = await liveStoreIds();
    return {
      surface: 'home',
      channel,
      stats: { shops: liveShops.size, products: (await products.find({ where: liveProduct })).filter((p) => liveShops.has(p.storeId)).length },
      sections: sections.filter((s) => s.items.length),
    };
  }

  async function trendingProducts({ limit = 8, city = null, days = 14, locale = null } = {}) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const live = await liveStoreIds();
    const rows = (await products.find({ where: liveProduct })).filter((row) => live.has(row.storeId));
    const scored = [];
    for (const row of rows) {
      const recency = new Date(row.publishedAt || row.createdAt) >= new Date(since) ? 8 : 0;
      let score = (row.stats?.orders || 0) * 10 + (row.stats?.views || 0) * 0.5 + recency + ratingOf(row.stats) * 4;
      if (city) {
        const parent = await stores.get(row.storeId);
        if (sameCity(parent?.location?.city, city)) score *= 1.4;
      }
      scored.push({ row, score });
    }
    return Promise.all(scored.sort((a, b) => b.score - a.score).slice(0, limit).map((hit) => productCard(hit.row, { locale })));
  }

  /** Open carts across every store — the strongest re-engagement surface we have. */
  async function continueShopping(accountId, { locale = null } = {}) {
    const carts = await services.carts.listOpen(accountId);
    const loc = locale || config.platform.defaultLocale;
    return Promise.all(carts.slice(0, 5).map(async (cart) => ({
      type: 'cart',
      id: cart.id,
      storeId: cart.storeId,
      storeSlug: (await stores.get(cart.storeId))?.slug || null,
      storeImage: (await stores.get(cart.storeId))?.logoUrl || null,
      thumbs: cart.items.map((item) => item.image).filter(Boolean).slice(0, 4),
      itemCount: cart.itemCount,
      total: formatMoney(cart.totals.total, cart.totals.currency, loc),
      title: cart.storeName,
      subtitle: translate(loc, 'feed.cart_subtitle', { count: cart.itemCount, total: formatMoney(cart.totals.total, cart.totals.currency, loc) }),
      image: cart.items[0]?.image || null,
      action: { type: 'open_cart', cartId: cart.id },
    })));
  }

  // -- Detail surfaces -------------------------------------------------------

  async function storefront(idOrSlug, { accountId = null, productLimit = 24, productOffset = 0, channel = 'web', locale = null, categoryId = null } = {}) {
    const record = await services.stores.resolve(idOrSlug);
    if (record.status !== 'active') {
      // Its own staff can preview it, and platform staff have to be able to
      // look at a shop in order to review it.
      const staffRole = accountId ? await services.stores.roleOf(record.id, accountId) : null;
      const viewer = accountId ? await db.collection(COLLECTIONS.accounts).get(accountId) : null;
      const isPlatformStaff = viewer?.role === 'admin' || viewer?.role === 'support';
      if (!staffRole && !isPlatformStaff) throw new NotFoundError('Store', idOrSlug);
    }

    // Arriving from a category (bot: "this shop's Tops"; web: a filtered storefront
    // URL) narrows the list to that category's subtree, not the shop's whole catalogue.
    const scope = categoryId ? await services.catalog.descendantIds(categoryId) : null;
    const productWhere = { storeId: record.id, status: { $in: ['active', 'out_of_stock'] }, ...(scope ? { categoryId: { $in: scope } } : {}) };
    const [items, productTotal, categoriesAll, category] = await Promise.all([
      products.find({ where: productWhere, sort: [['createdAt', 'desc']], limit: productLimit, offset: productOffset }),
      products.count(productWhere),
      services.catalog.listCategories({ locale }),
      categoryId ? services.catalog.getCategory(categoryId) : null,
    ]);

    const usedCategoryIds = [...new Set(items.map((p) => p.categoryId).filter(Boolean))];
    const cart = accountId ? await services.carts.getOpenCart(accountId, record.id) : null;

    // Only the first page is a visit; the rest of a long catalogue is the same visit loading on.
    if (!productOffset) {
      await stores.mutate(record.id, (draft) => {
        draft.stats = { ...draft.stats, views: (draft.stats?.views || 0) + 1 };
        return draft;
      });
      await events.emit('store.viewed', { storeId: record.id, accountId, channel });
    }

    return {
      surface: 'storefront',
      store: await storeCard(record, { full: true }),
      category: category ? services.catalog.localizeCategory(category, locale) : null,
      categories: categoriesAll.filter((c) => usedCategoryIds.includes(c.id)),
      products: await Promise.all(items.map((p) => productCard(p, { locale }))),
      page: { total: productTotal, limit: productLimit, offset: productOffset, hasMore: productOffset + items.length < productTotal },
      cart: cart ? { id: cart.id, itemCount: cart.items.reduce((n, i) => n + i.quantity, 0) } : null,
      open: isOpenNow(record),
    };
  }

  async function productDetail(idOrSlug, { accountId = null, storeId = null, channel = 'web', locale = null } = {}) {
    const product = await services.catalog.getProductOrFail(idOrSlug, { storeId });
    const parent = await stores.get(product.storeId);

    await services.catalog.bumpProductStats(product.id, { views: 1 });
    await events.emit('product.viewed', { productId: product.id, storeId: product.storeId, accountId, channel });

    const related = await products.find({
      where: { ...liveProduct, storeId: product.storeId, id: { $ne: product.id } },
      limit: 6,
      sort: [['stats.orders', 'desc']],
    });

    const accessStatus = (product.priceVisibility || 'public') === 'private'
      ? await services.access.statusFor(accountId, product.id)
      : 'none';

    const onRequest = (product.priceVisibility || 'public') === 'inquire' || product.price == null;
    const request = onRequest ? await services.priceRequests.latestFor(accountId, product.id) : null;

    return {
      surface: 'product',
      product: await productCard(product, { full: true, locale, accessStatus }),
      // The viewer's own price request, when the product is sold by asking.
      priceRequest: request ? { id: request.id, status: request.status, quantity: request.quantity, note: request.note, quotedPrice: request.quotedPrice, quotedFormatted: request.quotedFormatted, validUntil: request.validUntil, sellerNote: request.sellerNote, createdAt: request.createdAt } : null,
      // full: an inquire-priced product needs the shop's contact info here.
      store: parent ? await storeCard(parent, { full: true }) : null,
      related: await Promise.all(related.map((p) => productCard(p, { locale }))),
      saved: accountId ? Boolean(await savedItems.findOne({ accountId, refId: product.id })) : false,
    };
  }

  /** A product's own reviews, newest first — left by a buyer rating a delivered order (`orders.rate`). */
  async function productReviews(productId, { limit = 20, offset = 0 } = {}) {
    const reviews = db.collection(COLLECTIONS.reviews);
    const where = (row) => row.productIds?.includes(productId);
    const [rows, total] = await Promise.all([
      reviews.find({ where, sort: [['createdAt', 'desc']], limit, offset }),
      reviews.count(where),
    ]);
    const items = await Promise.all(rows.map(async (row) => {
      const author = await db.collection(COLLECTIONS.accounts).get(row.accountId);
      return {
        id: row.id,
        rating: row.rating,
        comment: row.comment,
        createdAt: row.createdAt,
        author: author?.displayName || null,
      };
    }));
    return { items, page: { total, limit, offset, hasMore: offset + items.length < total } };
  }

  async function categoryBrowse(idOrSlug, { limit = 20, offset = 0, sort = 'popular', city = null, locale = null } = {}) {
    const category = await services.catalog.getCategory(idOrSlug);
    if (!category) throw new NotFoundError('Category', idOrSlug);

    // Explore by shop, not by a flat product list: pick a category, see who
    // sells in it, then open a shop to see its products in that category.
    //
    // "Who sells here" is found from products, not from `store.categoryIds` —
    // that field only ever names the top-level *groups* a shop is filed under
    // (see catalog's `filedUnderStore`), so it can answer "who sells Tops" but
    // not "who sells T-shirts". Grouping matching products by shop answers both.
    const scope = await services.catalog.descendantIds(category.id);
    const live = await liveStoreIds();
    const rows = (await products.find({ where: { ...liveProduct, categoryId: { $in: scope } } }))
      .filter((row) => live.has(row.storeId));

    const byStore = new Map();
    for (const row of rows) byStore.set(row.storeId, (byStore.get(row.storeId) || 0) + 1);

    const storeRows = (await Promise.all([...byStore.keys()].map((id) => stores.get(id))))
      .filter((row) => row && (!city || sameCity(row.location?.city, city)));

    const hits = storeRows.map((row) => ({ kind: 'store', row, score: byStore.get(row.id) }));
    applySort(hits, sort);

    const total = hits.length;
    const window = hits.slice(offset, offset + limit);
    const items = await Promise.all(window.map(async (hit) => ({
      ...(await storeCard(hit.row)),
      // How many of *this* shop's products are in this category — not its
      // whole catalogue, which is what a plain storeCard would report.
      productCount: byStore.get(hit.row.id),
    })));

    const parent = category.parentId ? await services.catalog.getCategory(category.parentId) : null;
    return {
      surface: 'category',
      category: services.catalog.localizeCategory(category, locale),
      parent: parent ? services.catalog.localizeCategory(parent, locale) : null,
      children: await services.catalog.listCategories({ parentId: category.id, withCounts: true, locale }),
      query: { categoryId: category.id, city, sort },
      ...paged(items, total, { limit, offset }),
    };
  }

  // -- Saved items -----------------------------------------------------------

  async function toggleSaved(accountId, { refType = 'product', refId }) {
    const existing = await savedItems.findOne({ accountId, refId });
    if (existing) {
      await savedItems.delete(existing.id);
      return { saved: false };
    }
    await savedItems.insert({ id: newId('sav'), accountId, refType, refId });
    await events.emit('item.saved', { accountId, refType, refId });
    return { saved: true };
  }

  async function listSaved(accountId, { limit = 20, offset = 0, locale = null } = {}) {
    const rows = await savedItems.find({ where: { accountId }, sort: [['createdAt', 'desc']], limit, offset });
    const items = [];
    for (const row of rows) {
      if (row.refType === 'product') {
        const product = await products.get(row.refId);
        if (product) items.push(await productCard(product, { locale }));
      } else {
        const parent = await stores.get(row.refId);
        if (parent) items.push(await storeCard(parent));
      }
    }
    return { items, total: await savedItems.count({ accountId }) };
  }

  // -- Card builders ---------------------------------------------------------

  /**
   * `accessStatus` is the viewer's own access-request state for a `private`
   * product — only `productDetail` ever has a specific viewer to check it
   * for, so every list surface (search, feed, a storefront's grid) leaves it
   * unset and a private product's price stays hidden there regardless of who
   * is looking. Requesting access is a product-*page* action, not something
   * a grid card offers.
   */
  async function productCard(product, { full = false, locale = null, accessStatus = 'none' } = {}) {
    const currency = product.currency || config.platform.defaultCurrency;
    const loc = locale || config.platform.defaultLocale;
    // "Price on request": no price object at all, rather than a fake ۰ تومان —
    // every surface checks `card.price` before rendering one, the same way it
    // already checks `compareAtPrice`.
    const priceVisibility = product.priceVisibility || 'public';
    const hasPrice = (priceVisibility === 'public' || (priceVisibility === 'private' && accessStatus === 'approved')) && product.price != null;
    const card = {
      type: 'product',
      id: product.id,
      slug: product.slug,
      title: product.title,
      subtitle: product.storeName,
      storeId: product.storeId,
      storeSlug: product.storeSlug,
      image: product.images?.[0] || null,
      imageCount: product.images?.length || 0,
      hasVariants: (product.variants?.length || 0) > 0,
      saleUnit: product.saleUnit?.kind === 'pack' ? { kind: 'pack', size: product.saleUnit.size, label: product.saleUnit.label } : null,
      categoryId: product.categoryId || null,
      createdAt: product.createdAt || null,
      sold: product.stats?.orders || 0,
      // Telegram re-sends a photo by file id far more reliably than by URL.
      telegramFileId: product.telegramFileIds?.[0] || null,
      priceVisibility,
      ...(priceVisibility === 'private' ? { accessStatus } : {}),
      price: hasPrice ? { amount: product.price, currency, formatted: formatMoney(product.price, currency, loc) } : null,
      compareAtPrice: hasPrice && product.compareAtPrice
        ? { amount: product.compareAtPrice, currency, formatted: formatMoney(product.compareAtPrice, currency, loc) }
        : null,
      discountPercent: hasPrice && product.compareAtPrice ? Math.round(((product.compareAtPrice - product.price) / product.compareAtPrice) * 100) : null,
      inStock: product.stock === null || product.stock === undefined ? true : product.stock > 0,
      // Only a real, small number: "3 left" must be true or it is not shown.
      stockLeft: Number.isInteger(product.stock) && product.stock > 0 && product.stock <= 5 ? product.stock : null,
      rating: ratingOf(product.stats),
      ratingCount: product.stats?.ratingCount || 0,
      url: `${config.platform.webBaseUrl}/s/${product.storeSlug}/p/${product.slug}`,
    };
    if (!full) return card;
    return {
      ...card,
      description: product.description,
      seo: product.seo ? { metaTitle: product.seo.metaTitle || null, metaDescription: product.seo.metaDescription || null, keywords: product.seo.keywords || [], imageAlt: product.seo.imageAlt || null } : null,
      updatedAt: product.updatedAt || null,
      images: product.images || [],
      // Bot-internal, used only by the channel poster: Telegram's own file
      // download URL cannot reliably be handed back to Telegram, so it resends
      // the original file instead when it has one. Not meant for the web.
      telegramFileIds: product.telegramFileIds || [],
      tags: product.tags || [],
      // Specifications belong on the card: the channel post, the storefront
      // page and the bot detail view all render them from here.
      properties: product.properties || [],
      stock: product.stock,
      sku: product.sku || null,
      options: product.options || [],
      variants: product.variants || [],
      stats: product.stats,
    };
  }

  async function storeCard(record, { full = false } = {}) {
    const card = {
      type: 'store',
      id: record.id,
      slug: record.slug,
      title: record.name,
      subtitle: record.tagline || '',
      image: record.logoUrl || null,
      banner: record.bannerUrl || null,
      rating: ratingOf(record.stats),
      productCount: record.stats?.products || 0,
      verified: Boolean(record.verified),
      featured: Boolean(record.featured),
      city: record.location?.city || null,
      url: `${config.platform.webBaseUrl}/s/${record.slug}`,
    };
    if (!full) return card;
    return {
      ...card,
      description: record.description || '',
      status: record.status,
      ratingCount: record.stats?.ratingCount || 0,
      since: record.approvedAt || record.createdAt || null,
      hours: record.settings?.hours || null,
      currency: record.currency,
      contact: record.contact || {},
      // A public handle, same as the "Add to cart" post it already appears
      // under — safe to expose on the storefront's own read path, unlike the
      // staff-only `channels.get`, which also carries posting stats.
      telegramChannel: record.channels?.telegram?.username || null,
      location: record.location || {},
      settings: {
        paymentMethods: record.settings?.paymentMethods || [],
        // false: the platform has no working payment gateway, so buyers are told to contact the shop
        onlinePayment: services.gateway ? services.gateway.available() : true,
        // false: the owner's plan has lapsed and the shop takes no new orders - buyers are pointed to the seller
        ordersOpen: await services.subscriptions.ordersOpen(record.ownerAccountId),
        fulfillmentMethods: record.settings?.fulfillmentMethods || [],
        deliveryFee: record.settings?.deliveryFee || 0,
        shippingPayer: record.settings?.shippingPayer || 'buyer',
        freeDeliveryOver: record.settings?.freeDeliveryOver || null,
        minOrder: record.settings?.minOrder || 0,
        prepTimeMinutes: record.settings?.prepTimeMinutes || null,
        orderNotice: record.settings?.orderNotice || '',
      },
      stats: { orders: record.stats?.orders || 0, products: record.stats?.products || 0 },
    };
  }

  const xml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** Every live shop and product as a URL a search engine can crawl. */
  async function sitemap() {
    const web = config.platform.webBaseUrl.replace(/\/$/, '');
    const live = await stores.find({ where: { status: 'active' } });
    const bySlug = new Map(live.map((s) => [s.id, s]));
    const items = await products.find({ where: (p) => p.status === 'active' && bySlug.has(p.storeId) });
    const day = (iso) => String(iso || new Date().toISOString()).slice(0, 10);
    const rows = [
      { loc: `${web}/`, lastmod: day(), priority: '1.0' },
      ...(await services.content.sitemapEntries()).map((p) => ({ loc: `${web}${p.path}`, lastmod: day(p.updatedAt), priority: '0.5' })),
      { loc: `${web}/learn`, lastmod: day(), priority: '0.5' },
      { loc: `${web}/stores`, lastmod: day(), priority: '0.8' },
      ...live.map((s) => ({ loc: `${web}/s/${s.slug}`, lastmod: day(s.updatedAt), priority: '0.8' })),
      ...items.map((p) => ({ loc: `${web}/s/${bySlug.get(p.storeId).slug}/p/${p.slug}`, lastmod: day(p.updatedAt), priority: '0.6', images: (p.images || []).slice(0, 5).map((src) => ({ loc: new URL(src, `${web}/`).href, title: p.title })) })),
    ];
    const images = (r) => (r.images || []).map((i) => `<image:image><image:loc>${xml(i.loc)}</image:loc><image:title>${xml(i.title)}</image:title></image:image>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${rows.map((r) => `  <url><loc>${xml(r.loc)}</loc><lastmod>${r.lastmod}</lastmod><priority>${r.priority}</priority>${images(r)}</url>`).join('\n')}\n</urlset>\n`;
  }

  function robots() {
    const web = config.platform.webBaseUrl.replace(/\/$/, '');
    return `User-agent: *\nAllow: /\nDisallow: /manage\nDisallow: /admin\nDisallow: /cart\nDisallow: /orders\nDisallow: /pay\nDisallow: /track\nDisallow: /login\nDisallow: /account\nDisallow: /checkout\nSitemap: ${web}/sitemap.xml\n`;
  }

  return {
    shops,
    sitemap,
    robots,
    search,
    suggest,
    trendingSearches,
    trendingProducts,
    homeFeed,
    continueShopping,
    storefront,
    productDetail,
    productReviews,
    categoryBrowse,
    toggleSaved,
    listSaved,
    productCard,
    storeCard,
  };
}

// ---------------------------------------------------------------------------

/** Persian-aware: ي/ك, half-spaces and Persian digits all compare equal. */
function tokenize(q) {
  return normalizeText(q)
    .split(/[^a-z0-9-￿]+/)
    .filter((t) => t.length > 1);
}

function sameCity(a, b) {
  return Boolean(a && b) && normalizeText(a).trim() === normalizeText(b).trim();
}

function scoreProduct(product, terms) {
  if (!terms.length) return baseProductScore(product);
  const title = normalizeText(product.title);
  const haystack = normalizeText(product.searchText || title);
  let score = 0;
  for (const term of terms) {
    if (title === term) score += 60;
    else if (title.startsWith(term)) score += 40;
    else if (title.includes(term)) score += 25;
    else if (haystack.includes(term)) score += 10;
    else if (product.tags?.some((tag) => normalizeText(tag).includes(term))) score += 8;
    else return 0; // every term must land somewhere: AND semantics
  }
  return score + baseProductScore(product);
}

function baseProductScore(product) {
  return (product.stats?.orders || 0) * 2 + ratingOf(product.stats) * 3 + (product.images?.length ? 3 : 0);
}

function scoreStore(record, terms) {
  if (!terms.length) return baseStoreScore(record);
  const name = normalizeText(record.name);
  const haystack = normalizeText(`${name} ${record.tagline || ''} ${record.description || ''} ${(record.tags || []).join(' ')}`);
  let score = 0;
  for (const term of terms) {
    if (name === term) score += 70;
    else if (name.startsWith(term)) score += 45;
    else if (name.includes(term)) score += 30;
    else if (haystack.includes(term)) score += 12;
    else return 0;
  }
  return score + baseStoreScore(record);
}

function baseStoreScore(record) {
  return (record.featured ? 20 : 0) + (record.verified ? 10 : 0) + (record.stats?.orders || 0) * 1.5 + ratingOf(record.stats) * 4;
}

function applySort(hits, sort) {
  switch (sort) {
    case 'price_asc':
      return hits.sort((a, b) => (a.row.price ?? Infinity) - (b.row.price ?? Infinity));
    case 'price_desc':
      return hits.sort((a, b) => (b.row.price ?? -Infinity) - (a.row.price ?? -Infinity));
    case 'newest':
      return hits.sort((a, b) => String(b.row.createdAt).localeCompare(String(a.row.createdAt)));
    case 'rating':
      return hits.sort((a, b) => ratingOf(b.row.stats) - ratingOf(a.row.stats));
    case 'discount': {
      const cut = (r) => (r.compareAtPrice > r.price && r.price > 0 ? (r.compareAtPrice - r.price) / r.compareAtPrice : 0);
      return hits.sort((a, b) => cut(b.row) - cut(a.row));
    }
    case 'popular':
      return hits.sort((a, b) => (b.row.stats?.orders || 0) - (a.row.stats?.orders || 0));
    default:
      return hits.sort((a, b) => b.score - a.score);
  }
}

function ratingOf(stats) {
  if (!stats?.ratingCount) return 0;
  return Math.round((stats.ratingSum / stats.ratingCount) * 10) / 10;
}

/** Opening hours are optional; a store with none configured is always open. */
function isOpenNow(record, now = new Date()) {
  const hours = record.settings?.hours;
  if (!hours) return true;
  const day = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()];
  const today = hours[day];
  if (!today || today.closed) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const [openH, openM] = String(today.open || '00:00').split(':').map(Number);
  const [closeH, closeM] = String(today.close || '23:59').split(':').map(Number);
  return minutes >= openH * 60 + openM && minutes <= closeH * 60 + closeM;
}
