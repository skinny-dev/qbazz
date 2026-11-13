import { COLLECTIONS } from '../models/schemas.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors.js';
import { newId } from '../util/ids.js';

/**
 * Wholesale / private pricing. A seller marks a product `priceVisibility:
 * 'private'`; the real price stays hidden from everyone until a buyer sends
 * a request and the seller approves it (or later revokes it). One request
 * row per (buyer, product) — asking again while one is pending or already
 * approved just returns the existing row rather than opening a duplicate.
 */
export function createAccessService(ctx) {
  const { store: db, services } = ctx;
  const requests = db.collection(COLLECTIONS.accessRequests);

  /** What a specific viewer may see for a specific product — 'none' covers both "never asked" and "not a private product at all". */
  async function statusFor(accountId, productId) {
    if (!accountId) return 'none';
    const row = await requests.findOne({ productId, buyerAccountId: accountId });
    return row ? row.status : 'none';
  }

  async function request(buyerAccountId, productId) {
    const product = await services.catalog.getProductOrFail(productId);
    if ((product.priceVisibility || 'public') !== 'private') {
      throw new ConflictError('err.access_not_private');
    }

    const existing = await requests.findOne({ productId, buyerAccountId });
    // Already pending or already granted: nothing new to do — surface what's there.
    if (existing && existing.status !== 'declined' && existing.status !== 'revoked') return existing;

    const record = existing
      ? await requests.update(existing.id, { status: 'pending', decidedAt: null, decidedBy: null })
      : await requests.insert({
        id: newId('acr'),
        productId,
        storeId: product.storeId,
        buyerAccountId,
        status: 'pending',
        decidedAt: null,
        decidedBy: null,
      });

    const buyer = await services.accounts.get(buyerAccountId);
    await services.notifications.queueForStoreTeam(product.storeId, {
      type: 'access.requested',
      render: (t) => ({
        title: t('notif.access.requested.title', { buyer: buyer?.displayName || '', product: product.title }),
        body: '',
      }),
      data: { requestId: record.id, productId, storeId: product.storeId },
    }, { minRole: 'manager' });

    return record;
  }

  async function decide(actorAccountId, requestId, decision) {
    if (!['approved', 'declined'].includes(decision)) throw new ConflictError('err.access_decision_invalid');
    const record = await requests.get(requestId);
    if (!record) throw new NotFoundError('AccessRequest', requestId);
    await services.stores.assertCan(record.storeId, actorAccountId, 'products.manage');

    const updated = await requests.update(requestId, { status: decision, decidedAt: new Date().toISOString(), decidedBy: actorAccountId });
    const product = await services.catalog.getProduct(record.productId);
    await services.notifications.queue({
      accountId: record.buyerAccountId,
      storeId: record.storeId,
      type: `access.${decision}`,
      render: (t) => ({
        title: decision === 'approved'
          ? t('notif.access.approved.title', { product: product?.title || '' })
          : t('notif.access.declined.title', { product: product?.title || '' }),
        body: '',
      }),
      data: { requestId, productId: record.productId },
      priority: 'high',
    });
    return updated;
  }

  async function revoke(actorAccountId, requestId) {
    const record = await requests.get(requestId);
    if (!record) throw new NotFoundError('AccessRequest', requestId);
    await services.stores.assertCan(record.storeId, actorAccountId, 'products.manage');
    if (record.status !== 'approved') throw new ForbiddenError('err.access_not_approved');
    return requests.update(requestId, { status: 'revoked', decidedAt: new Date().toISOString(), decidedBy: actorAccountId });
  }

  async function listForStore(storeId, { status = null, limit = 50, offset = 0 } = {}) {
    const where = { storeId, ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([
      requests.find({ where, sort: [['createdAt', 'desc']], limit, offset }),
      requests.count(where),
    ]);
    const enriched = await Promise.all(items.map(async (r) => ({
      ...r,
      buyer: await services.accounts.get(r.buyerAccountId),
      product: await services.catalog.getProduct(r.productId),
    })));
    return { items: enriched, total };
  }

  return { statusFor, request, decide, revoke, listForStore };
}
