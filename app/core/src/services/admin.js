import { COLLECTIONS } from '../models/schemas.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors.js';
import { newId } from '../util/ids.js';

/**
 * The admin system: store review queue, moderation, and the platform switches.
 *
 * Every mutation writes an audit entry. `assertAdmin` is the single gate — the
 * HTTP layer and any in-process caller both go through it, so there is no
 * "admin-only" path that forgot to check.
 */
/** A typed phone (0936…, +98936…, 98936…) against a stored one, whichever way either is spelled; needs 4+ digits to count. */
function phoneMatches(stored, needle) {
  const typed = String(needle || '').replace(/\D/g, '').replace(/^(00)?98/, '').replace(/^0+/, '');
  return typed.length >= 4 && String(stored || '').replace(/\D/g, '').includes(typed);
}

export function createAdminService(ctx) {
  const { store: db, config, events, services } = ctx;
  const stores = db.collection(COLLECTIONS.stores);
  const auditLogs = db.collection(COLLECTIONS.auditLogs);

  async function assertAdmin(accountId, { allowSupport = false } = {}) {
    const account = await db.collection(COLLECTIONS.accounts).get(accountId);
    if (!account) throw new NotFoundError('Account', accountId);
    if (account.role === 'admin') return account;
    if (allowSupport && account.role === 'support') return account;
    throw new ForbiddenError('err.admin_required');
  }

  async function audit(actorAccountId, action, target = {}, meta = {}) {
    return auditLogs.insert({ id: newId('aud'), actorAccountId, action, target, meta });
  }

  // -- Review queue ----------------------------------------------------------

  async function reviewQueue(actorAccountId, { limit = 20, offset = 0 } = {}) {
    await assertAdmin(actorAccountId, { allowSupport: true });
    const where = { status: 'pending_review' };
    const [items, total] = await Promise.all([
      stores.find({ where, limit, offset, sort: [['submittedAt', 'asc']] }),
      stores.count(where),
    ]);
    const enriched = await Promise.all(items.map(async (record) => ({
      ...record,
      owner: await services.accounts.get(record.ownerAccountId),
      productCount: await db.collection(COLLECTIONS.products).count({ storeId: record.id, status: 'active' }),
      waitingHours: record.submittedAt ? Math.round((Date.now() - new Date(record.submittedAt)) / 3600000) : 0,
    })));
    return { items: enriched, total };
  }

  /** Every shop on the platform, newest first: search by name/address/owner, filter by status, with who owns it and how big it is. */
  async function listStores(actorAccountId, { q = '', status = null, limit = 20, offset = 0 } = {}) {
    await assertAdmin(actorAccountId, { allowSupport: true });
    const needle = String(q || '').trim().toLowerCase();
    const accounts = db.collection(COLLECTIONS.accounts);
    const ownerCache = new Map();
    const ownerOf = async (id) => {
      if (!id) return null;
      if (!ownerCache.has(id)) {
        const a = await accounts.get(id);
        ownerCache.set(id, a ? { id: a.id, displayName: a.displayName, phone: a.phone || '', email: a.email || '' } : null);
      }
      return ownerCache.get(id);
    };
    let rows = await stores.find({ where: status ? { status } : undefined, sort: [['createdAt', 'desc']] });
    if (needle) {
      const kept = [];
      for (const record of rows) {
        const owner = await ownerOf(record.ownerAccountId);
        const hay = `${record.name} ${record.slug} ${record.id} ${owner?.displayName || ''} ${owner?.phone || ''} ${owner?.email || ''}`.toLowerCase();
        if (hay.includes(needle) || phoneMatches(owner?.phone, needle)) kept.push(record);
      }
      rows = kept;
    }
    const page = rows.slice(offset, offset + limit);
    const products = db.collection(COLLECTIONS.products);
    const orders = db.collection(COLLECTIONS.orders);
    const items = await Promise.all(page.map(async (record) => ({
      ...record,
      owner: await ownerOf(record.ownerAccountId),
      productCount: await products.count({ storeId: record.id }),
      activeProductCount: await products.count({ storeId: record.id, status: 'active' }),
      orderCount: await orders.count({ storeId: record.id }),
    })));
    return { items, total: rows.length };
  }

  async function approveStore(actorAccountId, storeId, { note = '' } = {}) {
    await assertAdmin(actorAccountId);
    const record = await services.stores.setStatus(storeId, 'active', { actorAccountId });
    await audit(actorAccountId, 'store.approved', { storeId }, { note });
    await services.notifications.queue({
      accountId: record.ownerAccountId,
      storeId: record.id,
      type: 'store.approved',
      render: (t) => ({ title: t('notif.store.approved.title', { name: record.name }), body: t('notif.store.approved.body') }),
      data: { storeId: record.id, storefrontUrl: `${config.platform.webBaseUrl}/s/${record.slug}` },
      priority: 'high',
    });
    return record;
  }

  async function rejectStore(actorAccountId, storeId, reason) {
    await assertAdmin(actorAccountId);
    const record = await services.stores.setStatus(storeId, 'rejected', { reason, actorAccountId });
    await audit(actorAccountId, 'store.rejected', { storeId }, { reason });
    await services.notifications.queue({
      accountId: record.ownerAccountId,
      storeId: record.id,
      type: 'store.rejected',
      // The reason is the admin's own words; only the fallback is translated.
      render: (t) => ({ title: t('notif.store.rejected.title'), body: reason || t('notif.store.rejected.default') }),
      data: { storeId: record.id },
      priority: 'high',
    });
    return record;
  }

  async function suspendStore(actorAccountId, storeId, reason) {
    await assertAdmin(actorAccountId);
    const record = await services.stores.setStatus(storeId, 'suspended', { reason, actorAccountId });
    await audit(actorAccountId, 'store.suspended', { storeId }, { reason });
    await services.notifications.queue({
      accountId: record.ownerAccountId,
      storeId: record.id,
      type: 'store.suspended',
      render: (t) => ({
        title: t('notif.store.suspended.title'),
        body: reason || t('notif.store.suspended.default', { support: config.platform.supportHandle }),
      }),
      data: { storeId: record.id },
      priority: 'high',
    });
    return record;
  }

  async function setFeatured(actorAccountId, storeId, featured = true) {
    await assertAdmin(actorAccountId);
    const updated = await stores.update(storeId, { featured: Boolean(featured) });
    if (!updated) throw new NotFoundError('Store', storeId);
    await audit(actorAccountId, featured ? 'store.featured' : 'store.unfeatured', { storeId });
    await events.emit('store.updated', { storeId, store: updated, changed: ['featured'] });
    return updated;
  }

  async function setVerified(actorAccountId, storeId, verified = true) {
    await assertAdmin(actorAccountId);
    const updated = await stores.update(storeId, { verified: Boolean(verified) });
    if (!updated) throw new NotFoundError('Store', storeId);
    await audit(actorAccountId, verified ? 'store.verified' : 'store.unverified', { storeId });
    return updated;
  }

  // -- Accounts --------------------------------------------------------------

  async function suspendAccount(actorAccountId, targetAccountId, reason) {
    await assertAdmin(actorAccountId);
    if (actorAccountId === targetAccountId) throw new ForbiddenError('err.admin_self');
    const updated = await db.collection(COLLECTIONS.accounts).update(targetAccountId, { status: 'suspended', suspendedReason: reason });
    if (!updated) throw new NotFoundError('Account', targetAccountId);
    // Suspending an owner takes their shops offline too.
    const owned = await db.collection(COLLECTIONS.memberships).find({ where: { accountId: targetAccountId, role: 'owner' } });
    for (const membership of owned) await services.stores.setStatus(membership.storeId, 'suspended', { reason: 'Owner suspended', actorAccountId });
    await audit(actorAccountId, 'account.suspended', { accountId: targetAccountId }, { reason, storesAffected: owned.length });
    await events.emit('account.suspended', { accountId: targetAccountId, reason });
    return { accountId: targetAccountId, storesSuspended: owned.length };
  }

  async function restoreAccount(actorAccountId, targetAccountId) {
    await assertAdmin(actorAccountId);
    const updated = await db.collection(COLLECTIONS.accounts).update(targetAccountId, { status: 'active', suspendedReason: null });
    if (!updated) throw new NotFoundError('Account', targetAccountId);
    await audit(actorAccountId, 'account.restored', { accountId: targetAccountId });
    return updated;
  }

  async function grantRole(actorAccountId, targetAccountId, role) {
    await assertAdmin(actorAccountId);
    if (actorAccountId === targetAccountId && role !== 'admin') throw new ForbiddenError('err.admin_self');
    const updated = await services.accounts.setRole(targetAccountId, role);
    await audit(actorAccountId, 'account.role_granted', { accountId: targetAccountId }, { role });
    return updated;
  }

  /** A person's picture, set or removed by an admin (support tooling: an inappropriate picture has to be removable). */
  async function setAvatar(actorAccountId, targetAccountId, avatarUrl) {
    await assertAdmin(actorAccountId);
    const url = String(avatarUrl ?? '');
    const updated = await services.accounts.update(targetAccountId, { avatarUrl: url });
    await audit(actorAccountId, url ? 'account.avatar_changed' : 'account.avatar_removed', { accountId: targetAccountId });
    return updated;
  }

  async function avatarFromTelegram(actorAccountId, targetAccountId) {
    await assertAdmin(actorAccountId);
    const updated = await services.accounts.useTelegramPhoto(targetAccountId);
    await audit(actorAccountId, 'account.avatar_changed', { accountId: targetAccountId }, { source: 'telegram' });
    return updated;
  }

  // -- Subscriptions and wallets (billing support tooling) --------------------
  //
  // qbazz-core runs as shared infrastructure: every account here is a tenant
  // on someone else's plan and limits. These are the admin-panel operations
  // for managing that directly, since there is no self-serve payment gateway
  // wired up yet — a top-up or a plan grant is something support does by hand
  // after money changes hands some other way.

  /** Every account's plan, usage and wallet balance — the subscription list a billing panel needs. */
  async function listSubscriptions(actorAccountId, { limit = 20, offset = 0 } = {}) {
    await assertAdmin(actorAccountId, { allowSupport: true });
    const accounts = db.collection(COLLECTIONS.accounts);
    const [rows, total] = await Promise.all([
      accounts.find({ limit, offset, sort: [['createdAt', 'desc']] }),
      accounts.count(),
    ]);
    const items = await Promise.all(rows.map(async (account) => ({
      account: { id: account.id, displayName: account.displayName, email: account.email, phone: account.phone, role: account.role, status: account.status },
      ...(await services.subscriptions.summary(account.id)),
    })));
    return { items, total };
  }

  /**
   * Everyone on the platform, told apart: sellers (own or work in a shop), buyers (everyone else) and staff. Each row carries
   * the shops they are in, what they bought, which ways they sign in, and their plan and wallet. `counts` are for the filter
   * chips and follow the search text, not the chip.
   */
  async function listUsers(actorAccountId, { q = '', kind = '', limit = 20, offset = 0 } = {}) {
    await assertAdmin(actorAccountId, { allowSupport: true });
    const [accountRows, memberRows, storeRows, identityRows] = await Promise.all([
      db.collection(COLLECTIONS.accounts).find({ sort: [['createdAt', 'desc']] }),
      db.collection(COLLECTIONS.memberships).find({}),
      stores.find({}),
      db.collection(COLLECTIONS.identities).find({}),
    ]);
    const storeById = new Map(storeRows.map((s) => [s.id, s]));
    const shopsOf = new Map();
    for (const m of memberRows) {
      const shop = storeById.get(m.storeId);
      if (!shop) continue;
      if (!shopsOf.has(m.accountId)) shopsOf.set(m.accountId, []);
      shopsOf.get(m.accountId).push({ id: shop.id, name: shop.name, slug: shop.slug, status: shop.status, role: m.role });
    }
    const channelsOf = new Map();
    const handleOf = new Map();
    for (const i of identityRows) {
      if (!channelsOf.has(i.accountId)) channelsOf.set(i.accountId, new Set());
      channelsOf.get(i.accountId).add(i.channel);
      if (i.channel === 'telegram') handleOf.set(i.accountId, `${i.profile?.username || ''} ${i.externalId}`);
    }

    const needle = String(q || '').trim().toLowerCase();
    const kindOf = (a) => (a.role === 'admin' || a.role === 'support' ? 'staff' : (shopsOf.get(a.id) || []).length ? 'sellers' : 'buyers');
    const matched = accountRows.filter((a) => a.status !== 'deleted' && (!needle
      || `${a.displayName} ${a.email || ''} ${a.phone || ''} ${a.id} ${handleOf.get(a.id) || ''}`.toLowerCase().includes(needle)
      || phoneMatches(a.phone, needle)));
    const counts = { all: matched.length, sellers: 0, buyers: 0, staff: 0 };
    for (const a of matched) counts[kindOf(a)] += 1;

    const picked = kind ? matched.filter((a) => kindOf(a) === kind) : matched;
    const pageRows = picked.slice(offset, offset + limit);

    // What each person bought: read for the page being shown only, not every order the platform has ever taken.
    const boughtBy = new Map();
    if (pageRows.length) {
      for (const o of await db.collection(COLLECTIONS.orders).find({ where: { accountId: { $in: pageRows.map((a) => a.id) } } })) {
        const cur = boughtBy.get(o.accountId) || { count: 0, spentMinor: 0, currency: o.totals?.currency || null };
        cur.count += 1;
        if (!['cancelled', 'refunded'].includes(o.status)) cur.spentMinor += o.totals?.total || 0;
        boughtBy.set(o.accountId, cur);
      }
    }

    const items = await Promise.all(pageRows.map(async (a) => ({
      account: {
        id: a.id, displayName: a.displayName, avatarUrl: a.avatarUrl || '', email: a.email || '', phone: a.phone || '', role: a.role, status: a.status,
        suspendedReason: a.suspendedReason || null, createdAt: a.createdAt, lastSeenAt: a.lastSeenAt || null,
      },
      kind: kindOf(a),
      channels: [...(channelsOf.get(a.id) || [])],
      shops: await Promise.all((shopsOf.get(a.id) || []).map(async (s) => ({ ...s, productCount: await db.collection(COLLECTIONS.products).count({ storeId: s.id }) }))),
      bought: boughtBy.get(a.id) || { count: 0, spentMinor: 0, currency: null },
      ...(await services.subscriptions.summary(a.id)),
    })));
    return { items, total: picked.length, counts };
  }

  /** Grants a plan directly — a comp, or the manual side of an out-of-band payment. No wallet charge. */
  async function setAccountPlan(actorAccountId, targetAccountId, planId) {
    await assertAdmin(actorAccountId);
    const updated = await services.subscriptions.adminSetPlan(targetAccountId, planId, { actorAccountId });
    await audit(actorAccountId, 'subscription.plan_set', { accountId: targetAccountId }, { planId });
    return updated;
  }

  /** Every plan including hidden ones, with how many accounts sit on each — the plan editor's list. */
  async function listPlans(actorAccountId) {
    await assertAdmin(actorAccountId, { allowSupport: true });
    const subs = await db.collection(COLLECTIONS.subscriptions).find({});
    const counts = {};
    for (const s of subs) counts[s.planId] = (counts[s.planId] || 0) + 1;
    return { items: services.subscriptions.listPlans({ includeInactive: true }).map((p) => ({ ...p, accounts: counts[p.id] || 0 })) };
  }

  async function updatePlan(actorAccountId, planId, patch) {
    await assertAdmin(actorAccountId);
    const updated = await services.subscriptions.updatePlan(planId, patch, { actorAccountId });
    await audit(actorAccountId, 'plan.updated', { planId }, { patch });
    return updated;
  }

  async function createPlan(actorAccountId, input) {
    await assertAdmin(actorAccountId);
    const created = await services.subscriptions.createPlan(input, { actorAccountId });
    await audit(actorAccountId, 'plan.created', { planId: created.id });
    return created;
  }

  // -- Sale unit: whether a category is customarily sold by the piece or by the pack -------------

  async function getSaleUnits(actorAccountId, { locale = 'fa' } = {}) {
    await assertAdmin(actorAccountId, { allowSupport: true });
    return services.catalog.listSaleUnits({ locale });
  }

  async function setSaleUnits(actorAccountId, patch) {
    await assertAdmin(actorAccountId);
    const result = await services.catalog.setSaleUnits(patch);
    await audit(actorAccountId, 'catalog.sale_units_updated', {}, { groups: Object.keys(patch?.groups || {}), default: patch?.default !== undefined });
    return result;
  }

  // -- Photo prompts: what each category asks the mockup provider for ---------------

  async function getMockupPrompts(actorAccountId, { locale = 'fa' } = {}) {
    await assertAdmin(actorAccountId, { allowSupport: true });
    return services.mockups.listPrompts({ locale });
  }

  async function setMockupPrompts(actorAccountId, patch) {
    await assertAdmin(actorAccountId);
    const result = await services.mockups.setPrompts(patch);
    await audit(actorAccountId, 'mockup.prompts_updated', {}, { groups: Object.keys(patch?.groups || {}), default: patch?.default !== undefined });
    return result;
  }

  // -- Platform payment methods: the cards sellers pay, and the top-up rules -------

  async function getPayments(actorAccountId) {
    await assertAdmin(actorAccountId, { allowSupport: true });
    return { settings: await services.payments.getSettings(), ...(await services.payments.listCards(actorAccountId)) };
  }

  async function updatePaymentSettings(actorAccountId, patch) {
    await assertAdmin(actorAccountId);
    const settings = await services.payments.updateSettings(patch);
    await audit(actorAccountId, 'payments.settings_updated', {}, { patch });
    return settings;
  }

  async function createPaymentCard(actorAccountId, input) {
    await assertAdmin(actorAccountId);
    const card = await services.payments.createCard(input);
    await audit(actorAccountId, 'payments.card_created', { cardId: card.id }, { last4: card.last4 });
    return card;
  }

  async function updatePaymentCard(actorAccountId, cardId, patch) {
    await assertAdmin(actorAccountId);
    const card = await services.payments.updateCard(cardId, patch);
    // Log what changed, never the full number.
    await audit(actorAccountId, 'payments.card_updated', { cardId }, { fields: Object.keys(patch), last4: card.last4 });
    return card;
  }

  async function archivePaymentCard(actorAccountId, cardId) {
    await assertAdmin(actorAccountId);
    const result = await services.payments.archiveCard(cardId);
    await audit(actorAccountId, 'payments.card_archived', { cardId });
    return result;
  }

  /** Card-to-card wallet top-ups waiting on (or past) a decision. */
  async function listTopups(actorAccountId, query = {}) {
    return services.topups.list(actorAccountId, query);
  }

  async function decideTopup(actorAccountId, topupId, decision, { reason = '' } = {}) {
    const decided = await services.topups.decide(topupId, decision, { actorAccountId, reason });
    await audit(actorAccountId, `topup.${decision === 'approve' ? 'approved' : 'declined'}`, { accountId: decided.accountId }, { topupId, amountMinor: decided.amountMinor, reason });
    return decided;
  }

  /** A manual wallet top-up (positive) or correction (negative) — how balance gets in at all right now. */
  async function adjustWallet(actorAccountId, targetAccountId, amountMinor, { reason = 'admin_adjustment' } = {}) {
    await assertAdmin(actorAccountId);
    const amount = Math.trunc(Number(amountMinor));
    const wallet = amount >= 0
      ? await services.wallet.credit(targetAccountId, amount, { reason, actorAccountId })
      : await services.wallet.debit(targetAccountId, -amount, { reason, actorAccountId });
    await audit(actorAccountId, 'wallet.adjusted', { accountId: targetAccountId }, { amountMinor: amount, reason });
    return wallet;
  }

  // -- Full store management on a user's behalf -------------------------------
  //
  // "Edit" is already covered: `services.stores.update` grants a platform
  // admin access regardless of store role (see `assertCan`). "Delete" is a
  // suspend, not a hard delete — the store's products and order history stay
  // intact and referenceable, it just stops operating, which is what
  // removing a shop actually needs to mean in a marketplace.

  /** Opens a store for a user who cannot (or should not have to) do it themselves. */
  async function createStoreFor(actorAccountId, targetAccountId, input) {
    await assertAdmin(actorAccountId);
    const record = await services.stores.create(targetAccountId, input, { skipLimitCheck: true });
    await audit(actorAccountId, 'store.created_for_account', { storeId: record.id, accountId: targetAccountId });
    return record;
  }

  /** "Delete" a store — suspends it; nothing that references it (products, orders) is destroyed. */
  async function deleteStore(actorAccountId, storeId, reason = '') {
    return suspendStore(actorAccountId, storeId, reason || 'Removed by admin');
  }

  /**
   * Removes a shop for good, with everything that belongs to it (products, carts, orders, reviews, comments, channel data,
   * team, prompts). People's accounts stay. Because it cannot be undone it asks for the shop's exact name, and refuses while
   * orders are still open - finish or cancel them first (or suspend the shop instead).
   */
  async function destroyStore(actorAccountId, storeId, { confirmName = '' } = {}) {
    await assertAdmin(actorAccountId);
    const record = await services.stores.resolve(storeId);
    if (String(confirmName).trim() !== record.name) throw new ConflictError('err.store_name_mismatch');
    const open = await db.collection(COLLECTIONS.orders).count({ storeId: record.id, status: { $in: ['pending', 'confirmed', 'preparing', 'ready', 'shipped'] } });
    if (open) throw new ConflictError('err.store_open_orders', { count: open }, { count: open });

    const keep = new Set([COLLECTIONS.categories, COLLECTIONS.events, COLLECTIONS.auditLogs, COLLECTIONS.searchLogs, COLLECTIONS.accounts, COLLECTIONS.stores, COLLECTIONS.platformSettings, COLLECTIONS.plans, COLLECTIONS.uploads]);
    const removed = {};
    for (const name of Object.values(COLLECTIONS)) {
      if (keep.has(name)) continue;
      const collection = db.collection(name);
      const before = await collection.count({ storeId: record.id });
      if (before) { await collection.deleteWhere({ storeId: record.id }); removed[name] = before; }
    }
    for (const row of await db.collection(COLLECTIONS.platformSettings).find({})) {
      if (String(row.id).endsWith(`:${record.id}`)) await db.collection(COLLECTIONS.platformSettings).delete(row.id);
    }
    await stores.delete(record.id);
    await audit(actorAccountId, 'store.destroyed', { storeId: record.id }, { name: record.name, slug: record.slug, ownerAccountId: record.ownerAccountId, removed });
    return { removed: true, name: record.name, counts: removed };
  }

  // -- Search across the platform (support tooling) --------------------------

  async function lookup(actorAccountId, query) {
    await assertAdmin(actorAccountId, { allowSupport: true });
    const q = String(query || '').trim();
    if (!q) return { accounts: [], stores: [], orders: [] };

    const order = await services.orders.get(q);
    const [accountRows, storeRows] = await Promise.all([
      db.collection(COLLECTIONS.accounts).find({
        where: (doc) => `${doc.displayName} ${doc.email || ''} ${doc.phone || ''} ${doc.id}`.toLowerCase().includes(q.toLowerCase()),
        limit: 10,
      }),
      stores.find({
        where: (doc) => `${doc.name} ${doc.slug} ${doc.id}`.toLowerCase().includes(q.toLowerCase()),
        limit: 10,
      }),
    ]);

    return {
      accounts: accountRows.map(({ passwordHash, ...rest }) => rest),
      stores: storeRows,
      orders: order ? [order] : [],
    };
  }

  async function auditTrail(actorAccountId, { limit = 50, offset = 0, action = null } = {}) {
    await assertAdmin(actorAccountId, { allowSupport: true });
    const where = action ? { action } : undefined;
    const [items, total] = await Promise.all([
      auditLogs.find({ where, limit, offset, sort: [['createdAt', 'desc']] }),
      auditLogs.count(where),
    ]);
    return { items, total };
  }

  /** Broadcast to every account, or to sellers only. Goes out on every channel. */
  async function broadcast(actorAccountId, { title, body, audience = 'all', data = {} }) {
    await assertAdmin(actorAccountId);
    let targets;
    if (audience === 'sellers') {
      const memberships = await db.collection(COLLECTIONS.memberships).find({ where: { role: 'owner' } });
      targets = [...new Set(memberships.map((m) => m.accountId))];
    } else {
      const rows = await db.collection(COLLECTIONS.accounts).find({ where: { status: 'active' } });
      targets = rows.map((r) => r.id);
    }
    for (const accountId of targets) {
      await services.notifications.queue({
        accountId,
        type: 'announcement',
        // A string goes to everyone as written; { fa, en } is picked per reader.
        render: (_t, locale) => ({ title: pickText(title, locale), body: pickText(body, locale) }),
        data,
      });
    }
    await audit(actorAccountId, 'broadcast.sent', {}, { audience, recipients: targets.length, title });
    return { recipients: targets.length };
  }

  /** `'text'` or `{ fa: '…', en: '…' }` → the version for `locale`. */
  function pickText(value, locale) {
    if (!value || typeof value !== 'object') return value ?? '';
    return value[locale] || value.fa || value.en || Object.values(value)[0] || '';
  }

  return {
    assertAdmin,
    audit,
    reviewQueue,
    listStores,
    listUsers,
    getMockupPrompts,
    setMockupPrompts,
    getSaleUnits,
    setSaleUnits,
    setAvatar,
    avatarFromTelegram,
    destroyStore,
    approveStore,
    rejectStore,
    suspendStore,
    setFeatured,
    setVerified,
    suspendAccount,
    restoreAccount,
    grantRole,
    lookup,
    auditTrail,
    broadcast,
    listSubscriptions,
    listTopups,
    decideTopup,
    getPayments,
    updatePaymentSettings,
    createPaymentCard,
    updatePaymentCard,
    archivePaymentCard,
    listPlans,
    updatePlan,
    createPlan,
    setAccountPlan,
    adjustWallet,
    createStoreFor,
    deleteStore,
  };
}
