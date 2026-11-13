import { Router } from '../router.js';
import { pageParams } from '../../util/paginate.js';
import { CARRIERS } from '../../models/schemas.js';
import { requireAuth, status } from '../http.js';

/**
 * Public read surface. No auth required — an anonymous web visitor and a
 * logged-in bot user hit exactly the same endpoints; passing an account just
 * personalises the result.
 */
export function registerDiscoveryRoutes(root, core) {
  const { services } = core;
  const router = new Router();

  // Top-level groups by default; ?parent=<id|slug> for one group's sub-categories;
  // ?tree=1 for the whole tree in one request (groups with their children nested).
  router.get('/categories', async ({ query, locale }) => {
    const tree = Boolean(query.tree) && query.tree !== '0' && query.tree !== 'false';
    const flat = !tree && !query.parent;
    return {
      items: await services.catalog.listCategories({
        parentId: flat ? (query.parentId === undefined ? null : query.parentId || null) : undefined,
        parent: query.parent || null,
        tree,
        withCounts: query.counts !== 'false',
        locale,
      }),
    };
  });

  router.get('/feed', async ({ query, accountId, channel, locale }) => services.discovery.homeFeed({
    accountId,
    city: query.city || null,
    limit: Number(query.limit) || 8,
    channel,
    locale,
  }));

  router.get('/search', async ({ query, accountId, channel, locale }) => {
    const { limit, offset } = pageParams(query);
    return services.discovery.search({
      q: query.q || '',
      type: query.type || 'all',
      categoryId: query.category || null,
      storeId: query.store || null,
      city: query.city || null,
      priceMin: query.priceMin ? Number(query.priceMin) : null,
      priceMax: query.priceMax ? Number(query.priceMax) : null,
      tags: query.tags ? query.tags.split(',') : null,
      onSale: query.onSale === '1' || query.onSale === 'true',
      sort: query.sort || 'relevance',
      limit,
      offset,
      accountId,
      channel,
      locale,
    });
  });

  router.get('/shops', async ({ query, locale }) => services.discovery.shops({
    q: query.q || '',
    categoryId: query.category || null,
    city: query.city || null,
    sort: ['popular', 'new', 'rating', 'products'].includes(query.sort) ? query.sort : 'popular',
    limit: Math.min(Number(query.limit) || 24, 60),
    offset: Math.max(Number(query.offset) || 0, 0),
    locale,
  }));

  router.get('/suggest', async ({ query, locale }) => ({
    items: await services.discovery.suggest(query.q || '', { limit: Number(query.limit) || 8, locale }),
  }));

  router.get('/trending', async ({ query, locale }) => ({
    searches: await services.discovery.trendingSearches({ limit: Number(query.limit) || 6 }),
    products: await services.discovery.trendingProducts({ limit: Number(query.limit) || 8, city: query.city || null, locale }),
  }));

  router.get('/categories/:idOrSlug/browse', async ({ params, query, locale }) => {
    const { limit, offset } = pageParams(query);
    return services.discovery.categoryBrowse(params.idOrSlug, { limit, offset, sort: query.sort || 'popular', city: query.city || null, locale });
  });

  /** The storefront page — same payload the web app and the bot both render. */
  router.get('/s/:slug', async ({ params, query, accountId, channel, locale }) => services.discovery.storefront(params.slug, { accountId, channel, locale, categoryId: query.category || null, productLimit: Math.min(Number(query.limit) || 24, 100), productOffset: Math.max(Number(query.offset) || 0, 0) }));

  router.get('/s/:slug/p/:productSlug', async ({ params, accountId, channel, locale }) => {
    const parent = await services.stores.resolve(params.slug);
    return services.discovery.productDetail(params.productSlug, { accountId, storeId: parent.id, channel, locale });
  });

  router.get('/products/:id', async ({ params, accountId, channel, locale }) => services.discovery.productDetail(params.id, { accountId, channel, locale }));

  router.get('/products/:id/reviews', async ({ params, query }) => {
    const { limit, offset } = pageParams(query);
    return services.discovery.productReviews(params.id, { limit, offset });
  });

  /**
   * Location picker support. A web client that has coordinates from
   * navigator.geolocation or a dropped map pin resolves them here, so it shows
   * the same city string the Telegram picker produces.
   */
  router.get('/geo/reverse', async ({ query }) => {
    const place = await services.geo.reverse(Number(query.lat), Number(query.lng));
    return place || { city: null, country: null, label: null, lat: Number(query.lat), lng: Number(query.lng) };
  });

  /** Autocomplete for "type a city" in a web picker. */
  router.get('/geo/search', async ({ query }) => ({
    items: await services.geo.search(query.q || '', { limit: Number(query.limit) || 5 }),
  }));

  // -- Comments: readable by anyone, writable by a signed-in account ----------------------

  router.get('/products/:id/comments', async ({ params, query, accountId }) => services.comments.list(params.id, {
    accountId,
    sort: query.sort === 'new' ? 'new' : 'top',
    type: ['reviews', 'questions'].includes(query.type) ? query.type : 'all',
    limit: Math.min(Number(query.limit) || 10, 50),
    offset: Math.max(Number(query.offset) || 0, 0),
  }));
  router.post('/products/:id/comments', async (ctx) => status(201, await services.comments.create(requireAuth(ctx).id, ctx.params.id, { text: ctx.body.text, parentId: ctx.body.parentId || null, as: ctx.body.as === 'question' ? 'question' : 'review' })));
  router.post('/comments/:id/like', async (ctx) => services.comments.toggleLike(requireAuth(ctx).id, ctx.params.id));
  router.post('/comments/:id/pin', async (ctx) => services.comments.pin(requireAuth(ctx).id, ctx.params.id, ctx.body.pinned !== false));
  router.delete('/comments/:id', async (ctx) => services.comments.remove(requireAuth(ctx).id, ctx.params.id));

  // -- Pages the platform publishes ------------------------------------------------------------

  router.get('/site', async () => services.content.site());
  router.get('/pages', async ({ query }) => ({ items: await services.content.listPublished({ kind: query.kind || null }) }));
  router.get('/pages/:slug', async ({ params }) => services.content.getPublished(params.slug));

  // -- For search engines --------------------------------------------------------------------

  router.get('/sitemap.xml', async () => ({ __raw: { type: 'application/xml; charset=utf-8', body: await services.discovery.sitemap() } }));
  // The head tags and readable body of a public page, for the web server to put into the page it serves.
  router.get('/seo/render', async ({ query }) => {
    const page = await services.seo.render(query.path || '/');
    return page ? { ...page, prerender: true } : { prerender: false };
  });
  router.get('/robots.txt', async () => ({ __raw: { type: 'text/plain; charset=utf-8', body: services.discovery.robots() } }));

  // -- Online payment: the gateway sends the buyer back here ---------------------------------

  router.get('/pay/callback/:attemptId', async ({ params, query }) => {
    const result = await services.gateway.complete(params.attemptId, query);
    return { __redirect: services.gateway.returnUrl(result) };
  });
  // A signed link (from the bot) that starts the payment without a web login.
  router.get('/pay/go/:orderId', async ({ params, query }) => {
    const started = await services.gateway.startFromLink(params.orderId, query.sig);
    return { __redirect: started.url };
  });
  // The pretend gateway (development only): a page shows the amount, the buyer picks pay or cancel.
  router.get('/pay/sandbox/:attemptId', async ({ params }) => services.gateway.sandboxInfo(params.attemptId));
  router.post('/pay/sandbox/:attemptId/:outcome', async ({ params }) => services.gateway.sandboxDecide(params.attemptId, params.outcome));

  /** Order tracking without an account: the code and the last four digits of the phone on the order. */
  router.get('/track/:code', async ({ params, query }) => services.orders.track(params.code, query.phone));
  router.get('/carriers', async () => ({ items: Object.entries(CARRIERS).map(([id, c]) => ({ id, name: c.fa, site: c.site })) }));

  /** Static plan definitions — the plan picker's own source of truth. */
  router.get('/plans', async () => ({ items: services.subscriptions.listPlans() }));

  root.use('', router);
}
