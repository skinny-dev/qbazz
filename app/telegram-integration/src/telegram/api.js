/**
 * Telegram Bot API client — `fetch` and nothing else.
 *
 * Handles the two things that actually bite in production: 429 rate limits
 * (obey `retry_after`) and the "message is not modified" error that inline
 * keyboards produce constantly when a user taps the same button twice.
 */
export class TelegramApi {
  constructor(token, { log = console, fetchImpl = fetch, apiBase = 'https://api.telegram.org' } = {}) {
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
    this.token = token;
    // `apiBase` is where Bot API calls go: Telegram itself, or a relay for a server that cannot reach it directly.
    this.base = `${String(apiBase).replace(/\/+$/, '')}/bot${token}`;
    this.log = log;
    this.fetch = fetchImpl;
  }

  async call(method, payload = {}, { retries = 2 } = {}) {
    const response = await this.fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({ ok: false, description: 'Invalid JSON from Telegram' }));

    if (data.ok) return data.result;

    if (response.status === 429 && retries > 0) {
      const wait = (data.parameters?.retry_after || 1) * 1000;
      this.log.warn?.(`rate limited on ${method}, waiting ${wait}ms`);
      await sleep(wait);
      return this.call(method, payload, { retries: retries - 1 });
    }

    // Tapping a button that produces the same screen is not an error worth raising.
    if (/message is not modified/i.test(data.description || '')) return null;
    // The user blocked the bot or deleted the chat — the caller should not retry.
    if (/bot was blocked|chat not found|user is deactivated/i.test(data.description || '')) {
      const err = new Error(data.description);
      err.unreachable = true;
      throw err;
    }

    const err = new Error(`${method} failed: ${data.description}`);
    err.telegram = data;
    throw err;
  }

  getMe() { return this.call('getMe'); }

  getUpdates(offset, timeoutSec, allowedUpdates) {
    return this.call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: allowedUpdates });
  }

  setWebhook(url, secretToken, allowedUpdates) {
    return this.call('setWebhook', { url, secret_token: secretToken || undefined, allowed_updates: allowedUpdates, drop_pending_updates: false });
  }

  deleteWebhook(dropPending = false) {
    return this.call('deleteWebhook', { drop_pending_updates: dropPending });
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text: truncate(text, 4096),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  }

  editMessageText(chatId, messageId, text, extra = {}) {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: truncate(text, 4096),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  }

  sendPhoto(chatId, photo, caption, extra = {}) {
    return this.call('sendPhoto', { chat_id: chatId, photo, caption: truncate(caption, 1024), parse_mode: 'HTML', ...extra });
  }

  sendVideo(chatId, video, caption, extra = {}) {
    return this.call('sendVideo', { chat_id: chatId, video, caption: truncate(caption, 1024), parse_mode: 'HTML', supports_streaming: true, ...extra });
  }

  /** 2–10 photos shown as one album; each item may carry its own caption. */
  sendMediaGroup(chatId, media) {
    return this.call('sendMediaGroup', { chat_id: chatId, media: media.map((item) => ({ ...item, parse_mode: 'HTML', caption: truncate(item.caption || '', 1024) })) });
  }

  editMessageCaption(chatId, messageId, caption, extra = {}) {
    return this.call('editMessageCaption', {
      chat_id: chatId,
      message_id: messageId,
      caption: truncate(caption, 1024),
      parse_mode: 'HTML',
      ...extra,
    });
  }

  editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    return this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
  }

  deleteMessage(chatId, messageId) {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => null);
  }

  /** Every callback query must be answered or the client shows a spinner forever. */
  answerCallbackQuery(id, extra = {}) {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...extra }).catch(() => null);
  }

  answerInlineQuery(id, results, extra = {}) {
    return this.call('answerInlineQuery', { inline_query_id: id, results, cache_time: 30, ...extra });
  }

  getChat(chatId) {
    return this.call('getChat', { chat_id: chatId });
  }

  getChatMember(chatId, userId) {
    return this.call('getChatMember', { chat_id: chatId, user_id: userId });
  }

  getChatMemberCount(chatId) {
    return this.call('getChatMemberCount', { chat_id: chatId }).catch(() => null);
  }

  sendChatAction(chatId, action = 'typing') {
    return this.call('sendChatAction', { chat_id: chatId, action }).catch(() => null);
  }

  setMyCommands(commands, scope, languageCode) {
    return this.call('setMyCommands', { commands, scope, language_code: languageCode });
  }

  /** Shown on the bot's profile before anyone presses Start. */
  setMyDescription(description, languageCode) {
    return this.call('setMyDescription', { description, language_code: languageCode });
  }

  setMyShortDescription(shortDescription, languageCode) {
    return this.call('setMyShortDescription', { short_description: shortDescription, language_code: languageCode });
  }

  /** Resolves a file_id to a downloadable URL — used for product photos. */
  async fileUrl(fileId) {
    const file = await this.call('getFile', { file_id: fileId });
    return `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
