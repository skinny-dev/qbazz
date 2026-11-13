/**
 * Subscription plans — one per account (not per store): a seller with
 * multiple shops buys a single plan that covers all of them.
 *
 * Two kinds of limit:
 *  - LIVE (`stores`, `members`): counted as they exist right now — how many
 *    shops the account owns, how many team members sit on those shops.
 *  - QUOTAS (`products`, `orders`, `aiCredits`): used up and reset when the
 *    plan renews. `orders` is unlimited on every current plan — nothing
 *    enforces an order ceiling today.
 *
 * `aiCredits` is one shared pool for every AI feature that costs something to
 * run — a generated caption and a product mockup both spend from it.
 *
 * `null` on a limit means unlimited. `free` is a time-boxed trial
 * (`trialDays`), not a permanent tier — it renews on that schedule instead of
 * monthly, but there is deliberately no auto-enforced "trial over" lockout
 * yet: that is a real product decision (suspend the shop? force an upgrade
 * prompt?) this file does not make on its own.
 *
 * `features` are on/off capabilities rather than quotas. Today only
 * `privatePricing` (wholesale prices unlocked per buyer) is enforced.
 *
 * These are the SEED values. Plans live in the database once the core has
 * booted (`subscriptions.init()` writes them the first time), where a
 * platform admin edits prices, limits and features without a deploy — so
 * changing a number here only affects a brand-new install. Numbers marked
 * "inferred" were never specified.
 */
export const DEFAULT_PLANS = {
  free: {
    id: 'free',
    order: 0,
    name: { en: 'Free', fa: 'رایگان' },
    price: 0,
    currency: 'IRT',
    period: 'trial',
    trialDays: 7,
    limits: { stores: 1, members: 0, products: null, orders: null, aiCredits: 5 },
    features: { privatePricing: false },
    active: true,
  },
  beginner: {
    id: 'beginner',
    order: 1,
    name: { en: 'Beginner', fa: 'مبتدی' },
    price: 500000, // inferred — no price given
    currency: 'IRT',
    period: 'monthly',
    limits: { stores: 1, members: 1, products: 50, orders: null, aiCredits: 100 },
    features: { privatePricing: false },
    active: true,
  },
  medium: {
    id: 'medium',
    order: 2,
    name: { en: 'Medium', fa: 'متوسط' },
    price: 1500000, // inferred — no price given
    currency: 'IRT',
    period: 'monthly',
    limits: { stores: 3, members: 3, products: 200, orders: null, aiCredits: 600 },
    features: { privatePricing: true },
    active: true,
  },
  enterprise: {
    id: 'enterprise',
    order: 3,
    name: { en: 'Enterprise', fa: 'سازمانی' },
    price: 4000000, // inferred — no price given
    currency: 'IRT',
    period: 'monthly',
    limits: { stores: 10, members: 10, products: null, orders: null, aiCredits: 2000 }, // products/aiCredits inferred
    features: { privatePricing: true },
    active: true,
  },
};

export const DEFAULT_PLAN_ID = 'free';

/**
 * One-off top-ups of a quota, bought from the wallet when a plan's allowance
 * runs out before the period does. Bought units are a balance of their own:
 * they are spent only after the plan's allowance is used up and, unlike the
 * allowance, they do NOT reset on renewal — what you paid for stays yours.
 * Prices are inferred (none were specified) and priced in IRT like the plans.
 */
export const CREDIT_PACKS = [
  { id: 'ai_50', resource: 'aiCredits', amount: 50, price: 150000, currency: 'IRT' },
  { id: 'ai_200', resource: 'aiCredits', amount: 200, price: 500000, currency: 'IRT' },
  { id: 'products_25', resource: 'products', amount: 25, price: 200000, currency: 'IRT' },
  { id: 'products_100', resource: 'products', amount: 100, price: 650000, currency: 'IRT' },
];

/** Quotas that can be topped up with a pack. */
export const PACK_RESOURCES = ['aiCredits', 'products'];

/** Every resource a plan limits. */
export const PLAN_RESOURCES = ['stores', 'members', 'products', 'orders', 'aiCredits'];

/** Counted as they exist right now; never "consumed", never reset on renewal. */
export const LIVE_RESOURCES = ['stores', 'members'];

/** On/off capabilities a plan can include. */
export const PLAN_FEATURES = ['privatePricing'];
