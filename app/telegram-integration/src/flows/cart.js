import { button, grid, keyboard, requestContactKeyboard, requestLocationKeyboard, urlButton } from '../telegram/keyboard.js';
import { b, cartText, esc, i, lines } from '../render.js';
import { toLatinDigits } from '../../../qbazz-core/src/util/digits.js';

/**
 * Cart and checkout.
 *
 * The cart itself lives in the core, keyed to the account — so the items a user
 * adds here are the items they will see on the web. Only the *checkout answers*
 * are held in channel state, and only until the order is placed.
 *
 * Money is never formatted here: `tx.money(minor, currency)` knows that Toman
 * has no minor unit and that Persian readers expect ۱۲٬۵۰۰ تومان.
 */

export async function showCarts(ctx) {
  const { tx, t } = ctx;
  const { items } = await ctx.core.listCarts(ctx.account.id);

  if (!items.length) {
    return ctx.screen(
      lines(b(t('b.cart.empty_title')), '', i(t('b.cart.empty_hint'))),
      keyboard([
        [button(t('b.nav.search'), 'search'), button(t('b.btn.categories'), 'cats')],
        [button(t('b.nav.home'), 'home')],
      ]),
    );
  }

  if (items.length === 1) return showCart(ctx, items[0].id);

  // Carts are per shop, so a buyer can have several open at once.
  return ctx.screen(
    lines(
      b(t('b.cart.many_title')),
      '',
      ...items.map((cart, index) => `${tx.idx(index + 1)} ${b(cart.storeName)} — ${t('b.render.items', { count: cart.itemCount })} · ${tx.money(cart.totals.total, cart.totals.currency)}`),
    ),
    keyboard([
      ...grid(items.map((cart, index) => button(`${tx.idx(index + 1)} ${cart.storeName.slice(0, 14)}`, 'cart', cart.id)), 1),
      [button(t('b.nav.home'), 'home')],
    ]),
  );
}

export async function showCart(ctx, cartId) {
  const { tx, t } = ctx;
  const cart = await ctx.core.getCart(ctx.account.id, cartId);

  if (!cart.items.length) {
    return ctx.screen(
      lines(b(`🛒 ${cart.storeName}`), '', i(t('b.cart.this_empty'))),
      keyboard([[button(t('b.btn.back_to_shop_plain'), 'store', cart.storeId)], [button(t('b.nav.home'), 'home')]]),
    );
  }

  const rows = cart.items.map((item, index) => [
    button('➖', 'qty', cart.id, String(index), '-1'),
    button(`${tx.idx(index + 1)} ${item.title.slice(0, 16)} ×${tx.n(item.quantity)}`, 'noop'),
    button('➕', 'qty', cart.id, String(index), '1'),
  ]);

  rows.push([button(t('b.btn.empty_cart'), 'clr', cart.id)]);
  if (cart.meetsMinimum) rows.push([button(t('b.btn.checkout', { total: tx.money(cart.totals.total, cart.totals.currency) }), 'co', cart.id)]);
  rows.push([button(t('b.btn.keep_shopping'), 'store', cart.storeId), button(t('b.nav.home'), 'home')]);

  return ctx.screen(cartText(tx, cart), keyboard(rows));
}

export async function changeQuantity(ctx, cartId, index, delta) {
  const { tx, t } = ctx;
  const cart = await ctx.core.getCart(ctx.account.id, cartId);
  const item = cart.items[Number(index)];
  if (!item) {
    await ctx.answer(t('b.cart.gone'));
    return showCart(ctx, cartId);
  }

  const next = item.quantity + Number(delta);
  await ctx.core.setCartQuantity(ctx.account.id, cartId, item.key, next);
  await ctx.answer(next <= 0 ? t('b.cart.removed') : t('b.cart.qty', { title: item.title, qty: tx.n(next) }));
  return showCart(ctx, cartId);
}

export async function addToCart(ctx, productId, quantity = 1) {
  const { tx, t } = ctx;
  try {
    const cart = await ctx.core.addToCart(ctx.account.id, { productId, quantity: Number(quantity) });
    const total = tx.money(cart.totals.total, cart.totals.currency);
    await ctx.answer(t('b.cart.added_toast', { total }));
    return ctx.reply(
      lines(
        t('b.cart.added', { store: b(cart.storeName) }),
        '',
        `${t('b.render.items', { count: cart.itemCount })} · ${b(total)}`,
      ),
      keyboard([
        [button(t('b.btn.checkout', { total }), 'co', cart.id)],
        [button(t('b.btn.view_cart'), 'cart', cart.id), button(t('b.btn.keep_shopping'), 'store', cart.storeId)],
      ]),
    );
  } catch (err) {
    // Stock ran out between the listing and the tap — or this arrived from a
    // channel post's own "add to cart" link, a /start deep link rather than a
    // button tap, where `ctx.answer` has no callback to pop an alert on and
    // silently does nothing. Either way the person needs to see the reason.
    if (ctx.isCallback) {
      await ctx.answer(ctx.err(err), { alert: true });
      return null;
    }
    return ctx.reply(`⚠️ ${esc(ctx.err(err))}`, keyboard([[button(t('b.btn.view_product'), 'prod', productId)]]));
  }
}

export async function clearCart(ctx, cartId) {
  await ctx.core.clearCart(ctx.account.id, cartId);
  await ctx.answer(ctx.t('b.cart.emptied'));
  return showCarts(ctx);
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/** "Checkout · 2 of 4" as a bold heading. */
const heading = (ctx, step) => b(ctx.t('b.co.title', { step, total: 4 }));

export async function startCheckout(ctx, cartId) {
  const { tx } = ctx;
  const cart = await ctx.core.getCart(ctx.account.id, cartId);
  if (!cart.items.length) return showCart(ctx, cartId);
  if (!cart.meetsMinimum) {
    // The core already has the sentence for this, in every language.
    await ctx.answer(ctx.t('err.min_order', { amount: tx.money(cart.minOrder, cart.totals.currency) }), { alert: true });
    return showCart(ctx, cartId);
  }

  const store = (await ctx.core.storefront(cart.storeId, ctx.account.id)).store;
  await ctx.setState({
    checkout: {
      cartId,
      storeId: cart.storeId,
      step: 'name',
      name: ctx.account.displayName || '',
      phone: ctx.account.phone || '',
      fulfillmentMethods: store.settings.fulfillmentMethods || ['delivery'],
      paymentMethods: store.settings.paymentMethods || ['online'],
    },
    awaiting: 'checkout',
  });

  return askName(ctx);
}

async function askName(ctx) {
  const { t } = ctx;
  const checkout = ctx.state.checkout;
  const rows = checkout.name ? [[button(t('b.btn.use_name', { name: checkout.name }), 'cofield', 'name')]] : [];
  rows.push([button(t('b.nav.cancel'), 'cocancel')]);
  return ctx.screen(lines(heading(ctx, 1), '', esc(t('b.co.ask_name'))), keyboard(rows));
}

async function askPhone(ctx) {
  const { tx, t } = ctx;
  const checkout = ctx.state.checkout;
  await ctx.setState({ checkout: { ...checkout, step: 'phone' } });
  if (checkout.phone) {
    return ctx.reply(
      lines(heading(ctx, 2), '', esc(t('b.co.ask_phone'))),
      keyboard([[button(t('b.btn.use_phone', { phone: tx.ltr(checkout.phone) }), 'cofield', 'phone')], [button(t('b.nav.cancel'), 'cocancel')]]),
    );
  }
  // Telegram can hand us a verified number with one tap.
  return ctx.reply(
    lines(heading(ctx, 2), '', esc(t('b.co.ask_phone')), '', i(t('b.co.phone_hint'))),
    requestContactKeyboard(t('b.kb.share_number')),
  );
}

async function askFulfillment(ctx) {
  const { tx, t } = ctx;
  const checkout = ctx.state.checkout;
  await ctx.setState({ checkout: { ...checkout, step: 'fulfillment' } });

  if (checkout.fulfillmentMethods.length === 1) {
    return applyFulfillment(ctx, checkout.fulfillmentMethods[0]);
  }
  return ctx.reply(
    lines(heading(ctx, 3), '', esc(t('b.co.ask_fulfillment'))),
    keyboard([
      ...grid(checkout.fulfillmentMethods.map((method) => button(labelFor(tx, method), 'ful', method)), 2),
      [button(t('b.nav.cancel'), 'cocancel')],
    ]),
  );
}

export async function applyFulfillment(ctx, method) {
  const { t } = ctx;
  const checkout = { ...ctx.state.checkout, fulfillmentMethod: method };
  await ctx.setState({ checkout });

  if (method === 'delivery') {
    await ctx.setState({ checkout: { ...checkout, step: 'address' } });
    return ctx.reply(
      lines(heading(ctx, 3), '', esc(t('b.co.ask_address')), '', i(t('b.co.address_hint'))),
      requestLocationKeyboard(t('b.kb.share_location')),
    );
  }
  return askPayment(ctx);
}

async function askPayment(ctx) {
  const { tx, t } = ctx;
  const checkout = { ...ctx.state.checkout, step: 'payment' };
  await ctx.setState({ checkout });

  if (checkout.paymentMethods.length === 1) return applyPayment(ctx, checkout.paymentMethods[0]);

  return ctx.reply(
    lines(heading(ctx, 4), '', esc(t('b.co.ask_payment'))),
    keyboard([
      ...grid(checkout.paymentMethods.map((method) => button(labelFor(tx, method), 'pay', method)), 1),
      [button(t('b.nav.cancel'), 'cocancel')],
    ]),
  );
}

export async function applyPayment(ctx, method) {
  const checkout = { ...ctx.state.checkout, paymentMethod: method, step: 'confirm' };
  await ctx.setState({ checkout });
  return showConfirmation(ctx);
}

async function showConfirmation(ctx) {
  const { tx, t } = ctx;
  const checkout = ctx.state.checkout;
  const cart = await ctx.core.getCart(ctx.account.id, checkout.cartId);

  const text = lines(
    b(t('b.co.confirm_title')),
    '',
    cartText(tx, cart),
    '',
    `👤 ${esc(checkout.name)}`,
    `📱 ${esc(tx.ltr(checkout.phone))}`,
    `🚚 ${esc(labelFor(tx, checkout.fulfillmentMethod))}`,
    checkout.address ? `📍 ${esc(checkout.address.line1)}` : null,
    `💳 ${esc(labelFor(tx, checkout.paymentMethod))}`,
  );

  return ctx.reply(text, keyboard([
    [button(t('b.btn.place_order'), 'conf')],
    [button(t('b.btn.add_note'), 'conote'), button(t('b.nav.cancel'), 'cocancel')],
  ]));
}

export async function placeOrder(ctx) {
  const { tx, t } = ctx;
  const checkout = ctx.state.checkout;
  if (!checkout) {
    await ctx.answer(t('b.co.expired'));
    return showCarts(ctx);
  }

  try {
    const order = await ctx.core.checkout(ctx.account.id, checkout.cartId, {
      contact: { name: checkout.name, phone: checkout.phone, note: checkout.note || '' },
      address: checkout.address || null,
      fulfillmentMethod: checkout.fulfillmentMethod,
      paymentMethod: checkout.paymentMethod,
      note: checkout.note || '',
    });

    await ctx.clearState(['checkout', 'awaiting']);
    await ctx.answer(t('b.co.placed_toast'));

    // Card-to-card: the order is only half done until the buyer sends the money and the receipt.
    const cardToCard = checkout.paymentMethod === 'bank_transfer';
    const payTo = cardToCard ? (await ctx.core.getOrder(ctx.account.id, order.id).catch(() => null))?.payTo : null;
    // Online: the order is real once it is paid, so the very next thing is the payment link.
    const online = checkout.paymentMethod === 'online';
    const payLink = online ? (await ctx.core.getOrder(ctx.account.id, order.id).catch(() => null))?.payLink : null;

    return ctx.reply(
      lines(
        b(t('b.co.placed_title')),
        '',
        t('b.co.placed_number', { code: b(tx.ltr(order.code)) }),
        t('b.co.placed_notified', { store: esc(order.storeName) }),
        '',
        b(t('b.render.total', { amount: tx.money(order.totals.total, order.totals.currency) })),
        online ? i(t('b.co.pay_online')) : null,
        online && payLink && !/^https:/.test(payLink) ? esc(payLink) : null,
        cardToCard ? `\n${b(t('b.rcp.pay_to'))}` : null,
        payTo?.cardNumber ? `💳 ${tx.ltr(payTo.cardNumber)}` : null,
        payTo?.holder ? `👤 ${esc(payTo.holder)}` : null,
        cardToCard ? i(t('b.rcp.then_send')) : null,
      ),
      keyboard([
        ...(payLink && /^https:/.test(payLink) ? [[urlButton(t('b.btn.pay_online'), payLink)]] : []),
        ...(cardToCard ? [[button(t('b.rcp.send'), 'rcp', order.id)]] : []),
        [button(t('b.btn.track_order'), 'ord', order.id)],
        [button(t('b.nav.home'), 'home'), button(t('b.btn.shop_again'), 'store', order.storeId)],
      ]),
    );
  } catch (err) {
    const message = ctx.err(err);
    await ctx.answer(message, { alert: true });
    return ctx.reply(
      lines(`⚠️ ${esc(message)}`, '', i(t('b.co.failed_hint'))),
      keyboard([[button(t('b.btn.back_to_cart'), 'cart', checkout.cartId)], [button(t('b.nav.home'), 'home')]]),
    );
  }
}

export async function cancelCheckout(ctx) {
  const cartId = ctx.state.checkout?.cartId;
  await ctx.clearState(['checkout', 'awaiting']);
  await ctx.answer(ctx.t('b.co.cancelled_toast'));
  await ctx.dropKeyboard(ctx.t('b.co.cancelled_msg'));
  return cartId ? showCart(ctx, cartId) : showCarts(ctx);
}

/** Reuses a stored value (name/phone) instead of asking for it again. */
export async function useStoredField(ctx, field) {
  const checkout = ctx.state.checkout;
  if (!checkout) return showCarts(ctx);
  await ctx.answer(ctx.t('b.co.using_saved'));
  if (field === 'name') return askPhone(ctx);
  if (field === 'phone') return askFulfillment(ctx);
  return showConfirmation(ctx);
}

export async function promptNote(ctx) {
  await ctx.setState({ checkout: { ...ctx.state.checkout, step: 'note' } });
  await ctx.answer();
  return ctx.reply(lines(b(ctx.t('b.co.note_title')), '', i(ctx.t('b.co.note_hint'))));
}

/**
 * Free-text handler while a checkout is in progress. The router sends every
 * non-command message here when `awaiting === 'checkout'`.
 */
export async function handleCheckoutInput(ctx) {
  const { t } = ctx;
  const checkout = ctx.state.checkout;
  if (!checkout) return false;

  const text = ctx.text?.trim();

  switch (checkout.step) {
    case 'name': {
      if (!text || text.length < 2) {
        await ctx.reply(t('b.co.bad_name'));
        return true;
      }
      await ctx.setState({ checkout: { ...checkout, name: text } });
      await askPhone(ctx);
      return true;
    }
    case 'phone': {
      // A Persian keyboard types ۰۹۱۲…; store it the way every other system reads it.
      const phone = toLatinDigits(ctx.contact?.phone_number || text || '');
      if (!phone || !/^\+?[\d\s-]{7,20}$/.test(phone)) {
        await ctx.reply(t('b.co.bad_phone'));
        return true;
      }
      await ctx.setState({ checkout: { ...checkout, phone: phone.replace(/[\s-]/g, '') } });
      await ctx.dropKeyboard('👍');
      await askFulfillment(ctx);
      return true;
    }
    case 'address': {
      let address;
      const point = ctx.venue?.location || ctx.location;

      if (point) {
        // Turn the pin into something a courier can actually read.
        const place = await ctx.core.geoReverse(point.latitude, point.longitude).catch(() => null);
        const coords = `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`;
        const line1 = String(ctx.venue?.address || place?.address || place?.label || t('b.co.pinned', { coords })).slice(0, 200);
        address = { line1, city: place?.city || undefined, country: place?.country || undefined, lat: point.latitude, lng: point.longitude };
        await ctx.reply(`📍 ${esc(line1)}`);
      } else {
        address = { line1: text };
      }

      if (!address.line1 || address.line1.length < 4) {
        await ctx.reply(t('b.co.bad_address'));
        return true;
      }
      await ctx.setState({ checkout: { ...checkout, address } });
      await ctx.dropKeyboard('👍');
      await askPayment(ctx);
      return true;
    }
    case 'note': {
      await ctx.setState({ checkout: { ...checkout, note: text || '' } });
      await showConfirmation(ctx);
      return true;
    }
    default:
      return false;
  }
}

const ICONS = {
  online: '💳',
  cash_on_delivery: '💵',
  bank_transfer: '🏦',
  card: '💳',
  telegram_payments: '✈️',
  crypto: '₿',
  delivery: '🚚',
  pickup: '🏪',
  digital: '💾',
};

/** An icon plus the method's name in the reader's language. */
function labelFor(tx, value) {
  const name = value in { delivery: 1, pickup: 1, digital: 1 } ? tx.fulfillment(value) : tx.payment(value);
  return `${ICONS[value] || ''} ${name}`.trim();
}
