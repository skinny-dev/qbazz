import { makeTx } from './i18n/index.js';
import { bidiText } from './telegram/rtl.js';

/**
 * The quickest way to connect a channel: the person taps "add the bot to my channel" and picks one. Telegram then sends
 * `my_chat_member` - the bot is now an administrator, and `from` is who made it so. Telegram only lets a person pick
 * channels they administer, so that single tap is the proof; the core connects the channel to their shop (or keeps it
 * as a claim for the site to pick up), and this tells them in the chat they are already in.
 */
export function createChannelClaim({ core, api, config, log }) {
  async function handle(change) {
    const chat = change?.chat;
    const now = change?.new_chat_member;
    const was = change?.old_chat_member;
    if (!chat || chat.type !== 'channel' || !change.from?.id || change.from.is_bot) return;
    // Only the moment the bot becomes (or is re-promoted to) an administrator; leaving or being kicked is not a claim.
    if (now?.status !== 'administrator' || (was?.status === 'administrator' && was.can_post_messages === now.can_post_messages)) return;
    const { t } = makeTx(config.defaultLocale);
    try {
      const result = await core.channelBotAdded({
        telegramUserId: change.from.id,
        chat: { id: chat.id, type: chat.type, title: chat.title, username: chat.username },
        canPost: now.can_post_messages !== false,
      });
      if (result.ignored) return;
      const name = chat.title || chat.username || '';
      let text;
      if (!result.channel?.canPost) text = t('b.claim.cannot_post', { name });
      else if (result.connected) text = t('b.claim.connected', { name, shop: result.store.name });
      else if (!result.linked) text = t('b.claim.need_link', { name });
      else if (result.error) text = t('b.claim.failed', { name });
      else text = t('b.claim.pick_shop', { name });
      await api.sendMessage(change.from.id, bidiText(text, true));
    } catch (err) {
      log.warn(`channel claim for ${chat.id} failed: ${err.message}`);
    }
  }
  return { handle };
}
