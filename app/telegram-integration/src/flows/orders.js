import { button, grid, keyboard, pager, urlButton } from '../telegram/keyboard.js';
import { b, i, lines, orderSummaryLine, orderText, statusEmoji, esc } from '../render.js';
import { readReceipt } from './billing.js';

/** Buyer-side order tracking. */

export async function showOrders(ctx, offset = 0) {
  const { tx, t } = ctx;
  const limit = ctx.config.pageSize;
  const result = await ctx.core.myOrders(ctx.account.id, { limit, offset });

  if (!result.items.length) {
    return ctx.screen(
      lines(b(t('b.orders.empty_title')), '', i(t('b.orders.empty_hint'))),
      keyboard([[button(t('b.btn.start_shopping'), 'search')], [button(t('b.nav.home'), 'home')]]),
    );
  }

  const text = lines(b(t('b.orders.title')), '', ...result.items.map((order) => orderSummaryLine(tx, order)));
  const rows = [
    ...grid(result.items.map((order) => button(`${statusEmoji(order.status)} ${order.code}`, 'ord', order.id)), 2),
    pager(tx, 'ords', { offset, limit, total: result.total }),
    [button(t('b.nav.home'), 'home')],
  ];

  return ctx.screen(text, keyboard(rows));
}

export async function showOrder(ctx, orderId) {
  const { tx, t } = ctx;
  const order = await ctx.core.getOrder(ctx.account.id, orderId);

  const rows = [];
  // Card-to-card: tell the buyer where the money goes and let them send the receipt.
  const owes = order.paymentMethod === 'bank_transfer' && ['unpaid', 'failed'].includes(order.paymentStatus) && !['cancelled', 'refunded'].includes(order.status);
  if (owes) rows.push([button(t('b.rcp.send'), 'rcp', order.id)]);
  if (order.payLink && /^https:/.test(order.payLink)) rows.push([urlButton(t('b.btn.pay_online'), order.payLink)]);
  if (['pending', 'confirmed'].includes(order.status)) rows.push([button(t('b.btn.cancel_order'), 'ocan', order.id)]);
  if (order.status === 'delivered' && !order.rating) {
    rows.push(grid([1, 2, 3, 4, 5].map((n) => button('⭐'.repeat(n), 'rate', order.id, String(n))), 5)[0]);
  }
  rows.push([button(t('b.btn.shop_again'), 'store', order.storeId)]);
  rows.push([button(t('b.btn.all_orders'), 'ords'), button(t('b.nav.home'), 'home')]);

  const timeline = order.timeline
    .slice(-4)
    .map((entry) => `${statusEmoji(entry.status)} ${esc(tx.orderStatus(entry.status))} · ${tx.date(entry.at, { dateStyle: 'short', timeStyle: 'short' })}`)
    .join('\n');

  const declined = order.paymentReceipt?.decision === 'declined' && order.paymentStatus === 'failed';
  const payLines = owes
    ? [
      '',
      order.payTo?.cardNumber ? b(t('b.rcp.pay_to')) : null,
      order.payTo?.cardNumber ? `💳 ${tx.ltr(order.payTo.cardNumber)}` : null,
      order.payTo?.holder ? `👤 ${esc(order.payTo.holder)}` : null,
      declined ? `❌ ${esc(t('b.rcp.declined'))}${order.paymentReceipt.reason ? `: ${esc(order.paymentReceipt.reason)}` : ''}` : null,
    ]
    : order.paymentMethod === 'bank_transfer' && order.paymentStatus === 'pending' ? ['', i(t('b.rcp.under_review'))] : [];

  return ctx.screen(lines(orderText(tx, order), ...payLines, '', b(t('b.orders.history')), timeline), keyboard(rows));
}

export async function promptReceipt(ctx, orderId) {
  await ctx.answer();
  await ctx.setState({ awaiting: 'receipt', receiptOrderId: orderId });
  return ctx.reply(
    lines(b(ctx.t('b.rcp.title')), '', esc(ctx.t('b.rcp.prompt'))),
    keyboard([[button(ctx.t('b.nav.cancel'), 'ord', orderId)]]),
  );
}

/** The receipt itself: a photo of the transfer and/or its tracking code. */
export async function handleReceiptInput(ctx) {
  const orderId = ctx.state.receiptOrderId;
  if (ctx.state.awaiting !== 'receipt' || !orderId) return false;
  const receipt = await readReceipt(ctx);
  if (!receipt) {
    await ctx.reply(ctx.t('b.rcp.missing'));
    return true;
  }
  try {
    await ctx.core.submitPaymentReceipt(ctx.account.id, orderId, receipt);
    await ctx.clearState(['awaiting', 'receiptOrderId']);
  } catch (err) {
    await ctx.reply(`⚠️ ${esc(ctx.err(err))}`, keyboard([[button(ctx.t('b.btn.track_order'), 'ord', orderId)]]));
    return true;
  }
  await ctx.reply(
    lines(b(ctx.t('b.rcp.sent_title')), esc(ctx.t('b.rcp.sent_body'))),
    keyboard([[button(ctx.t('b.btn.track_order'), 'ord', orderId)], [button(ctx.t('b.nav.home'), 'home')]]),
  );
  return true;
}

export async function cancelOrder(ctx, orderId) {
  try {
    await ctx.core.cancelOrder(ctx.account.id, orderId, 'Cancelled from Telegram');
    await ctx.answer(ctx.t('b.orders.cancelled_toast'));
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
  }
  return showOrder(ctx, orderId);
}

export async function rateOrder(ctx, orderId, rating) {
  try {
    await ctx.core.rateOrder(ctx.account.id, orderId, { rating: Number(rating) });
    await ctx.answer(ctx.t('b.orders.rated_toast'));
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
  }
  return showOrder(ctx, orderId);
}
