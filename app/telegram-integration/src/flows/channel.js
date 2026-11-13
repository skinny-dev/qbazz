import { button, keyboard, urlButton } from '../telegram/keyboard.js';
import { b, esc, i, lines } from '../render.js';

/**
 * Connecting a shop's Telegram channel.
 *
 * Verification is the one thing only a Telegram client can do, so it lives
 * here: ask Telegram whether the bot can post in the channel, and whether the
 * person asking actually administers it. The core stores the result and
 * refuses a connection without both proofs — without the second check, anyone
 * could attach someone else's channel to their own shop.
 */

/** The four setup steps, in the reader's language. */
export const howToLines = (t) => [1, 2, 3, 4].map((n) => t(`b.chan.howto.${n}`));

export async function showChannel(ctx, storeId) {
  const { tx, t } = ctx;
  await ctx.setState({ sellerStoreId: storeId });
  const channel = await ctx.core.getChannel(ctx.account.id, storeId);

  if (!channel || channel.connected === false) {
    return ctx.screen(
      lines(
        b(t('b.chan.connect_title')),
        '',
        esc(t('b.chan.connect_lead')),
        '',
        b(t('b.chan.how_to')),
        ...howToLines(t).map((line) => esc(line)),
      ),
      keyboard([
        [button(t('b.btn.connect_now'), 'chc', storeId)],
        [button(t('b.nav.dashboard'), 'sd', storeId)],
      ]),
    );
  }

  const handle = channel.username ? `@${channel.username}` : channel.title;
  const sending = channel.stats?.queued ? ` · ${t('b.chan.sending', { count: channel.stats.queued })}` : '';

  return ctx.screen(
    lines(
      `📣 ${b(channel.title)}`,
      channel.username ? esc(tx.ltr(`@${channel.username}`)) : null,
      channel.memberCount ? t('b.chan.subscribers', { count: channel.memberCount }) : null,
      '',
      t('b.chan.auto_line', { state: channel.autoPost ? t('b.chan.on') : t('b.chan.off') }),
      channel.reviewBeforePost === false ? t('b.chan.review_line_off') : t('b.chan.review_line_on'),
      t('b.chan.sync_line', { state: channel.syncPosts ? t('b.chan.on') : t('b.chan.off') }),
      `${t('b.chan.posted_line', { count: channel.stats?.posted || 0 })}${sending}`,
      channel.stats?.drafts ? t('b.chan.drafts_line', { count: channel.stats.drafts }) : null,
      channel.lastPostAt ? t('b.chan.last_post', { date: tx.date(channel.lastPostAt, { dateStyle: 'short', timeStyle: 'short' }) }) : null,
      '',
      i(channel.autoPost ? t('b.chan.auto_on_note') : t('b.chan.auto_off_note')),
      i(channel.syncPosts ? t('b.chan.sync_on_note') : t('b.chan.sync_off_note')),
    ),
    keyboard([
      channel.stats?.drafts ? [button(t('b.btn.review_posts', { count: channel.stats.drafts }), 'drs', storeId)] : [],
      [button(channel.autoPost ? t('b.btn.auto_off') : t('b.btn.auto_on'), 'cha', storeId)],
      [button(channel.reviewBeforePost === false ? t('b.btn.review_on') : t('b.btn.review_off'), 'chr', storeId)],
      [button(channel.syncPosts ? t('b.btn.sync_off') : t('b.btn.sync_on'), 'chs', storeId)],
      [button(t('b.btn.queue_existing'), 'chb', storeId)],
      channel.username ? [urlButton(t('b.btn.open_channel', { handle }), `https://t.me/${channel.username}`)] : [],
      [button(t('b.btn.disconnect'), 'chd', storeId)],
      [button(t('b.nav.dashboard'), 'sd', storeId)],
    ]),
  );
}

export async function promptConnect(ctx, storeId) {
  const { t } = ctx;
  await ctx.setState({ awaiting: 'channel', channelStoreId: storeId });
  await ctx.answer();
  return ctx.reply(
    lines(
      b(t('b.chan.prompt_title')),
      '',
      ...howToLines(t).map((line) => esc(line)),
      '',
      i(t('b.chan.prompt_public')),
    ),
    keyboard([[button(t('b.nav.cancel'), 'ch', storeId)]]),
  );
}

/**
 * Asks Telegram the two questions that matter. Returns either a verified
 * payload for the core, or a human explanation — in the person's language — of
 * what is missing.
 */
export async function verifyChannel(ctx, reference) {
  const { t } = ctx;
  let chat;
  try {
    chat = await ctx.api.getChat(reference);
  } catch {
    return { error: t('b.chan.err_cannot_see') };
  }

  if (chat.type !== 'channel') {
    return { error: t('b.chan.err_not_channel', { type: esc(chat.type) }) };
  }

  const title = esc(chat.title);
  const me = await ctx.api.getMe();
  let botMember;
  try {
    botMember = await ctx.api.getChatMember(chat.id, me.id);
  } catch {
    return { error: t('b.chan.err_not_in', { title }) };
  }

  if (botMember.status !== 'administrator') {
    return { error: t('b.chan.err_bot_status', { title, status: esc(botMember.status) }) };
  }
  if (botMember.can_post_messages === false) {
    return { error: t('b.chan.err_cannot_post', { title }) };
  }

  // The person connecting must administer it — otherwise a shop could claim
  // any channel it happens to be able to see.
  let userMember;
  try {
    userMember = await ctx.api.getChatMember(chat.id, Number(ctx.userId));
  } catch {
    return { error: t('b.chan.err_cannot_confirm', { title }) };
  }
  if (!['creator', 'administrator'].includes(userMember.status)) {
    return { error: t('b.chan.err_not_admin', { title, status: esc(userMember.status) }) };
  }

  const memberCount = await ctx.api.getChatMemberCount(chat.id);

  // The channel already has a face and a description — a shop that borrows
  // its name (the channel-first onboarding) should borrow these too, rather
  // than start with a blank logo and an empty "describe your shop" the
  // seller was never even asked. Only used to *fill in what's missing*,
  // never to overwrite something the seller set themselves — see `connect()`.
  const photoFileId = chat.photo?.big_file_id || chat.photo?.small_file_id || null;
  const logoUrl = photoFileId ? await ctx.api.fileUrl(photoFileId).catch(() => null) : null;

  return {
    payload: {
      chatId: String(chat.id),
      username: chat.username || null,
      title: chat.title,
      logoUrl,
      description: chat.description || null,
      memberCount: memberCount ?? undefined,
      canPost: true,
      verifiedUserIsAdmin: true,
    },
  };
}

/** What the person sent to identify a channel: a forwarded post, or an @handle. */
function channelReference(ctx) {
  if (ctx.forwardedFromChat?.id) return ctx.forwardedFromChat.id;
  return (ctx.text || '').trim().replace(/^https?:\/\/t\.me\//i, '@').replace(/^@?/, '@');
}

/** Free-text/forward handler while a connect is in progress. */
export async function handleChannelInput(ctx) {
  if (ctx.state.awaiting !== 'channel') return false;
  const { t } = ctx;
  const storeId = ctx.state.channelStoreId;

  const reference = channelReference(ctx);
  if (!reference || reference === '@') {
    await ctx.reply(t('b.chan.need_reference'));
    return true;
  }

  await ctx.typing();
  const { payload, error } = await verifyChannel(ctx, reference);

  if (error) {
    await ctx.reply(
      lines(`⚠️ ${error}`, '', i(t('b.chan.fix_try'))),
      keyboard([[button(t('b.btn.try_again'), 'chc', storeId)], [button(t('b.nav.dashboard'), 'sd', storeId)]]),
    );
    return true;
  }

  try {
    const channel = await ctx.core.connectChannel(ctx.account.id, storeId, payload);
    await ctx.clearState(['awaiting', 'channelStoreId']);
    await ctx.reply(
      lines(
        t('b.chan.connected', { title: b(channel.title) }),
        '',
        esc(t('b.chan.connected_note')),
      ),
      keyboard([
        [button(t('b.btn.post_now'), 'chb', storeId)],
        [button(t('b.btn.channel_settings'), 'ch', storeId), button(t('b.btn.dashboard'), 'sd', storeId)],
      ]),
    );
  } catch (err) {
    await ctx.reply(
      lines(`⚠️ ${esc(ctx.err(err))}`),
      keyboard([[button(t('b.btn.try_again'), 'chc', storeId)], [button(t('b.nav.dashboard'), 'sd', storeId)]]),
    );
  }
  return true;
}

export async function toggleAutoPost(ctx, storeId) {
  const current = await ctx.core.getChannel(ctx.account.id, storeId);
  const next = !current?.autoPost;
  await ctx.core.setChannelAutoPost(ctx.account.id, storeId, next);
  await ctx.answer(next ? ctx.t('b.chan.toast_auto_on') : ctx.t('b.chan.toast_auto_off'));
  return showChannel(ctx, storeId);
}

/**
 * The other direction: does a post the seller sends *to* the channel become a
 * product? Off by default for a channel connected this way (the dashboard) —
 * only the channel-first onboarding turns it on automatically — so this is
 * how a shop that connected its channel earlier turns it on afterwards.
 */
export async function toggleSync(ctx, storeId) {
  const current = await ctx.core.getChannel(ctx.account.id, storeId);
  const next = !current?.syncPosts;
  await ctx.core.setChannelSync(ctx.account.id, storeId, next);
  await ctx.answer(next ? ctx.t('b.chan.toast_sync_on') : ctx.t('b.chan.toast_sync_off'));
  return showChannel(ctx, storeId);
}

export async function backfill(ctx, storeId) {
  const result = await ctx.core.backfillChannel(ctx.account.id, storeId);
  await ctx.answer(
    result.queued ? ctx.t('b.chan.toast_queued', { count: result.queued }) : ctx.t('b.chan.toast_nothing'),
    { alert: !result.queued },
  );
  return showChannel(ctx, storeId);
}

export async function disconnect(ctx, storeId) {
  await ctx.core.disconnectChannel(ctx.account.id, storeId);
  await ctx.answer(ctx.t('b.chan.toast_disconnected'));
  return showChannel(ctx, storeId);
}

/**
 * The onboarding version of the same thing. Onboarding hands us the raw answer;
 * we verify it here and submit proof, or explain what is wrong without
 * advancing the flow.
 */
export async function verifyForOnboarding(ctx) {
  const reference = channelReference(ctx);
  if (!reference || reference === '@') return { error: ctx.t('b.chan.need_reference') };

  await ctx.typing();
  return verifyChannel(ctx, reference);
}
