import { parseCb, button, keyboard } from './telegram/keyboard.js';
import { b, esc, i, lines } from './render.js';
import { LOCALES } from './i18n/index.js';
import { bidiText } from './telegram/rtl.js';
import * as discovery from './flows/discovery.js';
import * as cart from './flows/cart.js';
import * as orders from './flows/orders.js';
import * as onboarding from './flows/onboarding.js';
import * as seller from './flows/seller.js';
import * as admin from './flows/admin.js';
import * as billing from './flows/billing.js';
import * as link from './flows/link.js';
import * as channel from './flows/channel.js';
import * as draft from './flows/draft.js';

/** Commands in menu order. Descriptions are `b.cmd.<name>` in each language. */
export const COMMAND_NAMES = ['start', 'search', 'browse', 'cart', 'orders', 'sell', 'shop', 'link', 'language', 'help'];

/** The command list Telegram shows in its menu, worded by `t`. */
export const commandList = (t) => COMMAND_NAMES.map((command) => ({ command, description: t(`b.cmd.${command}`) }));

/** Entry point for every update. Returns after the screen has been sent. */
export async function route(ctx) {
  if (ctx.isCallback) return routeCallback(ctx);
  if (ctx.update.inline_query) return routeInline(ctx);
  return routeMessage(ctx);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

async function routeMessage(ctx) {
  const text = (ctx.text || '').trim();

  if (text.startsWith('/')) {
    // A command always wins over a half-finished flow, so nobody gets stuck.
    const [rawCommand, ...rest] = text.split(/\s+/);
    const command = rawCommand.split('@')[0].slice(1).toLowerCase();
    const argument = rest.join(' ');
    if (command !== 'start') await ctx.clearState(['awaiting']);
    return routeCommand(ctx, command, argument);
  }

  // Sharing your own contact is Telegram vouching for the number: tie it to the account (and to the
  // web account that already uses it, if any). Never interrupts whatever flow the message is part of.
  if (ctx.contact?.user_id && String(ctx.contact.user_id) === String(ctx.userId)) {
    await ctx.core.linkVerifiedPhone(ctx.account.id, ctx.contact.phone_number).catch(() => null);
  }

  // In-flight flows claim free text, contacts, locations and photos.
  if (await onboarding.handleOnboardingInput(ctx)) return null;
  if (ctx.state.awaiting === 'checkout' && (await cart.handleCheckoutInput(ctx))) return null;
  if (await seller.handleNewProductInput(ctx)) return null;
  if (ctx.state.awaiting === 'currency' && (await seller.handleCurrencyInput(ctx))) return null;
  if (await billing.handleTopupInput(ctx)) return null;
  if (await orders.handleReceiptInput(ctx)) return null;
  if (await seller.handleStoreCardInput(ctx)) return null;
  if (await seller.handleShippingFeeInput(ctx)) return null;
  if (await seller.handleProductEditNumberInput(ctx)) return null;
  if (await seller.handlePaymentReasonInput(ctx)) return null;
  if (await seller.handleProductEditInput(ctx)) return null;
  if (await seller.handleMockupPromptInput(ctx)) return null;
  if (await seller.handleDraftMockupPromptInput(ctx)) return null;
  if (await seller.handleQuickAddDetailInput(ctx)) return null;
  if (await channel.handleChannelInput(ctx)) return null;
  if (await draft.handleDraftInput(ctx)) return null;
  if (await admin.handleAdminInput(ctx)) return null;

  if (ctx.state.awaiting === 'search') return discovery.runSearch(ctx, text);
  if (ctx.state.awaiting === 'link') return link.redeemCode(ctx, text);

  if (!text) return null;

  // A bare uppercase 6-character token might be a link code pasted from the
  // web. Try it silently; if no such code exists, it was just a search.
  if (/^[0-9A-Z]{6}$/.test(text) && (await link.tryRedeemCode(ctx, text))) return null;

  // Anything else is treated as a search — the most common intent by far.
  return discovery.runSearch(ctx, text);
}

async function routeCommand(ctx, command, argument) {
  switch (command) {
    case 'start':
      return handleStart(ctx, argument);
    case 'search':
      return argument ? discovery.runSearch(ctx, argument) : discovery.promptSearch(ctx);
    case 'browse':
    case 'categories':
      return discovery.showCategories(ctx);
    case 'cart':
      return cart.showCarts(ctx);
    case 'orders':
      return orders.showOrders(ctx);
    case 'sell':
      return seller.sellerEntry(ctx);
    case 'shop':
    case 'dashboard':
      return seller.sellerEntry(ctx);
    case 'link':
      return link.showLink(ctx);
    case 'admin':
      return admin.adminEntry(ctx);
    case 'language':
    case 'lang':
      return showLanguage(ctx);
    case 'help':
      return showHelp(ctx);
    case 'cancel':
      await ctx.clearState();
      await ctx.dropKeyboard(ctx.t('b.common.cancelled'));
      return discovery.showHome(ctx);
    default:
      return ctx.reply(
        lines(ctx.t('b.common.unknown_command', { command: esc(ctx.tx.ltr(`/${command}`)) }), '', i(ctx.t('b.common.try_commands'))),
        keyboard([[button(ctx.t('b.nav.home'), 'home')]]),
      );
  }
}

/**
 * `/start` carries deep-link payloads: `s_<slug>` a shop, `p_<id>` a product,
 * `h_<token>` a handoff back from the web, `ref_<code>` a referral.
 */
async function handleStart(ctx, argument) {
  const { t } = ctx;
  const payload = (argument || '').trim();

  // From the website: one tap on Start joins this Telegram account to the web account.
  if (payload.startsWith('lc_')) return link.linkFromStart(ctx, payload.slice(3));
  if (payload.startsWith('s_')) return discovery.showStore(ctx, payload.slice(2));
  if (payload.startsWith('p_')) return discovery.showProduct(ctx, payload.slice(2));
  // A channel post's own buttons: add straight to cart, or toggle the wishlist,
  // in the one tap that opening the bot from a broadcast post already costs —
  // no reason to make someone tap twice for something they already decided on.
  if (payload.startsWith('c_')) return cart.addToCart(ctx, payload.slice(2), 1);
  if (payload.startsWith('w_')) {
    await discovery.toggleSaved(ctx, payload.slice(2));
    return discovery.showProduct(ctx, payload.slice(2));
  }
  if (payload.startsWith('h_')) {
    await ctx.setState({ handoff: payload.slice(2) });
    return discovery.showHome(ctx, { greeting: b(t('b.start.handoff')) });
  }
  if (payload.startsWith('ref_')) await ctx.setState({ referral: payload.slice(4) });

  const session = await ctx.core.session(ctx.account.id);
  const isNew = !session.account?.onboarded;
  const firstName = ctx.account.displayName.split(' ')[0];

  if (isNew) {
    return ctx.reply(
      lines(
        b(t('b.start.welcome', { name: firstName })),
        '',
        esc(t('b.start.lead')),
        '',
        esc(t('b.start.buy')),
        esc(t('b.start.sell')),
        '',
        i(t('b.start.ask')),
      ),
      keyboard([
        [button(t('b.btn.here_to_shop'), 'buyerstart')],
        [button(t('b.btn.want_to_sell'), 'onbstart')],
        [button(t('b.btn.just_looking'), 'home'), button(t('b.btn.language'), 'langs')],
      ]),
    );
  }

  // A bold hello, one line on what to do, one line of quick links. The
  // keyboard right below already carries the categories and actions, so the
  // text doesn't repeat them — and `minimal` skips the featured/trending
  // preview `showHome` normally adds, since that would undo the "short" part.
  // Joined by hand (not `lines()`, which drops empty separators) for a real
  // blank line between the two short paragraphs.
  const greeting = [
    b(t('b.start.back', { name: firstName })),
    esc(t('b.start.home_pick')),
    esc(t('b.start.home_quicklinks')),
  ].join('\n\n');

  return discovery.showHome(ctx, { greeting, minimal: true });
}

function showHelp(ctx) {
  const { t } = ctx;
  return ctx.screen(
    lines(
      b(t('b.help.title')),
      '',
      b(t('b.help.buying')),
      esc(t('b.help.buy_1')),
      esc(t('b.help.buy_2')),
      esc(t('b.help.buy_3')),
      '',
      b(t('b.help.selling')),
      esc(t('b.help.sell_1')),
      esc(t('b.help.sell_2')),
      esc(t('b.help.sell_3')),
      '',
      b(t('b.help.both')),
      esc(t('b.help.both_1')),
      esc(t('b.help.both_2')),
      '',
      i(t('b.help.human', { support: ctx.config.supportHandle || '@qbazz_support' })),
    ),
    keyboard([
      [button(t('b.nav.home'), 'home'), button(t('b.btn.link_web'), 'link')],
      [button(t('b.btn.language'), 'langs')],
    ]),
  );
}

/** Language picker. A person's own choice is the only thing that overrides the platform default. */
async function showLanguage(ctx) {
  const { t, tx } = ctx;
  return ctx.screen(
    lines(
      b(t('b.lang.title')),
      '',
      esc(t('b.lang.prompt')),
      t('b.lang.current', { name: esc(LOCALES[tx.locale].name) }),
      '',
      i(t('b.lang.hint')),
    ),
    keyboard([
      Object.values(LOCALES).map((locale) => button(`${locale.flag} ${locale.name}${locale.code === tx.locale ? ' ✅' : ''}`, 'lang', locale.code)),
      [button(t('b.nav.home'), 'home')],
    ]),
  );
}

// ---------------------------------------------------------------------------
// Callback buttons
// ---------------------------------------------------------------------------

async function routeCallback(ctx) {
  const { action, args } = parseCb(ctx.callbackData);

  switch (action) {
    case 'noop':
      return ctx.answer();

    // Language
    case 'langs':
      await ctx.answer();
      return showLanguage(ctx);
    case 'lang':
      await ctx.switchLocale(args[0]);
      await ctx.answer(ctx.t('b.lang.changed'));
      return discovery.showHome(ctx);

    // Discovery
    case 'home':
      await ctx.answer();
      // Home means "leave whatever I was typing into". Progress in a flow lives in the
      // core and can be resumed; a stale prompt must not swallow the next message.
      await ctx.clearState(['awaiting']);
      return discovery.showHome(ctx);
    case 'cats':
      await ctx.answer();
      return discovery.showCategories(ctx);
    case 'cat':
      await ctx.answer();
      return discovery.showCategory(ctx, args[0], Number(args[1]) || 0);
    case 'search':
      await ctx.answer();
      return discovery.promptSearch(ctx);
    case 'sr':
      await ctx.answer();
      return discovery.runSearch(ctx, decodeURIComponent(args[0]), Number(args[1]) || 0);
    case 'trend':
      await ctx.answer();
      return discovery.showTrending(ctx);
    case 'store':
    case 'st':
      // args: [storeId, categoryId, offset] — categoryId is present only when a
      // category-browse button sent us here; every older/plain call still works
      // since a missing slot just reads as undefined, same as before.
      await ctx.answer();
      return discovery.showStore(ctx, args[0], Number(args[2]) || 0, args[1] || null);
    case 'prod':
      await ctx.answer();
      return discovery.showProduct(ctx, args[0]);
    case 'save':
      await discovery.toggleSaved(ctx, args[0]);
      return discovery.showProduct(ctx, args[0]);
    case 'share':
      return discovery.shareStore(ctx, args[0]);
    case 'links':
      return discovery.showIntegrations(ctx, args[0]);

    // Cart and checkout
    case 'add':
      return cart.addToCart(ctx, args[0], 1);
    case 'addq':
      return cart.addToCart(ctx, args[0], Math.max(1, Number(args[1]) || 1));
    case 'cart':
      await ctx.answer();
      return args[0] ? cart.showCart(ctx, args[0]) : cart.showCarts(ctx);
    case 'qty':
      return cart.changeQuantity(ctx, args[0], args[1], args[2]);
    case 'clr':
      return cart.clearCart(ctx, args[0]);
    case 'co':
      await ctx.answer();
      return cart.startCheckout(ctx, args[0]);
    case 'cofield':
      return cart.useStoredField(ctx, args[0]);
    case 'ful':
      await ctx.answer();
      return cart.applyFulfillment(ctx, args[0]);
    case 'pay':
      await ctx.answer();
      return cart.applyPayment(ctx, args[0]);
    case 'conote':
      return cart.promptNote(ctx);
    case 'conf':
      return cart.placeOrder(ctx);
    case 'cocancel':
      return cart.cancelCheckout(ctx);

    // Buyer orders
    case 'orders':
      await ctx.answer();
      return orders.showOrders(ctx);
    case 'ords':
      await ctx.answer();
      return orders.showOrders(ctx, Number(args[0]) || 0);
    case 'ord':
      await ctx.answer();
      return orders.showOrder(ctx, args[0]);
    case 'rcp':
      return orders.promptReceipt(ctx, args[0]);
    case 'ocan':
      return orders.cancelOrder(ctx, args[0]);
    case 'rate':
      return orders.rateOrder(ctx, args[0], args[1]);

    // Onboarding
    case 'onbstart':
      await ctx.answer();
      return onboarding.startOnboarding(ctx, 'seller');
    case 'buyerstart':
      await ctx.answer();
      return onboarding.startOnboarding(ctx, 'buyer');
    case 'onbresume':
      await ctx.answer();
      return onboarding.resumeOnboarding(ctx, 'seller');
    case 'onbrestart':
      await ctx.answer();
      return onboarding.startOnboarding(ctx, 'seller', { restart: true });
    case 'onbpick':
      return onboarding.pickOption(ctx, args.join(':'));
    case 'onbtog':
      return onboarding.toggleOption(ctx, args.join(':'));
    case 'onbdone':
      return onboarding.submitSelection(ctx);
    case 'onbback':
      return onboarding.goBack(ctx);
    case 'onbskip':
      return onboarding.skipStep(ctx);
    case 'onbcancel':
      return onboarding.cancelOnboarding(ctx);

    // Seller
    case 'sell':
      await ctx.answer();
      return seller.sellerEntry(ctx);
    case 'sd':
      await ctx.answer();
      return seller.showDashboard(ctx, args[0]);
    case 'scur':
      return seller.showCurrencyPicker(ctx, args[0]);
    case 'scurset':
      return seller.setCurrency(ctx, args[0], args[1]);
    case 'ssh':
      await ctx.clearState(['awaiting']);
      return seller.showShippingSettings(ctx, args[0]);
    case 'sshp':
      return seller.setShippingPayer(ctx, args[0], args[1]);
    case 'sshf':
      return seller.promptShippingFee(ctx, args[0]);
    case 'so':
      await ctx.answer();
      return seller.showSellerOrders(ctx, args[0], Number(args[1]) || 0);
    case 'sso':
      await ctx.answer();
      return seller.showSellerOrder(ctx, args[0]);
    case 'sst':
      return seller.setOrderStatus(ctx, args[0], args[1]);
    case 'sp':
      await ctx.answer();
      return seller.showSellerProducts(ctx, args[0], Number(args[1]) || 0);
    case 'spr':
      await ctx.answer();
      return seller.showSellerProductDetail(ctx, args[0], args[1]);
    case 'sptog':
      return seller.toggleSellerProductStock(ctx, args[0], args[1]);
    case 'scd':
      await ctx.clearState(['awaiting']);
      return seller.showStoreCards(ctx, args[0]);
    case 'scda':
      return seller.promptStoreCard(ctx, args[0]);
    case 'scdt':
      return seller.toggleStoreCard(ctx, args[0], args[1]);
    case 'scdr':
      return seller.removeStoreCard(ctx, args[0], args[1]);
    case 'spp':
      return seller.promptProductPrice(ctx, args[0], args[1]);
    case 'sps':
      return seller.promptProductStock(ctx, args[0], args[1]);
    case 'spsu':
      return seller.setProductStockUnlimited(ctx, args[0], args[1]);
    case 'spd':
      return seller.showDiscountPicker(ctx, args[0], args[1]);
    case 'spdp':
      return seller.setDiscount(ctx, args[0], args[1], args[2]);
    case 'spa':
      return seller.toggleProductArchive(ctx, args[0], args[1]);
    case 'spay':
      return seller.reviewPayment(ctx, args[0], args[1]);
    case 'spayno':
      return seller.declinePayment(ctx, args[0]);
    case 'san':
      await ctx.answer();
      return seller.showSellerAnalytics(ctx, args[0]);
    case 'ssub':
      return seller.submitStore(ctx, args[0]);
    case 'padd':
      return seller.startAddProduct(ctx, args[0]);
    case 'npfix':
      return seller.requestQuickAddFix(ctx);
    case 'npreview':
      return seller.cancelQuickAddFix(ctx);
    case 'npjournal':
      return seller.requestQuickAddJournal(ctx);
    case 'npnext':
      return seller.showQuickAddPublish(ctx);
    case 'nptoggle':
      return seller.toggleQuickAddDestination(ctx);
    case 'nppublish':
      return seller.publishQuickAdd(ctx);
    case 'mkgen':
      return seller.requestMockup(ctx, args[0], args[1]);
    case 'mkuse':
      return seller.useMockup(ctx, Number(args[0]) || 0);
    case 'npmkuse':
      return seller.useDraftMockup(ctx, Number(args[0]) || 0);
    case 'mkprompt':
      return seller.requestMockupPromptEdit(ctx);
    case 'npmkprompt':
      return seller.requestDraftMockupPromptEdit(ctx);
    case 'pimp':
      return seller.requestProductImprove(ctx, args[0], args[1]);
    case 'pimpapply':
      return seller.applyProductImprove(ctx);
    case 'pedit':
      return seller.requestProductManualEdit(ctx, args[0], args[1]);
    case 'peditapply':
      return seller.applyProductEdit(ctx);
    case 'bill':
      return seller.showBilling(ctx, args[0]);
    case 'billplans':
      return seller.showPlanPicker(ctx, args[0]);
    case 'billset':
      return seller.setPlan(ctx, args[0], args[1]);
    case 'btu':
      return billing.showTopup(ctx, args[0]);
    case 'btua':
      return billing.chooseTopupAmount(ctx, args[0], args[1]);
    case 'bbuy':
      return billing.showPacks(ctx, args[0]);
    case 'bbp':
      return billing.buyPack(ctx, args[0], args[1]);

    // Telegram channel
    case 'ch':
      await ctx.answer();
      return channel.showChannel(ctx, args[0]);
    case 'chc':
      return channel.promptConnect(ctx, args[0]);
    case 'cha':
      return channel.toggleAutoPost(ctx, args[0]);
    case 'chs':
      return channel.toggleSync(ctx, args[0]);
    case 'chb':
      return channel.backfill(ctx, args[0]);
    case 'chd':
      return channel.disconnect(ctx, args[0]);
    case 'chr':
      await draft.toggleReview(ctx, args[0]);
      return channel.showChannel(ctx, args[0]);

    // Draft posts (the pre-posting preview)
    case 'drs':
      await ctx.answer();
      return draft.showDrafts(ctx, args[0]);
    case 'dr':
      await ctx.answer();
      return draft.showDraft(ctx, args[0]);
    case 'dgen':
      return draft.generate(ctx, args[0]);
    case 'ded':
      return draft.promptEdit(ctx, args[0]);
    case 'dap':
      return draft.applySuggestions(ctx, args[0]);
    case 'dok':
      return draft.approve(ctx, args[0]);
    case 'ddel':
      return draft.discard(ctx, args[0]);

    // Admin
    case 'admin':
      await ctx.answer();
      return admin.adminEntry(ctx);
    case 'aq':
      await ctx.answer();
      return admin.showReviewQueue(ctx, Number(args[0]) || 0);
    case 'aap':
      return admin.approveStore(ctx, args[0]);
    case 'arj':
      return admin.promptReject(ctx, args[0]);
    case 'apc':
      return admin.showPaymentCards(ctx);
    case 'apcs':
      return admin.setPaymentSetting(ctx, args[0]);
    case 'apct':
      return admin.updatePaymentCard(ctx, args[0], 'toggle');
    case 'apcp':
      return admin.updatePaymentCard(ctx, args[0], 'primary');
    case 'atq':
      return admin.showTopupQueue(ctx, Number(args[0]) || 0);
    case 'atap':
      return admin.approveTopup(ctx, args[0]);
    case 'atrj':
      return admin.promptTopupDecline(ctx, args[0]);
    case 'atrjn':
      return admin.declineTopup(ctx, args[0]);

    // Linking
    case 'link':
      await ctx.answer();
      return link.showLink(ctx);
    case 'web':
      await ctx.answer();
      return link.openOnWeb(ctx, args[0] ? decodeURIComponent(args[0]) : '/');

    default:
      return ctx.answer(ctx.t('b.common.expired_button'), { alert: true });
  }
}

// ---------------------------------------------------------------------------
// Inline mode — search Qbazz from any chat
// ---------------------------------------------------------------------------

async function routeInline(ctx) {
  const { tx, t } = ctx;
  const query = ctx.update.inline_query.query.trim();
  if (!query) return ctx.api.answerInlineQuery(ctx.update.inline_query.id, []);

  const result = await ctx.core.search(ctx.account.id, { q: query, limit: 20, type: 'products' });

  const articles = result.items.map((card) => ({
    type: 'article',
    id: card.id,
    title: card.title,
    description: `${tx.money(card.price.amount, card.price.currency)} · ${card.subtitle}`,
    thumbnail_url: card.image || undefined,
    input_message_content: {
      // Sent into someone else's chat, so it is worded for the sender's language
      // and marked for right-to-left the same way every other message is.
      message_text: bidiText(lines(
        b(card.title),
        `${tx.money(card.price.amount, card.price.currency)} · ${esc(card.subtitle)}`,
        '',
        `https://t.me/${ctx.config.username}?start=p_${card.id}`,
      ), tx.rtl),
      parse_mode: 'HTML',
    },
    reply_markup: keyboard([[button(t('b.inline.view'), 'prod', card.id)]]),
  }));

  return ctx.api.answerInlineQuery(ctx.update.inline_query.id, articles);
}
