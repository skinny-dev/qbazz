import { formatMoney } from './util/money.js';
import { CARRIERS } from './models/schemas.js';

/**
 * Domain events → notifications.
 *
 * Kept out of the services so that "what happens when an order is placed" is
 * readable in one file, and so a service never needs to know who cares about
 * its events. Notifications are queued against accounts, not channels — the
 * bot and (later) the web push worker each drain what they can deliver.
 *
 * Every message here is built with `render: (t, locale) => …`, where `t` is the
 * *recipient's* translator. The notification service calls it once per
 * recipient, which is how one order produces a Persian message for the shop
 * and an English one for a buyer who chose English.
 */
export function wireReactions(ctx) {
  const { events, services, config } = ctx;

  const notifyShopOfOrder = async (order) => {
      await services.notifications.queueForStoreTeam(order.storeId, {
        type: 'order.new',
        render: (t, locale) => ({
          title: t('notif.order.new.title', {
            code: order.code,
            money: formatMoney(order.totals.total, order.totals.currency, locale),
          }),
          body: t('notif.order.new.body', { count: order.items.length, name: order.contact.name }),
        }),
        data: { orderId: order.id, storeId: order.storeId, action: 'open_order' },
        priority: 'high',
      });
  };

  events.on('order.paid', async ({ payload }) => {
    const { order } = payload;
    await notifyShopOfOrder(order);
    await services.notifications.queue({
      accountId: order.accountId,
      storeId: order.storeId,
      type: 'order.paid',
      render: (t) => ({ title: t('notif.order.paid.title', { code: order.code }), body: t('notif.order.paid.body', { store: order.storeName }) }),
      data: { orderId: order.id, storeId: order.storeId, action: 'open_order' },
    });
  });

  events.on('order.created', async ({ payload }) => {
    const { order } = payload;

    // An online order is only news to the shop once it is paid (see order.paid below).
    if (!(order.paymentMethod === 'online' && order.paymentStatus !== 'paid')) await notifyShopOfOrder(order);

    await services.notifications.queue({
      accountId: order.accountId,
      storeId: order.storeId,
      type: 'order.placed',
      render: (t) => ({
        title: t('notif.order.placed.title', { code: order.code }),
        body: t('notif.order.placed.body', { store: order.storeName }),
      }),
      data: { orderId: order.id, storeId: order.storeId, action: 'open_order' },
    });
  });

  // Tracking details added or corrected after the order shipped: the buyer gets the code.
  events.on('order.shipment_updated', async ({ payload }) => {
    const { order } = payload;
    if (!order.shipment?.trackingCode) return;
    await services.notifications.queue({
      accountId: order.accountId,
      storeId: order.storeId,
      type: 'order.tracking',
      render: (t) => ({
        title: t('notif.order.tracking.title', { code: order.code }),
        body: t('notif.order.tracking.body', { carrier: order.shipment.carrier ? CARRIERS[order.shipment.carrier].fa : '', code: order.shipment.trackingCode }),
      }),
      data: { orderId: order.id, storeId: order.storeId, action: 'open_order' },
    });
  });

  events.on('order.status_changed', async ({ payload }) => {
    const { order, status } = payload;
    const copy = BUYER_STATUS_COPY[status];
    if (copy) {
      await services.notifications.queue({
        accountId: order.accountId,
        storeId: order.storeId,
        type: `order.${status}`,
        render: (t) => copy(t, order),
        data: { orderId: order.id, storeId: order.storeId, action: 'open_order' },
        priority: status === 'cancelled' ? 'high' : 'normal',
      });
    }
    // A buyer cancellation is news for the seller, not the other way round.
    if (status === 'cancelled') {
      await services.notifications.queueForStoreTeam(order.storeId, {
        type: 'order.cancelled',
        render: (t) => ({
          title: t('notif.order.cancelled.seller.title', { code: order.code }),
          body: t('notif.order.cancelled.seller.body', { name: order.contact.name }),
        }),
        data: { orderId: order.id, storeId: order.storeId },
      });
    }
  });

  // A new live product goes out to the shop's Telegram channel, if connected —
  // unless the product *is* a channel post already (channel_sync), in which
  // case posting it back would echo it into the audience it just came from, or
  // the caller already decided where this one goes itself (`skipChannelSync` —
  // the reviewed-listing flow, which posts explicitly, on its own terms, right
  // after creating the product, rather than through this automatic reaction).
  events.on('product.created', async ({ payload }) => {
    if (payload.product?.source === 'channel_sync' || payload.skipChannelSync) return;
    await services.channels.queueProduct(payload.productId, { reason: 'new_product' });
  });

  events.on('product.updated', async ({ payload }) => {
    // Covers a draft that has just been published.
    if (!payload.changed?.includes('status') || payload.product?.status !== 'active') return;
    if (payload.product?.source === 'channel_sync') return;
    await services.channels.queueProduct(payload.productId, { reason: 'published' });
  });

  // A product we posted to a channel changed: the post follows (price, discount, stock, availability, words).
  const POST_FIELDS = ['price', 'compareAtPrice', 'status', 'stock', 'title', 'description', 'priceVisibility'];
  events.on('product.updated', async ({ payload }) => {
    if (!payload.changed?.some((field) => POST_FIELDS.includes(field))) return;
    await services.channels.queueEdit(payload.productId);
  });

  events.on('store.status_changed', async ({ payload }) => {
    // Nothing may post before approval, so a newly approved shop catches up.
    if (payload.status !== 'active') return;
    const channel = await services.channels.get(payload.storeId).catch(() => null);
    if (!channel?.autoPost) return;
    await services.channels.backfill(payload.storeId, { limit: 10 }).catch(() => null);
  });

  // A draft is useless if nobody knows it is waiting.
  events.on('channel.draft_created', async ({ payload }) => {
    const product = await services.catalog.getProduct(payload.productId);
    await services.notifications.queueForStoreTeam(payload.storeId, {
      type: 'channel.draft_ready',
      render: (t) => ({
        title: t('notif.channel.draft_ready.title'),
        body: product
          ? t('notif.channel.draft_ready.body', { title: product.title })
          : t('notif.channel.draft_ready.plain'),
      }),
      data: { storeId: payload.storeId, postId: payload.postId, action: 'review_draft' },
    }, { minRole: 'manager' });
  });

  events.on('store.submitted', async ({ payload }) => {
    const { store } = payload;
    await services.notifications.queue({
      accountId: store.ownerAccountId,
      storeId: store.id,
      type: 'store.submitted',
      render: (t) => ({ title: t('notif.store.submitted.title'), body: t('notif.store.submitted.body') }),
      data: { storeId: store.id },
    });

    // The other half of that promise: somebody at Qbazz has to see it.
    const owner = await services.accounts.get(store.ownerAccountId);
    await services.notifications.queueForAdmins({
      storeId: store.id,
      type: 'admin.review_needed',
      render: (t) => ({
        title: t('notif.admin.review_needed.title', { name: store.name }),
        body: [
          store.description ? `«${store.description.slice(0, 120)}»` : null,
          t('notif.admin.review_needed.owner', { owner: owner?.displayName || '—' }),
          store.location?.city ? t('notif.admin.review_needed.location', { city: store.location.city }) : null,
          t('notif.admin.review_needed.products', { count: store.stats?.products || 0 }),
        ].filter(Boolean).join('\n'),
      }),
      data: { storeId: store.id, action: 'review_store' },
      priority: 'high',
    });
  });

  events.on('product.stock_changed', async ({ payload }) => {
    if (payload.stock !== 0 || payload.reason !== 'order') return;
    await services.notifications.queueForStoreTeam(payload.storeId, {
      type: 'product.out_of_stock',
      render: (t) => ({ title: t('notif.product.out_of_stock.title'), body: t('notif.product.out_of_stock.body') }),
      data: { productId: payload.productId, storeId: payload.storeId, action: 'open_product' },
    }, { minRole: 'manager' });
  });

  events.on('order.rated', async ({ payload }) => {
    await services.notifications.queueForStoreTeam(payload.storeId, {
      type: 'order.rated',
      render: (t) => ({ title: t('notif.order.rated.title', { rating: payload.rating }), body: t('notif.order.rated.body') }),
      data: { orderId: payload.orderId, storeId: payload.storeId },
    }, { minRole: 'manager' });

    // Admins hear about the bad ones only. Every rating would be noise; a one
    // or two star review is a shop that may need looking at.
    if (payload.rating > 2) return;
    const order = await services.orders.get(payload.orderId);
    await services.notifications.queueForAdmins({
      storeId: payload.storeId,
      type: 'admin.low_rating',
      render: (t) => ({
        title: t('notif.admin.low_rating.title', { rating: payload.rating, store: order?.storeName || '—' }),
        // The buyer's own words are shown as written, in whatever language they used.
        body: order?.rating?.comment ? `«${order.rating.comment}»` : t('notif.admin.low_rating.none'),
      }),
      data: { storeId: payload.storeId, orderId: payload.orderId, action: 'review_store' },
    });
  });

  events.on('store.created', async ({ payload }) => {
    // Worth knowing about even before it is submitted — it is the top of the
    // seller funnel, and a stalled shop here is a seller who needs a nudge.
    await services.notifications.queueForAdmins({
      storeId: payload.storeId,
      type: 'admin.new_store',
      render: (t) => ({
        title: t('notif.admin.new_store.title', { name: payload.store.name }),
        body: t('notif.admin.new_store.body'),
      }),
      data: { storeId: payload.storeId },
      priority: 'low',
    });
  });

  events.on('onboarding.completed', async ({ payload }) => {
    if (payload.flow !== 'seller' || !payload.result?.storeId) return;
    ctx.log.info(`seller onboarding completed: store ${payload.result.storeSlug} via ${payload.channel}`);
  });

  return () => {};
}

/** Buyer-facing copy per order status, built with the recipient's translator. */
const BUYER_STATUS_COPY = {
  confirmed: (t, o) => ({ title: t('notif.order.confirmed.title', { code: o.code }), body: t('notif.order.confirmed.body', { store: o.storeName }) }),
  preparing: (t, o) => ({ title: t('notif.order.preparing.title', { code: o.code }), body: t('notif.order.preparing.body') }),
  ready: (t, o) => ({
    title: t('notif.order.ready.title', { code: o.code }),
    body: t(o.fulfillmentMethod === 'pickup' ? 'notif.order.ready.pickup.body' : 'notif.order.ready.courier.body'),
  }),
  shipped: (t, o) => ({ title: t('notif.order.shipped.title', { code: o.code }), body: o.shipment?.trackingCode ? t('notif.order.tracking.body', { carrier: o.shipment.carrier ? CARRIERS[o.shipment.carrier].fa : '', code: o.shipment.trackingCode }) : t('notif.order.shipped.body') }),
  delivered: (t, o) => ({ title: t('notif.order.delivered.title', { code: o.code }), body: t('notif.order.delivered.body') }),
  cancelled: (t, o) => ({ title: t('notif.order.cancelled.title', { code: o.code }), body: t('notif.order.cancelled.body', { store: o.storeName }) }),
  refunded: (t, o) => ({ title: t('notif.order.refunded.title', { code: o.code }), body: t('notif.order.refunded.body') }),
};
