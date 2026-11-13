/**
 * Message formatting. Telegram HTML mode — escape anything user-supplied.
 *
 * Every function that produces words takes `tx` (see i18n/index.js) first: it
 * carries the reader's language, their digits, their currency format and their
 * calendar. Nothing here formats a number or a price itself, because doing it
 * once in the wrong place (`amount / 100`, `en-US`) is exactly how a Toman price
 * ends up a hundred times too small.
 */

export function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const b = (text) => `<b>${esc(text)}</b>`;
export const i = (text) => `<i>${esc(text)}</i>`;
export const code = (text) => `<code>${esc(text)}</code>`;
export const link = (text, url) => `<a href="${esc(url)}">${esc(text)}</a>`;

export function lines(...parts) {
  return parts.filter((part) => part !== null && part !== undefined && part !== '').join('\n');
}

export function stars(tx, rating) {
  if (!rating) return '';
  return `${'★'.repeat(Math.round(rating))}${'☆'.repeat(Math.max(0, 5 - Math.round(rating)))} ${tx.n(rating)}`;
}

/**
 * Price with its strike-through original, in the reader's currency format —
 * or, for a "price on request" product (no `price` object at all), the
 * inquire label instead of a number.
 */
export function priceText(tx, card) {
  if (!card.price) return tx.t('b.render.inquire_price');
  const now = tx.money(card.price.amount, card.price.currency);
  if (!card.compareAtPrice) return now;
  return `${now} <s>${esc(tx.money(card.compareAtPrice.amount, card.compareAtPrice.currency))}</s>`;
}

/**
 * `typeEmoji` is opt-in — most listings are all one kind (a shop's own product
 * list, the trending feed) and a leading icon would just be noise there. It
 * earns its place only where shop and product results sit mixed together, so
 * search passes one and everything else leaves it out.
 */
export function productLine(tx, card, index = null, typeEmoji = null) {
  const prefix = index === null ? '•' : tx.idx(index);
  const stock = card.inStock ? '' : ` · ${tx.t('b.render.out_of_stock')}`;
  return `${prefix} ${typeEmoji ? `${typeEmoji} ` : ''}${b(card.title)}\n   ${priceText(tx, card)}${stock} · ${esc(card.subtitle)}`;
}

export function storeLine(tx, card, index = null, typeEmoji = null) {
  const prefix = index === null ? '•' : tx.idx(index);
  const badges = [card.verified ? '✅' : '', card.featured ? '⭐' : ''].filter(Boolean).join('');
  const meta = [
    card.city,
    card.productCount ? tx.t('b.render.items', { count: card.productCount }) : null,
    card.rating ? stars(tx, card.rating) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return `${prefix} ${typeEmoji ? `${typeEmoji} ` : ''}${b(card.title)} ${badges}\n   ${esc(meta)}`;
}

export function productDetailText(tx, detail) {
  const { product, store } = detail;
  const properties = (product.properties || [])
    .slice(0, 8)
    .map((entry) => `• ${esc(entry.name)}: ${esc(entry.value)}`)
    .join('\n');

  return lines(
    b(product.title),
    product.compareAtPrice
      ? `${priceText(tx, product)}  ${tx.t('b.render.discount', { percent: product.discountPercent })}`
      : priceText(tx, product),
    '',
    product.description ? esc(truncate(product.description, 600)) : null,
    properties ? `\n${properties}` : null,
    '',
    store ? `🏪 ${esc(store.title)}${store.verified ? ' ✅' : ''}` : null,
    product.rating ? stars(tx, product.rating) : null,
    product.inStock
      ? (product.stock !== null && product.stock !== undefined ? tx.t('b.render.in_stock', { stock: product.stock }) : '')
      : tx.t('b.render.unavailable'),
  );
}

export function storefrontText(tx, view) {
  const { store } = view;
  const settings = store.settings || {};
  const delivery = settings.deliveryFee && settings.shippingPayer !== 'seller'
    ? tx.t('b.render.delivery_from', { fee: tx.money(settings.deliveryFee, store.currency) })
    : settings.fulfillmentMethods?.includes('delivery')
      ? tx.t('b.render.free_delivery')
      : null;

  return lines(
    `${b(store.title)}${store.verified ? ' ✅' : ''}${store.featured ? ' ⭐' : ''}`,
    store.subtitle ? i(store.subtitle) : null,
    '',
    store.description ? esc(truncate(store.description, 400)) : null,
    '',
    store.city ? `📍 ${esc(store.city)}` : null,
    store.rating ? stars(tx, store.rating) : null,
    delivery ? `🚚 ${esc(delivery)}` : null,
    settings.orderNotice ? `ℹ️ ${esc(settings.orderNotice)}` : null,
    view.open === false ? tx.t('b.render.closed') : null,
  );
}

export function cartText(tx, cart) {
  const currency = cart.totals.currency;
  const items = cart.items
    .map((item, index) => `${tx.idx(index + 1)} ${b(item.title)}${item.variantTitle ? ` (${esc(item.variantTitle)})` : ''}\n   ${tx.n(item.quantity)} × ${tx.money(item.unitPrice, currency)}`)
    .join('\n');

  return lines(
    `🛒 ${b(cart.storeName)}`,
    '',
    items || i(tx.t('b.render.cart_empty')),
    '',
    tx.t('b.render.subtotal', { amount: tx.money(cart.totals.subtotal, currency) }),
    cart.totals.delivery ? tx.t('b.render.delivery', { amount: tx.money(cart.totals.delivery, currency) }) : null,
    cart.totals.discount ? tx.t('b.render.discount_line', { amount: tx.money(cart.totals.discount, currency) }) : null,
    b(tx.t('b.render.total', { amount: tx.money(cart.totals.total, currency) })),
    !cart.meetsMinimum ? `\n${tx.t('b.render.min_order', { amount: tx.money(cart.minOrder, currency) })}` : null,
  );
}

const STATUS_EMOJI = {
  pending: '🕐',
  confirmed: '✅',
  preparing: '👨‍🍳',
  ready: '📦',
  shipped: '🚚',
  delivered: '🎉',
  cancelled: '❌',
  refunded: '↩️',
};

export const statusEmoji = (status) => STATUS_EMOJI[status] || '•';

export function orderText(tx, order, { forSeller = false } = {}) {
  const currency = order.totals.currency;
  const items = order.items
    .map((item) => `• ${tx.n(item.quantity)} × ${esc(item.title)} — ${tx.money(item.unitPrice * item.quantity, currency)}`)
    .join('\n');

  return lines(
    `${statusEmoji(order.status)} ${b(tx.t('b.order.title', { code: tx.ltr(order.code) }))}`,
    forSeller ? `👤 ${esc(order.contact.name)} · ${esc(tx.ltr(order.contact.phone))}` : `🏪 ${esc(order.storeName)}`,
    '',
    items,
    '',
    b(tx.t('b.render.total', { amount: tx.money(order.totals.total, currency) })),
    tx.t('b.order.status', { status: tx.orderStatus(order.status) }),
    tx.t('b.order.payment', { method: tx.payment(order.paymentMethod), status: tx.paymentStatus(order.paymentStatus) }),
    order.fulfillmentMethod === 'delivery' && order.address?.line1
      ? `📍 ${esc(order.address.line1)}${order.address.city ? `${tx.rtl ? '،' : ','} ${esc(order.address.city)}` : ''}`
      : null,
    order.note ? `📝 ${esc(order.note)}` : null,
  );
}

export function orderSummaryLine(tx, order) {
  return `${statusEmoji(order.status)} ${b(tx.ltr(order.code))} · ${tx.money(order.totals.total, order.totals.currency)} · ${esc(tx.orderStatus(order.status))}`;
}

export function onboardingText(tx, state) {
  const step = state.step;
  return lines(
    `${progressBar(state.progress)}  ${i(tx.t('b.step.of', { current: state.progress.current, total: state.progress.total }))}`,
    '',
    b(step.title),
    esc(step.prompt),
    step.help ? `\n${i(step.help)}` : null,
    state.error ? `\n⚠️ ${esc(state.error)}` : null,
  );
}

function progressBar({ current, total }) {
  const filled = Math.max(0, Math.min(total, current - 1));
  return `${'▰'.repeat(filled)}${'▱'.repeat(Math.max(0, total - filled))}`;
}

export function truncate(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** A product tag as a discovery hashtag — strips whatever would break it as one. */
export function hashtag(tag) {
  const clean = String(tag).trim().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_]/gu, '');
  return clean ? `#${clean}` : null;
}
