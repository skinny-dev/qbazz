import { COLLECTIONS } from '../models/schemas.js';
import { DEFAULT_PLANS, DEFAULT_PLAN_ID, PLAN_RESOURCES, LIVE_RESOURCES, PLAN_FEATURES, CREDIT_PACKS, PACK_RESOURCES } from '../models/plans.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../util/ids.js';

/** One concrete, translatable message per resource — bespoke reads better than a generic "{resource} limit reached". */
const LIMIT_ERROR_KEY = {
  stores: 'err.plan_stores_limit',
  members: 'err.plan_members_limit',
  products: 'err.plan_products_limit',
  orders: 'err.plan_orders_limit',
  aiCredits: 'err.plan_ai_credits',
};

const FEATURE_ERROR_KEY = {
  privatePricing: 'err.plan_feature_private_pricing',
};

/**
 * One subscription per account — not per store. A seller with several shops
 * buys a single plan that covers all of them. `stores` and `members` are
 * counted live (what the account owns right now); `products`, `orders` and
 * `aiCredits` are quotas that reset when the plan renews. `aiCredits` is one
 * shared pool — a generated caption and a product mockup both spend from the
 * same number, there is no separate allowance per AI feature.
 *
 * Plans themselves are data, not code: `init()` seeds the defaults from
 * `models/plans.js` the first time, and from then on a platform admin edits
 * them (price, limits, features, visibility) through `updatePlan`. They are
 * cached in memory so lookups stay cheap; every write refreshes the cache.
 *
 * A subscription row is created lazily, on first read — the same "self-heal"
 * approach the rest of the core uses for data that predates a feature,
 * rather than a migration that has to touch every account up front.
 */
export function createSubscriptionsService(ctx) {
  const { store: db, config, events, services } = ctx;
  const subs = db.collection(COLLECTIONS.subscriptions);
  const plansDb = db.collection(COLLECTIONS.plans);
  const stores = db.collection(COLLECTIONS.stores);
  const memberships = db.collection(COLLECTIONS.memberships);

  /** id → plan, refreshed from the database. Falls back to the seed before `init()` has run. */
  let planCache = new Map(Object.entries(DEFAULT_PLANS));

  async function refreshPlans() {
    const rows = await plansDb.find({});
    planCache = new Map(rows.map((row) => [row.id, normalizePlan(row)]));
    return planCache;
  }

  /** Fills anything a stored plan predates (a newer limit or feature) from the seed of the same id. */
  function normalizePlan(row) {
    const seed = DEFAULT_PLANS[row.id] || {};
    const limits = {};
    for (const resource of PLAN_RESOURCES) {
      limits[resource] = row.limits && resource in row.limits ? row.limits[resource] : (seed.limits?.[resource] ?? null);
    }
    const features = {};
    for (const feature of PLAN_FEATURES) {
      features[feature] = row.features && feature in row.features ? !!row.features[feature] : !!seed.features?.[feature];
    }
    return { ...row, limits, features, active: row.active !== false };
  }

  async function init() {
    for (const plan of Object.values(DEFAULT_PLANS)) {
      if (!(await plansDb.get(plan.id))) await plansDb.insert(structuredClone(plan));
    }
    await refreshPlans();
    await grantWelcomeCredits();
  }

  /** Accounts that existed before the welcome credits were switched on get them once, too. Safe to run on every boot. */
  async function grantWelcomeCredits() {
    const welcome = config.platform.welcomeAiCredits || 0;
    if (welcome <= 0) return 0;
    let granted = 0;
    for (const row of await subs.find({ where: (r) => !r.welcomeGranted })) {
      await subs.update(row.id, { bonus: { ...(row.bonus || {}), aiCredits: (Number(row.bonus?.aiCredits) || 0) + welcome }, welcomeGranted: true });
      granted += 1;
    }
    return granted;
  }

  function plan(id) {
    return planCache.get(id) || planCache.get(DEFAULT_PLAN_ID);
  }

  function freshUsage() {
    return { periodStart: new Date().toISOString(), products: 0, orders: 0, aiCredits: 0 };
  }

  function addMonths(iso, n) {
    const d = new Date(iso);
    d.setMonth(d.getMonth() + n);
    return d.toISOString();
  }

  function addDays(iso, n) {
    const d = new Date(iso);
    d.setDate(d.getDate() + n);
    return d.toISOString();
  }

  /** A time-boxed plan (the free trial) renews on its own schedule; everything else is monthly. */
  function nextRenewal(iso, p) {
    return p.trialDays ? addDays(iso, p.trialDays) : addMonths(iso, 1);
  }

  async function ensure(accountId) {
    const existing = await subs.findOne({ accountId });
    if (existing) return existing;
    const now = new Date().toISOString();
    const welcome = config.platform.welcomeAiCredits || 0;
    return subs.insert({
      id: newId('sub'),
      accountId,
      planId: DEFAULT_PLAN_ID,
      startedAt: now,
      renewsAt: nextRenewal(now, plan(DEFAULT_PLAN_ID)),
      usage: freshUsage(),
      ...(welcome > 0 ? { bonus: { aiCredits: welcome }, welcomeGranted: true } : {}),
    });
  }

  /**
   * A free-of-charge plan (the trial included) "renews" on schedule
   * automatically. A paid plan renews by charging the wallet again; if that
   * fails (not enough balance), the account drops to the default plan rather
   * than being left in a plan it is not paying for, or silently kept on
   * credit. There is deliberately no other consequence built in yet for a
   * trial that runs out — see the note on `free` in `models/plans.js`.
   */
  async function maybeRenew(accountId) {
    const sub = await ensure(accountId);
    if (new Date(sub.renewsAt) > new Date()) return sub;

    const current = plan(sub.planId);
    if (current.price > 0) {
      try {
        await services.wallet.debit(accountId, current.price, { reason: 'plan_renewal', meta: { planId: current.id } });
        const renewed = await subs.update(sub.id, { renewsAt: nextRenewal(sub.renewsAt, current), usage: freshUsage(), notified: {} });
        await events.emit('subscription.renewed', { accountId, planId: current.id });
        return renewed;
      } catch {
        // Insufficient balance: fall through to the downgrade below.
      }
      const fallback = plan(DEFAULT_PLAN_ID);
      // The plan could not be paid for: the account is on the free plan and the grace period before orders close starts now.
      const downgraded = await subs.update(sub.id, { planId: DEFAULT_PLAN_ID, renewsAt: nextRenewal(new Date().toISOString(), fallback), usage: freshUsage(), lapsedAt: new Date().toISOString(), notified: {} });
      await events.emit('subscription.downgraded', { accountId, fromPlanId: current.id, toPlanId: DEFAULT_PLAN_ID, reason: 'insufficient_balance' });
      return downgraded;
    }

    // No charge due: just roll the window forward. A free *trial* that has run its course counts as lapsed, from the day it ended.
    const trialOver = Boolean(current.trialDays) && !sub.lapsedAt;
    return subs.update(sub.id, { renewsAt: nextRenewal(sub.renewsAt, current), usage: freshUsage(), ...(trialOver ? { lapsedAt: sub.renewsAt, notified: {} } : {}) });
  }

  async function getSubscription(accountId) {
    return maybeRenew(accountId);
  }

  // ---- a plan that has lapsed ---------------------------------------------------------------------------------
  //
  // 'ok' - paid up, or never lapsed. 'grace' - lapsed, orders still open for `subscriptionGraceDays`. 'closed' - the grace
  // is over: the shop takes no NEW orders (when the platform enforces it). What was ordered before carries on.

  function accessOf(sub) {
    if (!sub.lapsedAt) return { state: 'ok', lapsedAt: null, closesAt: null };
    const graceMs = (config.platform.subscriptionGraceDays ?? 3) * 86400000;
    const closesAt = new Date(new Date(sub.lapsedAt).getTime() + graceMs).toISOString();
    return { state: Date.now() < new Date(closesAt).getTime() ? 'grace' : 'closed', lapsedAt: sub.lapsedAt, closesAt };
  }

  async function access(accountId) {
    return accessOf(await getSubscription(accountId));
  }

  /** May this owner's shops take a new order? Always, unless the platform enforces subscriptions and the grace is over. */
  async function ordersOpen(accountId) {
    if (!config.platform.enforceSubscriptions) return true;
    return (await access(accountId)).state !== 'closed';
  }

  async function notifyOwner(accountId, kind, params = {}) {
    await services.notifications.queue({
      accountId,
      type: `subscription.${kind}`,
      render: (t, locale) => ({
        title: t(`notif.sub.${kind}.title`),
        body: t(`notif.sub.${kind}.body`, { ...params, ...(params.date ? { date: new Date(params.date).toLocaleDateString(locale === 'fa' ? 'fa-IR' : 'en-US') } : {}) }),
      }),
      data: { action: 'open_plans' },
      priority: 'high',
    });
  }

  /**
   * Run now and then (hourly): lets what is due renew or lapse, and tells each owner once about each step - a plan about to end
   * that the wallet cannot cover, the grace that has started, the orders that have closed. Does nothing unless enforced.
   */
  async function sweep() {
    if (!config.platform.enforceSubscriptions) return { checked: 0, notified: 0 };
    let checked = 0;
    let notified = 0;
    for (const row of await subs.find({})) {
      checked += 1;
      const sub = await getSubscription(row.accountId);
      const flags = { ...(sub.notified || {}) };
      const tell = async (key, kind, params) => {
        if (flags[key]) return;
        flags[key] = new Date().toISOString();
        await notifyOwner(sub.accountId, kind, params);
        notified += 1;
      };
      const acc = accessOf(sub);
      if (acc.state === 'ok') {
        const p = plan(sub.planId);
        const left = new Date(sub.renewsAt).getTime() - Date.now();
        const trial = Boolean(p.trialDays);
        const short = !trial && p.price > 0 && ((await services.wallet.getBalance(sub.accountId)).balanceMinor || 0) < p.price;
        if (trial || short) {
          const kind = trial ? 'soon_trial' : 'soon_paid';
          if (left <= 86400000) await tell('soon1', kind, { date: sub.renewsAt });
          else if (left <= 3 * 86400000) await tell('soon3', kind, { date: sub.renewsAt });
        }
      } else {
        await tell('lapsed', 'lapsed', { date: acc.closesAt });
        if (acc.state === 'closed') await tell('closed', 'closed');
      }
      if (JSON.stringify(flags) !== JSON.stringify(sub.notified || {})) await subs.update(sub.id, { notified: flags });
    }
    return { checked, notified };
  }

  /** Stores are counted live — created, not "used up" like a quota. */
  async function storesInUse(accountId) {
    return stores.count({ ownerAccountId: accountId });
  }

  /** Team members across every shop this account owns (the owner themself is not counted). */
  async function membersInUse(accountId) {
    const owned = await stores.find({ where: { ownerAccountId: accountId } });
    let n = 0;
    for (const s of owned) n += await memberships.count({ storeId: s.id, role: { $ne: 'owner' } });
    return n;
  }

  async function liveUsage(accountId, resource) {
    return resource === 'stores' ? storesInUse(accountId) : membersInUse(accountId);
  }

  /** Plan, usage, and what is left of each quota — the shape a UI wants. */
  async function summary(accountId) {
    const sub = await getSubscription(accountId);
    const p = plan(sub.planId);

    const resources = {};
    for (const resource of PLAN_RESOURCES) {
      const limit = p.limits[resource];
      const used = LIVE_RESOURCES.includes(resource) ? await liveUsage(accountId, resource) : sub.usage[resource] || 0;
      const bonus = bonusOf(sub, resource);
      resources[resource] = { limit, used, bonus, remaining: limit === null ? null : Math.max(0, limit - used) + bonus };
    }
    return {
      plan: p,
      subscription: sub,
      resources,
      features: { ...p.features },
      canAddStore: resources.stores.remaining === null || resources.stores.remaining > 0,
      access: accessOf(sub),
      enforced: Boolean(config.platform.enforceSubscriptions),
    };
  }

  /** Throws when using `by` more of `resource` would exceed the plan's limit. `null` limit = unlimited. */
  async function checkLimit(accountId, resource, by = 1) {
    if (!PLAN_RESOURCES.includes(resource)) throw new Error(`Unknown plan resource: ${resource}`);
    const sub = await getSubscription(accountId);
    const limit = plan(sub.planId).limits[resource];
    if (limit === null) return true;

    const used = LIVE_RESOURCES.includes(resource) ? await liveUsage(accountId, resource) : sub.usage[resource] || 0;
    // Bought units cover what the plan's allowance cannot.
    const available = Math.max(0, limit - used) + bonusOf(sub, resource);
    if (by > available) {
      // `buyable` tells a client it can offer "buy more" instead of only "upgrade".
      throw new ConflictError(LIMIT_ERROR_KEY[resource], { resource, limit, used, buyable: PACK_RESOURCES.includes(resource) }, { limit });
    }
    return true;
  }

  async function hasFeature(accountId, feature) {
    const sub = await getSubscription(accountId);
    return !!plan(sub.planId).features[feature];
  }

  /** Throws a translatable "upgrade to use this" error when the plan lacks the feature. */
  async function requireFeature(accountId, feature) {
    if (!PLAN_FEATURES.includes(feature)) throw new Error(`Unknown plan feature: ${feature}`);
    if (!(await hasFeature(accountId, feature))) {
      throw new ConflictError(FEATURE_ERROR_KEY[feature], { feature });
    }
    return true;
  }

  /** Checks, then records the use — for the quota resources, never for the live ones. */
  async function consume(accountId, resource, amount = 1) {
    if (LIVE_RESOURCES.includes(resource)) throw new Error(`${resource} is counted live, not consumed`);
    await checkLimit(accountId, resource, amount);
    const sub = await getSubscription(accountId);
    const limit = plan(sub.planId).limits[resource];
    const updated = await subs.mutate(sub.id, (draft) => {
      // The plan's own allowance goes first; only the overflow touches bought units.
      const inPlan = limit === null ? amount : Math.min(amount, Math.max(0, limit - (draft.usage[resource] || 0)));
      draft.usage = { ...draft.usage, [resource]: (draft.usage[resource] || 0) + inPlan };
      if (amount > inPlan) draft.bonus = { ...(draft.bonus || {}), [resource]: Math.max(0, bonusOf(draft, resource) - (amount - inPlan)) };
      return draft;
    });
    return updated.usage[resource];
  }

  // ---- bought credit packs -------------------------------------------------

  const bonusOf = (sub, resource) => Number(sub?.bonus?.[resource]) || 0;

  function listPacks() {
    return CREDIT_PACKS.map((pack) => ({ ...pack }));
  }

  /** Pays for a pack from the wallet and adds its units. Insufficient balance fails before anything changes. */
  async function buyPack(accountId, packId, { actorAccountId = null } = {}) {
    const pack = CREDIT_PACKS.find((p) => p.id === packId);
    if (!pack) throw ValidationError.of('packId', 'err.unknown_pack');
    const sub = await getSubscription(accountId);
    await services.wallet.debit(accountId, pack.price, { reason: 'credit_pack', actorAccountId, meta: { packId: pack.id, resource: pack.resource, amount: pack.amount } });
    const updated = await subs.mutate(sub.id, (draft) => {
      draft.bonus = { ...(draft.bonus || {}), [pack.resource]: bonusOf(draft, pack.resource) + pack.amount };
      return draft;
    });
    await events.emit('subscription.pack_bought', { accountId, packId: pack.id, resource: pack.resource, amount: pack.amount });
    return { pack, bonus: bonusOf(updated, pack.resource) };
  }

  function assertPurchasable(planId, { admin = false } = {}) {
    const p = planCache.get(planId);
    if (!p || (!admin && !p.active)) throw ValidationError.of('planId', 'err.unknown_plan');
    return p;
  }

  async function changePlan(accountId, planId, { actorAccountId = null } = {}) {
    const p = assertPurchasable(planId);
    const sub = await getSubscription(accountId);
    if (sub.planId === planId) throw new ConflictError('err.plan_already_on');

    // Moving down must not strand what the account already has.
    for (const resource of LIVE_RESOURCES) {
      const limit = p.limits[resource];
      if (limit === null) continue;
      const used = await liveUsage(accountId, resource);
      if (used > limit) throw new ConflictError(`err.plan_downgrade_${resource}`, { resource, limit, used }, { limit, used });
    }

    if (p.price > 0) await services.wallet.debit(accountId, p.price, { reason: 'plan_change', actorAccountId, meta: { planId } });
    const now = new Date().toISOString();
    const updated = await subs.update(sub.id, { planId, startedAt: now, renewsAt: nextRenewal(now, p), usage: freshUsage(), lapsedAt: null, notified: {} });
    await events.emit('subscription.changed', { accountId, planId, actorAccountId });
    return updated;
  }

  /**
   * An admin granting a plan directly — a comp, a manual/offline payment, a
   * support gesture. No wallet charge: whatever paid for this happened
   * outside the app, which is also the whole reason a wallet top-up is an
   * admin action right now rather than a real checkout.
   */
  async function adminSetPlan(accountId, planId, { actorAccountId = null } = {}) {
    const p = assertPurchasable(planId, { admin: true });
    const sub = await getSubscription(accountId);
    const now = new Date().toISOString();
    const updated = await subs.update(sub.id, { planId, startedAt: now, renewsAt: nextRenewal(now, p), usage: freshUsage(), lapsedAt: null, notified: {} });
    await events.emit('subscription.changed', { accountId, planId, actorAccountId, admin: true });
    return updated;
  }

  // ---- plan catalogue (admin-editable) ------------------------------------

  /** Every plan, cheapest first. The public picker only sees active plans; an admin sees all. */
  function listPlans({ includeInactive = false } = {}) {
    return [...planCache.values()]
      .filter((p) => includeInactive || p.active)
      .sort((a, b) => a.order - b.order);
  }

  function badNumber(field, label) {
    return ValidationError.of(field, 'validation.number', { field: label });
  }

  function cleanLimit(field, value) {
    if (value === null || value === '' || value === undefined) return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw badNumber(`limits.${field}`, field);
    return n;
  }

  function cleanPlanPatch(patch, { creating = false } = {}) {
    const out = {};
    if (patch.name !== undefined || creating) {
      const name = patch.name && typeof patch.name === 'object' ? patch.name : { en: String(patch.name || '').trim() };
      if (!String(name.en || name.fa || '').trim()) throw ValidationError.of('name', 'validation.required', { field: 'Name' });
      out.name = { en: String(name.en || name.fa).trim(), fa: String(name.fa || name.en).trim() };
    }
    if (patch.price !== undefined) {
      const price = Number(patch.price);
      if (!Number.isInteger(price) || price < 0) throw badNumber('price', 'Price');
      out.price = price;
    }
    if (patch.currency !== undefined) out.currency = String(patch.currency).toUpperCase();
    if (patch.order !== undefined) {
      const order = Number(patch.order);
      if (!Number.isInteger(order)) throw badNumber('order', 'Order');
      out.order = order;
    }
    if (patch.trialDays !== undefined) {
      const days = patch.trialDays === null || patch.trialDays === '' ? null : Number(patch.trialDays);
      if (days !== null && (!Number.isInteger(days) || days < 1)) throw badNumber('trialDays', 'Trial days');
      out.trialDays = days;
      out.period = days ? 'trial' : 'monthly';
    }
    if (patch.limits) {
      out.limits = {};
      for (const [field, value] of Object.entries(patch.limits)) {
        if (PLAN_RESOURCES.includes(field)) out.limits[field] = cleanLimit(field, value);
      }
    }
    if (patch.features) {
      out.features = {};
      for (const [field, value] of Object.entries(patch.features)) {
        if (PLAN_FEATURES.includes(field)) out.features[field] = !!value;
      }
    }
    if (patch.active !== undefined) out.active = !!patch.active;
    return out;
  }

  async function updatePlan(planId, patch, { actorAccountId = null } = {}) {
    const existing = planCache.get(planId);
    if (!existing) throw new NotFoundError('Plan', planId);
    const clean = cleanPlanPatch(patch);
    // Everyone starts on the default plan, so it has to stay free and available.
    if (planId === DEFAULT_PLAN_ID && (clean.active === false || (clean.price !== undefined && clean.price > 0))) {
      throw new ConflictError('err.plan_default_locked');
    }

    const next = {
      ...clean,
      limits: { ...existing.limits, ...(clean.limits || {}) },
      features: { ...existing.features, ...(clean.features || {}) },
    };
    await plansDb.update(planId, next);
    await refreshPlans();
    await events.emit('plan.updated', { planId, actorAccountId, patch: clean });
    return planCache.get(planId);
  }

  async function createPlan(input, { actorAccountId = null } = {}) {
    const id = String(input.id || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{1,30}$/.test(id)) throw ValidationError.of('id', 'validation.format', { field: 'Plan id' });
    if (planCache.has(id)) throw new ConflictError('err.plan_exists');
    const clean = cleanPlanPatch(input, { creating: true });
    const order = clean.order ?? Math.max(0, ...[...planCache.values()].map((p) => p.order)) + 1;
    const limits = {};
    for (const resource of PLAN_RESOURCES) limits[resource] = clean.limits && resource in clean.limits ? clean.limits[resource] : null;
    const features = {};
    for (const feature of PLAN_FEATURES) features[feature] = !!clean.features?.[feature];
    await plansDb.insert({
      id,
      order,
      name: clean.name,
      price: clean.price ?? 0,
      currency: clean.currency || 'IRT',
      period: clean.trialDays ? 'trial' : 'monthly',
      ...(clean.trialDays ? { trialDays: clean.trialDays } : {}),
      limits,
      features,
      active: clean.active !== false,
    });
    await refreshPlans();
    await events.emit('plan.created', { planId: id, actorAccountId });
    return planCache.get(id);
  }

  return {
    init,
    getSubscription,
    summary,
    checkLimit,
    consume,
    hasFeature,
    requireFeature,
    access,
    ordersOpen,
    sweep,
    listPacks,
    buyPack,
    changePlan,
    adminSetPlan,
    storesInUse,
    membersInUse,
    listPlans,
    getPlan: (id) => planCache.get(id) || null,
    updatePlan,
    createPlan,
  };
}
