import { button, keyboard, urlButton } from '../telegram/keyboard.js';
import { b, esc, i, lines } from '../render.js';

/**
 * Admin system, chat edition: the review queue and the platform pulse.
 *
 * Authorisation is the core's job — every call here passes the acting account
 * and the core refuses if they are not an admin. The bot never checks a role
 * itself, so there is no second policy to keep in step.
 */

export async function adminEntry(ctx) {
  const { tx, t } = ctx;
  try {
    const { platform, reviewQueueSize } = await ctx.core.adminOverview(ctx.account.id);
    const topupsWaiting = (await ctx.core.adminTopups(ctx.account.id, { status: 'pending', limit: 1 }).catch(() => ({ total: 0 }))).total;
    const funnel = platform.onboarding.seller;

    const text = lines(
      b(t('b.adm.title')),
      '',
      // Shops price in their own currency, so totals come back per currency.
      t('b.adm.gmv', { amount: money(tx, platform.gmv) }),
      t('b.adm.commission', { amount: money(tx, platform.commission) }),
      t('b.adm.orders', { period: platform.orders.period, total: platform.orders.total }),
      '',
      t('b.adm.shops', { active: platform.stores.active, pending: platform.stores.pendingReview, suspended: platform.stores.suspended }),
      t('b.adm.accounts', { total: platform.accounts.total, fresh: platform.accounts.new }),
      t('b.adm.products', { count: platform.products.active }),
      '',
      b(t('b.adm.by_channel')),
      ...Object.entries(platform.channels).map(([channel, count]) => `• ${esc(channel)}: ${tx.n(count)}`),
      '',
      b(t('b.adm.funnel')),
      t('b.adm.funnel_line', { started: funnel.started, completed: funnel.completed, progress: funnel.inProgress }),
    );

    return ctx.screen(
      text,
      keyboard([
        [button(reviewQueueSize ? t('b.btn.review_queue_n', { count: reviewQueueSize }) : t('b.btn.review_queue'), 'aq', '0')],
        [button(topupsWaiting ? t('b.btn.topups_n', { count: topupsWaiting }) : t('b.btn.topups'), 'atq', '0'), button(t('b.btn.cards'), 'apc')],
        [urlButton(t('b.btn.full_admin'), `${ctx.config.webAppUrl}/admin`)],
        [button(t('b.nav.home'), 'home')],
      ]),
    );
  } catch (err) {
    if (err.status === 403 || /admin access/i.test(err.message)) {
      return ctx.screen(i(t('b.adm.staff_only')), keyboard([[button(t('b.nav.home'), 'home')]]));
    }
    throw err;
  }
}

export async function showReviewQueue(ctx, offset = 0) {
  const { tx, t } = ctx;
  const result = await ctx.core.adminReviewQueue(ctx.account.id, { limit: 5, offset });

  if (!result.items.length) {
    return ctx.screen(
      lines(b(t('b.adm.queue_title')), '', t('b.adm.queue_empty')),
      keyboard([[button(t('b.btn.admin_back'), 'admin')]]),
    );
  }

  const text = lines(
    b(t('b.adm.queue_head')),
    '',
    ...result.items.map((store, index) => lines(
      `${tx.idx(index + 1)} ${b(store.name)}`,
      `   ${esc(store.description ? store.description.slice(0, 80) : t('b.adm.no_description'))}`,
      t('b.adm.queue_meta', { owner: esc(store.owner?.displayName || '—'), products: store.productCount, hours: store.waitingHours }),
      store.location?.city ? `   📍 ${esc(store.location.city)}` : null,
    )),
  );

  const rows = result.items.map((store) => [
    button(t('b.btn.approve_shop', { name: store.name.slice(0, 14) }), 'aap', store.id),
    button(t('b.btn.reject'), 'arj', store.id),
  ]);
  if (result.total > offset + 5) rows.push([button(t('b.btn.next'), 'aq', String(offset + 5))]);
  rows.push([button(t('b.btn.admin_back'), 'admin')]);

  return ctx.screen(text, keyboard(rows));
}

export async function approveStore(ctx, storeId) {
  try {
    const store = await ctx.core.adminApprove(ctx.account.id, storeId);
    await ctx.answer(ctx.t('b.adm.approved_toast', { name: store.name }));
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
  }
  return showReviewQueue(ctx, 0);
}

export async function promptReject(ctx, storeId) {
  const { t } = ctx;
  await ctx.setState({ awaiting: 'admin_reject', rejectStoreId: storeId });
  await ctx.answer();
  return ctx.reply(
    lines(b(t('b.adm.reject_title')), '', esc(t('b.adm.reject_prompt'))),
    keyboard([[button(t('b.nav.cancel'), 'aq', '0')]]),
  );
}

// -- Payment methods: which cards sellers pay, and whether top-ups are on ----------------

export async function showPaymentCards(ctx) {
  const { t, tx } = ctx;
  await ctx.answer();
  const { settings, items } = await ctx.core.adminPayments(ctx.account.id);
  const top = settings.topup;

  const cardLine = (card) => {
    const state = card.primary ? t('b.cards.primary') : card.active ? t('b.cards.active') : t('b.cards.off');
    return `${card.primary ? '⭐' : card.active ? '✅' : '⏸'} •••• ${tx.ltr(card.last4)} — ${esc(card.holder)}${card.bank ? ` · ${esc(card.bank)}` : ''} (${state})`;
  };
  const text = lines(
    b(t('b.cards.title')),
    '',
    top.enabled ? t('b.cards.topups_on') : t('b.cards.topups_off'),
    t('b.cards.range', { min: tx.money(top.minAmount, 'IRT'), max: tx.money(top.maxAmount, 'IRT') }),
    t('b.cards.strategy', { strategy: t(`b.cards.strategy_${top.cardStrategy}`) }),
    '',
    items.length ? items.map(cardLine).join('\n') : i(t('b.cards.none')),
    '',
    i(t('b.cards.web_hint')),
  );

  const rows = [
    [button(top.enabled ? t('b.cards.turn_off') : t('b.cards.turn_on'), 'apcs', top.enabled ? 'off' : 'on')],
    [button(t('b.cards.switch_strategy'), 'apcs', top.cardStrategy === 'rotate' ? 'primary' : 'rotate')],
    ...items.flatMap((card) => [[
      button(`${card.active ? '⏸' : '✅'} •••• ${card.last4}`, 'apct', card.id),
      ...(card.primary ? [] : [button(`⭐ •••• ${card.last4}`, 'apcp', card.id)]),
    ]]),
    [urlButton(t('b.cards.manage_web'), `${ctx.config.webAppUrl}/admin`)],
    [button(t('b.btn.admin_back'), 'admin')],
  ];
  return ctx.screen(text, keyboard(rows));
}

export async function setPaymentSetting(ctx, value) {
  const patch = value === 'on' || value === 'off'
    ? { topup: { enabled: value === 'on' } }
    : { topup: { cardStrategy: value } };
  try {
    await ctx.core.adminUpdatePaymentSettings(ctx.account.id, patch);
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
  }
  return showPaymentCards(ctx);
}

export async function updatePaymentCard(ctx, cardId, change) {
  try {
    if (change === 'primary') {
      await ctx.core.adminUpdatePaymentCard(ctx.account.id, cardId, { primary: true });
    } else {
      const { items } = await ctx.core.adminPayments(ctx.account.id);
      const card = items.find((c) => c.id === cardId);
      await ctx.core.adminUpdatePaymentCard(ctx.account.id, cardId, { active: !card?.active });
    }
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
  }
  return showPaymentCards(ctx);
}

// -- Wallet top-ups (card-to-card receipts waiting on a person) ------------------------

/** One pending receipt at a time, with the photo, so the decision is made looking at the evidence. */
export async function showTopupQueue(ctx, offset = 0) {
  const { tx, t } = ctx;
  await ctx.answer();
  const result = await ctx.core.adminTopups(ctx.account.id, { status: 'pending', limit: 1, offset });

  if (!result.items.length) {
    return ctx.screen(
      lines(b(t('b.adm.topups_title')), '', t('b.adm.topups_empty')),
      keyboard([[button(t('b.btn.admin_back'), 'admin')]]),
    );
  }

  const item = result.items[0];
  const text = lines(
    b(t('b.adm.topups_head', { n: tx.n(offset + 1), total: tx.n(result.total) })),
    '',
    `👤 ${esc(item.account?.displayName || '—')}${item.account?.phone ? ` · ${esc(tx.ltr(item.account.phone))}` : ''}`,
    t('b.adm.topup_amount', { amount: tx.money(item.amountMinor, item.currency) }),
    item.card ? t('b.adm.topup_card', { last4: tx.ltr(item.card.last4), holder: esc(item.card.holder || '') }) : null,
    item.reference ? t('b.pay.receipt_ref', { ref: tx.ltr(item.reference) }) : null,
    item.note ? `📝 ${esc(item.note)}` : null,
    item.imageUrl || item.telegramFileId ? `🖼 ${t('b.pay.receipt_photo')}` : null,
  );
  const rows = [
    [button(t('b.pay.approve'), 'atap', item.id), button(t('b.pay.decline'), 'atrj', item.id)],
    ...(result.total > offset + 1 ? [[button(t('b.btn.next'), 'atq', String(offset + 1))]] : []),
    [button(t('b.btn.admin_back'), 'admin')],
  ];

  if (item.telegramFileId) {
    try {
      return await ctx.photoScreen(item.telegramFileId, text, keyboard(rows));
    } catch {
      // fall through to text
    }
  }
  return ctx.screen(text, keyboard(rows));
}

export async function approveTopup(ctx, topupId) {
  try {
    await ctx.core.adminDecideTopup(ctx.account.id, topupId, 'approve');
    await ctx.answer(ctx.t('b.adm.topup_approved_toast'));
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
  }
  return showTopupQueue(ctx, 0);
}

export async function promptTopupDecline(ctx, topupId) {
  const { t } = ctx;
  await ctx.answer();
  await ctx.setState({ awaiting: 'admin_topup_reject', topupRejectId: topupId });
  return ctx.reply(
    lines(b(t('b.pay.decline_title')), '', esc(t('b.pay.decline_prompt'))),
    keyboard([[button(t('b.pay.decline_now'), 'atrjn', topupId)], [button(t('b.nav.cancel'), 'atq', '0')]]),
  );
}

export async function declineTopup(ctx, topupId, reason = '') {
  try {
    await ctx.core.adminDecideTopup(ctx.account.id, topupId, 'decline', reason);
    await ctx.clearState(['awaiting', 'topupRejectId']);
    await ctx.answer(ctx.t('b.adm.topup_declined_toast'));
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
  }
  return showTopupQueue(ctx, 0);
}

/** Renders `{ NGN: { amount }, IRT: {...} }` as one line, or a dash. */
function money(tx, byCurrency) {
  const parts = Object.entries(byCurrency || {}).map(([currency, entry]) => tx.money(entry.amount, currency));
  return parts.length ? parts.join(tx.rtl ? ' ، ' : ' + ') : '—';
}

export async function handleAdminInput(ctx) {
  if (ctx.state.awaiting === 'admin_topup_reject' && ctx.state.topupRejectId) {
    await declineTopup(ctx, ctx.state.topupRejectId, (ctx.text || '').trim());
    return true;
  }
  if (ctx.state.awaiting !== 'admin_reject') return false;
  const { t } = ctx;
  const storeId = ctx.state.rejectStoreId;
  const reason = ctx.text?.trim();
  if (!reason || reason.length < 5) {
    await ctx.reply(t('b.adm.reject_short'));
    return true;
  }
  await ctx.core.adminReject(ctx.account.id, storeId, reason);
  await ctx.clearState(['awaiting', 'rejectStoreId']);
  await ctx.reply(t('b.adm.rejected'), keyboard([[button(t('b.btn.review_back'), 'aq', '0')]]));
  return true;
}
