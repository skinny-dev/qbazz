import { keyboard, urlButton } from './telegram/keyboard.js';
import { b, esc, hashtag, i, lines, priceText, truncate } from './render.js';
import { makeTx } from './i18n/index.js';
import { bidiText, mirrorMarkup } from './telegram/rtl.js';

/**
 * Posts queued products into shops' Telegram channels.
 *
 * Same shape as the notifier: the core decides what should go out and when,
 * this drains the queue and makes the Telegram call. A channel post cannot use
 * callback buttons — nobody is "pressing" in a broadcast channel — so every
 * button is a deep link that opens the bot on the right screen.
 *
 * A post is written in the *shop's* language, not the poster's or the
 * seller's current one: subscribers of a Persian channel read Persian, laid out
 * right to left, with prices in Toman and Persian digits.
 */
export function createChannelPoster({ core, api, config, log }) {
  let timer = null;
  let running = false;

  async function drain() {
    if (running) return;
    running = true;
    try {
      const { items } = await core.pendingChannelPosts(10);
      for (const post of items) await publish(post);
    } catch (err) {
      log.warn(`channel post drain failed: ${err.message}`);
    } finally {
      running = false;
    }
  }

  /**
   * A product we posted earlier changed: rewrite that very message, so the
   * channel never shows a stale price. Telegram says "not modified" when the
   * text is identical (fine) and "not found" when someone deleted the post
   * (the core then forgets the link and stops).
   */
  async function edit(post) {
    try {
      const tx = makeTx(post.locale || post.store?.locale || config.defaultLocale, config.defaultLocale);
      const text = bidiText(renderProduct(tx, post), tx.rtl);
      const markup = mirrorMarkup(keyboard(buildButtons(tx, post, config)), tx.rtl);
      const messageId = Number(post.messageId);
      try {
        if (post.hasPhoto) await api.editMessageCaption(post.chatId, messageId, text, { reply_markup: markup });
        else await api.editMessageText(post.chatId, messageId, text, { reply_markup: markup });
      } catch (err) {
        if (/not modified/i.test(err.message)) { await core.markChannelPosted(post.id, { ok: true }); return; }
        if (/not found|can't be edited|MESSAGE_ID_INVALID/i.test(err.message)) { await core.markChannelPosted(post.id, { ok: false, gone: true, error: err.message }); return; }
        throw err;
      }
      await core.markChannelPosted(post.id, { ok: true });
      log.info(`updated channel post ${post.messageId} for ${post.product?.title}`);
    } catch (err) {
      await core.markChannelPosted(post.id, { ok: false, error: err.message }).catch(() => null);
      log.warn(`channel post edit ${post.id} failed: ${err.message}`);
    }
  }

  async function publish(post) {
    if (post.kind === 'edit') return edit(post);
    try {
      if (!post.product) {
        await core.markChannelPosted(post.id, { ok: false, error: 'nothing to post' });
        return;
      }

      const tx = makeTx(post.locale || post.store?.locale || config.defaultLocale, config.defaultLocale);
      const text = bidiText(renderProduct(tx, post), tx.rtl);
      const markup = mirrorMarkup(keyboard(buildButtons(tx, post, config)), tx.rtl);

      // Telegram's own `getFile` download URL cannot reliably be handed back
      // to Telegram as a photo source ("failed to get HTTP URL content") —
      // the original file_id is what actually works, when the bot has one.
      const photo = post.product.telegramFileIds?.[0] || post.product.image;
      const message = await sendWithPhotoFallback({ api, log }, post.chatId, photo, text, markup);

      await core.markChannelPosted(post.id, { ok: true, messageId: String(message?.message_id || ''), hasPhoto: Boolean(message?.photo?.length) });
      log.info(`posted ${post.product.title} to channel ${post.chatId}`);
    } catch (err) {
      // Removed as admin, channel deleted, or the bot was kicked: the core
      // stops retrying after three of these.
      await core.markChannelPosted(post.id, { ok: false, error: err.message }).catch(() => null);
      log.warn(`channel post ${post.id} failed: ${err.message}`);
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(drain, config.notifyIntervalMs);
      if (timer.unref) timer.unref();
      drain();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    drain,
  };
}

const start = (config, payload) => `https://t.me/${config.username}?start=${payload}`;

/**
 * Every button is a deep link. The layout is per shop; a button the shop never
 * labelled is worded in the shop's language.
 */
function buildButtons(tx, post, config) {
  const rows = post.buttons?.length ? post.buttons : [[{ type: 'cart' }, { type: 'save' }]];
  const product = post.product;
  const label = (entry) => entry.label || tx.t(`b.post.${entry.type}`);

  return rows
    .map((row) => row
      .map((entry) => {
        switch (entry.type) {
          case 'buy':
            // No price to check out with: the button opens the same product
            // page in the bot, where "price on request" replaces Add to cart.
            return product.price
              ? urlButton(`🛒 ${label(entry)}`, start(config, `p_${product.id}`))
              : urlButton(`📞 ${tx.t('b.post.inquire')}`, start(config, `p_${product.id}`));
          case 'cart':
            // Adds straight to the buyer's cart in one tap — a channel post is
            // already a specific product, not a browsing session, so there is
            // no reason to make them tap twice. No price, no cart to add to:
            // falls back to the same "ask about it" link `buy` uses.
            return product.price
              ? urlButton(`🛒 ${label(entry)}`, start(config, `c_${product.id}`))
              : urlButton(`📞 ${tx.t('b.post.inquire')}`, start(config, `p_${product.id}`));
          case 'save':
            return urlButton(`❤️ ${label(entry)}`, start(config, `w_${product.id}`));
          case 'shop':
            return urlButton(`🏪 ${label(entry)}`, start(config, `s_${post.store?.slug || product.storeSlug}`));
          case 'contact': {
            const handle = post.contact?.telegram?.replace(/^@/, '');
            return handle ? urlButton(`💬 ${label(entry)}`, `https://t.me/${handle}`) : null;
          }
          case 'share':
            return urlButton(`↗️ ${label(entry)}`, `https://t.me/share/url?url=${encodeURIComponent(start(config, `p_${product.id}`))}`);
          case 'web':
            return product.url ? urlButton(`🌐 ${label(entry)}`, product.url) : null;
          default:
            return null;
        }
      })
      .filter(Boolean))
    .filter((row) => row.length);
}

/**
 * A bad or unfetchable photo must never sink the whole post — the caption and
 * the Buy button are the part that actually matters. Only a photo-specific
 * failure falls back to text; a reason `sendMessage` would fail identically
 * for (the bot was removed, the chat is gone) still propagates, so the
 * existing three-strikes give-up logic still applies to those.
 */
async function sendWithPhotoFallback({ api, log }, chatId, photo, text, markup) {
  if (!photo) return api.sendMessage(chatId, text, { reply_markup: markup });
  try {
    return await api.sendPhoto(chatId, photo, text, { reply_markup: markup });
  } catch (err) {
    if (err.unreachable) throw err;
    log.warn(`photo failed for channel post to ${chatId} (${err.message}) — posting as text instead`);
    return api.sendMessage(chatId, text, { reply_markup: markup });
  }
}

/** `#a_tag`, unicode-aware — works for a Persian tag as well as an English one. */
/**
 * The channel post as a mini product page: a hook (AI only — the offline
 * template never invents excitement), the name and a real description,
 * scannable specs, the price, whether it is in stock, a CTA line right above
 * the buttons, and — last, easy to skip past — discovery hashtags built from
 * the product's own tags. Nothing here is written fresh at post time: it is
 * all already on `post`/`product`, from whichever path put it there (AI
 * generation, the offline template, or the seller's own words).
 *
 * Each block gets a genuine blank line before it (a bare '' in `lines()`
 * is dropped, not rendered, so the gap is a leading "\n" on the block
 * itself) — a wall of text reads as filler even when the content is real.
 * There is no store-attribution footer: the channel's own name is already
 * the header Telegram shows above every post.
 */
function renderProduct(tx, post) {
  const product = post.product;
  const price = product.compareAtPrice
    ? `${priceText(tx, product)}  ${tx.t('b.render.discount', { percent: product.discountPercent })}`
    : priceText(tx, product);

  const hook = post.hook || '';
  const caption = post.caption || product.description || '';
  const properties = (product.properties || [])
    .slice(0, 6)
    .map((entry) => `• ${esc(entry.name)}: ${esc(entry.value)}`)
    .join('\n');
  const tags = (product.tags || []).slice(0, 8).map(hashtag).filter(Boolean).join(' ');

  return lines(
    hook ? `🔥 ${esc(hook)}` : null,
    b(product.title),
    caption ? `\n${esc(truncate(caption, 600))}` : null,
    properties ? `\n${properties}` : null,
    `\n💰 ${price}`,
    product.inStock === false ? tx.t('b.post.out_of_stock') : tx.t('b.post.in_stock'),
    `\n${i(tx.t('b.post.cta_line'))}`,
    tags ? `\n${esc(tags)}` : null,
  );
}
