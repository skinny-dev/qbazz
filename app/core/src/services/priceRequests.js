import { COLLECTIONS } from '../models/schemas.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../util/ids.js';
import { formatMoney } from '../util/money.js';

const MAX_OPEN = 20;
const DEFAULT_VALID_HOURS = 48;

/**
 * "Price on request", done properly.
 *
 * A product marked `inquire` has no public price. A buyer asks for one; the
 * shop's team is told; a manager answers with a price that is good for a stated
 * time (or declines); the buyer is told, and can then put the product in their
 * cart at exactly that price — the cart takes it from here, the browser never
 * names a price. A quote is used once (at checkout) or lapses on its own.
 *
 * Statuses: pending → quoted | declined | cancelled; quoted → accepted | expired.
 * `expired` is derived from `validUntil`, never stored, so nothing has to run on a timer.
 */
export function createPriceRequestsService(ctx) {
  const { store: db, config, events, services } = ctx;
  const rows = db.collection(COLLECTIONS.priceRequests);

  const effective = (row) => (row.status === 'quoted' && new Date(row.validUntil) < new Date() ? 'expired' : row.status);

  function present(row, { product = null, store = null, buyer = null, locale = null } = {}) {
    const loc = locale || config.platform.defaultLocale;
    const status = effective(row);
    return {
      ...row,
      status,
      quotedFormatted: row.quotedPrice != null ? formatMoney(row.quotedPrice, row.currency, loc) : null,
      ...(product ? { product: { id: product.id, slug: product.slug, title: product.title, image: product.images?.[0] || null, telegramFileId: product.telegramFileIds?.[0] || null, storeSlug: product.storeSlug } } : {}),
      ...(store ? { store: { id: store.id, name: store.name, slug: store.slug } } : {}),
      ...(buyer ? { buyer: { id: buyer.id, displayName: buyer.displayName, phone: buyer.phone || null } } : {}),
    };
  }

  async function request(buyerAccountId, productId, { quantity = 1, note = '', variantId = null } = {}) {
    const product = await services.catalog.getProductOrFail(productId);
    if (product.status !== 'active') throw new ConflictError('err.item_unavailable');
    if ((product.priceVisibility || 'public') !== 'inquire' && product.price != null) throw new ConflictError('err.pricereq_not_inquire');
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 9999) throw ValidationError.of('quantity', 'err.quantity_min');
    const cleanNote = String(note || '').trim().slice(0, 300);
    // which option of the product the buyer has in mind (none: any, or the product has no options)
    const option = variantId ? (product.variants || []).find((v) => v.id === variantId) : null;
    if (variantId && !option) throw new NotFoundError('Variant', variantId);
    // what one "unit" is when the shop sells by the pack
    const saleUnit = product.saleUnit?.kind === 'pack' ? { size: product.saleUnit.size, label: product.saleUnit.label } : null;

    // Asking again while an answer is pending, or while a quote is still good, returns that row.
    const mine = await rows.find({ where: { buyerAccountId, productId }, sort: [['createdAt', 'desc']] });
    const open = mine.find((r) => ['pending', 'quoted'].includes(effective(r)));
    if (open) return present(open, { product });

    const openCount = (await rows.find({ where: { buyerAccountId, status: 'pending' } })).length;
    if (openCount >= MAX_OPEN) throw new ConflictError('err.pricereq_too_many', { max: MAX_OPEN }, { max: MAX_OPEN });

    const record = await rows.insert({
      id: newId('prq'),
      productId,
      storeId: product.storeId,
      buyerAccountId,
      quantity: qty,
      variantId: option?.id || null,
      variantTitle: option?.title || null,
      saleUnit,
      note: cleanNote,
      status: 'pending',
      currency: product.currency || config.platform.defaultCurrency,
      quotedPrice: null,
      validUntil: null,
      sellerNote: '',
      decidedBy: null,
      decidedAt: null,
      orderId: null,
    });

    const buyer = await services.accounts.get(buyerAccountId);
    await services.notifications.queueForStoreTeam(product.storeId, {
      type: 'price.requested',
      render: (t) => ({
        title: t('notif.price.requested.title', { buyer: buyer?.displayName || '', product: product.title }),
        // what the seller needs to name a price: how many of what, which option, and the buyer's own words
        body: [
          saleUnit ? t('notif.price.requested.qty_pack', { qty, label: saleUnit.label, size: saleUnit.size }) : (qty > 1 ? t('notif.price.requested.qty', { qty }) : ''),
          option ? t('notif.price.requested.option', { option: option.title }) : '',
          cleanNote,
        ].filter(Boolean).join(' · '),
      }),
      data: { requestId: record.id, productId, storeId: product.storeId, action: 'answer_price_request' },
      priority: 'high',
    }, { minRole: 'manager' });
    await events.emit('price.requested', { requestId: record.id, productId, storeId: product.storeId, buyerAccountId });
    return present(record, { product });
  }

  async function cancel(buyerAccountId, requestId) {
    const row = await rows.get(requestId);
    if (!row || row.buyerAccountId !== buyerAccountId) throw new NotFoundError('Price request', requestId);
    if (row.status !== 'pending') throw new ConflictError('err.pricereq_not_pending');
    return present(await rows.update(requestId, { status: 'cancelled' }));
  }

  async function enrich(list, locale) {
    return Promise.all(list.map(async (row) => present(row, {
      product: await db.collection(COLLECTIONS.products).get(row.productId),
      store: await db.collection(COLLECTIONS.stores).get(row.storeId),
      locale,
    })));
  }

  async function listMine(accountId, { limit = 50, locale = null } = {}) {
    const list = await rows.find({ where: { buyerAccountId: accountId }, sort: [['createdAt', 'desc']], limit });
    return { items: await enrich(list, locale) };
  }

  /** The shop's inbox. `status` can be 'open' (pending), 'quoted', 'closed' or a single status. */
  async function listForStore(storeId, { actorAccountId, status = null, limit = 50, offset = 0, locale = null } = {}) {
    const record = await services.stores.resolve(storeId);
    await services.stores.assertCan(record.id, actorAccountId, 'products.manage');
    const all = await rows.find({ where: { storeId: record.id }, sort: [['createdAt', 'desc']] });
    const wanted = !status ? all : all.filter((r) => {
      const s = effective(r);
      if (status === 'open') return s === 'pending';
      if (status === 'closed') return ['declined', 'cancelled', 'accepted', 'expired'].includes(s);
      return s === status;
    });
    const page = wanted.slice(offset, offset + limit);
    const items = await enrich(page, locale);
    for (const item of items) item.buyer = await services.accounts.get(item.buyerAccountId).then((a) => (a ? { id: a.id, displayName: a.displayName, phone: a.phone || null } : null));
    return { items, total: wanted.length, pending: all.filter((r) => effective(r) === 'pending').length };
  }

  async function getForActor(requestId, actorAccountId) {
    const row = await rows.get(requestId);
    if (!row) throw new NotFoundError('Price request', requestId);
    if (row.buyerAccountId !== actorAccountId) await services.stores.assertCan(row.storeId, actorAccountId, 'products.manage');
    return row;
  }

  async function quote(actorAccountId, requestId, { price, validHours = DEFAULT_VALID_HOURS, note = '' } = {}) {
    const row = await rows.get(requestId);
    if (!row) throw new NotFoundError('Price request', requestId);
    await services.stores.assertCan(row.storeId, actorAccountId, 'products.manage');
    const status = effective(row);
    if (!['pending', 'quoted', 'expired'].includes(status)) throw new ConflictError('err.pricereq_closed');

    const amount = Number(price);
    if (!Number.isInteger(amount) || amount <= 0) throw ValidationError.of('price', 'err.price_required');
    const hours = Number(validHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) throw ValidationError.of('validHours', 'err.pricereq_hours');

    const validUntil = new Date(Date.now() + hours * 3600000).toISOString();
    const updated = await rows.update(requestId, {
      status: 'quoted',
      quotedPrice: amount,
      validUntil,
      sellerNote: String(note || '').trim().slice(0, 300),
      decidedBy: actorAccountId,
      decidedAt: new Date().toISOString(),
    });

    const product = await services.catalog.getProduct(row.productId);
    await services.notifications.queue({
      accountId: row.buyerAccountId,
      storeId: row.storeId,
      type: 'price.quoted',
      render: (t, locale) => ({
        title: t('notif.price.quoted.title', { product: product?.title || '', price: formatMoney(amount, row.currency, locale) }),
        body: updated.sellerNote || t('notif.price.quoted.hours', { hours }),
      }),
      data: { requestId, productId: row.productId, storeId: row.storeId, action: 'open_product', productSlug: product?.slug, storeSlug: product?.storeSlug },
      priority: 'high',
    });
    await events.emit('price.quoted', { requestId, productId: row.productId, storeId: row.storeId, amount });
    return present(updated, { product });
  }

  async function decline(actorAccountId, requestId, reason = '') {
    const row = await rows.get(requestId);
    if (!row) throw new NotFoundError('Price request', requestId);
    await services.stores.assertCan(row.storeId, actorAccountId, 'products.manage');
    if (effective(row) !== 'pending') throw new ConflictError('err.pricereq_closed');
    const cleanReason = String(reason || '').trim().slice(0, 300);
    const updated = await rows.update(requestId, { status: 'declined', sellerNote: cleanReason, decidedBy: actorAccountId, decidedAt: new Date().toISOString() });

    const product = await services.catalog.getProduct(row.productId);
    await services.notifications.queue({
      accountId: row.buyerAccountId,
      storeId: row.storeId,
      type: 'price.declined',
      render: (t) => ({
        title: t('notif.price.declined.title', { product: product?.title || '' }),
        body: cleanReason || t('notif.price.declined.default'),
      }),
      data: { requestId, productId: row.productId, storeId: row.storeId, action: 'open_product', productSlug: product?.slug, storeSlug: product?.storeSlug },
    });
    return present(updated, { product });
  }

  /** The viewer's latest request for a product, whatever state it is in — what the product page shows. */
  async function latestFor(accountId, productId) {
    if (!accountId) return null;
    const mine = await rows.find({ where: { buyerAccountId: accountId, productId }, sort: [['createdAt', 'desc']], limit: 1 });
    return mine[0] ? present(mine[0]) : null;
  }

  /** A quote the buyer can still use right now, or null. */
  async function activeQuote(accountId, productId) {
    if (!accountId) return null;
    const mine = await rows.find({ where: { buyerAccountId: accountId, productId, status: 'quoted' }, sort: [['createdAt', 'desc']] });
    return mine.find((r) => effective(r) === 'quoted') || null;
  }

  /** Checkout calls this for every line that carries a quote: a lapsed or used quote stops the order. */
  async function assertUsable(quoteId, accountId) {
    const row = await rows.get(quoteId);
    if (!row || row.buyerAccountId !== accountId) throw new ForbiddenError('err.forbidden');
    if (effective(row) !== 'quoted') throw new ConflictError('err.quote_expired');
    return row;
  }

  async function consume(quoteId, orderId) {
    return rows.update(quoteId, { status: 'accepted', orderId, acceptedAt: new Date().toISOString() });
  }

  return { request, cancel, listMine, listForStore, getForActor, quote, decline, latestFor, activeQuote, assertUsable, consume, effective };
}
