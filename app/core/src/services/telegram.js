import { COLLECTIONS } from '../models/schemas.js';
import { ConflictError } from '../errors.js';
import { telegramFetch } from '../util/telegramFetch.js';

/**
 * The core's own window onto Telegram, used for one thing: checking a channel
 * from the web. The bot already does this from inside Telegram (it knows who is
 * talking); the web does not, so the core asks Telegram directly and works out
 * the rest from the account — whether a Telegram identity is linked, and if so
 * whether that person administers the channel.
 *
 * Nothing the browser says about a channel is trusted: it sends a reference
 * (`@name`), and every fact comes from here.
 */
export function createTelegramService(ctx) {
  const { config, services, log, store: db } = ctx;
  const settingsDb = db.collection(COLLECTIONS.platformSettings);
  const identitiesDb = db.collection(COLLECTIONS.identities);

  const token = () => config.telegram?.botToken || '';
  // Telegram only goes through the proxy when one is configured (a server that cannot reach it directly)
  const tgFetch = telegramFetch(config.telegram?.proxy);
  const botUsername = () => config.platform.botUsername || 'qbazz_bot';

  async function call(method, params = {}) {
    if (!token()) throw new ConflictError('err.telegram_unavailable');
    const response = await tgFetch(`${config.telegram.apiBase}/bot${token()}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await response.json().catch(() => ({}));
    if (!data.ok) {
      const err = new Error(data.description || `Telegram ${method} failed`);
      err.telegram = true;
      throw err;
    }
    return data.result;
  }

  /** "@name", "name", "t.me/name" and "https://t.me/name" all mean the same channel. */
  function normalizeReference(input) {
    const raw = String(input ?? '').trim();
    if (!raw) return null;
    if (/^-?\d{5,}$/.test(raw)) return raw; // a numeric chat id
    const match = raw.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?@?([A-Za-z0-9_]{4,})\/?$/i) || raw.match(/^@?([A-Za-z0-9_]{4,})$/);
    return match ? `@${match[1]}` : null;
  }

  /** Link that opens Telegram's "add this bot as an admin to your channel" sheet with posting already ticked. */
  const addBotUrl = () => `https://t.me/${botUsername()}?startchannel&admin=post_messages+edit_messages+delete_messages`;

  /**
   * Where a person stands on connecting `reference`, as one status the web can
   * render. `ok` carries the channel facts the onboarding step needs.
   */
  async function inspectChannel(input, { accountId } = {}) {
    const reference = normalizeReference(input);
    if (!reference) return { status: 'bad_reference' };
    if (!token()) return { status: 'unavailable' };

    let chat;
    try {
      chat = await call('getChat', { chat_id: reference });
    } catch {
      // Public channels resolve by name even before the bot joins; a miss means a typo or a private channel.
      return { status: 'not_found', reference, addBotUrl: addBotUrl() };
    }
    if (chat.type !== 'channel') return { status: 'not_channel', reference, chatType: chat.type };

    const summary = { chatId: String(chat.id), username: chat.username || null, title: chat.title };

    const me = await call('getMe');
    let botMember = null;
    try {
      botMember = await call('getChatMember', { chat_id: chat.id, user_id: me.id });
    } catch {
      botMember = null;
    }
    if (!botMember || botMember.status !== 'administrator') return { status: 'bot_not_admin', channel: summary, addBotUrl: addBotUrl() };
    if (botMember.can_post_messages === false) return { status: 'bot_cannot_post', channel: summary, addBotUrl: addBotUrl() };

    // Who is asking? Only a linked Telegram identity can be checked against the channel's admins.
    const identities = accountId ? await services.accounts.listIdentities(accountId) : [];
    const telegram = identities.find((identity) => identity.channel === 'telegram');
    if (!telegram) {
      const { code } = await services.accounts.currentLinkCode(accountId);
      return { status: 'need_telegram', channel: summary, startUrl: `https://t.me/${botUsername()}?start=lc_${code}` };
    }

    let member;
    try {
      member = await call('getChatMember', { chat_id: chat.id, user_id: Number(telegram.externalId) });
    } catch {
      return { status: 'not_channel_admin', channel: summary };
    }
    if (!['creator', 'administrator'].includes(member.status)) return { status: 'not_channel_admin', channel: summary };

    const [memberCount, photoUrl] = await Promise.all([
      call('getChatMemberCount', { chat_id: chat.id }).catch(() => 0),
      chat.photo?.big_file_id
        ? call('getFile', { file_id: chat.photo.big_file_id }).then((file) => `https://api.telegram.org/file/bot${token()}/${file.file_path}`).catch(() => null)
        : Promise.resolve(null),
    ]);

    return {
      status: 'ok',
      channel: { ...summary, description: chat.description || null, memberCount, logoUrl: photoUrl },
    };
  }

  /** The object the seller onboarding's channel step stores — built here, never taken from a client. */
  async function verifiedChannelAnswer(input, { accountId }) {
    const result = await inspectChannel(typeof input === 'string' ? input : input?.reference, { accountId });
    if (result.status !== 'ok') {
      log.debug?.(`channel check for ${accountId}: ${result.status}`);
      throw new ConflictError(`err.channel_${result.status}`);
    }
    const c = result.channel;
    return {
      chatId: c.chatId,
      username: c.username || undefined,
      title: c.title,
      logoUrl: c.logoUrl || null,
      description: c.description || null,
      memberCount: c.memberCount,
      canPost: true,
      verifiedUserIsAdmin: true,
    };
  }

  /** The channel's current profile photo as a Telegram file URL (token inside: never hand it out), or null. */
  async function channelPhotoUrl(chatId) {
    if (!token()) return null;
    try {
      const chat = await call('getChat', { chat_id: chatId });
      if (!chat.photo?.big_file_id) return null;
      const file = await call('getFile', { file_id: chat.photo.big_file_id });
      return `https://api.telegram.org/file/bot${token()}/${file.file_path}`;
    } catch {
      return null;
    }
  }

  /** A Telegram user's current profile photo as a file URL (token inside: never hand it out), or null - they may hide it. */
  async function userPhotoUrl(userId) {
    if (!token()) return null;
    try {
      const { photos } = await call('getUserProfilePhotos', { user_id: Number(userId), limit: 1 });
      const sizes = photos?.[0];
      if (!sizes?.length) return null;
      const file = await call('getFile', { file_id: sizes[sizes.length - 1].file_id });
      return `https://api.telegram.org/file/bot${token()}/${file.file_path}`;
    } catch {
      return null;
    }
  }

  // -- The quick way in: the person adds the bot to their channel and everything else follows ---------------------------
  // Telegram only offers a person the channels they administer, and tells us who added the bot, so that one tap proves
  // both "the bot can post" and "this person runs the channel". We keep it as a claim until the person has a shop to put
  // it on, or connect it right away when they already do.

  const claimId = (telegramUserId) => `tg-claims:${telegramUserId}`;

  async function accountOfTelegram(telegramUserId) {
    const row = await identitiesDb.findOne({ channel: 'telegram', externalId: String(telegramUserId) });
    return row?.accountId || null;
  }

  /**
   * The bot was made an administrator of `chat` by `telegramUserId`. Remembers it and, when that person is a known
   * account with a shop, connects the channel to that shop (syncing in both directions) at once.
   * Returns what the bot should tell them: { connected, store?, channel, linked }.
   */
  async function botAdded({ telegramUserId, chat, canPost = true }) {
    if (!telegramUserId || !chat?.id || chat.type !== 'channel') return { ignored: true };
    const channel = { chatId: String(chat.id), title: chat.title || chat.username || '', username: chat.username || null, canPost: Boolean(canPost), at: new Date().toISOString() };
    const row = await settingsDb.get(claimId(telegramUserId));
    const items = [channel, ...((row?.items || []).filter((c) => c.chatId !== channel.chatId))].slice(0, 10);
    await settingsDb.upsert(claimId(telegramUserId), { items });

    const accountId = await accountOfTelegram(telegramUserId);
    if (!accountId || !channel.canPost) return { connected: false, linked: Boolean(accountId), channel };
    const mine = (await services.stores.listForAccount(accountId)).filter((s) => ['owner', 'manager'].includes(s.membership?.role) && !s.channels?.telegram);
    // One shop is unambiguous; with several the person picks on the site, where the claim is waiting.
    if (mine.length !== 1) return { connected: false, linked: true, channel, shops: mine.length };
    const shop = mine[0];
    try {
      const details = await Promise.all([
        call('getChatMemberCount', { chat_id: channel.chatId }).catch(() => 0),
        call('getChat', { chat_id: channel.chatId }).catch(() => ({})),
      ]);
      await services.channels.connect(shop.id, {
        chatId: channel.chatId,
        username: channel.username || undefined,
        title: channel.title || 'Telegram',
        description: details[1].description || null,
        memberCount: details[0],
        canPost: true,
        verifiedUserIsAdmin: true,
        logoUrl: await channelPhotoUrl(channel.chatId),
      }, { actorAccountId: accountId, syncPosts: true });
      return { connected: true, linked: true, channel, store: { id: shop.id, name: shop.name, slug: shop.slug } };
    } catch (err) {
      log.warn?.(`auto-connect of ${channel.chatId} to ${shop.slug} failed: ${err.message}`);
      return { connected: false, linked: true, channel, error: err.message };
    }
  }

  /** What the web needs to offer the quick way: whether Telegram is linked, the one-tap links, and any channel already claimed. */
  async function claimsFor(accountId) {
    const identities = await services.accounts.listIdentities(accountId);
    const telegram = identities.find((identity) => identity.channel === 'telegram');
    if (!telegram) {
      const { code } = await services.accounts.currentLinkCode(accountId);
      return { linked: false, connected: [], startUrl: `https://t.me/${botUsername()}?start=lc_${code}`, addBotUrl: addBotUrl(), items: [] };
    }
    const row = await settingsDb.get(claimId(telegram.externalId));
    const all = await db.collection(COLLECTIONS.stores).find({});
    const owner = new Map(all.filter((x) => x.channels?.telegram?.chatId).map((x) => [x.channels.telegram.chatId, x.id]));
    const mine = new Set((await services.stores.listForAccount(accountId)).map((x) => x.id));
    const claims = (row?.items || []).filter((c) => c.canPost);
    return {
      linked: true,
      addBotUrl: addBotUrl(),
      // waiting to be put on a shop
      items: claims.filter((c) => !owner.has(c.chatId)),
      // already put on one of this person's shops (by the bot, the moment it was added)
      connected: claims.filter((c) => mine.has(owner.get(c.chatId))).map((c) => ({ ...c, storeId: owner.get(c.chatId) })),
    };
  }

  return { botAdded, claimsFor, inspectChannel, verifiedChannelAnswer, normalizeReference, addBotUrl, channelPhotoUrl, userPhotoUrl };
}
