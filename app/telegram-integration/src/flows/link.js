import { button, keyboard, urlButton } from '../telegram/keyboard.js';
import { b, code, esc, i, lines } from '../render.js';

/**
 * Account linking and handoff — the seam between Telegram and the web.
 *
 * Two directions:
 *  • /link issues a code the user types on the website, which attaches this
 *    Telegram identity to their web account (merging the two if both exist).
 *  • "Open on web" mints a signed one-time handoff so they land signed in,
 *    without typing a password on a phone.
 */

export async function showLink(ctx) {
  const { tx, t } = ctx;
  const session = await ctx.core.session(ctx.account.id);
  const linked = (session.identities || []).filter((identity) => identity.channel !== 'telegram');

  if (linked.length) {
    const handoff = await ctx.core.createHandoff(ctx.account.id, { to: 'web', path: '/' });
    return ctx.screen(
      lines(
        b(t('b.link.linked_title')),
        '',
        ...linked.map((identity) => `• ${esc(identity.channel)}${identity.verified ? ' ✅' : ` ${t('b.link.unverified')}`}`),
        '',
        i(t('b.link.same')),
      ),
      keyboard([[urlButton(t('b.btn.open_web_signed'), handoff.url)], [button(t('b.nav.home'), 'home')]]),
    );
  }

  const { code: linkCode, expiresAt } = await ctx.core.issueLinkCode(ctx.account.id);
  const minutes = Math.max(1, Math.round((new Date(expiresAt) - Date.now()) / 60000));

  return ctx.screen(
    lines(
      b(t('b.link.code_title')),
      '',
      esc(t('b.link.code_lead')),
      '',
      tx.ltr(code(linkCode)),
      '',
      i(t('b.link.expires', { minutes })),
      '',
      esc(t('b.link.after')),
    ),
    keyboard([
      [urlButton(t('b.btn.open_website'), `${ctx.config.webAppUrl}/link`)],
      [button(t('b.btn.new_code'), 'link'), button(t('b.nav.home'), 'home')],
    ]),
  );
}

/**
 * Redeems a code generated on the web and pasted into the chat.
 *
 * `tryRedeemCode` returns false instead of complaining when the code is unknown
 * — the router uses that to try a six-character message as a code first and fall
 * through to search, so typing "banana" still searches for banana.
 */
export async function tryRedeemCode(ctx, rawCode) {
  const { t } = ctx;
  try {
    await ctx.core.redeemLinkCode(rawCode.trim().toUpperCase(), {
      channel: 'telegram',
      externalId: ctx.userId,
      profile: { displayName: ctx.account.displayName },
    });
  } catch {
    return false;
  }
  await ctx.clearState(['awaiting']);
  await ctx.reply(
    lines(b(t('b.link.done_title')), '', esc(t('b.link.done_body')), '', i(t('b.link.done_shared'))),
    keyboard([[button(t('b.nav.home'), 'home')]]),
  );
  return true;
}

export async function redeemCode(ctx, rawCode) {
  const { t } = ctx;
  try {
    const result = await ctx.core.redeemLinkCode(rawCode.trim().toUpperCase(), {
      channel: 'telegram',
      externalId: ctx.userId,
      profile: { displayName: ctx.account.displayName },
    });
    await ctx.clearState(['awaiting']);
    return ctx.reply(
      lines(b(t('b.link.done_title')), '', t('b.link.done_named', { name: esc(result.account.displayName) }), '', i(t('b.link.done_named_shared'))),
      keyboard([[button(t('b.nav.home'), 'home')]]),
    );
  } catch (err) {
    return ctx.reply(
      lines(`⚠️ ${esc(ctx.err(err))}`, '', i(t('b.link.retry_hint'))),
      keyboard([[button(t('b.btn.get_code'), 'link')], [button(t('b.nav.home'), 'home')]]),
    );
  }
}

/**
 * `?start=lc_<code>` — the one-tap link from the web. Someone setting up on the
 * website taps "open the bot", presses Start, and this account and their web
 * account become one. That is also the bot's first hello, so it doubles as a
 * short tour of what the bot is for.
 */
export async function linkFromStart(ctx, code) {
  const { t } = ctx;
  let result;
  try {
    result = await ctx.core.redeemLinkCode(String(code).toUpperCase().trim(), {
      channel: 'telegram',
      externalId: ctx.userId,
      profile: { displayName: ctx.account.displayName },
    });
  } catch (err) {
    return ctx.reply(
      lines(`⚠️ ${esc(ctx.err(err))}`, '', i(t('b.link.start_retry'))),
      keyboard([[button(t('b.nav.home'), 'home')]]),
    );
  }
  const name = (result.account.displayName || '').split(' ')[0];
  return ctx.reply(
    lines(
      b(t('b.link.start_title', { name })),
      '',
      esc(t('b.link.start_back_to_web')),
      '',
      b(t('b.link.start_tour')),
      esc(t('b.link.start_tour_1')),
      esc(t('b.link.start_tour_2')),
      esc(t('b.link.start_tour_3')),
      '',
      i(t('b.link.add_channel_hint')),
    ),
    keyboard([[urlButton(t('b.btn.add_to_channel'), `https://t.me/${ctx.config.username}?startchannel&admin=post_messages+edit_messages+delete_messages`)], [button(t('b.btn.my_shop'), 'sell')], [button(t('b.nav.home'), 'home')]]),
  );
}

/** Handles the `?start=h_<token>` deep link coming back from the web. */
export async function openOnWeb(ctx, path = '/') {
  const { t } = ctx;
  const handoff = await ctx.core.createHandoff(ctx.account.id, { to: 'web', path });
  return ctx.reply(
    lines(b(t('b.link.web_title')), '', i(t('b.link.web_hint'))),
    keyboard([[urlButton(t('b.btn.open_qbazz_web'), handoff.url)], [button(t('b.nav.home'), 'home')]]),
  );
}
