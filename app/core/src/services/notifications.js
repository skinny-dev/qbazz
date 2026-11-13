import { COLLECTIONS } from '../models/schemas.js';
import { newId } from '../util/ids.js';
import { effectiveLocale, translate } from '../i18n/index.js';

/**
 * Channel-agnostic outbound notifications.
 *
 * The core never talks to Telegram. It queues a notification addressed to an
 * *account*; each integration (the bot, an email sender, the web push worker)
 * drains the queue for the channels it owns. Same event reaches the seller
 * wherever they are, and a message delivered on Telegram is marked delivered
 * for the web inbox too.
 */
export function createNotificationsService(ctx) {
  const { store: db, config, events, services } = ctx;
  const notifications = db.collection(COLLECTIONS.notifications);

  /**
   * Queues one notification for one account.
   *
   * The text is written in the *recipient's* language, decided here at queue
   * time from their account — so a seller reading Persian and a buyer reading
   * English can both be told about the same order. Give either:
   *   - `title` / `body` — literal text (an admin broadcast the admin wrote), or
   *   - `render: (t, locale) => ({ title, body })` — text built with the
   *     recipient's translator `t`, which is what every system message uses.
   */
  async function queue({ accountId, storeId = null, type, title = '', body = '', render = null, data = {}, channels = ['telegram', 'web'], priority = 'normal' }) {
    const recipient = await db.collection(COLLECTIONS.accounts).get(accountId);
    const locale = effectiveLocale(recipient, config.platform.defaultLocale);

    if (render) {
      const t = (key, params) => translate(locale, key, params);
      ({ title, body = '' } = render(t, locale));
    }

    const record = await notifications.insert({
      id: newId('ntf'),
      accountId,
      storeId,
      type,
      title,
      body,
      locale,
      data,
      channels,
      priority,
      status: 'queued',
      deliveries: {},
      readAt: null,
    });
    await events.emit('notification.queued', { notificationId: record.id, accountId, type, notification: record });
    return record;
  }

  /** Fan-out helper: notify every member of a store (order queue, payouts). */
  async function queueForStoreTeam(storeId, payload, { minRole = 'staff' } = {}) {
    const members = await services.stores.listMembers(storeId);
    const rank = { staff: 1, manager: 2, owner: 3 };
    const out = [];
    for (const member of members) {
      if ((rank[member.role] || 0) < (rank[minRole] || 0)) continue;
      out.push(await queue({ ...payload, accountId: member.accountId, storeId }));
    }
    return out;
  }

  /**
   * Fan-out to platform staff. Used for anything that needs a human at Qbazz
   * rather than at a shop: a store waiting for review, a quality flag.
   */
  async function queueForAdmins(payload, { includeSupport = false } = {}) {
    const roles = includeSupport ? ['admin', 'support'] : ['admin'];
    const admins = await db.collection(COLLECTIONS.accounts).find({
      where: { role: { $in: roles }, status: 'active' },
    });
    const out = [];
    for (const admin of admins) out.push(await queue({ ...payload, accountId: admin.id }));
    return out;
  }

  /** Integrations call this to claim work for their channel. */
  async function pending({ channel, limit = 50, maxAgeDays = 7 } = {}) {
    // A notification for someone who has not opened the bot yet stays queued so
    // they get the backlog on their first /start. The age bound stops that
    // queue growing without limit for a chat that never arrives.
    const since = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
    const rows = await notifications.find({
      where: { status: { $in: ['queued', 'partial'] }, channels: { $contains: channel }, createdAt: { $gte: since } },
      sort: [['createdAt', 'asc']],
      limit,
    });
    return rows.filter((row) => !row.deliveries?.[channel]);
  }

  async function markDelivered(notificationId, channel, { ok = true, error = null, ref = null } = {}) {
    return notifications.mutate(notificationId, (draft) => {
      draft.deliveries = { ...draft.deliveries, [channel]: { ok, error, ref, at: new Date().toISOString() } };
      const attempted = Object.keys(draft.deliveries);
      const anyOk = Object.values(draft.deliveries).some((d) => d.ok);
      draft.status = anyOk ? 'delivered' : attempted.length >= draft.channels.length ? 'failed' : 'partial';
      return draft;
    });
  }

  async function listForAccount(accountId, { unreadOnly = false, limit = 30, offset = 0 } = {}) {
    const where = unreadOnly ? { accountId, readAt: null } : { accountId };
    const [items, total] = await Promise.all([
      notifications.find({ where, limit, offset, sort: [['createdAt', 'desc']] }),
      notifications.count(where),
    ]);
    return { items, total, unread: await notifications.count({ accountId, readAt: null }) };
  }

  async function markRead(accountId, notificationId = null) {
    const rows = notificationId
      ? [await notifications.get(notificationId)].filter((n) => n && n.accountId === accountId)
      : await notifications.find({ where: { accountId, readAt: null } });
    for (const row of rows) await notifications.update(row.id, { readAt: new Date().toISOString() });
    return { marked: rows.length };
  }

  return { queue, queueForStoreTeam, queueForAdmins, pending, markDelivered, listForAccount, markRead };
}
