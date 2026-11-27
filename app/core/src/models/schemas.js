/**
 * Single source of truth for collection names, enums and field schemas.
 * The bot, the storefront and the admin system all import these, which is what
 * keeps a value written on Telegram readable by the web app without translation.
 */

export const COLLECTIONS = {
  accounts: 'accounts',
  identities: 'identities',
  sessions: 'sessions',
  linkCodes: 'linkCodes',
  memberships: 'memberships',
  stores: 'stores',
  categories: 'categories',
  products: 'products',
  carts: 'carts',
  orders: 'orders',
  customers: 'customers',
  reviews: 'reviews',
  comments: 'comments',
  pages: 'pages',
  commentLikes: 'commentLikes',
  onboardings: 'onboardings',
  channelSessions: 'channelSessions',
  integrations: 'integrations',
  webhooks: 'webhooks',
  notifications: 'notifications',
  events: 'events',
  savedItems: 'savedItems',
  channelPosts: 'channelPosts',
  searchLogs: 'searchLogs',
  auditLogs: 'auditLogs',
  walletTransactions: 'walletTransactions',
  subscriptions: 'subscriptions',
  plans: 'plans',
  topups: 'topups',
  priceRequests: 'priceRequests',
  uploads: 'uploads',
  paymentCards: 'paymentCards',
  platformSettings: 'platformSettings',
  mockups: 'mockups',
  channelImports: 'channelImports',
  otpCodes: 'otpCodes',
  accessRequests: 'accessRequests',
};

/** Channels a user can reach Qbazz through. Identity linking unifies them. */
export const CHANNELS = ['telegram', 'web', 'email', 'phone', 'api'];

export const ACCOUNT_ROLES = ['user', 'support', 'admin'];
export const ACCOUNT_STATUS = ['active', 'suspended', 'deleted'];

export const STORE_ROLES = ['owner', 'manager', 'staff'];
export const STORE_STATUS = ['draft', 'pending_review', 'active', 'paused', 'rejected', 'suspended'];

export const PRODUCT_STATUS = ['draft', 'active', 'out_of_stock', 'archived'];

/**
 * `public`: the normal case — a real price, buyable through cart and checkout.
 * `inquire`: no price is shown; buyers get a "price on request" button that
 * opens a chat with the seller instead of Buy. Common for negotiable-price
 * goods, and what a channel-synced post becomes when no price could be read
 * from it — never skipped, never blocked, just live without a price tag.
 * `private`: a real price exists (required, same as `public`) but is hidden
 * until the seller grants a specific buyer access — wholesale pricing shown
 * only to approved retailers. See `services.access`.
 */
export const PRICE_VISIBILITY = ['public', 'inquire', 'private'];

export const ACCESS_REQUEST_STATUS = ['pending', 'approved', 'declined', 'revoked'];

export const ORDER_STATUS = ['pending', 'confirmed', 'preparing', 'ready', 'shipped', 'delivered', 'cancelled', 'refunded'];
export const PAYMENT_STATUS = ['unpaid', 'pending', 'paid', 'refund_pending', 'refunded', 'failed'];
// 'cash_on_delivery' stays in the list only so that orders placed before it was retired still read correctly.
export const PAYMENT_METHODS = ['online', 'bank_transfer', 'card', 'telegram_payments', 'crypto', 'other', 'cash_on_delivery'];

/**
 * How a shop can be paid: online through the gateway - always - and, if the shop adds a card, card-to-card.
 * Cash on delivery is gone; whatever a shop asks for, `online` is on and the rest is dropped.
 */
export const SELLABLE_PAYMENT_METHODS = ['online', 'bank_transfer'];
export function normalizePaymentMethods(list) {
  const wanted = [].concat(list || []);
  return ['online', ...SELLABLE_PAYMENT_METHODS.filter((m) => m !== 'online' && wanted.includes(m))];
}
export const SHIPPING_PAYER = ['buyer', 'seller'];
export const FULFILLMENT_METHODS = ['delivery', 'pickup', 'digital'];

/** Allowed order transitions. Enforced in one place so the bot and the dashboard agree. */
/**
 * Who carries an order. `site` is where a buyer can look a code up themselves - only home pages we are sure of.
 * "courier" is the shop's own rider and has no code to look up.
 */
export const CARRIERS = {
  post: { fa: 'پست جمهوری اسلامی', en: 'Iran Post', site: 'https://tracking.post.ir/' },
  tipax: { fa: 'تیپاکس', en: 'Tipax', site: 'https://tipaxco.com/' },
  chapar: { fa: 'چاپار', en: 'Chapar', site: 'https://chaparnet.com/' },
  courier: { fa: 'پیک فروشگاه', en: 'Shop courier', site: null },
  other: { fa: 'سایر', en: 'Other', site: null },
};

export const ORDER_TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'shipped', 'ready', 'cancelled'],
  preparing: ['ready', 'shipped', 'cancelled'],
  ready: ['shipped', 'delivered', 'cancelled'],
  shipped: ['delivered', 'cancelled'],
  delivered: ['refunded'],
  cancelled: [],
  refunded: [],
};

export const ONBOARDING_FLOWS = ['seller', 'buyer'];
export const ONBOARDING_STATUS = ['in_progress', 'completed', 'abandoned'];

// ---------------------------------------------------------------------------
// Field schemas (consumed by util/validate.js)
// ---------------------------------------------------------------------------

export const accountSchema = {
  displayName: { type: 'string', required: true, min: 1, max: 80 },
  email: { type: 'email' },
  phone: { type: 'phone' },
  avatarUrl: { type: 'string', max: 500 },
  locale: { type: 'string', max: 10 },
  role: { type: 'enum', values: ACCOUNT_ROLES, default: 'user' },
  status: { type: 'enum', values: ACCOUNT_STATUS, default: 'active' },
};

export const storeSchema = {
  name: { type: 'string', required: true, min: 2, max: 80 },
  tagline: { type: 'string', max: 160 },
  description: { type: 'string', max: 2000 },
  logoUrl: { type: 'string', max: 500 },
  bannerUrl: { type: 'string', max: 500 },
  currency: { type: 'string', min: 3, max: 3, transform: (v) => v.toUpperCase() },
  categoryIds: { type: 'array', of: { type: 'string' }, default: () => [] },
  tags: { type: 'array', of: { type: 'string' }, default: () => [] },
  location: {
    type: 'object',
    partial: true,
    schema: {
      country: { type: 'string', max: 60 },
      city: { type: 'string', max: 80 },
      address: { type: 'string', max: 200 },
      lat: { type: 'number' },
      lng: { type: 'number' },
    },
  },
  contact: {
    type: 'object',
    partial: true,
    schema: {
      telegram: { type: 'string', max: 64 },
      phone: { type: 'phone' },
      email: { type: 'email' },
      website: { type: 'string', max: 200 },
      instagram: { type: 'string', max: 200 },
    },
  },
  settings: {
    type: 'object',
    partial: true,
    schema: {
      paymentMethods: { type: 'array', of: { type: 'string' } },
      fulfillmentMethods: { type: 'array', of: { type: 'string' } },
      deliveryFee: { type: 'int', min: 0 },
      // Who bears the delivery cost: the buyer (deliveryFee is added to the order) or the seller (the buyer pays nothing for it).
      shippingPayer: { type: 'enum', values: SHIPPING_PAYER },
      // Where a card-to-card (bank_transfer) buyer sends the money. Shown only on their own order.
      paymentCard: { type: 'object', partial: true, schema: { number: { type: 'string', max: 32 }, holder: { type: 'string', max: 80 } } },
      freeDeliveryOver: { type: 'int', min: 0 },
      minOrder: { type: 'int', min: 0 },
      prepTimeMinutes: { type: 'int', min: 0 },
      autoConfirmOrders: { type: 'bool' },
      orderNotice: { type: 'string', max: 300 },
    },
  },
};

export const propertySchema = {
  name: { type: 'string', required: true, min: 1, max: 40 },
  value: { type: 'string', required: true, min: 1, max: 80 },
  confident: { type: 'bool', default: true },
};

export const productSchema = {
  title: { type: 'string', required: true, min: 2, max: 140 },
  // Search-engine metadata for the product page, written by the AI (or the offline rules) and kept editable.
  seo: {
    type: 'object',
    partial: true,
    schema: {
      metaTitle: { type: 'string', max: 80 },
      metaDescription: { type: 'string', max: 200 },
      keywords: { type: 'array', of: { type: 'string' } },
      imageAlt: { type: 'string', max: 160 },
      optimizedAt: { type: 'string', max: 40 },
      provider: { type: 'string', max: 20 },
      // What the seller wrote before the rewrite, so it can be put back.
      original: { type: 'object', partial: true, schema: { title: { type: 'string', max: 140 }, description: { type: 'string', max: 4000 } } },
    },
  },
  description: { type: 'string', max: 4000 },
  // Required only when priceVisibility is 'public' — enforced in catalog.js,
  // since that's a cross-field rule a flat schema can't express.
  price: { type: 'int', min: 0, nullable: true, label: 'Price' },
  priceVisibility: { type: 'enum', values: PRICE_VISIBILITY, default: 'public' },
  // Where the product came from. 'channel_sync' means this product *is* a
  // channel post already, so the reaction that pushes new products back out
  // to the channel skips it — nothing echoes into the audience it came from.
  source: { type: 'enum', values: ['manual', 'channel_sync'], default: 'manual' },
  compareAtPrice: { type: 'int', min: 0 },
  currency: { type: 'string', min: 3, max: 3, transform: (v) => v.toUpperCase() },
  images: { type: 'array', of: { type: 'string' }, default: () => [] },
  /**
   * The Telegram `file_id` behind each image the bot itself uploaded, same
   * index as `images`. Telegram's own `getFile` download URL cannot reliably
   * be handed back to Telegram as a photo source ("failed to get HTTP URL
   * content") — resending the original file_id is what actually works, so the
   * channel poster prefers this when it has one. `images` stays the plain
   * URL for everything else (search, the web storefront, product pages).
   */
  telegramFileIds: { type: 'array', of: { type: 'string' }, default: () => [] },
  // One short video per product: the web copy this server made (services/videos.js) and its still frame
  videoUrl: { type: 'string', max: 300 },
  videoPoster: { type: 'string', max: 300 },
  /** The Telegram file_id of that video when it came from Telegram: resending it costs nothing. */
  telegramVideoId: { type: 'string', max: 200 },
  categoryId: { type: 'string', max: 64 },
  tags: { type: 'array', of: { type: 'string' }, default: () => [] },
  stock: { type: 'int', min: 0, nullable: true },
  sku: { type: 'string', max: 64 },
  status: { type: 'enum', values: PRODUCT_STATUS, default: 'draft' },
  options: { type: 'array', default: () => [] },
  variants: { type: 'array', default: () => [] },
  /**
   * How it is sold: `piece` (the default - price and stock are per item) or `pack` of `size` pieces at one price, named
   * `label` (pack, series, set, carton). Price, stock and the cart's quantity then all count packs.
   */
  saleUnit: { type: 'object', partial: true, schema: { kind: { type: 'enum', values: ['piece', 'pack'] }, size: { type: 'int', min: 2, max: 1000 }, label: { type: 'string', max: 20 } } },
  /**
   * Structured specifications — size, material, weight, warranty. Rendered in
   * the channel post, on the product page, and used as search keywords, so
   * they live on the product rather than being buried in the description.
   */
  properties: { type: 'array', of: { type: 'object', schema: propertySchema }, default: () => [] },
};


export const orderContactSchema = {
  name: { type: 'string', required: true, min: 2, max: 80 },
  phone: { type: 'phone', required: true },
  note: { type: 'string', max: 500 },
};

export const addressSchema = {
  label: { type: 'string', max: 40 },
  line1: { type: 'string', max: 200 },
  city: { type: 'string', max: 80 },
  country: { type: 'string', max: 60 },
  postalCode: { type: 'string', max: 20 },
  lat: { type: 'number' },
  lng: { type: 'number' },
};

export const categorySchema = {
  name: { type: 'string', required: true, min: 2, max: 60 },
  icon: { type: 'string', max: 8 },
  parentId: { type: 'string', max: 64, nullable: true },
  order: { type: 'int', default: 0 },
  description: { type: 'string', max: 300 },
};
