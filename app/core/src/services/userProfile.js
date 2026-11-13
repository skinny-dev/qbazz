import { COLLECTIONS } from '../models/schemas.js';
import { NotFoundError } from '../errors.js';

/**
 * Everything the platform holds about one person, for an admin or support: who they are, how they sign in, their
 * shops with products and sales, what they bought and where it was sent, their wallet, and a single dated history.
 * Read-only; every change an admin makes still goes through the ordinary services (and their audit trail).
 */
export function createUserProfileService(ctx) {
  const { store: db, services } = ctx;
  const col = (name) => db.collection(COLLECTIONS[name]);
  const byNewest = (field) => (a, b) => String(b[field] || '').localeCompare(String(a[field] || ''));

  const orderRow = (o) => ({
    id: o.id,
    code: o.code,
    storeId: o.storeId,
    storeName: o.storeName,
    status: o.status,
    paymentStatus: o.paymentStatus,
    paymentMethod: o.paymentMethod,
    total: o.totals?.total || 0,
    currency: o.totals?.currency || 'IRT',
    itemCount: (o.items || []).reduce((n, i) => n + i.quantity, 0),
    buyerName: o.contact?.name || '',
    buyerPhone: o.contact?.phone || '',
    placedAt: o.placedAt || o.createdAt,
  });

  async function get(actorAccountId, accountId) {
    await services.admin.assertAdmin(actorAccountId, { allowSupport: true });
    const raw = await col('accounts').get(accountId);
    if (!raw) throw new NotFoundError('Account', accountId);
    const { passwordHash, ...account } = raw;

    const [identities, memberships, mine, wallet, ledger, subscription, topups, comments, saved, searches, carts, audits] = await Promise.all([
      col('identities').find({ where: { accountId } }),
      col('memberships').find({ where: { accountId } }),
      col('orders').find({ where: { accountId } }),
      services.wallet.getBalance(accountId),
      services.wallet.listTransactions(accountId, { limit: 30 }),
      services.subscriptions.summary(accountId),
      col('topups').find({ where: { accountId } }),
      col('comments').find({ where: { accountId } }),
      col('savedItems').count({ accountId }),
      col('searchLogs').count({ accountId }),
      col('carts').find({ where: { accountId, status: 'open' } }),
      col('auditLogs').find({ where: (a) => a.actorAccountId === accountId || a.target?.accountId === accountId }),
    ]);

    // -- Shops, with their products and what they sold ----------------------------------------------------------
    const shopIds = new Set(memberships.map((m) => m.storeId));
    const stores = (await Promise.all([...shopIds].map((id) => col('stores').get(id)))).filter(Boolean);
    const received = shopIds.size ? await col('orders').find({ where: (o) => shopIds.has(o.storeId) }) : [];
    const shops = [];
    for (const shop of stores) {
      const products = await col('products').find({ where: { storeId: shop.id } });
      const sold = received.filter((o) => o.storeId === shop.id);
      const statusCounts = {};
      for (const p of products) statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
      shops.push({
        ...shop,
        role: memberships.find((m) => m.storeId === shop.id)?.role || null,
        productsTotal: products.length,
        productStatusCounts: statusCounts,
        orderCount: sold.length,
        revenueMinor: sold.filter((o) => !['cancelled', 'refunded'].includes(o.status)).reduce((n, o) => n + (o.totals?.total || 0), 0),
        products: products.sort(byNewest('createdAt')).slice(0, 100).map((p) => ({
          id: p.id, title: p.title, slug: p.slug, price: p.price, currency: p.currency || shop.currency, priceVisibility: p.priceVisibility,
          status: p.status, stock: p.stock, image: p.images?.[0] || null, categoryId: p.categoryId || null, createdAt: p.createdAt,
        })),
      });
    }
    shops.sort(byNewest('createdAt'));

    // -- What they bought and where it went -----------------------------------------------------------------------
    const addresses = new Map();
    for (const o of mine) {
      const line = o.address?.line1;
      if (!line) continue;
      const key = `${line}|${o.address?.city || ''}`;
      const at = o.placedAt || o.createdAt;
      const row = addresses.get(key) || { line1: line, city: o.address?.city || '', name: o.contact?.name || '', phone: o.contact?.phone || '', count: 0, lastUsedAt: at };
      row.count += 1;
      if (String(at) > String(row.lastUsedAt)) Object.assign(row, { lastUsedAt: at, name: o.contact?.name || row.name, phone: o.contact?.phone || row.phone });
      addresses.set(key, row);
    }
    const spent = mine.filter((o) => !['cancelled', 'refunded'].includes(o.status)).reduce((n, o) => n + (o.totals?.total || 0), 0);

    // -- One history, newest first ---------------------------------------------------------------------------------
    const activity = [{ at: account.createdAt, type: 'account.created' }];
    if (account.lastSeenAt) activity.push({ at: account.lastSeenAt, type: 'account.seen' });
    for (const i of identities) activity.push({ at: i.createdAt, type: 'identity.linked', channel: i.channel, value: i.channel === 'telegram' ? (i.profile?.username ? `@${i.profile.username}` : i.externalId) : i.externalId });
    for (const o of mine) activity.push({ at: o.placedAt || o.createdAt, type: 'order.placed', orderId: o.id, code: o.code, storeName: o.storeName, total: o.totals?.total || 0, currency: o.totals?.currency || 'IRT', status: o.status });
    for (const o of received.slice(0, 200)) activity.push({ at: o.placedAt || o.createdAt, type: 'order.received', orderId: o.id, code: o.code, storeName: o.storeName, total: o.totals?.total || 0, currency: o.totals?.currency || 'IRT', status: o.status });
    for (const s of stores) activity.push({ at: s.createdAt, type: 'store.created', storeId: s.id, storeName: s.name, status: s.status });
    for (const c of comments) activity.push({ at: c.createdAt, type: 'comment', productId: c.productId, text: String(c.text || '').slice(0, 120) });
    for (const t of topups) activity.push({ at: t.createdAt, type: 'topup', amount: t.amountMinor, currency: t.currency, status: t.status });
    for (const w of ledger.items) activity.push({ at: w.createdAt, type: 'wallet', amount: w.amountMinor, currency: w.currency, reason: w.reason, kind: w.type });
    for (const a of audits) {
      const did = a.actorAccountId === accountId;
      activity.push({ at: a.createdAt, type: did ? 'audit.did' : 'audit.received', action: a.action, target: a.target || {}, meta: a.meta || {}, actorAccountId: a.actorAccountId || null });
    }
    activity.sort(byNewest('at'));

    return {
      account,
      kind: account.role === 'admin' || account.role === 'support' ? 'staff' : shops.length ? 'sellers' : 'buyers',
      identities: identities.map((i) => ({ id: i.id, channel: i.channel, externalId: i.externalId, verified: Boolean(i.verified), username: i.profile?.username || null, createdAt: i.createdAt, lastSeenAt: i.lastSeenAt || null })),
      subscription,
      wallet: { balanceMinor: wallet.balanceMinor || 0, currency: wallet.currency || 'IRT', recent: ledger.items, total: ledger.total },
      shops,
      salesOrders: received.sort(byNewest('placedAt')).slice(0, 100).map(orderRow),
      purchases: {
        count: mine.length,
        spentMinor: spent,
        orders: mine.sort(byNewest('placedAt')).slice(0, 100).map(orderRow),
      },
      addresses: [...addresses.values()].sort(byNewest('lastUsedAt')),
      counts: { saved, searches, comments: comments.length, openCarts: carts.length, cartItems: carts.reduce((n, c) => n + (c.items || []).length, 0), activity: activity.length },
      activity: activity.slice(0, 200),
    };
  }

  return { get };
}
