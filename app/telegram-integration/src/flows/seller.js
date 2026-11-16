import { button, grid, keyboard, pager, urlButton } from '../telegram/keyboard.js';
import { b, esc, hashtag, i, lines, orderText, statusEmoji, truncate } from '../render.js';
import { startOnboarding, resumeOnboarding } from './onboarding.js';
import { toLatinDigits } from '../../../qbazz-core/src/util/digits.js';
import { toMinor } from '../../../qbazz-core/src/util/money.js';

/**
 * The store owner dashboard, in chat.
 *
 * Deliberately a subset of the web dashboard: the things a seller needs while
 * away from a desk — new orders, moving them along, adding a product, checking
 * today's numbers. Anything heavier links out to the web app.
 */

export async function sellerEntry(ctx) {
  const { tx, t } = ctx;
  const stores = await ctx.core.myStores(ctx.account.id);

  if (!stores.length) {
    const existing = await ctx.core.onboardingState(ctx.account.id, 'seller');
    if (existing?.status === 'in_progress') {
      return ctx.screen(
        lines(b(t('b.sel.resume_title')), '', t('b.sel.resume_step', { current: existing.progress.current, total: existing.progress.total })),
        keyboard([
          [button(t('b.btn.continue_setup'), 'onbresume')],
          [button(t('b.btn.start_over'), 'onbrestart')],
          [button(t('b.nav.home'), 'home')],
        ]),
      );
    }
    return ctx.screen(
      lines(
        b(t('b.sel.intro_title')),
        '',
        esc(t('b.sel.intro_lead')),
        '',
        esc(t('b.sel.intro_1')),
        esc(t('b.sel.intro_2')),
        esc(t('b.sel.intro_3')),
        '',
        i(t('b.sel.intro_foot')),
      ),
      keyboard([[button(t('b.btn.open_shop'), 'onbstart')], [button(t('b.nav.home'), 'home')]]),
    );
  }

  if (stores.length === 1) return showDashboard(ctx, stores[0].id);

  return ctx.screen(
    lines(b(t('b.sel.your_shops')), '', ...stores.map((store, index) => `${tx.idx(index + 1)} ${b(store.name)} — ${esc(tx.storeStatus(store.status))}`)),
    keyboard([...grid(stores.map((store) => button(truncate(store.name, 22), 'sd', store.id)), 1), [button(t('b.btn.new_shop'), 'onbstart')], [button(t('b.nav.home'), 'home')]]),
  );
}

export async function showDashboard(ctx, storeId) {
  const { tx, t } = ctx;
  // Remembered so order callbacks stay inside the 64-byte budget.
  await ctx.setState({ sellerStoreId: storeId });

  const stores = await ctx.core.myStores(ctx.account.id);
  const store = stores.find((s) => s.id === storeId) || stores[0];
  if (!store) return sellerEntry(ctx);

  const [analytics, queue] = await Promise.all([
    ctx.core.storeAnalytics(ctx.account.id, store.id, 7).catch(() => null),
    ctx.core.storeOrders(ctx.account.id, store.id, { status: 'pending,confirmed,preparing,ready', limit: 5 }).catch(() => ({ items: [], total: 0 })),
  ]);

  const overview = analytics?.overview;
  const statusLine = t(`b.sel.status.${store.status}`);

  const text = lines(
    `🏪 ${b(store.name)}`,
    statusLine,
    '',
    overview ? b(t('b.sel.last7')) : null,
    overview ? t('b.sel.revenue_line', { amount: tx.money(overview.revenue.amount, overview.currency), trend: trend(tx, overview.revenue.changePercent) }) : null,
    overview ? t('b.sel.orders_line', { count: overview.orders.count, trend: trend(tx, overview.orders.changePercent) }) : null,
    overview ? t('b.sel.views_line', { views: overview.views }) : null,
    overview?.rating ? t('b.sel.rating_line', { rating: overview.rating }) : null,
    '',
    queue.total ? b(t('b.sel.attention', { count: queue.total })) : i(t('b.sel.no_open')),
    ...queue.items.slice(0, 3).map((order) => `${statusEmoji(order.status)} ${tx.ltr(order.code)} · ${tx.money(order.totals.total, order.totals.currency)} · ${esc(order.contact.name)}`),
  );

  const rows = [
    [button(queue.total ? t('b.btn.orders_n', { count: queue.total }) : t('b.btn.orders_plain'), 'so', store.id, '0'), button(t('b.btn.products'), 'sp', store.id, '0')],
    [button(t('b.btn.add_product'), 'padd', store.id), button(t('b.btn.stats'), 'san', store.id)],
    [button(store.channels?.telegram ? `📣 ${store.channels.telegram.title.slice(0, 18)}` : t('b.btn.connect_channel'), 'ch', store.id)],
    [button(t('b.btn.currency', { code: store.currency }), 'scur', store.id), button(t('b.btn.shipping'), 'ssh', store.id)],
    [button(t('b.btn.cards'), 'scd', store.id), button(t('b.btn.wallet_plan'), 'bill', store.id)],
    [button(t('b.btn.new_shop'), 'onbstart')],
  ];
  if (store.status === 'draft' || store.status === 'rejected') rows.push([button(t('b.btn.submit_review'), 'ssub', store.id)]);
  rows.push([urlButton(t('b.btn.full_dashboard'), `${ctx.config.webAppUrl}/dashboard/${store.slug}`)]);
  rows.push([button(t('b.nav.home'), 'home')]);

  return ctx.screen(text, keyboard(rows));
}

export async function showSellerOrders(ctx, storeId, offset = 0) {
  const { tx, t } = ctx;
  await ctx.setState({ sellerStoreId: storeId });
  const limit = ctx.config.pageSize;
  const result = await ctx.core.storeOrders(ctx.account.id, storeId, { limit, offset });

  if (!result.items.length) {
    return ctx.screen(
      lines(b(t('b.sel.orders_empty_title')), '', i(t('b.sel.orders_empty_hint'))),
      keyboard([[button(t('b.nav.dashboard'), 'sd', storeId)]]),
    );
  }

  const text = lines(
    b(t('b.sel.orders_title')),
    '',
    ...result.items.map((order) => `${statusEmoji(order.status)} ${b(tx.ltr(order.code))} · ${tx.money(order.totals.total, order.totals.currency)}\n   ${esc(order.contact.name)} · ${esc(tx.orderStatus(order.status))}`),
  );

  const rows = [
    ...grid(result.items.map((order) => button(`${statusEmoji(order.status)} ${order.code}`, 'sso', order.id)), 2),
    pager(tx, 'so', { offset, limit, total: result.total }, storeId),
    [button(t('b.nav.dashboard'), 'sd', storeId)],
  ];

  return ctx.screen(text, keyboard(rows));
}

/**
 * The statuses an order can move to from each state. The buttons are worded per
 * language (b.act.<status>); which ones appear is this table, which mirrors the
 * core's transition rules — the core still refuses anything it does not allow.
 */
const NEXT_ACTIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'shipped'],
  preparing: ['ready', 'shipped'],
  ready: ['shipped', 'delivered'],
  shipped: ['delivered'],
};

export async function showSellerOrder(ctx, orderId) {
  const { tx, t } = ctx;
  const order = await ctx.core.getOrder(ctx.account.id, orderId);
  // A notification button can land here without a dashboard visit first.
  const storeId = ctx.state.sellerStoreId || order.storeId;
  if (ctx.state.sellerStoreId !== storeId) await ctx.setState({ sellerStoreId: storeId });

  const rows = [];
  // Card-to-card: the buyer sent a receipt and is waiting on a yes or no.
  const receipt = order.paymentReceipt;
  const awaitingReview = order.paymentMethod === 'bank_transfer' && order.paymentStatus === 'pending' && receipt;
  if (awaitingReview) rows.push([button(t('b.pay.approve'), 'spay', order.id, 'approve'), button(t('b.pay.decline'), 'spay', order.id, 'decline')]);
  const actions = NEXT_ACTIONS[order.status] || [];
  if (actions.length) rows.push(actions.map((status) => button(t(`b.act.${status}`), 'sst', order.id, status)));
  if (order.contact?.phone) rows.push([urlButton(t('b.btn.call_buyer'), `tel:${order.contact.phone}`)]);
  rows.push([button(t('b.btn.all_orders_back'), 'so', storeId || order.storeId, '0'), button(t('b.btn.dashboard'), 'sd', storeId || order.storeId)]);

  const receiptLines = order.paymentMethod === 'bank_transfer' && receipt
    ? [
      '',
      b(t('b.pay.receipt_title')),
      receipt.card ? t('b.pay.paid_to', { last4: tx.ltr(receipt.card.last4) }) : null,
      receipt.reference ? t('b.pay.receipt_ref', { ref: tx.ltr(receipt.reference) }) : null,
      receipt.note ? `📝 ${esc(receipt.note)}` : null,
      // Never print `imageUrl` here: a Telegram file URL carries the bot token.
      receipt.imageUrl || receipt.telegramFileId ? `🖼 ${t('b.pay.receipt_photo')}` : null,
      receipt.decision === 'declined' ? `❌ ${t('b.pay.declined_line')}${receipt.reason ? `: ${esc(receipt.reason)}` : ''}` : null,
    ]
    : order.paymentMethod === 'bank_transfer' && order.paymentStatus === 'unpaid'
      ? ['', i(t('b.pay.waiting_receipt'))]
      : [];

  const text = lines(orderText(tx, order, { forSeller: true }), ...receiptLines);
  // The receipt photo is the evidence the decision rests on, so it travels with the buttons.
  if (awaitingReview && receipt.telegramFileId) {
    try {
      return await ctx.photoScreen(receipt.telegramFileId, text, keyboard(rows));
    } catch {
      // fall through to the plain text screen
    }
  }
  return ctx.screen(text, keyboard(rows));
}

/** Approve straight away; decline asks for an optional reason the buyer will see. */
export async function reviewPayment(ctx, orderId, decision) {
  const { t } = ctx;
  const order = await ctx.core.getOrder(ctx.account.id, orderId);
  const storeId = ctx.state.sellerStoreId || order.storeId;

  if (decision === 'decline') {
    await ctx.answer();
    await ctx.setState({ awaiting: 'payreason', payReasonOrderId: orderId });
    return ctx.reply(
      lines(b(t('b.pay.decline_title')), '', esc(t('b.pay.decline_prompt'))),
      keyboard([[button(t('b.pay.decline_now'), 'spayno', orderId)], [button(t('b.nav.cancel'), 'sso', orderId)]]),
    );
  }

  try {
    await ctx.core.reviewPayment(ctx.account.id, storeId, orderId, 'approve');
    await ctx.answer(t('b.pay.approved_toast'));
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
  }
  return showSellerOrder(ctx, orderId);
}

export async function declinePayment(ctx, orderId, reason = '') {
  const order = await ctx.core.getOrder(ctx.account.id, orderId);
  const storeId = ctx.state.sellerStoreId || order.storeId;
  try {
    await ctx.core.reviewPayment(ctx.account.id, storeId, orderId, 'decline', reason);
    await ctx.clearState(['awaiting', 'payReasonOrderId']);
    await ctx.answer(ctx.t('b.pay.declined_toast'));
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
  }
  return showSellerOrder(ctx, orderId);
}

export async function handlePaymentReasonInput(ctx) {
  const orderId = ctx.state.payReasonOrderId;
  if (ctx.state.awaiting !== 'payreason' || !orderId) return false;
  await declinePayment(ctx, orderId, (ctx.text || '').trim());
  return true;
}

export async function setOrderStatus(ctx, orderId, status) {
  const storeId = ctx.state.sellerStoreId || (await ctx.core.getOrder(ctx.account.id, orderId)).storeId;
  try {
    await ctx.core.setOrderStatus(ctx.account.id, storeId, orderId, status);
    await ctx.answer(ctx.t('b.sel.marked', { status: ctx.tx.orderStatus(status) }));
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
  }
  return showSellerOrder(ctx, orderId);
}

export async function showSellerProducts(ctx, storeId, offset = 0) {
  const { tx, t } = ctx;
  await ctx.setState({ sellerStoreId: storeId });
  const limit = ctx.config.pageSize;
  const result = await ctx.core.storeProducts(ctx.account.id, storeId, { limit, offset });

  const text = lines(
    b(t('b.sel.products_title')),
    '',
    result.items.length
      ? result.items
        .map((product, index) => {
          const stock = product.stock !== null && product.stock !== undefined ? ` · ${t('b.sel.product_stock', { count: product.stock })}` : '';
          return `${tx.idx(offset + index + 1)} ${b(product.title)} — ${tx.money(product.price, product.currency)}\n   ${esc(tx.productStatus(product.status))}${stock}`;
        })
        .join('\n')
      : i(t('b.sel.products_empty')),
  );

  // Each product is its own row — tapping it opens the management screen
  // where stock/availability actually gets toggled, not just viewed.
  const rows = [
    ...result.items.map((product, index) => [button(`${tx.idx(offset + index + 1)} ${truncate(product.title, 28)}`, 'spr', storeId, product.id)]),
    [button(t('b.btn.add_product'), 'padd', storeId), button(t('b.sel.discount_all'), 'spd', storeId, '*')],
    pager(tx, 'sp', { offset, limit, total: result.total }, storeId),
    [button(t('b.nav.dashboard'), 'sd', storeId)],
  ];

  return ctx.screen(text, keyboard(rows));
}

/** A seller's own management view of one product: status, stock, and the one
 * control this screen exists for — marking it in stock or out of stock,
 * independent of whatever the tracked stock count says. */
export async function showSellerProductDetail(ctx, storeId, productId) {
  const { tx, t } = ctx;
  await ctx.setState({ sellerStoreId: storeId });
  const product = await ctx.core.getStoreProduct(ctx.account.id, storeId, productId).catch(() => null);
  if (!product) {
    await ctx.answer(t('b.sel.product_gone'));
    return showSellerProducts(ctx, storeId);
  }

  const outOfStock = product.status === 'out_of_stock';
  const archived = product.status === 'archived';
  const discounted = product.price != null && product.compareAtPrice > product.price;
  const percent = discounted ? Math.round(((product.compareAtPrice - product.price) / product.compareAtPrice) * 100) : 0;
  const priceLine = product.price == null
    ? i(t('b.render.inquire_price'))
    : discounted
      ? `${tx.money(product.price, product.currency)}  <s>${tx.money(product.compareAtPrice, product.currency)}</s>  ${t('b.sel.discount_badge', { percent: tx.n(percent) })}`
      : tx.money(product.price, product.currency);
  const text = lines(
    b(product.title),
    priceLine,
    `${esc(tx.productStatus(product.status))} · ${product.stock != null ? t('b.sel.product_stock', { count: product.stock }) : t('b.sel.stock_unlimited')}`,
  );

  const rows = [];
  if (!archived) {
    rows.push([button(outOfStock ? `✅ ${t('b.sel.mark_in_stock')}` : `🚫 ${t('b.sel.mark_out_of_stock')}`, 'sptog', storeId, productId)]);
    rows.push([button(t('b.sel.edit_price'), 'spp', storeId, productId), button(t('b.sel.edit_stock'), 'sps', storeId, productId)]);
    rows.push([button(discounted ? t('b.sel.change_discount') : t('b.sel.add_discount'), 'spd', storeId, productId)]);
  }
  rows.push([button(archived ? t('b.sel.restore') : t('b.sel.archive'), 'spa', storeId, productId), button(t('b.sel.delete'), 'spx', storeId, productId)]);
  rows.push([button(t('b.btn.view_product'), 'prod', productId)]);
  rows.push([button(t('b.nav.back'), 'sp', storeId, '0')]);

  return ctx.screen(text, keyboard(rows));
}

/** Flips active ⇄ out_of_stock. Deliberately independent of the tracked
 * stock number — a seller pausing sales does not need to zero it out first. */
export async function toggleSellerProductStock(ctx, storeId, productId) {
  const { t } = ctx;
  const product = await ctx.core.getStoreProduct(ctx.account.id, storeId, productId).catch(() => null);
  if (!product) {
    await ctx.answer(t('b.sel.product_gone'));
    return showSellerProducts(ctx, storeId);
  }

  const nextStatus = product.status === 'out_of_stock' ? 'active' : 'out_of_stock';
  try {
    await ctx.core.updateProduct(ctx.account.id, storeId, productId, { status: nextStatus });
    await ctx.answer(nextStatus === 'active' ? t('b.sel.marked_in_stock_toast') : t('b.sel.marked_out_of_stock_toast'));
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
  }
  return showSellerProductDetail(ctx, storeId, productId);
}

// -- Card-to-card cards: a shop can hold several ------------------------------------------

export async function showStoreCards(ctx, storeId) {
  const { t, tx } = ctx;
  await ctx.answer();
  const { items } = await ctx.core.storeCards(ctx.account.id, storeId);
  const text = lines(
    b(t('b.sc.title')),
    '',
    items.length
      ? items.map((card) => `${card.active === false ? '⏸' : '✅'} ${tx.ltr(card.display)}\n   ${esc(card.holder)}${card.bank ? ` · ${esc(card.bank)}` : ''}`).join('\n')
      : i(t('b.sc.none')),
    '',
    i(t('b.sc.hint')),
  );
  const rows = [
    ...items.map((card) => [
      button(`${card.active === false ? '✅' : '⏸'} •••• ${card.last4}`, 'scdt', storeId, card.id),
      button(`🗑 •••• ${card.last4}`, 'scdr', storeId, card.id),
    ]),
    [button(t('b.sc.add'), 'scda', storeId)],
    [button(t('b.nav.dashboard'), 'sd', storeId)],
  ];
  return ctx.screen(text, keyboard(rows));
}

export async function promptStoreCard(ctx, storeId) {
  await ctx.answer();
  await ctx.setState({ awaiting: 'storecard', storeCardStoreId: storeId });
  return ctx.reply(
    lines(b(ctx.t('b.sc.add_title')), '', esc(ctx.t('b.sc.add_prompt'))),
    keyboard([[button(ctx.t('b.nav.cancel'), 'scd', storeId)]]),
  );
}

/** "6037 9911 2222 3333 Ali Rezaei" — the number, then whoever holds the card. */
export async function handleStoreCardInput(ctx) {
  const storeId = ctx.state.storeCardStoreId;
  if (ctx.state.awaiting !== 'storecard' || !storeId) return false;
  const match = toLatinDigits(ctx.text || '').match(/^(\d[\d\s-]*?)\s*([^\d\s-].*)$/);
  if (!match) {
    await ctx.reply(ctx.t('b.sc.bad_input'));
    return true;
  }
  try {
    await ctx.core.addStoreCard(ctx.account.id, storeId, { number: match[1], holder: match[2].trim() });
    await ctx.clearState(['awaiting', 'storeCardStoreId']);
  } catch (err) {
    await ctx.reply(`⚠️ ${esc(ctx.err(err))}`);
    return true;
  }
  await showStoreCards(ctx, storeId);
  return true;
}

export async function toggleStoreCard(ctx, storeId, cardId) {
  try {
    const { items } = await ctx.core.storeCards(ctx.account.id, storeId);
    const card = items.find((c) => c.id === cardId);
    await ctx.core.updateStoreCard(ctx.account.id, storeId, cardId, { active: card?.active === false });
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
  }
  return showStoreCards(ctx, storeId);
}

export async function removeStoreCard(ctx, storeId, cardId) {
  try {
    await ctx.core.removeStoreCard(ctx.account.id, storeId, cardId);
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
  }
  return showStoreCards(ctx, storeId);
}

// -- Price, stock, discount and archive: the edits a seller makes most ------------------

async function ownProduct(ctx, storeId, productId) {
  const product = await ctx.core.getStoreProduct(ctx.account.id, storeId, productId).catch(() => null);
  if (!product) {
    await ctx.answer(ctx.t('b.sel.product_gone'));
    await showSellerProducts(ctx, storeId);
  }
  return product;
}

export async function promptProductPrice(ctx, storeId, productId) {
  const { t, tx } = ctx;
  const product = await ownProduct(ctx, storeId, productId);
  if (!product) return null;
  await ctx.answer();
  await ctx.setState({ awaiting: 'prodprice', prodEditStoreId: storeId, prodEditId: productId });
  return ctx.reply(
    lines(
      b(t('b.sel.price_title')),
      product.price != null ? t('b.sel.price_current', { amount: tx.money(product.price, product.currency) }) : null,
      '',
      esc(t('b.sel.price_prompt')),
    ),
    keyboard([[button(t('b.nav.cancel'), 'spr', storeId, productId)]]),
  );
}

export async function promptProductStock(ctx, storeId, productId) {
  const { t } = ctx;
  const product = await ownProduct(ctx, storeId, productId);
  if (!product) return null;
  await ctx.answer();
  await ctx.setState({ awaiting: 'prodstock', prodEditStoreId: storeId, prodEditId: productId });
  return ctx.reply(
    lines(
      b(t('b.sel.stock_title')),
      product.stock != null ? t('b.sel.stock_current', { count: product.stock }) : t('b.sel.stock_unlimited'),
      '',
      esc(t('b.sel.stock_prompt')),
    ),
    keyboard([[button(t('b.sel.stock_unlimited_btn'), 'spsu', storeId, productId)], [button(t('b.nav.cancel'), 'spr', storeId, productId)]]),
  );
}

/** Handles the number a seller sends after tapping "edit price" or "edit stock". */
export async function handleProductEditNumberInput(ctx) {
  const { awaiting, prodEditStoreId: storeId, prodEditId: productId } = ctx.state;
  if (!['prodprice', 'prodstock'].includes(awaiting) || !storeId || !productId) return false;

  const raw = toLatinDigits(ctx.text || '').replace(/[,٬،\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(raw) || (awaiting === 'prodstock' && !/^\d+$/.test(raw))) {
    await ctx.reply(ctx.t(awaiting === 'prodprice' ? 'b.sel.price_bad' : 'b.sel.stock_bad'));
    return true;
  }

  try {
    if (awaiting === 'prodprice') {
      const product = await ctx.core.getStoreProduct(ctx.account.id, storeId, productId);
      // Typing a new price replaces any offer: the number sent is what it costs.
      await ctx.core.updateProduct(ctx.account.id, storeId, productId, { price: toMinor(Number(raw), product.currency || ctx.config.defaultCurrency), compareAtPrice: 0 });
    } else {
      await ctx.core.updateProduct(ctx.account.id, storeId, productId, { stock: Number(raw) });
    }
    await ctx.clearState(['awaiting', 'prodEditStoreId', 'prodEditId']);
  } catch (err) {
    await ctx.reply(`⚠️ ${esc(ctx.err(err))}`);
    return true;
  }
  await showSellerProductDetail(ctx, storeId, productId);
  return true;
}

export async function setProductStockUnlimited(ctx, storeId, productId) {
  try {
    await ctx.core.updateProduct(ctx.account.id, storeId, productId, { stock: null });
    await ctx.clearState(['awaiting', 'prodEditStoreId', 'prodEditId']);
    await ctx.answer(ctx.t('b.sel.saved'));
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
  }
  return showSellerProductDetail(ctx, storeId, productId);
}

const DISCOUNT_PRESETS = [10, 15, 20, 30, 40, 50];

export async function showDiscountPicker(ctx, storeId, productId) {
  const { t, tx } = ctx;
  await ctx.answer();
  const whole = productId === '*';
  const product = whole ? null : await ownProduct(ctx, storeId, productId);
  if (!whole && !product) return null;
  const active = !whole && product.compareAtPrice > product.price;

  const rows = [
    ...grid(DISCOUNT_PRESETS.map((p) => button(`${tx.n(p)}${tx.rtl ? '٪' : '%'}`, 'spdp', storeId, productId, String(p))), 3),
  ];
  if (active || whole) rows.push([button(t('b.sel.discount_remove'), 'spdp', storeId, productId, '0')]);
  rows.push([button(t('b.nav.back'), whole ? 'sp' : 'spr', storeId, whole ? '0' : productId)]);

  return ctx.screen(
    lines(b(whole ? t('b.sel.discount_all_title') : t('b.sel.discount_title', { name: product.title })), '', esc(t('b.sel.discount_hint'))),
    keyboard(rows),
  );
}

export async function setDiscount(ctx, storeId, productId, percent) {
  const { t } = ctx;
  const value = Number(percent) || 0;
  try {
    if (productId === '*') {
      const { updated } = await ctx.core.discountStore(ctx.account.id, storeId, value);
      await ctx.answer(value > 0 ? t('b.sel.discount_applied_all', { count: updated }) : t('b.sel.discount_removed_all', { count: updated }));
      return showSellerProducts(ctx, storeId);
    }
    await ctx.core.discountProduct(ctx.account.id, storeId, productId, value);
    await ctx.answer(value > 0 ? t('b.sel.discount_applied') : t('b.sel.discount_removed'));
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
  }
  return showSellerProductDetail(ctx, storeId, productId);
}

/** "Delete" asks once: the product, its photos and its channel post go, and there is no undo. */
export async function confirmProductDelete(ctx, storeId, productId) {
  const { t } = ctx;
  const product = await ownProduct(ctx, storeId, productId);
  if (!product) return null;
  await ctx.answer();
  return ctx.screen(
    lines(b(t('b.sel.delete_title')), esc(product.title), '', esc(t('b.sel.delete_warn'))),
    keyboard([
      [button(t('b.sel.delete_yes'), 'spxy', storeId, productId)],
      [button(t('b.nav.cancel'), 'spr', storeId, productId)],
    ]),
  );
}

export async function deleteProduct(ctx, storeId, productId) {
  const product = await ownProduct(ctx, storeId, productId);
  if (!product) return null;
  try {
    const result = await ctx.core.deleteProduct(ctx.account.id, storeId, productId);
    // a product somebody ordered is archived instead: say so, so the seller is not surprised to still see it
    await ctx.answer(result?.deleted === false || result?.status === 'archived' ? ctx.t('b.sel.delete_archived_toast') : ctx.t('b.sel.delete_toast'), { alert: result?.status === 'archived' });
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
    return showSellerProductDetail(ctx, storeId, productId);
  }
  return showSellerProducts(ctx, storeId);
}

export async function toggleProductArchive(ctx, storeId, productId) {
  const product = await ownProduct(ctx, storeId, productId);
  if (!product) return null;
  const archiving = product.status !== 'archived';
  try {
    await ctx.core.updateProduct(ctx.account.id, storeId, productId, { status: archiving ? 'archived' : 'active' });
    await ctx.answer(archiving ? ctx.t('b.sel.archived_toast') : ctx.t('b.sel.restored_toast'));
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
  }
  return archiving ? showSellerProducts(ctx, storeId) : showSellerProductDetail(ctx, storeId, productId);
}

export async function showSellerAnalytics(ctx, storeId) {
  const { tx, t } = ctx;
  const { overview, topProducts } = await ctx.core.storeAnalytics(ctx.account.id, storeId, 30);

  const text = lines(
    b(t('b.sel.stats_title')),
    '',
    t('b.sel.stat_revenue', { amount: tx.money(overview.revenue.amount, overview.currency), trend: trend(tx, overview.revenue.changePercent) }),
    t('b.sel.stat_orders', { count: overview.orders.count, trend: trend(tx, overview.orders.changePercent) }),
    t('b.sel.stat_average', { amount: tx.money(overview.averageOrder.amount, overview.currency) }),
    t('b.sel.stat_views', { views: overview.views, percent: overview.conversionPercent }),
    t('b.sel.stat_customers', { count: overview.customers }),
    overview.rating ? t('b.sel.stat_rating', { rating: overview.rating }) : null,
    '',
    topProducts.length ? b(t('b.sel.best_sellers')) : null,
    ...topProducts.map((product, index) => `${tx.idx(index + 1)} ${t('b.sel.best_line', {
      name: esc(product.title),
      sold: product.unitsSold,
      revenue: tx.money(product.revenueMinor, product.currency),
    })}`),
  );

  return ctx.screen(text, keyboard([[button(t('b.nav.dashboard'), 'sd', storeId)]]));
}

export async function submitStore(ctx, storeId) {
  const { t } = ctx;
  try {
    const store = await ctx.core.submitStore(ctx.account.id, storeId);
    await ctx.answer(t('b.sel.submitted_toast'));
    return ctx.screen(
      lines(b(t('b.sel.submitted', { store: store.name })), '', esc(t('b.sel.submitted_hint'))),
      keyboard([[button(t('b.nav.dashboard'), 'sd', storeId)]]),
    );
  } catch (err) {
    await ctx.answer(t('b.sel.not_ready_toast'), { alert: false });
    return ctx.reply(
      lines(b(t('b.sel.almost')), '', esc(ctx.err(err)), '', i(t('b.sel.fix_submit'))),
      keyboard([[button(t('b.nav.dashboard'), 'sd', storeId)]]),
    );
  }
}

// -- Quick add product ---------------------------------------------------
//
// One message — a photo with everything in the caption, or just text — is
// read by AI into a title, price, stock and specs. The seller sees exactly
// that before anything is created: fix it by sending a better message, have
// AI write a proper listing from it, then choose where it goes. No category
// is asked here (an uncategorised product is the same trade-off the channel
// auto-sync already makes); no step-by-step questions.

export async function startAddProduct(ctx, storeId) {
  const { t } = ctx;
  await ctx.setState({ awaiting: 'quickadd', quickAddStoreId: storeId, quickDraft: null });
  await ctx.answer();
  return ctx.reply(
    lines(b(t('b.np.title')), '', esc(t('b.np.one_shot_prompt')), '', i(t('b.np.one_shot_hint'))),
    keyboard([[button(t('b.nav.cancel'), 'sd', storeId)]]),
  );
}

export async function handleNewProductInput(ctx) {
  if (ctx.state.awaiting === 'quickadd') return captureQuickAdd(ctx, ctx.state.quickAddStoreId);
  return false;
}

/** Reads the one message that creates the draft. */
async function captureQuickAdd(ctx, storeId) {
  const { t } = ctx;
  if (!storeId) return false;
  const text = (ctx.caption || ctx.text || '').trim();

  let image = null;
  let fileId = null;
  if (ctx.photo?.length) {
    fileId = ctx.photo[ctx.photo.length - 1].file_id;
    image = await ctx.api.fileUrl(fileId).catch(() => null);
    if (!image) fileId = null;
  }
  if (!text && !image) {
    await ctx.reply(t('b.np.need_something'));
    return true;
  }

  await ctx.typing();
  let extracted;
  try {
    ({ extracted } = await ctx.core.extractProductDraft(ctx.account.id, storeId, { text, photo: image }));
  } catch (err) {
    await ctx.reply(`⚠️ ${esc(ctx.err(err))}`);
    return true;
  }
  if (!extracted?.title) {
    await ctx.reply(t('b.np.not_recognized'));
    return true;
  }

  const stores = await ctx.core.myStores(ctx.account.id);
  const store = stores.find((entry) => entry.id === storeId);

  // Write it up properly before the seller ever sees it — a raw extraction
  // ("لباس جدید آرموا، رنگ بندی سفید مشکی و آبی") is not a listing, it is
  // notes. "Add detail" below is for filling in what AI could not have known,
  // not for redoing this step.
  const polished = await polishExtraction(ctx, storeId, extracted);

  await ctx.setState({
    awaiting: null,
    quickDraft: {
      storeId,
      currency: store?.currency || ctx.config.defaultCurrency,
      title: extracted.title,
      hook: polished.hook,
      description: polished.description,
      price: extracted.price ?? null,
      stock: extracted.stock ?? null,
      properties: polished.properties,
      tags: polished.tags,
      image,
      fileId,
      telegramOn: Boolean(store?.channels?.telegram),
    },
  });
  return showQuickAddReview(ctx);
}

/**
 * Runs the same listing-generation AI a channel draft uses over a freshly
 * extracted (but not yet created) product, so what the seller reviews is
 * already store-ready copy rather than a raw reading of their message. Falls
 * back to the extraction's own fields — never blocks on this, same as
 * everywhere else AI writes a caption.
 */
async function polishExtraction(ctx, storeId, extracted, notes = null) {
  try {
    const { generated } = await ctx.core.generateProductJournal(ctx.account.id, storeId, {
      title: extracted.title,
      description: extracted.description,
      price: extracted.price,
      stock: extracted.stock,
      properties: extracted.properties,
      tags: extracted.tags,
      notes,
    });
    return {
      hook: generated.hook || '',
      description: generated.caption || extracted.description || '',
      properties: generated.properties?.length ? generated.properties : (extracted.properties || []),
      tags: generated.tags?.length ? generated.tags : (extracted.tags || []),
    };
  } catch {
    return { hook: '', description: extracted.description || '', properties: extracted.properties || [], tags: extracted.tags || [] };
  }
}

/** What AI read out of the message, shown exactly as it will be published. */
async function showQuickAddReview(ctx) {
  const { tx, t } = ctx;
  const draft = ctx.state.quickDraft;
  if (!draft) return null;

  const tags = (draft.tags || []).slice(0, 8).map(hashtag).filter(Boolean).join(' ');

  const text = lines(
    b(t('b.np.review_title')),
    '',
    draft.hook ? `🔥 ${esc(draft.hook)}` : null,
    b(draft.title),
    draft.price != null ? tx.money(draft.price, draft.currency) : i(t('b.render.inquire_price')),
    draft.stock != null ? t('b.render.in_stock', { stock: draft.stock }) : null,
    draft.description ? esc(truncate(draft.description, 600)) : i(t('b.np.no_description')),
    draft.properties.length ? `\n${draft.properties.map((p) => `• ${esc(p.name)}: ${esc(p.value)}`).join('\n')}` : null,
    tags ? `\n${esc(tags)}` : null,
  );

  const rows = [
    [button(t('b.btn.add_detail'), 'npfix'), button(t('b.btn.generate_images'), 'npjournal')],
    [button(t('b.btn.continue'), 'npnext')],
    [button(t('b.nav.cancel'), 'sd', draft.storeId)],
  ];

  // Generated mockups are what "Use this photo" actually picked — show them
  // as their own messages, not just a count, so the seller sees what will
  // publish before tapping Continue.
  for (const url of draft.extraImages || []) {
    try {
      await ctx.photoScreen(url, i(t('b.mockup.generated_photo')), keyboard([]));
    } catch {
      // A stale/expired mockup URL just gets skipped; the review still works.
    }
  }

  if (draft.image) {
    try {
      return await ctx.photoScreen(draft.image, text, keyboard(rows));
    } catch {
      // Falls through to text when the image URL is unreachable.
    }
  }
  return ctx.screen(text, keyboard(rows));
}

/**
 * "➕ Add detail": the draft is already AI-written from the one-shot message
 * (see `polishExtraction`, run automatically when the draft was created) —
 * this is for filling in what that message did not mention (material, sizes,
 * a specific measurement), not for redoing the whole thing. Whatever the
 * seller sends here is folded in alongside what is already there; the title,
 * price and photo are untouched.
 */
export async function requestQuickAddFix(ctx) {
  const { t } = ctx;
  await ctx.answer();
  await ctx.setState({ awaiting: 'quickadddetail' });
  return ctx.reply(
    lines(b(t('b.np.detail_title')), '', esc(t('b.np.detail_prompt'))),
    keyboard([[button(t('b.nav.cancel'), 'npreview')]]),
  );
}

export async function handleQuickAddDetailInput(ctx) {
  if (ctx.state.awaiting !== 'quickadddetail') return false;
  const draft = ctx.state.quickDraft;
  if (!draft) return false;
  const text = (ctx.text || '').trim();
  if (!text) {
    await ctx.reply(ctx.t('b.np.need_something'));
    return true;
  }

  await ctx.typing();
  const polished = await polishExtraction(ctx, draft.storeId, draft, text);
  await ctx.setState({
    awaiting: null,
    quickDraft: { ...draft, hook: polished.hook, description: polished.description, properties: polished.properties, tags: polished.tags },
  });
  await showQuickAddReview(ctx);
  return true;
}

/** Cancels out of a prompt back to the review, unchanged. */
export async function cancelQuickAddFix(ctx) {
  await ctx.answer();
  await ctx.setState({ awaiting: null });
  return showQuickAddReview(ctx);
}

/**
 * "✨ Generate images": a batch of AI product-mockup photos generated from
 * the seller's own submitted photo, via fashn.ai — a person wearing it, not a
 * flat product shot. Nothing is added to the draft until the seller picks
 * one of the results; tapping again generates a fresh batch on top.
 */
/** The actual generate-and-show step for a not-yet-created draft — shared by the first attempt and a re-roll with a custom prompt. */
async function runDraftMockup(ctx, { prompt = null } = {}) {
  const { t } = ctx;
  const draft = ctx.state.quickDraft;
  if (!draft) return null;
  if (!draft.image) {
    await ctx.reply(t('b.mockup.needs_photo'));
    return showQuickAddReview(ctx);
  }
  await ctx.typing();

  let mockup;
  try {
    mockup = await ctx.core.generateMockupFromImage(ctx.account.id, draft.storeId, { image: draft.image, count: 4, prompt });
  } catch (err) {
    await ctx.reply(`⚠️ ${esc(ctx.err(err))}`);
    return showQuickAddReview(ctx);
  }
  if (mockup.status !== 'completed' || !mockup.results?.length) {
    await ctx.reply(lines(`⚠️ ${esc(t('b.mockup.failed'))}`, mockup.error ? i(esc(mockup.error)) : null));
    return showQuickAddReview(ctx);
  }

  await ctx.setState({ pendingDraftMockup: { results: mockup.results } });
  return showMockupOptions(ctx, mockup.results, { useAction: 'npmkuse', promptAction: 'npmkprompt', backAction: [button(t('b.nav.back'), 'npreview')] });
}

export async function requestQuickAddJournal(ctx) {
  await ctx.answer();
  return runDraftMockup(ctx);
}

/** Picks one generated option into the draft — folded into `images` at publish time. */
export async function useDraftMockup(ctx, resultIndex = 0) {
  const draft = ctx.state.quickDraft;
  const url = ctx.state.pendingDraftMockup?.results?.[resultIndex];
  if (!draft || !url) {
    await ctx.answer();
    return null;
  }
  const extra = draft.extraImages?.includes(url) ? draft.extraImages : [...(draft.extraImages || []), url];
  await ctx.setState({ quickDraft: { ...draft, extraImages: extra } });
  await ctx.answer(ctx.t('b.mockup.added_toast'));
  return null;
}

export async function requestDraftMockupPromptEdit(ctx) {
  const { t } = ctx;
  await ctx.answer();
  await ctx.setState({ awaiting: 'draftmockupprompt' });
  return ctx.reply(
    lines(b(t('b.mockup.prompt_title')), '', esc(t('b.mockup.prompt_hint'))),
    keyboard([[button(t('b.nav.cancel'), 'npjournal')]]),
  );
}

export async function handleDraftMockupPromptInput(ctx) {
  if (ctx.state.awaiting !== 'draftmockupprompt') return false;
  const text = (ctx.text || '').trim();
  if (!text) {
    await ctx.reply(ctx.t('b.np.need_something'));
    return true;
  }
  await ctx.clearState(['awaiting']);
  await runDraftMockup(ctx, { prompt: text });
  return true;
}

/** Where it goes: the channel toggle (only shown if one is connected), a
 * website line that is always on (a live product just is visible there),
 * and Instagram, always shown, never on — coming later. */
export async function showQuickAddPublish(ctx) {
  const { t } = ctx;
  const draft = ctx.state.quickDraft;
  if (!draft) return null;
  await ctx.answer();

  const stores = await ctx.core.myStores(ctx.account.id);
  const store = stores.find((entry) => entry.id === draft.storeId);
  const hasChannel = Boolean(store?.channels?.telegram);

  // ✅/❌ rather than the old ☑️/▫️ pair: on Telegram's own dark-theme emoji
  // rendering, a checked box and an empty box can look nearly identical at a
  // glance — green-vs-red is unambiguous at any size. 🔒 marks Instagram as
  // not-yet-available rather than off, so it doesn't read as a third toggle.
  const rows = [
    [button(`✅ ${t('b.pub.website')}`, 'noop')],
    hasChannel
      ? [button(`${draft.telegramOn ? '✅' : '❌'} ${t('b.pub.telegram')}`, 'nptoggle')]
      : [button(t('b.pub.connect_first'), 'ch', draft.storeId)],
    [button(`🔒 ${t('b.pub.instagram')} · ${t('b.pub.soon')}`, 'noop')],
    [button(t('b.btn.publish'), 'nppublish')],
    [button(t('b.nav.back'), 'npreview')],
  ];

  return ctx.screen(lines(b(t('b.pub.title')), '', esc(t('b.pub.hint'))), keyboard(rows));
}

export async function toggleQuickAddDestination(ctx) {
  const draft = ctx.state.quickDraft;
  if (!draft) return null;
  await ctx.setState({ quickDraft: { ...draft, telegramOn: !draft.telegramOn } });
  await ctx.answer();
  return showQuickAddPublish(ctx);
}

export async function publishQuickAdd(ctx) {
  const { tx, t } = ctx;
  const draft = ctx.state.quickDraft;
  if (!draft) return null;
  await ctx.answer();

  try {
    const product = await ctx.core.publishProduct(ctx.account.id, draft.storeId, {
      title: draft.title,
      description: draft.description || '',
      price: draft.price,
      priceVisibility: draft.price == null ? 'inquire' : 'public',
      stock: draft.stock,
      properties: draft.properties,
      tags: draft.tags,
      images: [draft.image, ...(draft.extraImages || [])].filter(Boolean),
      telegramFileIds: draft.fileId ? [draft.fileId] : [],
      status: 'active',
      telegram: draft.telegramOn,
    });
    await ctx.clearState(['awaiting', 'quickDraft', 'quickAddStoreId', 'pendingDraftMockup']);
    return ctx.reply(
      lines(t('b.np.published', { title: b(product.title), price: product.price != null ? tx.money(product.price, product.currency) : t('b.render.inquire_price') })),
      keyboard([
        product.images?.length ? [button(t('b.btn.generate_images'), 'mkgen', draft.storeId, product.id)] : null,
        [button(t('b.btn.add_another_short'), 'padd', draft.storeId)],
        [button(t('b.btn.all_products'), 'sp', draft.storeId, '0'), button(t('b.btn.dashboard'), 'sd', draft.storeId)],
      ]),
    );
  } catch (err) {
    await ctx.clearState(['awaiting', 'quickDraft']);
    return ctx.reply(
      lines(`⚠️ ${esc(ctx.err(err))}`),
      keyboard([[button(t('b.btn.try_again'), 'padd', draft.storeId)], [button(t('b.btn.dashboard'), 'sd', draft.storeId)]]),
    );
  }
}

// -- Product mockups ------------------------------------------------------
//
// Turns a product photo into a photo of it worn, via fashn.ai — a batch of up
// to 4 at once. A generation takes a few seconds, so the seller waits for it
// right there. Nothing is applied anywhere until the seller picks one.

/**
 * Sends each generated photo as its own message with "use this one" and
 * "edit prompt" side by side — editing the prompt applies to the whole batch
 * (it throws these results away and generates a fresh set), not just the one
 * message it happens to be tapped from.
 */
async function showMockupOptions(ctx, results, { useAction, promptAction, backAction }) {
  const { t } = ctx;
  await ctx.reply(t('b.mockup.result_title', { count: results.length }));
  for (let idx = 0; idx < results.length; idx++) {
    const isLast = idx === results.length - 1;
    const rows = [[button(t('b.btn.use_photo'), useAction, idx), button(t('b.btn.edit_prompt'), promptAction)]];
    if (isLast && backAction) rows.push(backAction);
    const caption = t('b.mockup.option', { n: idx + 1 });
    try {
      await ctx.photoScreen(results[idx], caption, keyboard(rows));
    } catch {
      await ctx.reply(lines(caption, esc(results[idx])), keyboard(rows));
    }
  }
  return null;
}

/** The actual generate-and-show step for an existing product — shared by the first attempt and a re-roll with a custom prompt. */
async function runProductMockup(ctx, storeId, productId, { prompt = null } = {}) {
  const { t } = ctx;
  await ctx.typing();

  let mockup;
  try {
    mockup = await ctx.core.generateMockup(ctx.account.id, storeId, productId, { count: 4, prompt });
  } catch (err) {
    return ctx.reply(`⚠️ ${esc(ctx.err(err))}`, keyboard([[button(t('b.nav.dashboard'), 'sd', storeId)]]));
  }

  if (mockup.status !== 'completed' || !mockup.results?.length) {
    return ctx.reply(
      lines(`⚠️ ${esc(t('b.mockup.failed'))}`, mockup.error ? i(esc(mockup.error)) : null),
      keyboard([[button(t('b.btn.try_again'), 'mkgen', storeId, productId)], [button(t('b.nav.dashboard'), 'sd', storeId)]]),
    );
  }

  // The three ids together (store, product, mockup) blow past Telegram's
  // 64-byte callback_data budget, so the mockup being reviewed lives in
  // session state instead — the same way a quick-add draft does.
  await ctx.setState({ pendingMockup: { storeId, productId, mockupId: mockup.id } });
  return showMockupOptions(ctx, mockup.results, { useAction: 'mkuse', promptAction: 'mkprompt', backAction: [button(t('b.nav.dashboard'), 'sd', storeId)] });
}

export async function requestMockup(ctx, storeId, productId) {
  await ctx.answer();
  return runProductMockup(ctx, storeId, productId);
}

export async function useMockup(ctx, resultIndex = 0) {
  const { t } = ctx;
  const pending = ctx.state.pendingMockup;
  await ctx.answer();
  if (!pending) return null;
  const { storeId, productId, mockupId } = pending;

  try {
    await ctx.core.attachMockup(ctx.account.id, storeId, productId, mockupId, resultIndex);
  } catch (err) {
    return ctx.reply(`⚠️ ${esc(ctx.err(err))}`, keyboard([[button(t('b.nav.dashboard'), 'sd', storeId)]]));
  }
  return ctx.reply(t('b.mockup.attached'), keyboard([[button(t('b.btn.view_product'), 'prod', productId)], [button(t('b.nav.dashboard'), 'sd', storeId)]]));
}

/**
 * "✏️ Edit prompt": there is no settings screen for this — the default prompt
 * per garment group lives in `qbazz-core/src/services/mockups.js`
 * (`GROUP_MOCKUP_PROMPTS`). This is the lever a seller actually has: describe
 * the pose, styling or background they want, and the next batch uses that
 * instead of the default.
 */
export async function requestMockupPromptEdit(ctx) {
  const { t } = ctx;
  const pending = ctx.state.pendingMockup;
  await ctx.answer();
  if (!pending) return null;
  await ctx.setState({ awaiting: 'mockupprompt' });
  return ctx.reply(
    lines(b(t('b.mockup.prompt_title')), '', esc(t('b.mockup.prompt_hint'))),
    keyboard([[button(t('b.nav.cancel'), 'mkgen', pending.storeId, pending.productId)]]),
  );
}

export async function handleMockupPromptInput(ctx) {
  if (ctx.state.awaiting !== 'mockupprompt') return false;
  const pending = ctx.state.pendingMockup;
  if (!pending) return false;
  const text = (ctx.text || '').trim();
  if (!text) {
    await ctx.reply(ctx.t('b.np.need_something'));
    return true;
  }
  await ctx.clearState(['awaiting']);
  await runProductMockup(ctx, pending.storeId, pending.productId, { prompt: text });
  return true;
}

// -- Improving an already-published product --------------------------------
//
// Reached from the "a channel post became a product" alert: the text is
// whatever the seller happened to type into their channel, not necessarily
// something worth keeping as the permanent listing. Two ways to fix it —
// AI rewrites the copy, or the seller retypes it and that is taken as-is, no
// AI involved at all. Either way nothing changes until the seller applies it.

export async function requestProductImprove(ctx, storeId, productId) {
  const { t } = ctx;
  await ctx.answer();
  await ctx.typing();
  let generated;
  try {
    generated = await ctx.core.improveProduct(ctx.account.id, storeId, productId);
  } catch (err) {
    return ctx.reply(`⚠️ ${esc(ctx.err(err))}`, keyboard([[button(t('b.nav.dashboard'), 'sd', storeId)]]));
  }
  await ctx.setState({ pendingImprove: { storeId, productId, generated } });
  return showProductImproveReview(ctx);
}

async function showProductImproveReview(ctx) {
  const { t } = ctx;
  const pending = ctx.state.pendingImprove;
  if (!pending) return null;
  const { generated, productId } = pending;

  const text = lines(
    b(t('b.improve.title')),
    '',
    generated.caption ? esc(generated.caption) : i(t('b.np.no_description')),
    generated.properties?.length ? `\n${generated.properties.map((p) => `• ${esc(p.name)}: ${esc(p.value)}`).join('\n')}` : null,
    generated.tags?.length ? `\n${generated.tags.map((tag) => `#${tag}`).join(' ')}` : null,
  );

  return ctx.screen(text, keyboard([
    [button(t('b.btn.apply'), 'pimpapply')],
    [button(t('b.nav.cancel'), 'prod', productId)],
  ]));
}

export async function applyProductImprove(ctx) {
  const { t } = ctx;
  const pending = ctx.state.pendingImprove;
  await ctx.answer();
  if (!pending) return null;
  const { storeId, productId, generated } = pending;

  try {
    await ctx.core.updateProduct(ctx.account.id, storeId, productId, {
      description: generated.caption,
      ...(generated.properties?.length ? { properties: generated.properties } : {}),
      ...(generated.tags?.length ? { tags: generated.tags } : {}),
    });
  } catch (err) {
    return ctx.reply(`⚠️ ${esc(ctx.err(err))}`, keyboard([[button(t('b.nav.dashboard'), 'sd', storeId)]]));
  }
  await ctx.clearState(['pendingImprove']);
  return ctx.reply(t('b.improve.applied'), keyboard([[button(t('b.btn.view_product'), 'prod', productId)], [button(t('b.nav.dashboard'), 'sd', storeId)]]));
}

export async function requestProductManualEdit(ctx, storeId, productId) {
  const { t } = ctx;
  await ctx.answer();
  await ctx.setState({ awaiting: 'editproduct', editTarget: { storeId, productId } });
  return ctx.reply(
    lines(b(t('b.edit.title')), '', esc(t('b.edit.prompt'))),
    keyboard([[button(t('b.nav.cancel'), 'prod', productId)]]),
  );
}

export async function handleProductEditInput(ctx) {
  if (ctx.state.awaiting !== 'editproduct') return false;
  const { t } = ctx;
  const { storeId, productId } = ctx.state.editTarget || {};
  if (!storeId) return false;

  const text = (ctx.text || '').trim();
  if (!text) {
    await ctx.reply(t('b.np.need_something'));
    return true;
  }

  const extracted = await ctx.core.editProductPreview(ctx.account.id, storeId, productId, text);
  if (!extracted?.title) {
    await ctx.reply(t('b.np.not_recognized'));
    return true;
  }

  await ctx.setState({ awaiting: null, editTarget: null, pendingEdit: { storeId, productId, extracted } });
  return showProductEditReview(ctx);
}

async function showProductEditReview(ctx) {
  const { tx, t } = ctx;
  const pending = ctx.state.pendingEdit;
  if (!pending) return null;
  const { extracted, storeId, productId } = pending;
  const stores = await ctx.core.myStores(ctx.account.id);
  const currency = stores.find((entry) => entry.id === storeId)?.currency || 'IRT';

  const text = lines(
    b(t('b.np.review_title')),
    '',
    b(extracted.title),
    extracted.price != null ? tx.money(extracted.price, currency) : i(t('b.render.inquire_price')),
    extracted.stock != null ? t('b.render.in_stock', { stock: extracted.stock }) : null,
    extracted.description ? esc(truncate(extracted.description, 600)) : null,
    extracted.properties?.length ? `\n${extracted.properties.map((p) => `• ${esc(p.name)}: ${esc(p.value)}`).join('\n')}` : null,
  );

  return ctx.screen(text, keyboard([
    [button(t('b.btn.apply'), 'peditapply')],
    [button(t('b.nav.cancel'), 'prod', productId)],
  ]));
}

export async function applyProductEdit(ctx) {
  const { t } = ctx;
  const pending = ctx.state.pendingEdit;
  await ctx.answer();
  if (!pending) return null;
  const { storeId, productId, extracted } = pending;

  try {
    await ctx.core.updateProduct(ctx.account.id, storeId, productId, {
      title: extracted.title,
      description: extracted.description || '',
      price: extracted.price,
      priceVisibility: extracted.price == null ? 'inquire' : 'public',
      stock: extracted.stock,
      properties: extracted.properties,
      tags: extracted.tags,
    });
  } catch (err) {
    return ctx.reply(`⚠️ ${esc(ctx.err(err))}`, keyboard([[button(t('b.nav.dashboard'), 'sd', storeId)]]));
  }
  await ctx.clearState(['pendingEdit']);
  return ctx.reply(t('b.edit.applied'), keyboard([[button(t('b.btn.view_product'), 'prod', productId)], [button(t('b.nav.dashboard'), 'sd', storeId)]]));
}

// -- Wallet and plan ------------------------------------------------------
//
// One wallet, one plan per account — not per store — so every screen here
// takes `storeId` only to know which dashboard to come back to.

const PLAN_RESOURCE_KEYS = ['stores', 'members', 'products', 'aiCredits'];

export async function showBilling(ctx, storeId) {
  const { t, tx } = ctx;
  await ctx.answer();
  const billing = await ctx.core.getBilling(ctx.account.id);
  const { wallet, plan, resources } = billing;
  const planName = plan.name[ctx.locale] || plan.name.en;

  const resourceLine = (key) => {
    const r = resources[key];
    const limitText = r.limit === null ? t('b.bill.unlimited') : tx.n(r.limit);
    const bought = r.bonus ? ` (+${tx.n(r.bonus)} ${t('b.bill.bought')})` : '';
    return `${t(`b.bill.res.${key}`)}: ${tx.n(r.used)} / ${limitText}${bought}`;
  };

  const text = lines(
    b(t('b.bill.title')),
    '',
    t('b.bill.wallet', { amount: tx.money(wallet.balanceMinor, wallet.currency) }),
    '',
    b(t('b.bill.plan_line', { plan: planName, price: plan.price ? tx.money(plan.price, plan.currency) : t('b.bill.free') })),
    ...PLAN_RESOURCE_KEYS.map(resourceLine),
    billing.features?.privatePricing ? t('b.bill.feature_private') : i(t('b.bill.feature_private_locked')),
  );

  return ctx.screen(text, keyboard([
    [button(t('b.btn.top_up'), 'btu', storeId), button(t('b.btn.buy_credits'), 'bbuy', storeId)],
    [button(t('b.btn.change_plan'), 'billplans', storeId)],
    [button(t('b.nav.dashboard'), 'sd', storeId)],
  ]));
}

export async function showPlanPicker(ctx, storeId) {
  const { t, tx } = ctx;
  await ctx.answer();
  const [billing, plans] = await Promise.all([ctx.core.getBilling(ctx.account.id), ctx.core.listPlans()]);

  const limitText = (limit) => (limit === null ? t('b.bill.unlimited') : tx.n(limit));
  const summaries = [];
  const rows = plans.map((plan) => {
    const name = plan.name[ctx.locale] || plan.name.en;
    const price = plan.price ? tx.money(plan.price, plan.currency) : t('b.bill.free');
    const current = plan.id === billing.plan.id ? ' ✅' : '';
    summaries.push(lines(
      b(`${name} — ${price}${current}`),
      t('b.bill.plan_summary', {
        stores: limitText(plan.limits.stores),
        members: limitText(plan.limits.members),
        products: limitText(plan.limits.products),
        credits: limitText(plan.limits.aiCredits),
      }),
      plan.features?.privatePricing ? t('b.bill.feature_private') : null,
    ));
    return [button(`${name} — ${price}${current}`, 'billset', storeId, plan.id)];
  });
  rows.push([button(t('b.nav.back'), 'bill', storeId)]);

  return ctx.screen(lines(b(t('b.bill.pick_title')), '', summaries.join('\n\n'), '', i(t('b.bill.pick_hint'))), keyboard(rows));
}

export async function setPlan(ctx, storeId, planId) {
  const { t } = ctx;
  await ctx.answer();
  try {
    await ctx.core.changePlan(ctx.account.id, planId);
  } catch (err) {
    const message = ctx.err(err);
    // Not enough balance is the common failure: the way out is a top-up.
    const rows = [[button(t('b.btn.change_plan'), 'billplans', storeId)], [button(t('b.nav.dashboard'), 'sd', storeId)]];
    if (ctx.limitHit?.wallet) rows.unshift([button(t('b.btn.top_up'), 'btu', storeId)]);
    ctx.limitHit = null;
    return ctx.reply(`⚠️ ${esc(message)}`, keyboard(rows));
  }
  return showBilling(ctx, storeId);
}

// -- Currency -----------------------------------------------------------

/** Short list covering the common cases; anything else is typed as a code. */
const CURRENCY_CHOICES = ['IRT', 'USD', 'NGN', 'AED', 'EUR', 'TRY'];

export async function showCurrencyPicker(ctx, storeId) {
  const { tx, t } = ctx;
  await ctx.setState({ awaiting: 'currency', currencyStoreId: storeId });
  const stores = await ctx.core.myStores(ctx.account.id);
  const store = stores.find((s) => s.id === storeId);
  await ctx.answer();

  return ctx.screen(
    lines(
      b(t('b.cur.title')),
      '',
      t('b.cur.current', { code: tx.ltr(store?.currency || '—') }),
      '',
      esc(t('b.cur.prompt')),
      '',
      i(t('b.cur.warning')),
    ),
    keyboard([
      ...grid(CURRENCY_CHOICES.map((code) => button(`${tx.ltr(code)} · ${t(`enum.currency.${code}`)}`, 'scurset', storeId, code)), 2),
      [button(t('b.nav.cancel'), 'sd', storeId)],
    ]),
  );
}

export async function handleCurrencyInput(ctx) {
  const storeId = ctx.state.currencyStoreId;
  if (!storeId) return false;
  const code = (ctx.text || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    await ctx.reply(ctx.t('b.cur.bad_code'));
    return true;
  }
  return applyCurrency(ctx, storeId, code);
}

export async function setCurrency(ctx, storeId, code) {
  await ctx.answer();
  return applyCurrency(ctx, storeId, code);
}

async function applyCurrency(ctx, storeId, code) {
  const { tx, t } = ctx;
  try {
    const store = await ctx.core.updateStore(ctx.account.id, storeId, { currency: code });
    await ctx.clearState(['awaiting', 'currencyStoreId']);
    return ctx.reply(
      t('b.cur.done', { code: tx.ltr(store.currency) }),
      keyboard([[button(t('b.nav.dashboard'), 'sd', storeId)]]),
    );
  } catch (err) {
    return ctx.reply(`⚠️ ${esc(ctx.err(err))}`, keyboard([[button(t('b.nav.dashboard'), 'sd', storeId)]]));
  }
}

// -- Shipping: who pays, and how much ----------------------------------------

export async function showShippingSettings(ctx, storeId) {
  const { tx, t } = ctx;
  const stores = await ctx.core.myStores(ctx.account.id);
  const store = stores.find((entry) => entry.id === storeId);
  await ctx.answer();
  if (!store) return showDashboard(ctx, storeId);

  const sellerPays = store.settings?.shippingPayer === 'seller';
  const fee = store.settings?.deliveryFee || 0;
  const text = lines(
    b(t('b.ship.title')),
    '',
    sellerPays ? t('b.ship.seller_pays') : t('b.ship.buyer_pays', { fee: tx.money(fee, store.currency) }),
    '',
    i(t('b.ship.hint')),
  );
  const rows = [
    [button(`${sellerPays ? '▫️' : '✅'} ${t('b.ship.opt_buyer')}`, 'sshp', storeId, 'buyer')],
    [button(`${sellerPays ? '✅' : '▫️'} ${t('b.ship.opt_seller')}`, 'sshp', storeId, 'seller')],
  ];
  if (!sellerPays) rows.push([button(t('b.ship.set_fee'), 'sshf', storeId)]);
  rows.push([button(t('b.nav.dashboard'), 'sd', storeId)]);
  return ctx.screen(text, keyboard(rows));
}

export async function setShippingPayer(ctx, storeId, payer) {
  try {
    await ctx.core.updateStore(ctx.account.id, storeId, { settings: { shippingPayer: payer === 'seller' ? 'seller' : 'buyer' } });
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
    return null;
  }
  return showShippingSettings(ctx, storeId);
}

export async function promptShippingFee(ctx, storeId) {
  await ctx.answer();
  await ctx.setState({ awaiting: 'shipfee', shipFeeStoreId: storeId });
  return ctx.reply(
    lines(b(ctx.t('b.ship.fee_title')), '', esc(ctx.t('b.ship.fee_prompt'))),
    keyboard([[button(ctx.t('b.nav.cancel'), 'ssh', storeId)]]),
  );
}

export async function handleShippingFeeInput(ctx) {
  const storeId = ctx.state.shipFeeStoreId;
  if (ctx.state.awaiting !== 'shipfee' || !storeId) return false;
  const raw = toLatinDigits(ctx.text || '').replace(/[,٬،\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    await ctx.reply(ctx.t('b.ship.bad_amount'));
    return true;
  }
  const stores = await ctx.core.myStores(ctx.account.id);
  const store = stores.find((entry) => entry.id === storeId);
  try {
    await ctx.core.updateStore(ctx.account.id, storeId, { settings: { deliveryFee: toMinor(Number(raw), store?.currency || ctx.config.defaultCurrency) } });
    await ctx.clearState(['awaiting', 'shipFeeStoreId']);
  } catch (err) {
    await ctx.reply(`⚠️ ${esc(ctx.err(err))}`);
    return true;
  }
  await showShippingSettings(ctx, storeId);
  return true;
}

export { startOnboarding, resumeOnboarding };

/** "(▲ 12%)" / "(▼ 4%)", with the percentage in the reader's digits. */
function trend(tx, percent) {
  if (!percent) return '';
  return tx.t(percent > 0 ? 'b.sel.trend_up' : 'b.sel.trend_down', { percent: Math.abs(percent) });
}
