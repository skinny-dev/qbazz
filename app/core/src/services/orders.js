import {
  CARRIERS,
  COLLECTIONS,
  ORDER_STATUS,
  ORDER_TRANSITIONS,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  FULFILLMENT_METHODS,
  orderContactSchema,
  addressSchema,
} from '../models/schemas.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { humanCode, newId } from '../util/ids.js';
import { moneyRef, ref } from '../i18n/index.js';
import { applyBps, formatMoney } from '../util/money.js';
import { validate } from '../util/validate.js';
import { withTotals } from './carts.js';

/**
 * Orders: checkout, lifecycle and the store-owner queue.
 *
 * An order snapshots its line items — price, title, image — so the buyer's
 * receipt never changes when the seller edits the product later.
 */
export function createOrdersService(ctx) {
  const { store: db, config, events, services } = ctx;
  const orders = db.collection(COLLECTIONS.orders);

  async function checkout(accountId, cartId, input = {}) {
    const cart = await db.collection(COLLECTIONS.carts).get(cartId);
    if (!cart || cart.accountId !== accountId) throw new NotFoundError('Cart', cartId);
    if (cart.status !== 'open') throw new ConflictError('err.cart_converted');
    if (!cart.items.length) throw new ConflictError('err.cart_empty');

    const storeRecord = await services.stores.resolve(cart.storeId);
    if (storeRecord.status !== 'active') throw new ConflictError('err.store_closed');
    // Billed against the shop owner's plan. Checked early so a buyer finds
    // out before typing an address into a shop that cannot take the order —
    // but only actually *spent* once the order is real (below), so an
    // unrelated failure later in checkout never burns a slot for nothing.
    // The shop's plan has lapsed and the grace is over: no NEW orders (those already placed carry on).
    if (!(await services.subscriptions.ordersOpen(storeRecord.ownerAccountId))) throw new ConflictError('err.shop_orders_closed');
    await services.subscriptions.checkLimit(storeRecord.ownerAccountId, 'orders');

    // A line priced by a quote needs that quote to still be good — it lapses, and it is single-use.
    for (const item of cart.items) if (item.quoteId) await services.priceRequests.assertUsable(item.quoteId, accountId);

    const contact = validate(input.contact || {}, orderContactSchema);
    const fulfillment = validate(input, {
      fulfillmentMethod: { type: 'enum', values: FULFILLMENT_METHODS, default: storeRecord.settings?.fulfillmentMethods?.[0] || 'delivery' },
      paymentMethod: { type: 'enum', values: PAYMENT_METHODS, default: storeRecord.settings?.paymentMethods?.[0] || 'online' },
      channel: { type: 'string', default: 'web' },
    });

    if (!storeRecord.settings?.paymentMethods?.includes(fulfillment.paymentMethod)) {
      throw ValidationError.of('paymentMethod', 'err.payment_unsupported');
    }
    // Card-to-card with nowhere to send the money would strand the buyer.
    if (fulfillment.paymentMethod === 'bank_transfer' && !services.storeCards.hasActiveCard(storeRecord)) {
      throw new ConflictError('err.store_no_card');
    }
    const address = fulfillment.fulfillmentMethod === 'delivery'
      ? validate(input.address || {}, { ...addressSchema, line1: { ...addressSchema.line1, required: true } })
      : null;

    const priced = withTotals(cart, storeRecord, { fulfillmentMethod: fulfillment.fulfillmentMethod });
    if (!priced.meetsMinimum) {
      throw new ConflictError('err.min_order', { minOrder: priced.minOrder }, { amount: moneyRef(priced.minOrder, priced.totals.currency) });
    }

    // Reserve stock before writing the order so two simultaneous checkouts
    // cannot both take the last unit.
    const reserved = [];
    try {
      for (const item of cart.items) {
        const product = await services.catalog.getProduct(item.productId);
        if (!product || product.status === 'archived') throw new ConflictError('err.item_gone', { title: item.title });
        // an option has its own stock; a product without options uses its own
        const option = item.variantId ? (product.variants || []).find((v) => v.id === item.variantId) : null;
        if (item.variantId && !option) throw new ConflictError('err.item_gone', { title: item.title });
        const available = option ? option.stock : product.stock;
        if (available !== null && available !== undefined) {
          if (available < item.quantity) throw new ConflictError('err.stock_left', { stock: available, title: item.variantTitle ? `${item.title} · ${item.variantTitle}` : item.title });
          await services.catalog.adjustStock(item.productId, -item.quantity, { reason: 'order', variantId: item.variantId || null });
          reserved.push(item);
        }
      }
    } catch (err) {
      for (const item of reserved) await services.catalog.adjustStock(item.productId, item.quantity, { reason: 'rollback', variantId: item.variantId || null });
      throw err;
    }

    const commission = applyBps(priced.totals.subtotal, config.platform.commissionBps);
    const online = fulfillment.paymentMethod === 'online';
    // An online order is not a real order until it is paid: it waits, for a while, and then it lapses.
    const autoConfirm = Boolean(storeRecord.settings?.autoConfirmOrders) && !online;
    const now = new Date().toISOString();

    const order = await orders.insert({
      id: newId('ord'),
      code: humanCode(6, 'QB'),
      storeId: storeRecord.id,
      storeName: storeRecord.name,
      storeSlug: storeRecord.slug,
      accountId,
      cartId,
      items: cart.items.map((item) => ({ ...item })),
      contact,
      address,
      note: input.note || cart.note || '',
      fulfillmentMethod: fulfillment.fulfillmentMethod,
      paymentMethod: fulfillment.paymentMethod,
      paymentStatus: 'unpaid',
      payBy: online ? new Date(Date.now() + config.payments.gateway.unpaidMinutes * 60000).toISOString() : null,
      paymentAttempts: [],
      paidAt: null,
      status: autoConfirm ? 'confirmed' : 'pending',
      totals: { ...priced.totals, commission },
      channel: fulfillment.channel,
      timeline: [
        { status: 'pending', at: now, by: accountId, note: `Placed via ${fulfillment.channel}` },
        ...(autoConfirm ? [{ status: 'confirmed', at: now, by: 'system', note: 'Auto-confirmed' }] : []),
      ],
      placedAt: now,
      closedAt: null,
      rating: null,
    });

    for (const item of order.items) if (item.quoteId) await services.priceRequests.consume(item.quoteId, order.id);
    await services.carts.markConverted(cartId, order.id);
    await services.subscriptions.consume(storeRecord.ownerAccountId, 'orders').catch(() => null);
    await services.stores.bumpStats(storeRecord.id, { orders: 1, revenueMinor: order.totals.total });
    for (const item of order.items) {
      await services.catalog.bumpProductStats(item.productId, { orders: 1, unitsSold: item.quantity });
    }
    await bumpAccountStats(accountId, order);
    await services.customers.recordOrder(storeRecord.id, accountId, order);

    await events.emit('order.created', { orderId: order.id, storeId: storeRecord.id, accountId, order });
    return order;
  }

  async function bumpAccountStats(accountId, order) {
    const accounts = db.collection(COLLECTIONS.accounts);
    const account = await accounts.get(accountId);
    if (!account) return;
    await accounts.update(accountId, {
      stats: {
        orders: (account.stats?.orders || 0) + 1,
        spentMinor: (account.stats?.spentMinor || 0) + order.totals.total,
      },
    });
  }

  async function get(idOrCode) {
    if (!idOrCode) return null;
    return (await orders.get(idOrCode)) || (await orders.findOne({ code: String(idOrCode).toUpperCase() }));
  }

  async function getOrFail(idOrCode) {
    const order = await get(idOrCode);
    if (!order) throw new NotFoundError('Order', idOrCode);
    return order;
  }

  /** Buyers see their own orders; staff see the store's. Enforced here, once. */
  async function getForActor(idOrCode, actorAccountId) {
    const order = await getOrFail(idOrCode);
    if (order.accountId === actorAccountId) return order;
    const account = await db.collection(COLLECTIONS.accounts).get(actorAccountId);
    if (account?.role === 'admin' || account?.role === 'support') return order;
    await services.stores.assertCan(order.storeId, actorAccountId, 'orders.view');
    return order;
  }

  async function listForBuyer(accountId, { status, limit = 20, offset = 0 } = {}) {
    const where = { accountId };
    if (status) where.status = Array.isArray(status) ? { $in: status } : status;
    const [items, total] = await Promise.all([
      orders.find({ where, limit, offset, sort: [['createdAt', 'desc']] }),
      orders.count(where),
    ]);
    return { items, total };
  }

  async function listForStore(storeId, { status, actorAccountId, limit = 20, offset = 0 } = {}) {
    if (actorAccountId) await services.stores.assertCan(storeId, actorAccountId, 'orders.view');
    const wanted = status ? [].concat(status) : null;
    // An online order that was never paid is a checkout the buyer walked away from - the shop never sees it.
    const where = (o) => o.storeId === storeId && (!wanted || wanted.includes(o.status)) && !(o.paymentMethod === 'online' && !o.paidAt);
    const [items, total] = await Promise.all([
      orders.find({ where, limit, offset, sort: [['createdAt', 'desc']] }),
      orders.count(where),
    ]);
    return { items, total };
  }

  /** The count the dashboard badge and the bot's "you have N new orders" both read. */
  async function pendingCount(storeId) {
    return orders.count((o) => o.storeId === storeId && ['pending', 'confirmed', 'preparing', 'ready'].includes(o.status) && !(o.paymentMethod === 'online' && !o.paidAt));
  }

  async function updateStatus(orderId, nextStatus, { actorAccountId, note = '', byBuyer = false, shipment = null } = {}) {
    if (!ORDER_STATUS.includes(nextStatus)) {
      throw new ValidationError({ status: `Status must be one of: ${ORDER_STATUS.join(', ')}` });
    }
    const order = await getOrFail(orderId);

    if (byBuyer) {
      if (order.accountId !== actorAccountId) throw new ForbiddenError('err.not_your_order');
      if (nextStatus === 'delivered') {
        // "I have it" - only once it has left the shop (or is waiting at it, for pickup).
        if (!['shipped', 'ready'].includes(order.status)) throw new ConflictError('err.cannot_receive');
      } else {
        if (nextStatus !== 'cancelled') throw new ForbiddenError('err.only_cancel');
        if (!['pending', 'confirmed'].includes(order.status)) throw new ConflictError('err.cannot_cancel');
      }
    } else if (actorAccountId) {
      await services.stores.assertCan(order.storeId, actorAccountId, 'orders.update');
    }

    const allowed = ORDER_TRANSITIONS[order.status] || [];
    if (!allowed.includes(nextStatus)) {
      throw new ConflictError('err.order_transition', { from: order.status, to: nextStatus, allowed }, { from: ref(`enum.order.${order.status}`), to: ref(`enum.order.${nextStatus}`) });
    }

    // Nothing moves forward until the money is in.
    if (order.paymentMethod === 'online' && order.paymentStatus !== 'paid' && nextStatus !== 'cancelled') throw new ConflictError('err.unpaid_order');

    if (nextStatus === 'cancelled' || nextStatus === 'refunded') {
      for (const item of order.items) await services.catalog.adjustStock(item.productId, item.quantity, { reason: nextStatus, variantId: item.variantId || null });
      await services.stores.bumpStats(order.storeId, { orders: -1, revenueMinor: -order.totals.total });
    }

    const closed = ['delivered', 'cancelled', 'refunded'].includes(nextStatus);
    // Marking it shipped can carry the tracking details in the same step.
    const parcel = nextStatus === 'shipped' && shipment ? normalizeShipment(shipment, order.shipment, actorAccountId) : null;
    const updated = await orders.mutate(order.id, (draft) => {
      draft.status = nextStatus;
      if (parcel) draft.shipment = parcel;
      draft.timeline.push({ status: nextStatus, at: new Date().toISOString(), by: actorAccountId || 'system', note });
      if (closed) draft.closedAt = new Date().toISOString();
      if (nextStatus === 'delivered' && draft.paymentMethod === 'cash_on_delivery') draft.paymentStatus = 'paid';
      if (nextStatus === 'refunded') draft.paymentStatus = 'refunded';
      // Paid, then cancelled: the money has to go back to the buyer.
      if (nextStatus === 'cancelled' && draft.paymentMethod === 'online' && draft.paymentStatus === 'paid') draft.paymentStatus = 'refund_pending';
      return draft;
    });

    await events.emit('order.status_changed', {
      orderId: order.id,
      storeId: order.storeId,
      accountId: order.accountId,
      from: order.status,
      status: nextStatus,
      order: updated,
    });
    return updated;
  }

  /** Carrier, code and expected date, cleaned: a code only has meaning with a carrier that can look it up. */
  function normalizeShipment(input, previous, actorAccountId) {
    const carrier = input.carrier && CARRIERS[input.carrier] ? input.carrier : (input.carrier ? null : previous?.carrier || null);
    if (input.carrier && !carrier) throw ValidationError.of('carrier', 'err.carrier_invalid');
    const trackingCode = String(input.trackingCode ?? previous?.trackingCode ?? '').trim().replace(/\s+/g, '').slice(0, 60);
    if (trackingCode && !/^[A-Za-z0-9-]{4,60}$/.test(trackingCode)) throw ValidationError.of('trackingCode', 'err.tracking_code');
    let eta = input.eta === undefined ? previous?.eta || null : (input.eta || null);
    if (eta) {
      const when = new Date(eta);
      if (Number.isNaN(when.getTime())) throw ValidationError.of('eta', 'err.eta_invalid');
      eta = when.toISOString().slice(0, 10);
    }
    return {
      carrier,
      trackingCode: trackingCode || null,
      eta,
      note: String(input.note ?? previous?.note ?? '').trim().slice(0, 200),
      updatedAt: new Date().toISOString(),
      updatedBy: actorAccountId || null,
    };
  }

  /** The gateway confirmed the money. Idempotent: a repeated callback changes nothing. */
  async function markPaid(orderId, { provider = 'sandbox', refId = null, attemptId = null } = {}) {
    const order = await getOrFail(orderId);
    if (order.paymentStatus === 'paid') return order;
    if (order.status === 'cancelled') throw new ConflictError('err.pay_not_available');
    const at = new Date().toISOString();
    const updated = await orders.mutate(order.id, (draft) => {
      draft.paymentStatus = 'paid';
      draft.paidAt = at;
      draft.paymentRef = { provider, refId, attemptId };
      draft.paymentAttempts = (draft.paymentAttempts || []).map((a) => (a.id === attemptId ? { ...a, status: 'paid', paidAt: at, refId } : a));
      draft.timeline.push({ status: draft.status, kind: 'payment', at, by: 'gateway', note: refId || '' });
      return draft;
    });
    await events.emit('order.paid', { orderId: order.id, storeId: order.storeId, accountId: order.accountId, order: updated });
    const shop = await services.stores.get(order.storeId);
    if (shop?.settings?.autoConfirmOrders && updated.status === 'pending') {
      return updateStatus(order.id, 'confirmed', { note: 'Auto-confirmed' });
    }
    return updated;
  }

  /** The seller adds or corrects tracking details after the order has left (or is about to leave). */
  async function setShipment(orderId, input, { actorAccountId } = {}) {
    const order = await getOrFail(orderId);
    if (actorAccountId) await services.stores.assertCan(order.storeId, actorAccountId, 'orders.update');
    if (!['confirmed', 'preparing', 'ready', 'shipped'].includes(order.status)) throw new ConflictError('err.shipment_status');
    const parcel = normalizeShipment(input || {}, order.shipment, actorAccountId);
    const updated = await orders.mutate(order.id, (draft) => {
      draft.shipment = parcel;
      draft.timeline.push({ status: draft.status, kind: 'shipment', at: parcel.updatedAt, by: actorAccountId || 'system', note: [parcel.carrier ? CARRIERS[parcel.carrier].fa : '', parcel.trackingCode || ''].filter(Boolean).join(' · ') });
      return draft;
    });
    await events.emit('order.shipment_updated', { orderId: order.id, storeId: order.storeId, accountId: order.accountId, order: updated });
    return updated;
  }

  /** The buyer says it arrived. */
  async function confirmReceived(orderId, accountId) {
    return updateStatus(orderId, 'delivered', { actorAccountId: accountId, byBuyer: true, note: 'received_by_buyer' });
  }

  /**
   * Public lookup: an order code plus the last four digits of the phone it was placed with. That pair is the whole
   * credential, so a wrong guess answers exactly like a code that does not exist.
   */
  async function track(code, lastDigits) {
    const order = code ? await orders.findOne({ code: String(code).trim().toUpperCase() }) : null;
    const digits = String(lastDigits || '').replace(/\D/g, '');
    const phones = order ? [order.contact?.phone, (await db.collection(COLLECTIONS.accounts).get(order.accountId))?.phone] : [];
    const ok = order && digits.length === 4 && phones.some((p) => String(p || '').replace(/\D/g, '').endsWith(digits));
    if (!ok) throw new NotFoundError('Order', code);
    const store = await db.collection(COLLECTIONS.stores).get(order.storeId);
    return {
      code: order.code,
      status: order.status,
      placedAt: order.placedAt || order.createdAt,
      storeName: store?.name || '',
      storeSlug: store?.slug || '',
      fulfillmentMethod: order.fulfillmentMethod,
      city: order.address?.city || null,
      itemCount: order.items.reduce((n, item) => n + item.quantity, 0),
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      paidAt: order.paidAt || null,
      timeline: order.timeline.map(({ status, kind = null, at }) => ({ status, kind, at })),
      shipment: order.shipment ? trackingView(order.shipment) : null,
    };
  }

  /** A shipment as buyers see it: with the carrier's name and where to look the code up. */
  function trackingView(shipment) {
    const carrier = shipment.carrier ? CARRIERS[shipment.carrier] : null;
    return { carrier: shipment.carrier, carrierName: carrier?.fa || null, carrierSite: carrier?.site || null, trackingCode: shipment.trackingCode, eta: shipment.eta, note: shipment.note, updatedAt: shipment.updatedAt };
  }

  async function setPaymentStatus(orderId, paymentStatus, { actorAccountId, reference = null } = {}) {
    if (!PAYMENT_STATUS.includes(paymentStatus)) {
      throw new ValidationError({ paymentStatus: `Must be one of: ${PAYMENT_STATUS.join(', ')}` });
    }
    const order = await getOrFail(orderId);
    if (actorAccountId) await services.stores.assertCan(order.storeId, actorAccountId, 'orders.update');
    const updated = await orders.update(order.id, { paymentStatus, paymentReference: reference });
    await events.emit('order.payment_changed', { orderId: order.id, storeId: order.storeId, paymentStatus, order: updated });
    return updated;
  }

  // -- Card-to-card payments ---------------------------------------------------
  //
  // The buyer transfers the money from their card to the shop's card outside
  // the app, then tells us how: a tracking reference, a photo of the receipt,
  // or both. The money never passes through here, so the only proof is the
  // seller's own bank — which is why an actual person approves or declines.

  /** What a buyer needs to pay: the shop's card, shown only on their own order. */
  async function paymentInstructions(order) {
    if (order.paymentMethod !== 'bank_transfer') return null;
    const shop = await db.collection(COLLECTIONS.stores).get(order.storeId);
    const card = services.storeCards.cardForOrder(shop, order.id);
    return card ? { cardId: card.id, cardNumber: services.storeCards.format(card.number), holder: card.holder || null, bank: card.bank || null } : null;
  }

  async function receiptCard(order) {
    const shop = await db.collection(COLLECTIONS.stores).get(order.storeId);
    const card = services.storeCards.cardForOrder(shop, order.id);
    return card ? { last4: card.number.slice(-4), holder: card.holder || null, bank: card.bank || null } : null;
  }

  async function submitPaymentReceipt(orderId, accountId, { reference = '', imageUrl = '', telegramFileId = '', note = '' } = {}) {
    const order = await getOrFail(orderId);
    if (order.accountId !== accountId) throw new ForbiddenError('err.not_your_order');
    if (order.paymentMethod !== 'bank_transfer') throw new ConflictError('err.payment_not_card_to_card');
    if (['paid', 'refunded'].includes(order.paymentStatus) || ['cancelled', 'refunded'].includes(order.status)) {
      throw new ConflictError('err.payment_closed');
    }
    const data = validate({ reference, imageUrl, telegramFileId, note }, {
      reference: { type: 'string', max: 80 },
      imageUrl: { type: 'string', max: 500 },
      // The same photo as a Telegram file id, which the bot can resend; the URL form embeds the bot token and must never be shown in chat.
      telegramFileId: { type: 'string', max: 200 },
      note: { type: 'string', max: 300 },
    });
    if (!data.reference && !data.imageUrl) throw ValidationError.of('reference', 'err.receipt_required');

    const updated = await orders.update(order.id, {
      paymentStatus: 'pending',
      paymentReference: data.reference || null,
      // Which of the shop's cards this buyer was told to pay — so the seller knows where to look.
      paymentReceipt: { ...data, card: await receiptCard(order), submittedAt: new Date().toISOString(), decision: null, decidedAt: null, decidedBy: null, reason: null },
    });
    await events.emit('order.payment_changed', { orderId: order.id, storeId: order.storeId, paymentStatus: 'pending', order: updated });
    await services.notifications.queueForStoreTeam(order.storeId, {
      type: 'order.payment_submitted',
      render: (t) => ({ title: t('notif.payment.submitted.title', { code: order.code }), body: '' }),
      data: { orderId: order.id, storeId: order.storeId, action: 'open_order' },
      priority: 'high',
    }, { minRole: 'staff' });
    return updated;
  }

  /** Approve (`paid`, and a still-pending order is confirmed) or decline (`failed`, with an optional reason the buyer sees). */
  async function reviewPayment(orderId, decision, { actorAccountId, reason = '' } = {}) {
    if (!['approve', 'decline'].includes(decision)) throw new ValidationError({ decision: 'Must be approve or decline' });
    const order = await getOrFail(orderId);
    await services.stores.assertCan(order.storeId, actorAccountId, 'orders.update');
    if (order.paymentMethod !== 'bank_transfer') throw new ConflictError('err.payment_not_card_to_card');
    if (order.paymentStatus !== 'pending' || !order.paymentReceipt) throw new ConflictError('err.payment_nothing_to_review');

    const approved = decision === 'approve';
    const cleanReason = String(reason || '').trim().slice(0, 300);
    let updated = await orders.update(order.id, {
      paymentStatus: approved ? 'paid' : 'failed',
      paymentReceipt: {
        ...order.paymentReceipt,
        decision: approved ? 'approved' : 'declined',
        decidedAt: new Date().toISOString(),
        decidedBy: actorAccountId,
        reason: approved ? null : (cleanReason || null),
      },
    });
    await events.emit('order.payment_changed', { orderId: order.id, storeId: order.storeId, paymentStatus: updated.paymentStatus, order: updated });

    // Money confirmed on a still-open order is the cue to start preparing it.
    if (approved && order.status === 'pending') {
      updated = await updateStatus(order.id, 'confirmed', { actorAccountId, note: 'Payment approved' });
    }

    await services.notifications.queue({
      accountId: order.accountId,
      storeId: order.storeId,
      type: approved ? 'order.payment_approved' : 'order.payment_declined',
      render: (t) => ({
        title: approved
          ? t('notif.payment.approved.title', { code: order.code })
          : t('notif.payment.declined.title', { code: order.code }),
        body: approved ? '' : (cleanReason || t('notif.payment.declined.default')),
      }),
      data: { orderId: order.id, storeId: order.storeId, action: 'open_order' },
      priority: 'high',
    });
    return updated;
  }

  /** Buyer rating after delivery; feeds store and product rating aggregates. */
  async function rate(orderId, accountId, { rating, comment = '' }) {
    const order = await getOrFail(orderId);
    if (order.accountId !== accountId) throw new ForbiddenError('err.not_your_order');
    if (order.status !== 'delivered') throw new ConflictError('err.rate_early');
    if (order.rating) throw new ConflictError('err.already_rated');
    const value = validate({ rating }, { rating: { type: 'int', required: true, min: 1, max: 5 } }).rating;

    const updated = await orders.update(order.id, { rating: { value, comment: String(comment).slice(0, 500), at: new Date().toISOString() } });
    await db.collection(COLLECTIONS.reviews).insert({
      id: newId('rev'),
      storeId: order.storeId,
      orderId: order.id,
      accountId,
      rating: value,
      comment: String(comment).slice(0, 500),
      productIds: order.items.map((item) => item.productId),
    });
    await services.stores.bumpStats(order.storeId, { ratingSum: value, ratingCount: 1 });
    for (const item of order.items) await services.catalog.bumpProductStats(item.productId, { ratingSum: value, ratingCount: 1 });

    await events.emit('order.rated', { orderId: order.id, storeId: order.storeId, rating: value });
    return updated;
  }

  return {
    checkout,
    get,
    getOrFail,
    getForActor,
    listForBuyer,
    listForStore,
    pendingCount,
    updateStatus,
    markPaid,
    setShipment,
    confirmReceived,
    track,
    trackingView,
    setPaymentStatus,
    paymentInstructions,
    submitPaymentReceipt,
    reviewPayment,
    rate,
  };
}
