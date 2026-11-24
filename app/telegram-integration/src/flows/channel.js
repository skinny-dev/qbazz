import { button, keyboard, urlButton } from '../telegram/keyboard.js';
import { b, esc, i, lines } from '../render.js';
import { parseDateRange } from '../util/jalali.js';

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
      [button(t('b.btn.import_history'), 'chip', storeId)],
      [button(t('b.btn.queue_existing'), 'chbp', storeId)],
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
      esc(t('b.chan.prompt_fast')),
      '',
      ...howToLines(t).map((line) => esc(line)),
      '',
      i(t('b.chan.prompt_public')),
    ),
    keyboard([
      [urlButton(t('b.btn.add_to_channel'), `https://t.me/${ctx.config.username}?startchannel&admin=post_messages+edit_messages+delete_messages`)],
      [button(t('b.nav.cancel'), 'ch', storeId)],
    ]),
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
        [button(t('b.btn.import_history'), 'chip', storeId)],
        [button(t('b.btn.post_now'), 'chbp', storeId)],
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

const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

/**
 * Bring the channel's older posts in as products, from the chat itself: read the public page, then ONE tap adds every
 * post the reader was sure about (the rest wait for a look on the site). The work runs in the background - the bot
 * keeps answering everyone else - and the message the person is looking at is the progress bar.
 */
const dayAgo = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
const PRESETS = { all: () => ({}), w: () => ({ from: dayAgo(7), to: today() }), m: () => ({ from: dayAgo(30), to: today() }) };

/** Step one of both directions: which days? A few buttons, or the days typed in the Persian calendar. */
export async function chooseRange(ctx, storeId, direction) {
  const { t } = ctx;
  await ctx.answer();
  const [pick, typed] = direction === 'import' ? ['chir', 'chid'] : ['chbr', 'chbd'];
  return ctx.screen(
    lines(b(t(direction === 'import' ? 'b.chan.range_title_in' : 'b.chan.range_title_out')), '', esc(t('b.chan.range_lead'))),
    keyboard([
      [button(t('b.chan.range_all'), pick, storeId, 'all')],
      [button(t('b.chan.range_week'), pick, storeId, 'w'), button(t('b.chan.range_month'), pick, storeId, 'm')],
      [button(t('b.chan.range_dates'), typed, storeId)],
      [button(t('b.nav.back'), 'ch', storeId)],
    ]),
  );
}

export async function askRange(ctx, storeId, direction) {
  const { t } = ctx;
  await ctx.answer();
  await ctx.setState({ awaiting: 'chrange', rangeStoreId: storeId, rangeDirection: direction });
  return ctx.reply(lines(b(t('b.chan.range_ask')), '', esc(t('b.chan.range_example'))), keyboard([[button(t('b.nav.cancel'), 'ch', storeId)]]));
}

/** The seller typed the days. */
export async function handleRangeInput(ctx) {
  if (ctx.state.awaiting !== 'chrange') return false;
  const { t } = ctx;
  const storeId = ctx.state.rangeStoreId;
  const range = parseDateRange(ctx.text || '');
  if (!range) {
    await ctx.reply(lines(esc(t('b.chan.range_bad')), '', esc(t('b.chan.range_example'))));
    return true;
  }
  const direction = ctx.state.rangeDirection;
  await ctx.clearState(['awaiting', 'rangeStoreId', 'rangeDirection']);
  const clean = Object.fromEntries(Object.entries(range).filter(([, v]) => v));
  if (direction === 'import') await importHistory(ctx, storeId, clean);
  else await backfill(ctx, storeId, clean);
  return true;
}

export async function importWithPreset(ctx, storeId, preset) { return importHistory(ctx, storeId, (PRESETS[preset] || PRESETS.all)()); }
export async function backfillWithPreset(ctx, storeId, preset) { return backfill(ctx, storeId, (PRESETS[preset] || PRESETS.all)()); }

export async function importHistory(ctx, storeId, range = {}) {
  const { t } = ctx;
  const channel = await ctx.core.getChannel(ctx.account.id, storeId);
  await ctx.answer();
  if (!channel || channel.connected === false) return showChannel(ctx, storeId);
  if (!channel.username) {
    return ctx.reply(t('b.chan.import_private'), keyboard([[button(t('b.nav.back'), 'ch', storeId)]]));
  }

  let job;
  try {
    job = await ctx.core.channelImportStart(ctx.account.id, storeId, channel.username, range);
  } catch (err) {
    return ctx.reply(`⚠️ ${esc(ctx.err(err))}`, keyboard([[button(t('b.nav.back'), 'ch', storeId)]]));
  }
  const sent = await ctx.reply(t('b.chan.import_reading', { pages: 0, posts: 0 }));
  const messageId = sent?.message_id;
  const webUrl = `${String(ctx.config.webAppUrl || '').replace(/\/$/, '')}/manage/settings`;

  const show = (text, markup) => (messageId ? ctx.edit(messageId, text, markup) : ctx.reply(text, markup).catch(() => null));

  (async () => {
    let state = job;
    for (let n = 0; n < 240 && ['reading'].includes(state.status); n += 1) {
      await sleep(ctx.config.importPollMs ?? 2500);
      state = await ctx.core.channelImportGet(ctx.account.id, storeId, job.id);
      if ((n % 2 === 1 || ctx.config.importPollMs) && state.status === 'reading') await show(t('b.chan.import_reading', { pages: state.progress?.pages || 0, posts: state.progress?.posts || 0 }));
    }
    if (state.status === 'failed') return show(t('b.chan.import_failed'), keyboard([[button(t('b.btn.try_again'), 'chi', storeId)], [button(t('b.nav.back'), 'ch', storeId)]]));
    if (state.status !== 'ready') return show(t('b.chan.import_slow'), keyboard([[urlButton(t('b.btn.review_on_site'), webUrl)]]));

    const items = state.items || [];
    const sure = items.filter((x) => x.selected);
    if (!items.length) return show(t('b.chan.import_none', { posts: state.progress?.posts || 0 }), keyboard([[button(t('b.nav.back'), 'ch', storeId)]]));
    await ctx.setState({ importJobId: job.id, importStoreId: storeId }).catch(() => null);
    return show(
      lines(t('b.chan.import_found', { total: items.length, sure: sure.length, posts: state.progress?.posts || 0 }), '', i(t('b.chan.import_hint'))),
      keyboard([
        sure.length ? [button(t('b.btn.import_sure', { count: sure.length }), 'chia', storeId, job.id)] : [],
        items.length !== sure.length ? [button(t('b.btn.import_all', { count: items.length }), 'chiw', storeId, job.id)] : [],
        [urlButton(t('b.btn.review_on_site'), webUrl)],
        [button(t('b.nav.back'), 'ch', storeId)],
      ]),
    );
  })().catch((err) => ctx.log?.warn?.(`channel import (bot) failed: ${err.message}`));
}

/** The tap: add the sure ones (or every one found), then show what happened. */
export async function commitImport(ctx, storeId, jobId, everything = false) {
  const { t } = ctx;
  let job;
  try {
    job = await ctx.core.channelImportGet(ctx.account.id, storeId, jobId);
  } catch (err) {
    await ctx.answer();
    return ctx.reply(`⚠️ ${esc(ctx.err(err))}`);
  }
  if (job.status !== 'ready') { await ctx.answer(t('b.chan.import_already'), { alert: true }); return null; }
  const picked = (job.items || []).filter((x) => everything || x.selected).map((x) => ({ id: x.id }));
  try {
    await ctx.core.channelImportCommit(ctx.account.id, storeId, jobId, picked);
  } catch (err) {
    await ctx.answer();
    return ctx.reply(`⚠️ ${esc(ctx.err(err))}`);
  }
  await ctx.answer();
  const messageId = ctx.messageId;
  const show = (text, markup) => ctx.edit(messageId, text, markup);
  await show(t('b.chan.import_adding', { done: 0, total: picked.length }));

  (async () => {
    let state = job;
    for (let n = 0; n < 400 && state.status !== 'done' && state.status !== 'failed'; n += 1) {
      await sleep(ctx.config.importPollMs ?? 3000);
      state = await ctx.core.channelImportGet(ctx.account.id, storeId, jobId);
      if ((n % 2 === 1 || ctx.config.importPollMs) && state.status === 'importing') await show(t('b.chan.import_adding', { done: state.progress?.imported || 0, total: picked.length }));
    }
    const done = state.result || {};
    const webUrl = `${String(ctx.config.webAppUrl || '').replace(/\/$/, '')}/manage/products`;
    const note = done.stopped ? `\n${t(`b.chan.import_stopped_${done.stopped}`)}` : '';
    return show(
      `${t('b.chan.import_done', { created: done.created || 0, failed: done.failed || 0 })}${note}`,
      keyboard([[urlButton(t('b.btn.open_products'), webUrl)], [button(t('b.nav.back'), 'ch', storeId)]]),
    );
  })().catch((err) => ctx.log?.warn?.(`channel import commit (bot) failed: ${err.message}`));
  return null;
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

export async function backfill(ctx, storeId, range = {}) {
  let result;
  try {
    result = await ctx.core.backfillChannel(ctx.account.id, storeId, range);
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
    return showChannel(ctx, storeId);
  }
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
