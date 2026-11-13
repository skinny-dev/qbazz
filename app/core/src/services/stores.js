import { COLLECTIONS, STORE_ROLES, STORE_STATUS, storeSchema, normalizePaymentMethods } from '../models/schemas.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../util/ids.js';
import { uniqueSlug } from '../util/slug.js';
import { validate } from '../util/validate.js';
import { effectiveLocale, ref } from '../i18n/index.js';

const ROLE_RANK = { staff: 1, manager: 2, owner: 3 };

/** Capability matrix — the dashboard greys out what `can()` returns false for. */
export const STORE_PERMISSIONS = {
  'store.view': 'staff',
  'orders.view': 'staff',
  'orders.update': 'staff',
  'products.view': 'staff',
  'products.manage': 'manager',
  'store.update': 'manager',
  'analytics.view': 'manager',
  'staff.manage': 'owner',
  'store.publish': 'owner',
  'store.delete': 'owner',
};

export function createStoresService(ctx) {
  const { store: db, config, events, services } = ctx;
  const stores = db.collection(COLLECTIONS.stores);
  const memberships = db.collection(COLLECTIONS.memberships);

  async function create(ownerAccountId, input = {}, { skipLimitCheck = false } = {}) {
    if (!skipLimitCheck) await services.subscriptions.checkLimit(ownerAccountId, 'stores');
    const data = validate(input, storeSchema);
    const slug = await uniqueSlug(input.slug || data.name, async (candidate) => Boolean(await stores.findOne({ slug: candidate })));

    const approvalRequired = config.platform.storeApprovalRequired;
    // The shop speaks its owner's language: it decides what its channel posts
    // and generated listings are written in.
    const owner = await db.collection(COLLECTIONS.accounts).get(ownerAccountId);
    const locale = effectiveLocale(owner, config.platform.defaultLocale);
    const record = await stores.insert({
      id: newId('str'),
      slug,
      ...data,
      currency: data.currency || config.platform.defaultCurrency,
      ownerAccountId,
      locale,
      status: 'draft',
      // A store is only discoverable once it is active AND has at least one product.
      discoverable: false,
      featured: false,
      verified: false,
      approvalRequired,
      settings: {
        paymentMethods: ['online'],
        fulfillmentMethods: ['delivery'],
        deliveryFee: 0,
        shippingPayer: 'buyer',
        freeDeliveryOver: null,
        minOrder: 0,
        prepTimeMinutes: 30,
        autoConfirmOrders: false,
        orderNotice: '',
        ...(data.settings || {}),
        paymentMethods: normalizePaymentMethods(data.settings?.paymentMethods),
      },
      contact: data.contact || {},
      location: data.location || {},
      stats: { products: 0, orders: 0, revenueMinor: 0, ratingSum: 0, ratingCount: 0, views: 0 },
      channels: {},
      submittedAt: null,
      approvedAt: null,
      rejectionReason: null,
    });

    await memberships.insert({
      id: newId('mem'),
      storeId: record.id,
      accountId: ownerAccountId,
      role: 'owner',
      invitedBy: null,
      acceptedAt: new Date().toISOString(),
    });

    await events.emit('store.created', { storeId: record.id, ownerAccountId, store: record });
    return record;
  }

  async function get(id) {
    return stores.get(id);
  }

  async function getBySlug(slug) {
    return stores.findOne({ slug: String(slug).toLowerCase() });
  }

  /** Accepts an id or a slug — the bot passes whichever it has. */
  async function resolve(idOrSlug) {
    if (!idOrSlug) throw new NotFoundError('Store');
    const found = (await stores.get(idOrSlug)) || (await getBySlug(idOrSlug));
    if (!found) throw new NotFoundError('Store', idOrSlug);
    return found;
  }

  async function update(storeId, patch, { actorAccountId } = {}) {
    if (actorAccountId) await assertCan(storeId, actorAccountId, 'store.update');
    const current = await resolve(storeId);
    const data = validate(patch, storeSchema, { partial: true });
    // An empty string is how a picture is taken away; the validator treats it as "not given".
    for (const field of ['logoUrl', 'bannerUrl']) if (patch[field] === '') data[field] = '';

    if (patch.slug && patch.slug !== current.slug) {
      // The owner's own handle: it is part of every link they share, so keep it plain and typeable.
      const handle = String(patch.slug).trim().toLowerCase();
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(handle) || handle.length < 3 || handle.length > 40) throw ValidationError.of('slug', 'err.slug_format');
      patch = { ...patch, slug: handle };
      const taken = await stores.findOne({ slug: patch.slug });
      if (taken) throw new ConflictError('err.slug_taken_store', { field: 'slug' });
      data.slug = patch.slug;
    }
    if (patch.settings) {
      // Cards have their own validated endpoints (services.storeCards); a settings patch must not rewrite them.
      const { paymentCards: _cards, paymentCard: _card, ...rest } = patch.settings;
      data.settings = { ...current.settings, ...rest };
      if (rest.paymentMethods) data.settings.paymentMethods = normalizePaymentMethods(rest.paymentMethods);
    }
    if (patch.contact) data.contact = { ...current.contact, ...patch.contact };
    if (patch.location) data.location = { ...current.location, ...patch.location };

    const updated = await stores.update(current.id, data);
    await events.emit('store.updated', { storeId: current.id, store: updated, changed: Object.keys(data) });
    return updated;
  }

  /**
   * Owner-initiated publish. Routes through admin review when the platform
   * requires approval; otherwise goes live immediately.
   */
  async function submitForReview(storeId, actorAccountId) {
    await assertCan(storeId, actorAccountId, 'store.publish');
    const current = await resolve(storeId);
    const productCount = await db.collection(COLLECTIONS.products).count({ storeId: current.id, status: 'active' });

    const missing = [];
    if (!current.name) missing.push('name');
    if (!current.description) missing.push('description');
    if (!current.categoryIds?.length) missing.push('category');
    if (!current.contact?.phone && !current.contact?.telegram) missing.push('contact');
    if (productCount < 1) missing.push('product');
    if (missing.length) {
      throw ValidationError.of('store', 'err.store_not_ready', { missing: missing.map((need) => ref(`store.needs.${need}`)) });
    }

    if (!current.approvalRequired) return setStatus(current.id, 'active', { reason: 'auto-approved' });

    const updated = await stores.update(current.id, { status: 'pending_review', submittedAt: new Date().toISOString(), rejectionReason: null });
    await events.emit('store.submitted', { storeId: current.id, store: updated });
    return updated;
  }

  /** Admin-side decision. `discoverable` is recomputed so listings stay honest. */
  async function setStatus(storeId, status, { reason = null, actorAccountId = null } = {}) {
    if (!STORE_STATUS.includes(status)) throw new ValidationError({ status: `Status must be one of: ${STORE_STATUS.join(', ')}` });
    const current = await resolve(storeId);
    const productCount = await db.collection(COLLECTIONS.products).count({ storeId: current.id, status: 'active' });

    const updated = await stores.update(current.id, {
      status,
      discoverable: status === 'active' && productCount > 0,
      approvedAt: status === 'active' ? current.approvedAt || new Date().toISOString() : current.approvedAt,
      rejectionReason: status === 'rejected' || status === 'suspended' ? reason : null,
    });

    await events.emit('store.status_changed', { storeId: current.id, status, reason, actorAccountId, store: updated });
    return updated;
  }

  /** Called by the catalog service whenever product counts change. */
  async function refreshDiscoverability(storeId) {
    const current = await stores.get(storeId);
    if (!current) return null;
    const products = await db.collection(COLLECTIONS.products).count({ storeId, status: 'active' });
    const discoverable = current.status === 'active' && products > 0;
    if (discoverable === current.discoverable && products === current.stats?.products) return current;
    return stores.update(storeId, { discoverable, stats: { ...current.stats, products } });
  }

  async function bumpStats(storeId, patch) {
    const current = await stores.get(storeId);
    if (!current) return null;
    const stats = { ...current.stats };
    for (const [key, delta] of Object.entries(patch)) stats[key] = (stats[key] || 0) + delta;
    return stores.update(storeId, { stats });
  }

  // -- Membership / staff ----------------------------------------------------

  async function listForAccount(accountId, { includeStore = true } = {}) {
    const rows = await memberships.find({ where: { accountId }, sort: [['createdAt', 'asc']] });
    if (!includeStore) return rows;
    const out = [];
    for (const row of rows) {
      const record = await stores.get(row.storeId);
      if (record) out.push({ ...record, membership: { role: row.role, since: row.createdAt } });
    }
    return out;
  }

  async function listMembers(storeId) {
    const rows = await memberships.find({ where: { storeId }, sort: [['createdAt', 'asc']] });
    const accounts = db.collection(COLLECTIONS.accounts);
    return Promise.all(rows.map(async (row) => {
      const account = await accounts.get(row.accountId);
      return { ...row, account: account ? { id: account.id, displayName: account.displayName, avatarUrl: account.avatarUrl, phone: account.phone || null } : null };
    }));
  }

  async function addMember(storeId, accountId, role = 'staff', { actorAccountId } = {}) {
    if (!STORE_ROLES.includes(role)) throw new ValidationError({ role: `Role must be one of: ${STORE_ROLES.join(', ')}` });
    if (actorAccountId) await assertCan(storeId, actorAccountId, 'staff.manage');
    const existing = await memberships.findOne({ storeId, accountId });
    if (existing) return memberships.update(existing.id, { role });
    if (role !== 'owner') {
      const target = await stores.get(storeId);
      if (target?.ownerAccountId) await services.subscriptions.checkLimit(target.ownerAccountId, 'members');
    }
    const member = await memberships.insert({
      id: newId('mem'),
      storeId,
      accountId,
      role,
      invitedBy: actorAccountId || null,
      acceptedAt: new Date().toISOString(),
    });
    await events.emit('store.member_added', { storeId, accountId, role });
    return member;
  }

  async function removeMember(storeId, accountId, { actorAccountId } = {}) {
    if (actorAccountId) await assertCan(storeId, actorAccountId, 'staff.manage');
    const existing = await memberships.findOne({ storeId, accountId });
    if (!existing) throw new NotFoundError('Member', accountId);
    if (existing.role === 'owner') throw new ForbiddenError('err.transfer_owner');
    await memberships.delete(existing.id);
    await events.emit('store.member_removed', { storeId, accountId });
    return { removed: true };
  }

  async function roleOf(storeId, accountId) {
    if (!accountId) return null;
    const membership = await memberships.findOne({ storeId, accountId });
    return membership?.role || null;
  }

  /** Platform admins run any shop as its owner would: no membership needed. */
  async function isPlatformAdmin(accountId) {
    if (!accountId) return false;
    const account = await db.collection(COLLECTIONS.accounts).get(accountId);
    return account?.role === 'admin' && account.status !== 'suspended';
  }

  /** The role a person acts with in a shop: their membership, or `owner` for a platform admin. */
  async function effectiveRole(storeId, accountId) {
    return (await roleOf(storeId, accountId)) || ((await isPlatformAdmin(accountId)) ? 'owner' : null);
  }

  async function can(storeId, accountId, permission) {
    const required = STORE_PERMISSIONS[permission];
    if (!required) return false;
    const role = await effectiveRole(storeId, accountId);
    if (!role) return false;
    return (ROLE_RANK[role] || 0) >= (ROLE_RANK[required] || 99);
  }

  async function assertCan(storeId, accountId, permission) {
    if (await can(storeId, accountId, permission)) return true;
    const account = await db.collection(COLLECTIONS.accounts).get(accountId);
    // Support can read but not write.
    if (account?.role === 'support' && permission.endsWith('.view')) return true;
    throw new ForbiddenError('err.permission', { permission: ref(`perm.${permission}`) });
  }

  async function list({ where, limit = 20, offset = 0, sort = [['createdAt', 'desc']] } = {}) {
    const [items, total] = await Promise.all([stores.find({ where, limit, offset, sort }), stores.count(where)]);
    return { items, total };
  }

  /** At boot: shops that still list cash on delivery (or no online payment) are brought in line. */
  async function migratePaymentMethods() {
    let changed = 0;
    for (const record of await stores.find({})) {
      const next = normalizePaymentMethods(record.settings?.paymentMethods);
      if (JSON.stringify(next) !== JSON.stringify(record.settings?.paymentMethods)) {
        await stores.update(record.id, { settings: { ...(record.settings || {}), paymentMethods: next } });
        changed += 1;
      }
    }
    return changed;
  }

  return {
    migratePaymentMethods,
    create,
    get,
    getBySlug,
    resolve,
    update,
    list,
    submitForReview,
    setStatus,
    refreshDiscoverability,
    bumpStats,
    listForAccount,
    listMembers,
    addMember,
    removeMember,
    roleOf,
    effectiveRole,
    can,
    assertCan,
  };
}
