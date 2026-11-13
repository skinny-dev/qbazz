import { button, keyboard } from './telegram/keyboard.js';
import { b, esc, lines } from './render.js';
import { makeTx } from './i18n/index.js';
import { bidiText, mirrorMarkup } from './telegram/rtl.js';

/**
 * Drains the core's notification queue into Telegram.
 *
 * The core queues notifications against *accounts*, not chats. This worker
 * claims the ones deliverable on Telegram, resolves the account to a chat id,
 * sends, and reports back. When the web app ships, its push worker drains the
 * same queue for the `web` channel — neither one needs changing.
 *
 * The text arrives already written in the recipient's language (the core
 * decides that when it queues, from the recipient's account). What is left for
 * this file is the part around the text: the button labels, and the direction —
 * right-to-left marks and mirrored rows for Persian.
 */
export function createNotifier({ core, api, config, log }) {
  let timer = null;
  let running = false;

  async function drain() {
    if (running) return;
    running = true;
    try {
      const { items } = await core.pendingNotifications('telegram', 50);
      for (const notification of items) await deliver(notification);
    } catch (err) {
      log.warn(`notification drain failed: ${err.message}`);
    } finally {
      running = false;
    }
  }

  async function deliver(notification) {
    try {
      const { items: sessions } = await core.channelSessionsForAccount(notification.accountId, 'telegram');
      const chatId = sessions[0]?.meta?.chatId || sessions[0]?.externalId;

      if (!chatId) {
        // Telegram forbids a bot messaging someone who has never opened it, so
        // this is not a failure — it is a "not yet". Leave it queued and the
        // person gets the backlog on their first /start. `pending()` bounds how
        // long that can accumulate.
        return;
      }

      const tx = txFor(notification, config);
      const message = await api.sendMessage(chatId, bidiText(renderNotification(notification), tx.rtl), {
        reply_markup: mirrorMarkup(buildKeyboard(notification, tx), tx.rtl),
        disable_notification: notification.priority === 'low',
      });

      await core.markNotificationDelivered(notification.id, { channel: 'telegram', ok: true, ref: String(message?.message_id || '') });
    } catch (err) {
      // "Bot was blocked" / "chat not found" is permanent — record it and move
      // on. Everything else, including "can't initiate conversation" (they have
      // simply not pressed Start yet), is left queued for a later pass.
      if (err.unreachable) {
        await core.markNotificationDelivered(notification.id, { channel: 'telegram', ok: false, error: err.message }).catch(() => null);
        return;
      }
      log.warn(`notification ${notification.id} failed, will retry: ${err.message}`);
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(drain, config.notifyIntervalMs);
      if (timer.unref) timer.unref();
      log.info(`notifier polling every ${config.notifyIntervalMs}ms`);
      drain();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    drain,
  };
}

/**
 * The language a notification was written in. Anything queued before the core
 * recorded a language has no `locale`, so fall back to what the text itself
 * says: Persian letters mean right-to-left, and English text must not be
 * flipped just because the platform default is Persian.
 */
function txFor(notification, config) {
  if (notification.locale) return makeTx(notification.locale, config.defaultLocale);
  const sample = `${notification.title || ''} ${notification.body || ''}`;
  return makeTx(/[؀-ۿ]/.test(sample) ? 'fa' : 'en', config.defaultLocale);
}

const ICONS = {
  'order.new': '🔔',
  'admin.topup_requested': '💳',
  'wallet.topup_approved': '✅',
  'wallet.topup_declined': '❌',
  'order.payment_submitted': '💳',
  'order.payment_approved': '✅',
  'order.payment_declined': '❌',
  'order.placed': '🧾',
  'order.confirmed': '✅',
  'order.preparing': '👨‍🍳',
  'order.ready': '📦',
  'order.shipped': '🚚',
  'order.delivered': '🎉',
  'order.cancelled': '❌',
  'order.refunded': '↩️',
  'order.rated': '⭐',
  'store.approved': '🎉',
  'store.rejected': '⚠️',
  'store.suspended': '🔴',
  'store.submitted': '⏳',
  'store.created': '🏪',
  'product.out_of_stock': '📉',
  'admin.review_needed': '🔍',
  'admin.low_rating': '⚠️',
  'admin.new_store': '🌱',
  'channel.draft_ready': '📝',
  announcement: '📣',
};

function renderNotification(notification) {
  const icon = ICONS[notification.type] || '🔔';
  return lines(`${icon} ${b(notification.title)}`, notification.body ? esc(notification.body) : null);
}

/** Every notification that refers to something gets a button straight to it. */
function buildKeyboard(notification, tx) {
  const { t } = tx;
  const data = notification.data || {};
  const rows = [];

  if (data.action === 'open_order' && data.orderId) {
    // Sellers land on the store view of the order; buyers on their own.
    rows.push([
      notification.type === 'order.new' || notification.type === 'order.payment_submitted'
        ? button(t('b.alert.open_order'), 'sso', data.orderId)
        : button(t('b.alert.track_order'), 'ord', data.orderId),
    ]);
  }
  if (data.action === 'review_topup' && data.topupId) rows.push([button(t('b.alert.review_topup'), 'atq', '0')]);
  if (data.action === 'open_billing') rows.push([button(t('b.btn.wallet_plan'), 'bill', '-')]);
  if (data.action === 'open_product' && data.productId) rows.push([button(t('b.alert.open_product'), 'prod', data.productId)]);
  if (data.action === 'review_draft' && data.postId) rows.push([button(t('b.alert.review_post'), 'dr', data.postId)]);

  // A channel post became a product sight unseen — worded however the post
  // happened to be, so the very next thing offered is a way to clean that up.
  if (notification.type === 'product.synced_from_channel' && data.storeId && data.productId) {
    rows.push([button(t('b.alert.open_product'), 'prod', data.productId)]);
    rows.push([button(t('b.alert.ai_improve'), 'pimp', data.storeId, data.productId)]);
    rows.push([button(t('b.alert.edit_manually'), 'pedit', data.storeId, data.productId)]);
  }

  // An admin should be able to clear the queue from the alert itself.
  if (data.action === 'review_store' && data.storeId) {
    if (notification.type === 'admin.review_needed') {
      rows.push([button(t('b.alert.approve'), 'aap', data.storeId), button(t('b.alert.reject'), 'arj', data.storeId)]);
      rows.push([button(t('b.alert.see_shop'), 'store', data.storeId), button(t('b.alert.full_queue'), 'aq', '0')]);
    } else {
      rows.push([button(t('b.alert.see_shop'), 'store', data.storeId), button(t('b.alert.admin'), 'admin')]);
    }
  }
  if (notification.type === 'admin.new_store' && data.storeId) rows.push([button(t('b.alert.see_shop'), 'store', data.storeId)]);
  if (notification.type === 'store.approved' && data.storeId) rows.push([button(t('b.alert.my_shop'), 'sd', data.storeId)]);
  if (notification.type === 'store.rejected' && data.storeId) rows.push([button(t('b.alert.fix_resubmit'), 'sd', data.storeId)]);
  if (notification.type === 'order.delivered' && data.orderId) rows.push([button(t('b.alert.rate_it'), 'ord', data.orderId)]);

  rows.push([button(t('b.nav.home'), 'home')]);
  return keyboard(rows);
}
