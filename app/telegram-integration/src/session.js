import { removeKeyboard } from './telegram/keyboard.js';
import { makeTx } from './i18n/index.js';
import { bidiText, bidiToast, mirrorMarkup } from './telegram/rtl.js';
import { effectiveLocale } from '../../qbazz-core/src/i18n/index.js';
import { isAppError, localizeError } from '../../qbazz-core/src/errors.js';

/**
 * Per-update context.
 *
 * Conversation state is *not* held in this process — it round-trips through the
 * core's channel sessions. That costs one extra call per update and buys three
 * things: the bot can restart mid-flow, it can run more than one instance, and
 * the web app can see where a user got to in Telegram.
 *
 * The context also carries the person's language. It is decided once, here, from
 * their account, and from then on `ctx.t`, `ctx.tx`, `ctx.core` (which words its
 * results for them) and every send method below agree on it — so no screen has
 * to remember to ask.
 */
export async function createContext({ update, api, core: baseCore, config, log }) {
  const message = update.message || update.callback_query?.message;
  const from = update.message?.from || update.callback_query?.from || update.inline_query?.from;
  if (!from) return null;

  const chatId = message?.chat?.id || from.id;
  const userId = String(from.id);

  // One idempotent call establishes the unified account for this Telegram user.
  const { account } = await baseCore.resolveIdentity({
    channel: 'telegram',
    externalId: userId,
    profile: {
      displayName: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Telegram user',
      username: from.username || null,
      firstName: from.first_name || null,
      // What the Telegram client says it is set to. Recorded, never obeyed: an
      // Iranian user on an English-language phone is still a Persian shopper.
      clientLanguage: from.language_code || null,
    },
    meta: { chatId },
  });

  const session = await baseCore.getChannelSession('telegram', userId);
  let state = session?.state || {};

  if (!session?.accountId) {
    await baseCore.touchChannelSession({ channel: 'telegram', externalId: userId, accountId: account.id, meta: { chatId } });
  }

  let locale = effectiveLocale(account, config.defaultLocale);
  let tx = makeTx(locale, config.defaultLocale);

  // What a send sends: RTL-marked text, and keyboards mirrored to read right to left.
  const dress = (text) => bidiText(text, tx.rtl);
  const mirror = (markup) => mirrorMarkup(markup, tx.rtl);

  const ctx = {
    update,
    api,
    core: baseCore.withLocale ? baseCore.withLocale(locale) : baseCore,
    config,
    log,
    chatId,
    userId,
    account,
    from,
    tx,
    t: tx.t,
    locale,
    messageId: message?.message_id || null,
    text: update.message?.text || '',
    // A photo's own text travels as `caption`, never `text` — a flow that
    // wants "whatever the person wrote, photo or not" reads both.
    caption: update.message?.caption || '',
    contact: update.message?.contact || null,
    location: update.message?.location || null,
    // A venue carries a location plus a street address, which makes a better
    // delivery line than coordinates alone.
    venue: update.message?.venue || null,
    // Forwarding a post is the easiest proof that a channel exists and that
    // the person can see it; connecting still verifies who administers it.
    forwardedFromChat: update.message?.forward_from_chat || update.message?.forward_origin?.chat || null,
    photo: update.message?.photo || null,
    callback: update.callback_query || null,
    isCallback: Boolean(update.callback_query),
    callbackData: update.callback_query?.data || null,

    get state() {
      return state;
    },

    async setState(patch) {
      state = { ...state, ...patch };
      await baseCore.touchChannelSession({ channel: 'telegram', externalId: userId, accountId: account.id, state: patch, meta: { chatId } });
      return state;
    },

    async clearState(keys = null) {
      if (keys) for (const key of keys) delete state[key];
      else state = {};
      await baseCore.clearChannelState('telegram', userId, keys);
      return state;
    },

    /**
     * Switches this person's language for good. Everything after this call in
     * the same update — including the screen that follows — is in the new one.
     */
    async switchLocale(next) {
      const updated = await baseCore.setLocale(account.id, next);
      locale = effectiveLocale(updated, config.defaultLocale);
      tx = makeTx(locale, config.defaultLocale);
      ctx.tx = tx;
      ctx.t = tx.t;
      ctx.locale = locale;
      ctx.core = baseCore.withLocale ? baseCore.withLocale(locale) : baseCore;
      return locale;
    },

    /** An error worded for this person: the core's own keyed message, or a generic one. */
    err(error) {
      // A plan limit or an empty wallet gets a follow-up with buttons (see flows/billing.js).
      const d = error?.details;
      if (d?.resource && 'buyable' in d && ['stores', 'members', 'products', 'orders', 'aiCredits'].includes(d.resource)) ctx.limitHit = { resource: d.resource, buyable: Boolean(d.buyable) };
      else if (d?.balanceMinor !== undefined && d?.amountMinor !== undefined) ctx.limitHit = { wallet: true };
      if (isAppError(error) || error?.key || error?.status < 500) return localizeError(error, locale) || error.message;
      // A raw failure from the network or a bug is not something to show anyone.
      return tx.t('b.common.error_generic');
    },

    reply(text, replyMarkup, extra = {}) {
      return api.sendMessage(chatId, dress(text), { reply_markup: mirror(replyMarkup), ...extra });
    },

    /**
     * Renders a screen: edits the message in place when the user tapped a
     * button, sends a new one otherwise. Keeps the chat from filling up with
     * near-identical menus.
     */
    async screen(text, replyMarkup, extra = {}) {
      if (ctx.isCallback && ctx.messageId && !ctx.state.__forceNew) {
        try {
          return await api.editMessageText(chatId, ctx.messageId, dress(text), { reply_markup: mirror(replyMarkup), ...extra });
        } catch (err) {
          // The original message had a photo, or is too old to edit — fall through.
          log.debug?.(`edit failed, sending new message: ${err.message}`);
        }
      }
      return api.sendMessage(chatId, dress(text), { reply_markup: mirror(replyMarkup), ...extra });
    },

    /** Several photos as one album (or a lone photo), each with its own caption. */
    photoAlbum(items) {
      if (!items.length) return Promise.resolve(null);
      if (items.length === 1) return api.sendPhoto(chatId, items[0].media, dress(items[0].caption));
      return api.sendMediaGroup(chatId, items.map((item) => ({ type: 'photo', media: item.media, caption: dress(item.caption) })));
    },

    photoScreen(photoUrl, caption, replyMarkup) {
      return api.sendPhoto(chatId, photoUrl, dress(caption), { reply_markup: mirror(replyMarkup) });
    },

    answer(text, { alert = false } = {}) {
      if (!ctx.callback) return Promise.resolve(null);
      return api.answerCallbackQuery(ctx.callback.id, { text: bidiToast(text, tx.rtl), show_alert: alert });
    },

    dropKeyboard(text = '👌') {
      return api.sendMessage(chatId, dress(text), { reply_markup: removeKeyboard() });
    },

    typing() {
      return api.sendChatAction(chatId, 'typing');
    },
  };

  return ctx;
}
