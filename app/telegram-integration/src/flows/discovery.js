import { button, grid, keyboard, pager, urlButton, webAppButton } from '../telegram/keyboard.js';
import { b, esc, i, lines, productDetailText, productLine, storeLine, storefrontText, truncate } from '../render.js';

/**
 * Discovery flows: home, categories, search, storefront, product.
 *
 * Each screen is built from a core "surface" payload — the same one the web
 * storefront will render. Nothing here decides what is popular or what a
 * category contains; it only decides how to draw it in a chat.
 */

/**
 * `minimal: true` (used by the /start greeting) skips the featured-shops and
 * trending-products preview below the greeting — just the hello and the
 * keyboard. Every other caller (the "home" button, `/language`, `/cancel`, …)
 * gets the full preview exactly as before.
 */
export async function showHome(ctx, { greeting = null, minimal = false } = {}) {
  const { tx, t } = ctx;
  const feed = await ctx.core.feed(ctx.account.id, { city: ctx.state.city || null });
  const sections = new Map(feed.sections.map((section) => [section.id, section]));

  // Categories and Trending are off the home screen for now — search carries
  // the same job on its own, and a shorter keyboard reads better as the front
  // door. Both screens still exist and are still reachable elsewhere (a search
  // that comes up empty still offers Categories, for one).
  const rows = [
    [button(t('b.nav.search'), 'search')],
  ];

  const resume = sections.get('continue')?.items || [];
  if (resume.length) {
    // The feed's subtitle is "<items> · <total>"; the button only has room for the first part.
    rows.unshift([button(t('b.btn.resume', { store: truncate(resume[0].title, 20), items: resume[0].subtitle.split('·')[0].trim() }), 'cart')]);
  }

  rows.push([button(t('b.btn.cart'), 'cart'), button(t('b.btn.orders'), 'orders')]);
  rows.push([button(t('b.btn.sell'), 'sell')]);
  if (ctx.config.miniAppUrl) rows.push([webAppButton(t('b.btn.web_store'), ctx.config.miniAppUrl)]);

  const headline = greeting || `${b(t('b.brand'))} — ${esc(t('b.home.tagline'))}`;
  if (minimal) return ctx.screen(headline, keyboard(rows));

  const featured = sections.get('featured')?.items || [];

  const text = lines(
    headline,
    '',
    featured.length ? b(t('b.home.featured')) : null,
    ...featured.slice(0, 3).map((card, index) => storeLine(tx, card, index + 1)),
    '',
    i(t('b.home.hint')),
  );

  return ctx.screen(text, keyboard(rows));
}

/**
 * A category is browsed by its shops, not by a flat product list: pick "Tops",
 * see who sells there, open a shop to see its products in Tops. Each store's
 * count is how many of *its* products are in this category, not its whole
 * catalogue (`categoryBrowse` computes that), so the number means what it says.
 */
export async function showCategory(ctx, categoryId, offset = 0) {
  const { tx, t } = ctx;
  const limit = ctx.config.pageSize;
  const result = await ctx.core.categoryBrowse(categoryId, ctx.account.id, { limit, offset });
  const { category, parent, children = [], items, page } = result;

  // "Tops › T-shirt": where you are, and (below) the way back up.
  const heading = `${category.icon || parent?.icon || ''} ${b(parent ? `${parent.name} › ${category.name}` : category.name)}`.trim();
  const subRows = grid(
    children.map((child) => button(child.productCount ? `${child.name} · ${tx.n(child.productCount)}` : child.name, 'cat', child.id, '0')),
    2,
  );
  const upRow = parent ? [[button(t('b.cat.up', { name: parent.name }), 'cat', parent.id, '0')]] : [];
  const navRow = [button(t('b.nav.home'), 'home'), button(t('b.nav.search'), 'search')];

  if (!items.length) {
    return ctx.screen(
      lines(heading, '', i(children.length ? t('b.cat.pick_type') : t('b.cat.empty'))),
      keyboard([...subRows, ...upRow, navRow]),
    );
  }

  const text = lines(
    heading,
    i(t('b.render.shops', { count: page.total })),
    '',
    ...items.map((card, index) => storeLine(tx, card, offset + index + 1)),
  );

  const rows = [
    ...subRows,
    // args: [storeId, categoryId] — opens the shop already filtered to this category.
    ...grid(items.map((card, index) => button(tx.n(offset + index + 1), 'store', card.id, categoryId)), 3),
    pager(tx, 'cat', { offset, limit, total: page.total }, categoryId),
    ...upRow,
    navRow,
  ];

  return ctx.screen(text, keyboard(rows));
}

export async function showCategories(ctx) {
  const { t } = ctx;
  const { items } = await ctx.core.categories();
  const rows = grid(items.map((category) => button(`${category.icon || ''} ${category.name}`.trim(), 'cat', category.id, '0')), 2);
  rows.push([button(t('b.nav.home'), 'home')]);
  return ctx.screen(lines(b(t('b.cat.browse')), '', i(t('b.cat.browse_hint'))), keyboard(rows));
}

export async function promptSearch(ctx) {
  const { t } = ctx;
  await ctx.setState({ awaiting: 'search' });
  return ctx.screen(
    lines(b(t('b.search.title')), '', esc(t('b.search.prompt')), '', i(t('b.search.example'))),
    keyboard([[button(t('b.nav.cancel'), 'home')]]),
  );
}

export async function runSearch(ctx, query, offset = 0) {
  const { tx, t } = ctx;
  const limit = ctx.config.pageSize;
  await ctx.typing();
  const result = await ctx.core.search(ctx.account.id, { q: query, limit, offset, city: ctx.state.city || null });
  await ctx.setState({ lastQuery: query, awaiting: null });

  if (!result.items.length) {
    const { items: suggestions } = await ctx.core.suggest(query);
    return ctx.screen(
      lines(
        t('b.search.none', { query: b(query) }),
        '',
        suggestions.length ? i(t('b.search.try_instead')) : i(t('b.search.try_other')),
        ...suggestions.slice(0, 4).map((s) => `• ${esc(s.text)}`),
      ),
      keyboard([
        [button(t('b.btn.search_again'), 'search')],
        [button(t('b.btn.categories'), 'cats'), button(t('b.nav.home'), 'home')],
      ]),
    );
  }

  const text = lines(
    b(t('b.search.results_for', { query })),
    i(t('b.search.matches', { count: result.page.total })),
    '',
    ...result.items.map((card, index) => (card.type === 'store'
      ? storeLine(tx, card, offset + index + 1, '🏪')
      : productLine(tx, card, offset + index + 1, '🧺'))),
  );

  // Photos first: a result list of bare text is a poor way to shop for things.
  await sendResultPhotos(ctx, result.items, offset);

  const rows = [
    ...grid(
      result.items.map((card, index) => button(tx.n(offset + index + 1), card.type === 'store' ? 'store' : 'prod', card.id)),
      3,
    ),
    pager(tx, 'sr', { offset, limit, total: result.page.total }, encodeURIComponent(truncate(query, 24))),
    [button(t('b.btn.new_search'), 'search'), button(t('b.nav.home'), 'home')],
  ];

  return ctx.screen(text, keyboard(rows));
}

/**
 * The matching products' photos as one album, each captioned with the same
 * number as its row in the list below. A product with no photo is simply left
 * out of the album; a failure here (a photo Telegram can't fetch) never blocks
 * the results themselves.
 */
async function sendResultPhotos(ctx, cards, offset) {
  const { tx } = ctx;
  const items = cards
    .map((card, index) => ({ card, number: offset + index + 1 }))
    .filter(({ card }) => card.type === 'product' && (card.telegramFileId || card.image))
    .slice(0, 10)
    .map(({ card, number }) => ({
      media: card.telegramFileId || card.image,
      caption: lines(`${tx.idx(number)} ${b(card.title)}`, card.price ? esc(card.price.formatted) : null),
    }));
  try {
    await ctx.photoAlbum(items);
  } catch (err) {
    ctx.log.debug?.(`result photos skipped: ${err.message}`);
  }
}

export async function showTrending(ctx) {
  const { tx, t } = ctx;
  const feed = await ctx.core.feed(ctx.account.id, { city: ctx.state.city || null });
  const trending = feed.sections.find((section) => section.id === 'trending')?.items || [];
  const fresh = feed.sections.find((section) => section.id === 'new')?.items || [];
  const items = (trending.length ? trending : fresh).slice(0, ctx.config.pageSize);

  if (!items.length) {
    return ctx.screen(lines(b(t('b.trend.title')), '', i(t('b.trend.empty'))), keyboard([[button(t('b.nav.home'), 'home')]]));
  }

  return ctx.screen(
    lines(b(trending.length ? t('b.trend.now') : t('b.trend.new')), '', ...items.map((card, index) => productLine(tx, card, index + 1))),
    keyboard([
      ...grid(items.map((card, index) => button(tx.n(index + 1), 'prod', card.id)), 3),
      [button(t('b.nav.home'), 'home'), button(t('b.nav.search'), 'search')],
    ]),
  );
}

/**
 * `categoryId` arrives when a category-browse button sent us here: the product
 * list is narrowed to that category (see core `storefront`'s `scope`), and a
 * "back to <category>" row replaces nothing — it's just added — so the shop's
 * full catalogue is still one tap away via `b.btn.open_web` /home/ search.
 */
export async function showStore(ctx, slugOrId, offset = 0, categoryId = null) {
  const { tx, t } = ctx;
  const view = await ctx.core.storefront(slugOrId, ctx.account.id, { categoryId });
  const limit = ctx.config.pageSize;
  const products = view.products.slice(offset, offset + limit);

  const text = lines(
    storefrontText(tx, view),
    '',
    view.category ? b(`${view.category.icon || ''} ${view.category.name}`.trim()) : null,
    products.length
      ? (view.category ? null : b(t('b.store.products')))
      : i(view.category ? t('b.store.no_products_in_category') : t('b.store.no_products')),
    ...products.map((card, index) => productLine(tx, card, offset + index + 1)),
  );

  const rows = [
    ...grid(products.map((card, index) => button(tx.n(offset + index + 1), 'prod', card.id)), 3),
    // args: [storeId, categoryId, offset] — stays filtered across pages.
    pager(tx, 'st', { offset, limit, total: view.products.length }, view.store.id, categoryId || ''),
  ];

  if (view.cart?.itemCount) rows.push([button(t('b.btn.cart_n', { count: view.cart.itemCount }), 'cart')]);
  if (view.category) rows.push([button(t('b.cat.up', { name: view.category.name }), 'cat', view.category.id, '0')]);
  rows.push([button(t('b.btn.share'), 'share', view.store.id), button(t('b.btn.integrations'), 'links', view.store.id)]);
  rows.push([urlButton(t('b.btn.open_web'), view.store.url)]);
  rows.push([button(t('b.nav.home'), 'home'), button(t('b.nav.search'), 'search')]);

  return ctx.screen(text, keyboard(rows));
}

export async function showProduct(ctx, productId) {
  const { tx, t } = ctx;
  const detail = await ctx.core.productDetail(productId, ctx.account.id);
  const { product, store } = detail;

  const rows = [];
  if (!product.price) {
    // No number to check out with — a chat with the seller, not a cart.
    const handle = store?.contact?.telegram?.replace(/^@/, '');
    rows.push([
      handle
        ? urlButton(t('b.btn.inquire_price'), `https://t.me/${handle}`)
        : button(t('b.btn.inquire_price'), 'store', store?.id),
    ]);
  } else if (product.inStock) {
    rows.push([
      button('➖', 'addq', product.id, '-1'),
      button(t('b.btn.add_to_cart'), 'add', product.id),
      button('➕', 'addq', product.id, '1'),
    ]);
  } else {
    rows.push([button(t('b.btn.notify_back'), 'save', product.id)]);
  }
  rows.push([
    button(detail.saved ? t('b.btn.unsave') : t('b.btn.save'), 'save', product.id),
    store ? button(t('b.btn.visit_shop'), 'store', store.id) : null,
  ].filter(Boolean));

  if (detail.related?.length) rows.push([button(t('b.btn.similar'), 'store', product.storeId)]);
  rows.push([urlButton(t('b.btn.view_web'), product.url)]);
  rows.push([button(t('b.btn.cart'), 'cart'), button(t('b.nav.home'), 'home')]);

  const text = productDetailText(tx, detail);

  // A product with a photo is worth a photo message; otherwise edit in place.
  if (product.image && !ctx.state.__noPhoto) {
    try {
      return await ctx.photoScreen(product.image, text, keyboard(rows));
    } catch (err) {
      ctx.log.debug?.(`photo send failed (${err.message}), falling back to text`);
    }
  }
  return ctx.screen(text, keyboard(rows));
}

export async function toggleSaved(ctx, productId) {
  const result = await ctx.core.toggleSaved(ctx.account.id, productId);
  await ctx.answer(result.saved ? ctx.t('b.toast.saved') : ctx.t('b.toast.unsaved'));
  return result;
}

export async function shareStore(ctx, storeId) {
  const { t, tx } = ctx;
  const view = await ctx.core.storefront(storeId, ctx.account.id);
  const deepLink = `https://t.me/${ctx.config.username}?start=s_${view.store.slug}`;
  await ctx.answer(t('b.share.ready'));
  return ctx.reply(
    lines(b(t('b.share.title', { store: view.store.title })), '', esc(tx.ltr(deepLink)), '', i(t('b.share.hint'))),
    keyboard([
      [urlButton(t('b.btn.forward'), `https://t.me/share/url?url=${encodeURIComponent(deepLink)}`)],
      [button(t('b.btn.back_to_shop'), 'store', view.store.id)],
    ]),
  );
}

/** A normal URL as typed, or a bare domain given the protocol it is missing. */
function externalUrl(value) {
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/** A handle, an @handle, or a full URL — always ends up a real Instagram link. */
function instagramUrl(value) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `https://instagram.com/${value.replace(/^@/, '')}`;
}

/**
 * Where else this shop can be found — its real Telegram channel (not the Qbazz
 * bot deep link `shareStore` sends), its Instagram, its own website. Only the
 * ones the shop actually has show up; nothing here is asked for again if the
 * shop has none of them yet.
 */
export async function showIntegrations(ctx, storeId) {
  const { t } = ctx;
  const view = await ctx.core.storefront(storeId, ctx.account.id);
  const store = view.store;

  const links = [
    store.telegramChannel ? [t('b.links.telegram'), `https://t.me/${store.telegramChannel}`] : null,
    store.contact?.instagram ? [t('b.links.instagram'), instagramUrl(store.contact.instagram)] : null,
    store.contact?.website ? [t('b.links.website'), externalUrl(store.contact.website)] : null,
  ].filter(Boolean);

  await ctx.answer();
  return ctx.screen(
    lines(b(t('b.links.title', { store: store.title })), '', links.length ? null : i(t('b.links.empty'))),
    keyboard([
      ...links.map(([label, url]) => [urlButton(label, url)]),
      [button(t('b.btn.back_to_shop'), 'store', store.id)],
    ]),
  );
}
