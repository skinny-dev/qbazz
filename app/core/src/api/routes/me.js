import { Router } from '../router.js';
import { requireAuth, status } from '../http.js';
import { pageParams } from '../../util/paginate.js';

/** Everything scoped to the signed-in buyer: profile, carts, orders, saved items. */
export function registerMeRoutes(root, core) {
  const { services } = core;
  const router = new Router();

  router.get('/', async (ctx) => {
    const account = requireAuth(ctx);
    return {
      account,
      cartItemCount: await services.carts.countItems(account.id),
      stores: await services.stores.listForAccount(account.id),
      unreadNotifications: (await services.notifications.listForAccount(account.id, { limit: 1 })).unread,
    };
  });

  router.patch('/', async (ctx) => services.accounts.update(requireAuth(ctx).id, ctx.body));

  router.post('/avatar/from-telegram', async (ctx) => services.accounts.useTelegramPhoto(requireAuth(ctx).id));

  // -- Carts -----------------------------------------------------------------

  /**
   * How a buyer can reach the seller: shown when online payment cannot be used, so they are not left at a dead end.
   * Only what the shop already publishes on its public page.
   */
  async function sellerOf(storeId) {
    const shop = await services.stores.resolve(storeId).catch(() => null);
    if (!shop) return null;
    return {
      name: shop.name,
      slug: shop.slug,
      phone: shop.contact?.phone || '',
      telegram: shop.contact?.telegram || shop.channels?.telegram?.username || '',
      instagram: shop.contact?.instagram || '',
    };
  }

  router.get('/carts', async (ctx) => {
    const carts = await services.carts.listOpen(requireAuth(ctx).id);
    const online = services.gateway.available();
    return {
      items: await Promise.all(carts.map(async (cart) => {
        const open = await services.subscriptions.ordersOpen((await services.stores.resolve(cart.storeId).catch(() => null))?.ownerAccountId);
        return { ...cart, onlinePayment: online, ordersOpen: open, seller: online && open ? null : await sellerOf(cart.storeId) };
      })),
    };
  });

  router.get('/carts/:id', async (ctx) => services.carts.get(ctx.params.id));

  router.post('/carts/items', async (ctx) => {
    const account = requireAuth(ctx);
    return services.carts.addItem(account.id, {
      productId: ctx.body.productId,
      variantId: ctx.body.variantId || null,
      quantity: Number(ctx.body.quantity) || 1,
      channel: ctx.channel,
    });
  });

  router.patch('/carts/:id/items/:key', async (ctx) => services.carts.setQuantity(
    requireAuth(ctx).id,
    ctx.params.id,
    ctx.params.key,
    Number(ctx.body.quantity),
    { channel: ctx.channel },
  ));

  router.delete('/carts/:id/items/:key', async (ctx) => services.carts.removeItem(
    requireAuth(ctx).id,
    ctx.params.id,
    ctx.params.key,
    { channel: ctx.channel },
  ));

  router.post('/carts/:id/note', async (ctx) => services.carts.setNote(requireAuth(ctx).id, ctx.params.id, ctx.body.note));

  router.delete('/carts/:id', async (ctx) => services.carts.clear(requireAuth(ctx).id, ctx.params.id));

  // -- Checkout and orders ---------------------------------------------------

  router.post('/carts/:id/checkout', async (ctx) => {
    const account = requireAuth(ctx);
    const order = await services.orders.checkout(account.id, ctx.params.id, { ...ctx.body, channel: ctx.channel });
    return status(201, order);
  });

  router.get('/orders', async (ctx) => {
    const account = requireAuth(ctx);
    const { limit, offset } = pageParams(ctx.query);
    return services.orders.listForBuyer(account.id, { status: ctx.query.status, limit, offset });
  });

  router.get('/orders/:id', async (ctx) => {
    const order = await services.orders.getForActor(ctx.params.id, requireAuth(ctx).id);
    // The shop's card number is only ever shown to the person who has to pay it.
    const tracking = order.shipment ? services.orders.trackingView(order.shipment) : null;
    const onlinePayment = services.gateway.available();
    const seller = onlinePayment ? null : await sellerOf(order.storeId);
    return order.accountId === ctx.accountId ? { ...order, tracking, onlinePayment, seller, payLink: services.gateway.payLink(order), payTo: await services.orders.paymentInstructions(order) } : { ...order, tracking };
  });

  /** Card-to-card: the buyer says how they paid (a reference, a receipt photo URL, or both). */
  router.post('/orders/:id/payment-receipt', async (ctx) => services.orders.submitPaymentReceipt(ctx.params.id, requireAuth(ctx).id, {
    reference: ctx.body.reference || '',
    imageUrl: ctx.body.imageUrl || '',
    telegramFileId: ctx.body.telegramFileId || '',
    note: ctx.body.note || '',
  }));

  /** Start paying an online order: answers with the gateway page to send the buyer to. */
  router.post('/orders/:id/pay', async (ctx) => services.gateway.startPayment(ctx.params.id, requireAuth(ctx).id));

  router.post('/orders/:id/received', async (ctx) => services.orders.confirmReceived(ctx.params.id, requireAuth(ctx).id));

  router.post('/orders/:id/cancel', async (ctx) => services.orders.updateStatus(ctx.params.id, 'cancelled', {
    actorAccountId: requireAuth(ctx).id,
    byBuyer: true,
    note: ctx.body.reason || '',
  }));

  router.post('/orders/:id/rate', async (ctx) => services.orders.rate(ctx.params.id, requireAuth(ctx).id, {
    rating: ctx.body.rating,
    comment: ctx.body.comment || '',
  }));

  // -- Wholesale access requests (private-priced products) --------------------

  router.post('/access-requests', async (ctx) => status(201, await services.access.request(requireAuth(ctx).id, ctx.body.productId)));

  // -- Saved items and notifications ----------------------------------------

  router.get('/saved', async (ctx) => {
    const { limit, offset } = pageParams(ctx.query);
    return services.discovery.listSaved(requireAuth(ctx).id, { limit, offset });
  });

  router.post('/saved', async (ctx) => services.discovery.toggleSaved(requireAuth(ctx).id, {
    refType: ctx.body.refType || 'product',
    refId: ctx.body.refId,
  }));

  router.get('/notifications', async (ctx) => {
    const { limit, offset } = pageParams(ctx.query);
    return services.notifications.listForAccount(requireAuth(ctx).id, {
      unreadOnly: ctx.query.unread === 'true',
      limit,
      offset,
    });
  });

  router.post('/notifications/read', async (ctx) => services.notifications.markRead(requireAuth(ctx).id, ctx.body.id || null));

  // -- Wallet and subscription plan -------------------------------------------
  // Account-scoped, not store-scoped: one plan and one wallet cover every
  // store this account owns.

  router.get('/billing', async (ctx) => {
    const account = requireAuth(ctx);
    const pending = await services.topups.listMine(account.id, { limit: 5 });
    return {
      wallet: await services.wallet.getBalance(account.id),
      ...(await services.subscriptions.summary(account.id)),
      packs: services.subscriptions.listPacks(),
      topup: await services.topups.instructions(account.id),
      topups: pending.items,
    };
  });

  // -- Image uploads (base64 in JSON; the web client resizes first) -----------------

  router.post('/uploads', async (ctx) => status(201, await services.uploads.saveImage(requireAuth(ctx).id, ctx.body.data)));

  // The same, as the file's own bytes: a third less to send than base64, which matters on a slow phone connection.
  router.post('/uploads/image', async (ctx) => {
    const account = requireAuth(ctx);
    const chunks = [];
    let size = 0;
    for await (const chunk of ctx.req) {
      size += chunk.length;
      if (size > 1_600_000) break; // saveImage says why
      chunks.push(chunk);
    }
    const bytes = size > 1_600_000 ? Buffer.alloc(1_600_000) : Buffer.concat(chunks);
    return status(201, await services.uploads.saveImage(account.id, bytes.toString('base64')));
  }, { auth: 'required', raw: true });

  // A video arrives as the file itself (not JSON), is converted in the background, and is asked about until it is ready.
  router.post('/uploads/video', async (ctx) => status(201, await services.videos.save(requireAuth(ctx).id, ctx.req)), { auth: 'required', raw: true });
  router.get('/uploads/video/:id', async (ctx) => services.videos.get(requireAuth(ctx).id, ctx.params.id));

  // -- Price requests (products sold by asking) -------------------------------

  router.post('/price-requests', async (ctx) => status(201, await services.priceRequests.request(requireAuth(ctx).id, ctx.body.productId, {
    quantity: ctx.body.quantity,
    note: ctx.body.note,
    variantId: ctx.body.variantId || null,
  })));

  router.get('/price-requests', async (ctx) => services.priceRequests.listMine(requireAuth(ctx).id, { locale: ctx.locale }));

  router.post('/price-requests/:id/cancel', async (ctx) => services.priceRequests.cancel(requireAuth(ctx).id, ctx.params.id));

  // Buying a pack spends wallet balance; topping the wallet up is a card-to-card
  // request an admin reviews — together they are the "out of credits" path.
  router.post('/billing/packs', async (ctx) => {
    const account = requireAuth(ctx);
    return services.subscriptions.buyPack(account.id, ctx.body.packId, { actorAccountId: account.id });
  });

  router.get('/billing/topups', async (ctx) => {
    const { limit, offset } = pageParams(ctx.query);
    return services.topups.listMine(requireAuth(ctx).id, { limit, offset });
  });

  router.post('/billing/topups', async (ctx) => status(201, await services.topups.request(requireAuth(ctx).id, {
    amountMinor: ctx.body.amountMinor,
    reference: ctx.body.reference,
    imageUrl: ctx.body.imageUrl,
    telegramFileId: ctx.body.telegramFileId,
    note: ctx.body.note,
    cardId: ctx.body.cardId,
    planId: ctx.body.planId || null,
  })));

  router.post('/billing/plan', async (ctx) => {
    const account = requireAuth(ctx);
    return services.subscriptions.changePlan(account.id, ctx.body.planId, { actorAccountId: account.id });
  });

  router.get('/billing/transactions', async (ctx) => {
    const { limit, offset } = pageParams(ctx.query);
    return services.wallet.listTransactions(requireAuth(ctx).id, { limit, offset });
  });

  root.use('/me', router);
}
