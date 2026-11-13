import { COLLECTIONS, addressSchema } from '../models/schemas.js';
import { NotFoundError } from '../errors.js';
import { newId } from '../util/ids.js';
import { validate } from '../util/validate.js';

/**
 * A "customer" is the store-scoped view of an account: what this shop knows
 * about this buyer. The account is global; the customer record is per store,
 * which is what the owner dashboard's customer list reads.
 */
export function createCustomersService(ctx) {
  const { store: db, events, services } = ctx;
  const customers = db.collection(COLLECTIONS.customers);

  async function upsert(storeId, accountId, patch = {}) {
    const existing = await customers.findOne({ storeId, accountId });
    if (existing) return customers.update(existing.id, patch);
    const account = await services.accounts.get(accountId);
    return customers.insert({
      id: newId('cus'),
      storeId,
      accountId,
      displayName: account?.displayName || 'Customer',
      phone: account?.phone || null,
      addresses: [],
      tags: [],
      note: '',
      stats: { orders: 0, spentMinor: 0, lastOrderAt: null },
      blocked: false,
      ...patch,
    });
  }

  async function recordOrder(storeId, accountId, order) {
    const record = await upsert(storeId, accountId, {});
    return customers.mutate(record.id, (draft) => {
      draft.displayName = order.contact?.name || draft.displayName;
      draft.phone = order.contact?.phone || draft.phone;
      draft.stats = {
        orders: (draft.stats?.orders || 0) + 1,
        spentMinor: (draft.stats?.spentMinor || 0) + order.totals.total,
        lastOrderAt: order.placedAt,
      };
      if (order.address?.line1 && !draft.addresses.some((a) => a.line1 === order.address.line1)) {
        draft.addresses.push({ id: newId('adr'), ...order.address });
      }
      return draft;
    });
  }

  async function listForStore(storeId, { actorAccountId, limit = 20, offset = 0, search = '' } = {}) {
    if (actorAccountId) await services.stores.assertCan(storeId, actorAccountId, 'orders.view');
    const where = search
      ? (doc) => doc.storeId === storeId && `${doc.displayName} ${doc.phone || ''}`.toLowerCase().includes(search.toLowerCase())
      : { storeId };
    const [items, total] = await Promise.all([
      customers.find({ where, limit, offset, sort: [['stats.lastOrderAt', 'desc']] }),
      customers.count(where),
    ]);
    return { items, total };
  }

  async function get(storeId, accountId) {
    const record = await customers.findOne({ storeId, accountId });
    if (!record) throw new NotFoundError('Customer', accountId);
    return record;
  }

  async function annotate(storeId, accountId, { note, tags, blocked }, { actorAccountId } = {}) {
    if (actorAccountId) await services.stores.assertCan(storeId, actorAccountId, 'orders.update');
    const record = await upsert(storeId, accountId, {});
    const patch = {};
    if (note !== undefined) patch.note = String(note).slice(0, 1000);
    if (tags !== undefined) patch.tags = tags;
    if (blocked !== undefined) patch.blocked = Boolean(blocked);
    const updated = await customers.update(record.id, patch);
    await events.emit('customer.updated', { storeId, accountId, customer: updated });
    return updated;
  }

  /** Buyer-side address book, shared by bot checkout and web checkout. */
  async function addAddress(storeId, accountId, input) {
    const data = validate(input, { ...addressSchema, line1: { ...addressSchema.line1, required: true } });
    const record = await upsert(storeId, accountId, {});
    return customers.mutate(record.id, (draft) => {
      draft.addresses.push({ id: newId('adr'), ...data });
      return draft;
    });
  }

  return { upsert, recordOrder, listForStore, get, annotate, addAddress };
}
