import { COLLECTIONS } from '../models/schemas.js';
import { formatMoney } from '../util/money.js';

/**
 * Read-only aggregates for the store owner dashboard and the admin system.
 * Computed on demand from the collections — fine at pilot volume, and the
 * function boundary is where a materialised rollup would slot in later.
 */
export function createAnalyticsService(ctx) {
  const { store: db, config, services } = ctx;
  const orders = db.collection(COLLECTIONS.orders);
  const products = db.collection(COLLECTIONS.products);
  const stores = db.collection(COLLECTIONS.stores);
  const accounts = db.collection(COLLECTIONS.accounts);

  /** Headline numbers for the owner dashboard, with period-over-period deltas. */
  async function storeOverview(storeId, { days = 30, actorAccountId = null } = {}) {
    if (actorAccountId) await services.stores.assertCan(storeId, actorAccountId, 'analytics.view');
    const record = await services.stores.resolve(storeId);
    const currency = record.currency || config.platform.defaultCurrency;

    const now = Date.now();
    const periodStart = new Date(now - days * 86400000).toISOString();
    const priorStart = new Date(now - days * 2 * 86400000).toISOString();

    const all = await orders.find({ where: { storeId: record.id } });
    const current = all.filter((o) => o.placedAt >= periodStart);
    const prior = all.filter((o) => o.placedAt >= priorStart && o.placedAt < periodStart);

    const revenue = sumRevenue(current);
    const priorRevenue = sumRevenue(prior);

    const statusCounts = {};
    for (const order of all) statusCounts[order.status] = (statusCounts[order.status] || 0) + 1;

    return {
      storeId: record.id,
      period: { days, from: periodStart, to: new Date(now).toISOString() },
      currency,
      revenue: {
        amount: revenue,
        formatted: formatMoney(revenue, currency),
        changePercent: percentChange(revenue, priorRevenue),
      },
      orders: { count: current.length, changePercent: percentChange(current.length, prior.length) },
      averageOrder: {
        amount: current.length ? Math.round(revenue / current.length) : 0,
        formatted: formatMoney(current.length ? Math.round(revenue / current.length) : 0, currency),
      },
      pending: await services.orders.pendingCount(record.id),
      statusCounts,
      products: {
        total: await products.count({ storeId: record.id }),
        active: await products.count({ storeId: record.id, status: 'active' }),
        outOfStock: await products.count({ storeId: record.id, status: 'out_of_stock' }),
      },
      customers: await db.collection(COLLECTIONS.customers).count({ storeId: record.id }),
      rating: record.stats?.ratingCount ? Math.round((record.stats.ratingSum / record.stats.ratingCount) * 10) / 10 : null,
      views: record.stats?.views || 0,
      conversionPercent: record.stats?.views ? Math.round((all.length / record.stats.views) * 1000) / 10 : 0,
    };
  }

  /** Daily revenue/order series for the dashboard chart. */
  async function storeTimeSeries(storeId, { days = 30, actorAccountId = null } = {}) {
    if (actorAccountId) await services.stores.assertCan(storeId, actorAccountId, 'analytics.view');
    const from = new Date(Date.now() - days * 86400000);
    const rows = await orders.find({ where: { storeId, placedAt: { $gte: from.toISOString() } } });

    const buckets = new Map();
    for (let i = 0; i < days; i++) {
      const key = new Date(from.getTime() + i * 86400000).toISOString().slice(0, 10);
      buckets.set(key, { date: key, orders: 0, revenue: 0 });
    }
    for (const order of rows) {
      const key = order.placedAt.slice(0, 10);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.orders += 1;
      if (!['cancelled', 'refunded'].includes(order.status)) bucket.revenue += order.totals.total;
    }
    return [...buckets.values()];
  }

  async function topProducts(storeId, { limit = 5, actorAccountId = null } = {}) {
    if (actorAccountId) await services.stores.assertCan(storeId, actorAccountId, 'analytics.view');
    const rows = await products.find({ where: { storeId }, sort: [['stats.unitsSold', 'desc']], limit });
    const record = await stores.get(storeId);
    const currency = record?.currency || config.platform.defaultCurrency;
    return rows.map((p) => ({
      id: p.id,
      title: p.title,
      unitsSold: p.stats?.unitsSold || 0,
      revenue: formatMoney((p.stats?.unitsSold || 0) * p.price, currency),
      // Numbers alongside the string, so a client can format them in its own
      // language and calendar instead of parsing an English price back out.
      revenueMinor: (p.stats?.unitsSold || 0) * p.price,
      currency,
      views: p.stats?.views || 0,
      image: p.images?.[0] || null,
    }));
  }

  /** Platform-wide numbers for the admin system. */
  async function platformOverview({ days = 30 } = {}) {
    const periodStart = new Date(Date.now() - days * 86400000).toISOString();
    const allOrders = await orders.find({});
    const current = allOrders.filter((o) => o.placedAt >= periodStart);

    // Shops price in their own currency, so platform totals are per currency.
    // Summing them into one number would need FX rates we do not have.
    const gmv = byCurrency(current, (o) => o.totals.total);
    const commission = byCurrency(current, (o) => o.totals.commission || 0);

    return {
      period: { days, from: periodStart },
      gmv,
      commission,
      orders: { total: allOrders.length, period: current.length },
      stores: {
        total: await stores.count(),
        active: await stores.count({ status: 'active' }),
        pendingReview: await stores.count({ status: 'pending_review' }),
        suspended: await stores.count({ status: 'suspended' }),
      },
      accounts: {
        total: await accounts.count({ status: 'active' }),
        sellers: await db.collection(COLLECTIONS.memberships).count({ role: 'owner' }),
        new: await accounts.count({ createdAt: { $gte: periodStart } }),
      },
      products: { total: await products.count(), active: await products.count({ status: 'active' }) },
      channels: await channelSplit(allOrders),
      onboarding: {
        seller: await services.onboarding.funnel('seller'),
        buyer: await services.onboarding.funnel('buyer'),
      },
    };
  }

  /** Which surface orders arrive from — the number that justifies the web build. */
  async function channelSplit(allOrders = null) {
    const rows = allOrders || (await orders.find({}));
    const split = {};
    for (const order of rows) {
      const key = order.channel || 'unknown';
      split[key] = (split[key] || 0) + 1;
    }
    return split;
  }

  async function topStores({ limit = 10, days = 30 } = {}) {
    const periodStart = new Date(Date.now() - days * 86400000).toISOString();
    const rows = await orders.find({ where: { placedAt: { $gte: periodStart } } });
    const totals = new Map();
    for (const order of rows) {
      if (['cancelled', 'refunded'].includes(order.status)) continue;
      const entry = totals.get(order.storeId) || {
        storeId: order.storeId,
        storeName: order.storeName,
        currency: order.totals.currency,
        orders: 0,
        revenue: 0,
      };
      entry.orders += 1;
      entry.revenue += order.totals.total;
      totals.set(order.storeId, entry);
    }
    // Ranked by order count, which is currency-neutral; revenue is shown in
    // each shop's own currency rather than converted.
    return [...totals.values()]
      .sort((a, b) => b.orders - a.orders || b.revenue - a.revenue)
      .slice(0, limit)
      .map((entry) => ({ ...entry, revenueFormatted: formatMoney(entry.revenue, entry.currency) }));
  }

  return { storeOverview, storeTimeSeries, topProducts, platformOverview, channelSplit, topStores };
}

/** `{ NGN: { amount, formatted }, USD: {...} }` plus a total order count. */
function byCurrency(orderRows, pick) {
  const out = {};
  for (const order of orderRows) {
    if (['cancelled', 'refunded'].includes(order.status)) continue;
    const currency = order.totals.currency;
    out[currency] = (out[currency] || 0) + pick(order);
  }
  return Object.fromEntries(
    Object.entries(out).map(([currency, amount]) => [currency, { amount, formatted: formatMoney(amount, currency) }]),
  );
}

function sumRevenue(orderRows) {
  return orderRows.filter((o) => !['cancelled', 'refunded'].includes(o.status)).reduce((sum, o) => sum + o.totals.total, 0);
}

function percentChange(current, prior) {
  if (!prior) return current ? 100 : 0;
  return Math.round(((current - prior) / prior) * 1000) / 10;
}
