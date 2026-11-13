import { COLLECTIONS } from '../models/schemas.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../util/ids.js';
import { applyBps, formatMoney } from '../util/money.js';

/**
 * Carts are per (account, store) and *not* per channel: add an item in the bot,
 * open the web storefront, and it is the same cart. That is the whole point of
 * keeping cart state in the core instead of in bot conversation memory.
 */
export function createCartsService(ctx) {
  const { store: db, events, services } = ctx;
  const carts = db.collection(COLLECTIONS.carts);

  async function getOpenCart(accountId, storeId) {
    return carts.findOne({ accountId, storeId, status: 'open' });
  }

  async function getOrCreate(accountId, storeId, { channel = 'web' } = {}) {
    const existing = await getOpenCart(accountId, storeId);
    if (existing) return existing;
    const parent = await services.stores.resolve(storeId);
    return carts.insert({
      id: newId('crt'),
      accountId,
      storeId: parent.id,
      storeName: parent.name,
      storeSlug: parent.slug,
      currency: parent.currency,
      items: [],
      status: 'open',
      channel,
      lastChannel: channel,
      note: '',
      discountMinor: 0,
    });
  }

  async function get(cartId) {
    const cart = await carts.get(cartId);
    if (!cart) throw new NotFoundError('Cart', cartId);
    return withTotals(cart, await services.stores.get(cart.storeId));
  }

  async function listOpen(accountId) {
    const rows = await carts.find({ where: { accountId, status: 'open' }, sort: [['updatedAt', 'desc']] });
    const out = [];
    for (const cart of rows) {
      if (!cart.items.length) continue;
      out.push(withTotals(cart, await services.stores.get(cart.storeId)));
    }
    return out;
  }

  async function addItem(accountId, { productId, variantId = null, quantity = 1, channel = 'web' }) {
    const product = await services.catalog.getProductOrFail(productId);
    if (product.status !== 'active') throw new ConflictError('err.item_unavailable');
    // A "price on request" product has nothing for checkout math to work with —
    // the bot and web both hide Add to cart for one, this is the backstop.
    // ...unless this buyer holds a quote the shop gave them: that is their price, and the only way in.
    const onRequest = (product.priceVisibility || 'public') === 'inquire' || product.price == null;
    const quote = onRequest ? await services.priceRequests.activeQuote(accountId, productId) : null;
    if (onRequest && !quote) {
      throw new ConflictError('err.price_on_request');
    }
    if (quantity < 1) throw ValidationError.of('quantity', 'err.quantity_min');

    const variant = variantId ? (product.variants || []).find((v) => v.id === variantId) : null;
    if (variantId && !variant) throw new NotFoundError('Variant', variantId);

    const unitPrice = quote ? quote.quotedPrice : (variant?.price ?? product.price);
    const available = variant?.stock ?? product.stock;

    const cart = await getOrCreate(accountId, product.storeId, { channel });
    const updated = await carts.mutate(cart.id, (draft) => {
      const key = `${productId}:${variantId || ''}`;
      const line = draft.items.find((item) => item.key === key);
      const nextQty = (line?.quantity || 0) + quantity;
      if (available !== null && available !== undefined && nextQty > available) {
        throw new ConflictError('err.stock_limited', { productId, available });
      }
      if (line) {
        line.quantity = nextQty;
        line.unitPrice = unitPrice;
      } else {
        draft.items.push({
          key,
          productId,
          variantId,
          title: product.title,
          variantTitle: variant?.title || null,
          // what one "unit" of this line is, when it is a pack
          saleUnit: product.saleUnit?.kind === 'pack' ? { size: product.saleUnit.size, label: product.saleUnit.label } : null,
          image: product.images?.[0] || null,
          unitPrice,
          quantity,
          currency: product.currency,
          ...(quote ? { quoteId: quote.id } : {}),
        });
      }
      draft.lastChannel = channel;
      return draft;
    });

    await events.emit('cart.updated', { accountId, cartId: cart.id, storeId: cart.storeId, channel, action: 'add', productId });
    return withTotals(updated, await services.stores.get(cart.storeId));
  }

  async function setQuantity(accountId, cartId, key, quantity, { channel = 'web' } = {}) {
    const cart = await carts.get(cartId);
    if (!cart || cart.accountId !== accountId) throw new NotFoundError('Cart', cartId);

    const updated = await carts.mutate(cartId, (draft) => {
      const index = draft.items.findIndex((item) => item.key === key);
      if (index === -1) throw new NotFoundError('Cart item', key);
      if (quantity <= 0) draft.items.splice(index, 1);
      else draft.items[index].quantity = quantity;
      draft.lastChannel = channel;
      return draft;
    });

    await events.emit('cart.updated', { accountId, cartId, storeId: cart.storeId, channel, action: 'quantity' });
    return withTotals(updated, await services.stores.get(cart.storeId));
  }

  async function removeItem(accountId, cartId, key, opts) {
    return setQuantity(accountId, cartId, key, 0, opts);
  }

  async function setNote(accountId, cartId, note) {
    const cart = await carts.get(cartId);
    if (!cart || cart.accountId !== accountId) throw new NotFoundError('Cart', cartId);
    const updated = await carts.update(cartId, { note: String(note || '').slice(0, 500) });
    return withTotals(updated, await services.stores.get(cart.storeId));
  }

  async function clear(accountId, cartId) {
    const cart = await carts.get(cartId);
    if (!cart || cart.accountId !== accountId) throw new NotFoundError('Cart', cartId);
    const updated = await carts.update(cartId, { items: [], discountMinor: 0, note: '' });
    await events.emit('cart.updated', { accountId, cartId, storeId: cart.storeId, action: 'clear' });
    return withTotals(updated, await services.stores.get(cart.storeId));
  }

  /** Marks a cart converted once its order exists. Called by the orders service. */
  async function markConverted(cartId, orderId) {
    return carts.update(cartId, { status: 'converted', orderId, convertedAt: new Date().toISOString() });
  }

  async function countItems(accountId) {
    const rows = await carts.find({ where: { accountId, status: 'open' } });
    return rows.reduce((sum, cart) => sum + cart.items.reduce((n, item) => n + item.quantity, 0), 0);
  }

  return { getOpenCart, getOrCreate, get, listOpen, addItem, setQuantity, removeItem, setNote, clear, markConverted, countItems, withTotals };
}

/**
 * Totals are computed, never stored — store settings (delivery fee, free-delivery
 * threshold) can change between the bot adding an item and the web checking out.
 */
export function withTotals(cart, storeRecord = null, { fulfillmentMethod = null } = {}) {
  const currency = cart.currency || storeRecord?.currency || 'USD';
  const subtotal = cart.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const settings = storeRecord?.settings || {};
  const method = fulfillmentMethod || (settings.fulfillmentMethods?.[0] ?? 'delivery');

  let delivery = 0;
  // What a zero delivery line means: 'none' (no delivery), 'seller' (the shop covers it), 'free' (over the free-shipping
  // amount), 'carrier' (the buyer pays the carrier; the shop sets no fee) - or 'fee' when an amount is charged.
  let deliveryKind = 'none';
  if (method === 'delivery') {
    // The seller covering shipping means the buyer is never charged for it.
    delivery = settings.shippingPayer === 'seller' ? 0 : (settings.deliveryFee || 0);
    deliveryKind = settings.shippingPayer === 'seller' ? 'seller' : delivery > 0 ? 'fee' : 'carrier';
    if (settings.freeDeliveryOver && subtotal >= settings.freeDeliveryOver && deliveryKind !== 'seller') { delivery = 0; deliveryKind = 'free'; }
  }
  const discount = cart.discountMinor || 0;
  const total = Math.max(0, subtotal + delivery - discount);
  const commission = applyBps(subtotal, storeRecord?.commissionBps ?? 0);

  return {
    ...cart,
    itemCount: cart.items.reduce((n, item) => n + item.quantity, 0),
    totals: {
      currency,
      subtotal,
      delivery,
      deliveryKind,
      discount,
      total,
      commission,
      formatted: {
        subtotal: formatMoney(subtotal, currency),
        delivery: formatMoney(delivery, currency),
        discount: formatMoney(discount, currency),
        total: formatMoney(total, currency),
      },
    },
    meetsMinimum: !settings.minOrder || subtotal >= settings.minOrder,
    minOrder: settings.minOrder || 0,
  };
}
