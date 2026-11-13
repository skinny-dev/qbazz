import { button, grid, keyboard } from '../telegram/keyboard.js';
import { b, esc, i, lines } from '../render.js';
import { toLatinDigits } from '../../../qbazz-core/src/util/digits.js';

/**
 * Wallet top-ups, credit packs, and the "you ran out" prompts.
 *
 * Nothing here moves money. A top-up is a card-to-card transfer the seller
 * reports with a receipt; a platform admin approves or declines it (in this
 * bot or on the web) and only then does the balance change. Packs and plans
 * are paid from that balance.
 */

/**
 * What a card-to-card receipt message carries: a photo (kept both as a URL for
 * the web and as a Telegram file id the bot can resend) and/or a tracking code.
 * Null when it carries neither.
 */
export async function readReceipt(ctx) {
  const reference = (ctx.text || ctx.caption || '').trim().slice(0, 80);
  const largest = ctx.photo?.length ? ctx.photo[ctx.photo.length - 1] : null;
  const imageUrl = largest ? (await ctx.api.fileUrl(largest.file_id).catch(() => null)) || '' : '';
  if (!reference && !imageUrl) return null;
  return { reference, imageUrl, telegramFileId: largest?.file_id || '' };
}

const TOPUP_PRESETS =[500000, 1000000, 2000000, 5000000];
const TOPUP_STATE = ['awaiting', 'topupAmount', 'topupStoreId', 'topupCardId'];

export async function showTopup(ctx, storeId) {
  const { t, tx } = ctx;
  await ctx.answer();
  const billing = await ctx.core.getBilling(ctx.account.id);
  const { topup } = billing;

  if (!topup.configured) {
    return ctx.screen(
      lines(b(t('b.top.title')), '', esc(t('b.top.unavailable'))),
      keyboard([[button(t('b.nav.back'), 'bill', storeId)]]),
    );
  }

  // The card shown is remembered, so the request records exactly what this person was told to pay.
  await ctx.setState({ awaiting: 'topupamount', topupStoreId: storeId, topupCardId: topup.cardId });
  const pending = (billing.topups || []).filter((entry) => entry.status === 'pending');
  const text = lines(
    b(t('b.top.title')),
    '',
    t('b.top.balance', { amount: tx.money(billing.wallet.balanceMinor, billing.wallet.currency) }),
    '',
    t('b.top.step1'),
    `💳 ${tx.ltr(topup.cardNumber)}`,
    topup.holder ? `👤 ${esc(topup.holder)}${topup.bank ? ` · ${esc(topup.bank)}` : ''}` : null,
    '',
    t('b.top.step2'),
    i(t('b.top.range', { min: tx.money(topup.minAmount, 'IRT'), max: tx.money(topup.maxAmount, 'IRT') })),
    pending.length ? `\n${i(t('b.top.pending', { count: tx.n(pending.length) }))}` : null,
  );

  return ctx.screen(text, keyboard([
    ...grid(TOPUP_PRESETS.map((amount) => button(tx.money(amount, 'IRT'), 'btua', storeId, String(amount))), 2),
    [button(t('b.nav.back'), 'bill', storeId)],
  ]));
}

async function askForReceipt(ctx, storeId, amount) {
  const { t, tx } = ctx;
  await ctx.setState({ awaiting: 'topupreceipt', topupAmount: amount, topupStoreId: storeId });
  return ctx.reply(
    lines(b(t('b.top.receipt_title')), t('b.top.amount_line', { amount: tx.money(amount, 'IRT') }), '', esc(t('b.top.receipt_prompt'))),
    keyboard([[button(t('b.nav.cancel'), 'bill', storeId)]]),
  );
}

export async function chooseTopupAmount(ctx, storeId, amount) {
  await ctx.answer();
  return askForReceipt(ctx, storeId, Number(amount));
}

/** The amount typed in chat, then the receipt (a photo or a tracking code). */
export async function handleTopupInput(ctx) {
  const { awaiting, topupStoreId: storeId } = ctx.state;
  if (!['topupamount', 'topupreceipt'].includes(awaiting) || !storeId) return false;
  const { t, tx } = ctx;

  if (awaiting === 'topupamount') {
    const raw = toLatinDigits(ctx.text || '').replace(/[,٬،\s]/g, '');
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
      await ctx.reply(t('b.top.bad_amount'));
      return true;
    }
    await askForReceipt(ctx, storeId, Number(raw));
    return true;
  }

  const receipt = await readReceipt(ctx);
  if (!receipt) {
    await ctx.reply(t('b.top.receipt_missing'));
    return true;
  }

  try {
    await ctx.core.requestTopup(ctx.account.id, { amountMinor: ctx.state.topupAmount, cardId: ctx.state.topupCardId || undefined, ...receipt });
    await ctx.clearState(TOPUP_STATE);
  } catch (err) {
    await ctx.reply(`⚠️ ${esc(ctx.err(err))}`, keyboard([[button(t('b.nav.back'), 'bill', storeId)]]));
    return true;
  }
  await ctx.reply(
    lines(b(t('b.top.sent_title')), esc(t('b.top.sent_body', { amount: tx.money(ctx.state.topupAmount, 'IRT') }))),
    keyboard([[button(t('b.btn.wallet_plan'), 'bill', storeId)], [button(t('b.nav.dashboard'), 'sd', storeId)]]),
  );
  return true;
}

// -- Credit packs -----------------------------------------------------------------

export async function showPacks(ctx, storeId) {
  const { t, tx } = ctx;
  await ctx.answer();
  const billing = await ctx.core.getBilling(ctx.account.id);
  const label = (pack) => t(`b.pack.${pack.resource}`, { amount: tx.n(pack.amount) });

  const text = lines(
    b(t('b.pack.title')),
    '',
    t('b.top.balance', { amount: tx.money(billing.wallet.balanceMinor, billing.wallet.currency) }),
    ...['aiCredits', 'products'].map((resource) => {
      const r = billing.resources[resource];
      return r.limit === null ? null : t('b.pack.left', { name: t(`b.bill.res.${resource}`), left: tx.n(r.remaining) });
    }),
    '',
    i(t('b.pack.hint')),
  );

  return ctx.screen(text, keyboard([
    ...billing.packs.map((pack) => [button(`${label(pack)} — ${tx.money(pack.price, pack.currency)}`, 'bbp', storeId, pack.id)]),
    [button(t('b.btn.top_up'), 'btu', storeId)],
    [button(t('b.nav.back'), 'bill', storeId)],
  ]));
}

export async function buyPack(ctx, storeId, packId) {
  const { t } = ctx;
  try {
    const { pack } = await ctx.core.buyPack(ctx.account.id, packId);
    await ctx.answer(t('b.pack.bought', { amount: ctx.tx.n(pack.amount) }));
  } catch (err) {
    await ctx.answer();
    // The wallet is the usual reason; say so and offer the way to fill it.
    const message = ctx.err(err);
    ctx.limitHit = null; // this reply carries its own buttons
    return ctx.reply(`⚠️ ${esc(message)}`, keyboard([[button(t('b.btn.top_up'), 'btu', storeId)], [button(t('b.nav.back'), 'bbuy', storeId)]]));
  }
  return showPacks(ctx, storeId);
}

// -- "You hit a limit" ----------------------------------------------------------

/**
 * Called once after a handler finishes. If the person ran into a plan limit
 * (or an empty wallet) while it ran, follow the error with what they can do
 * about it — buy credits, top up, or upgrade — instead of leaving a dead end.
 */
export async function offerLimitHelp(ctx) {
  const hit = ctx.limitHit;
  if (!hit) return;
  ctx.limitHit = null;
  const { t } = ctx;
  const storeId = ctx.state?.sellerStoreId || '-';

  const rows = [];
  if (hit.buyable) rows.push([button(t('b.cta.buy_credits'), 'bbuy', storeId)]);
  if (hit.wallet) rows.push([button(t('b.btn.top_up'), 'btu', storeId)]);
  if (hit.resource) rows.push([button(t('b.cta.upgrade'), 'billplans', storeId)]);
  if (!rows.length) return;

  await ctx.reply(esc(t(hit.resource ? `b.cta.limit_${hit.resource}` : 'b.cta.low_balance')), keyboard(rows));
}
