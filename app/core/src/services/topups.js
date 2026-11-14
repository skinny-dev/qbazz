import { COLLECTIONS } from '../models/schemas.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../util/ids.js';
import { validate } from '../util/validate.js';
import { formatMoney } from '../util/money.js';

const MAX_PENDING = 5;

/**
 * Wallet top-ups by card-to-card transfer, reviewed by a person.
 *
 * There is no payment gateway: a seller sends money to the platform's card,
 * submits the receipt here, and a platform admin approves or declines it. Only
 * an approval touches the balance — the wallet stays an internal ledger, and
 * every credit it receives from this path has a reviewed receipt behind it.
 * Each request is decided exactly once; a second decision is refused.
 */
export function createTopupsService(ctx) {
  const { store: db, config, events, services } = ctx;
  const topups = db.collection(COLLECTIONS.topups);
  const accounts = db.collection(COLLECTIONS.accounts);

  /** Where to send the money, and within what limits. Managed by a platform admin (services.payments). */
  function instructions(accountId) {
    return services.payments.topupInstructions(accountId);
  }

  async function request(accountId, { amountMinor, reference = '', imageUrl = '', telegramFileId = '', note = '', cardId = null, planId = null } = {}) {
    const { topup: rules } = await services.payments.getSettings();
    services.payments.assertEnabled({ topup: rules });
    const data = validate({ reference, imageUrl, telegramFileId, note }, {
      reference: { type: 'string', max: 80 },
      imageUrl: { type: 'string', max: 500 },
      telegramFileId: { type: 'string', max: 200 },
      note: { type: 'string', max: 300 },
    });
    // Paying for a plan: the amount is the plan's price (never what the browser says) and the limits for a free top-up
    // do not apply. Approving the receipt credits that amount and switches the plan on.
    let plan = null;
    if (planId) {
      plan = services.subscriptions.listPlans().find((p) => p.id === planId && p.price > 0);
      if (!plan) throw ValidationError.of('planId', 'validation.invalid', { field: 'Plan' });
      const sub = await services.subscriptions.summary(accountId);
      if (sub.plan?.id === planId) throw new ConflictError('err.plan_already_on');
    }
    const amount = plan ? plan.price : Number(amountMinor);
    if (!plan) {
      if (!Number.isInteger(amount) || amount <= 0) throw ValidationError.of('amount', 'err.topup_amount', { min: rules.minAmount, max: rules.maxAmount });
      if (amount < rules.minAmount || amount > rules.maxAmount) throw ValidationError.of('amount', 'err.topup_amount', { min: rules.minAmount, max: rules.maxAmount });
    }
    if (!data.reference && !data.imageUrl) throw ValidationError.of('reference', 'err.receipt_required');
    if ((await topups.count({ accountId, status: 'pending' })) >= MAX_PENDING) throw new ConflictError('err.topup_too_many', { max: MAX_PENDING }, { max: MAX_PENDING });

    const record = await topups.insert({
      id: newId('top'),
      accountId,
      amountMinor: amount,
      currency: 'IRT',
      reference: data.reference || null,
      imageUrl: data.imageUrl || null,
      telegramFileId: data.telegramFileId || null,
      note: data.note || null,
      planId: plan?.id || null,
      planName: plan ? (plan.name?.fa || plan.name?.en || plan.id) : null,
      planApplied: null,
      planError: null,
      // The card the seller was shown, as it was then — for the admin matching the receipt.
      card: await services.payments.snapshot(cardId),
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      reason: null,
    });

    const who = await accounts.get(accountId);
    await services.notifications.queueForAdmins({
      type: 'admin.topup_requested',
      render: (t, locale) => ({
        title: plan
          ? t('notif.topup.requested_plan.title', { name: who?.displayName || '—', plan: plan.name?.fa || plan.id, amount: formatMoney(amount, 'IRT', locale) })
          : t('notif.topup.requested.title', { name: who?.displayName || '—', amount: formatMoney(amount, 'IRT', locale) }),
        body: data.reference ? t('notif.topup.requested.ref', { ref: data.reference }) : '',
      }),
      data: { topupId: record.id, action: 'review_topup' },
      priority: 'high',
    });
    await events.emit('wallet.topup_requested', { topupId: record.id, accountId, amountMinor: amount });
    return record;
  }

  async function listMine(accountId, { limit = 10, offset = 0 } = {}) {
    const [items, total] = await Promise.all([
      topups.find({ where: { accountId }, sort: [['createdAt', 'desc']], limit, offset }),
      topups.count({ accountId }),
    ]);
    return { items, total };
  }

  /** The review queue: every account's requests, oldest pending first when filtering to pending. */
  async function list(actorAccountId, { status = null, limit = 30, offset = 0 } = {}) {
    await services.admin.assertAdmin(actorAccountId, { allowSupport: true });
    const where = status ? { status } : undefined;
    const [rows, total] = await Promise.all([
      topups.find({ where, sort: [['createdAt', status === 'pending' ? 'asc' : 'desc']], limit, offset }),
      topups.count(where),
    ]);
    const items = await Promise.all(rows.map(async (row) => {
      const account = await accounts.get(row.accountId);
      return { ...row, account: account ? { id: account.id, displayName: account.displayName, phone: account.phone || null } : null };
    }));
    return { items, total };
  }

  async function get(actorAccountId, topupId) {
    await services.admin.assertAdmin(actorAccountId, { allowSupport: true });
    const row = await topups.get(topupId);
    if (!row) throw new NotFoundError('Top-up', topupId);
    const account = await accounts.get(row.accountId);
    return { ...row, account: account ? { id: account.id, displayName: account.displayName, phone: account.phone || null } : null };
  }

  /** Approve (credits the wallet) or decline (with a reason the seller sees). */
  async function decide(topupId, decision, { actorAccountId, reason = '' } = {}) {
    if (!['approve', 'decline'].includes(decision)) throw new ValidationError({ decision: 'Must be approve or decline' });
    await services.admin.assertAdmin(actorAccountId);
    const approved = decision === 'approve';
    const cleanReason = String(reason || '').trim().slice(0, 300);

    // Claim the decision atomically so two admins tapping at once cannot credit twice.
    let alreadyDecided = false;
    const claimed = await topups.mutate(topupId, (draft) => {
      if (draft.status !== 'pending') {
        alreadyDecided = true;
        return draft;
      }
      draft.status = approved ? 'approved' : 'declined';
      draft.decidedBy = actorAccountId;
      draft.decidedAt = new Date().toISOString();
      draft.reason = approved ? null : (cleanReason || null);
      return draft;
    });
    if (!claimed) throw new NotFoundError('Top-up', topupId);
    if (alreadyDecided) throw new ConflictError('err.topup_already_decided');

    if (approved) {
      try {
        await services.wallet.credit(claimed.accountId, claimed.amountMinor, { reason: 'topup', actorAccountId, meta: { topupId, reference: claimed.reference } });
      } catch (err) {
        // The credit failed, so the request was not really approved — put it back.
        await topups.update(topupId, { status: 'pending', decidedBy: null, decidedAt: null, reason: null });
        throw err;
      }
    }

    // A receipt for a plan: with the money in the wallet, buy the plan from it. If that cannot happen (the plan changed,
    // a downgrade would strand something) the money stays in the wallet and the admin sees why.
    let planApplied = null;
    if (approved && claimed.planId) {
      try {
        await services.subscriptions.changePlan(claimed.accountId, claimed.planId, { actorAccountId });
        planApplied = true;
        await topups.update(topupId, { planApplied: true, planError: null });
      } catch (err) {
        planApplied = false;
        await topups.update(topupId, { planApplied: false, planError: String(err.message || err).slice(0, 200) });
      }
    }

    await services.notifications.queue({
      accountId: claimed.accountId,
      type: approved ? 'wallet.topup_approved' : 'wallet.topup_declined',
      render: (t, locale) => ({
        title: approved
          ? (planApplied ? t('notif.topup.approved_plan.title', { plan: claimed.planName || claimed.planId }) : t('notif.topup.approved.title', { amount: formatMoney(claimed.amountMinor, 'IRT', locale) }))
          : t('notif.topup.declined.title', { amount: formatMoney(claimed.amountMinor, 'IRT', locale) }),
        body: approved ? '' : (cleanReason || t('notif.topup.declined.default')),
      }),
      data: { topupId, action: 'open_billing' },
      priority: 'high',
    });
    await events.emit('wallet.topup_decided', { topupId, accountId: claimed.accountId, decision, actorAccountId });
    return planApplied === null ? claimed : topups.get(topupId);
  }

  return { instructions, request, listMine, list, get, decide };
}
