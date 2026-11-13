import { button, keyboard, grid } from '../telegram/keyboard.js';
import { b, esc, i, lines, truncate } from '../render.js';

/**
 * The pre-posting preview.
 *
 * A product listed from the bot or the web dashboard becomes a *draft* channel
 * post, not a live one. The seller sees exactly what their subscribers would
 * see, can have the copy written for them, can promote the generated
 * specifications onto the product, and only then does it go out.
 *
 * The generated properties and tags are proposed, never auto-applied — a
 * machine guess about what something is made of should not quietly become a
 * fact on the product page.
 */

export async function showDrafts(ctx, storeId) {
  const { tx, t } = ctx;
  await ctx.setState({ sellerStoreId: storeId });
  const { items } = await ctx.core.listDrafts(ctx.account.id, storeId);

  if (!items.length) {
    return ctx.screen(
      lines(b(t('b.draft.none_title')), '', i(t('b.draft.none_hint'))),
      keyboard([[button(t('b.btn.channel'), 'ch', storeId)], [button(t('b.btn.dashboard'), 'sd', storeId)]]),
    );
  }

  if (items.length === 1) return showDraft(ctx, items[0].id);

  return ctx.screen(
    lines(b(t('b.draft.many_title', { count: items.length })), '', i(t('b.draft.many_hint'))),
    keyboard([
      ...grid(items.map((draft, index) => button(t('b.btn.review_n', { n: index + 1 }), 'dr', draft.id)), 2),
      [button(t('b.btn.channel'), 'ch', storeId)],
    ]),
  );
}

export async function showDraft(ctx, postId) {
  const { t } = ctx;
  const storeId = ctx.state.sellerStoreId;
  const draft = await ctx.core.getDraft(ctx.account.id, storeId, postId);
  const product = draft.product;

  if (!product) {
    await ctx.answer(t('b.draft.product_gone'));
    return showDrafts(ctx, storeId);
  }

  const properties = (product.properties || []).map((entry) => `• ${esc(entry.name)}: ${esc(entry.value)}`);
  const suggested = draft.suggested;

  const text = lines(
    b(t('b.draft.ready')),
    i(draft.store?.name || ''),
    '',
    b(product.title),
    draft.caption ? esc(truncate(draft.caption, 500)) : i(t('b.draft.no_caption')),
    properties.length ? `\n${properties.join('\n')}` : null,
    suggested?.properties?.length
      ? `\n${b(t('b.draft.suggested'))}\n${suggested.properties.map((entry) => `◦ ${esc(entry.name)}: ${esc(entry.value)}${entry.confident === false ? ` ${t('b.draft.guess')}` : ''}`).join('\n')}`
      : null,
    suggested?.tags?.length ? `\n🏷 ${esc(suggested.tags.join(ctx.tx.rtl ? '، ' : ', '))}` : null,
    suggested?.analysis?.missing?.length
      ? `\n${b(t('b.draft.worth_adding'))}\n${suggested.analysis.missing.map((entry) => `• ${esc(entry)}`).join('\n')}`
      : null,
    suggested?.analysis?.note ? `\n${i(suggested.analysis.note)}` : null,
    suggested?.provider === 'template' ? `\n${i(t('b.draft.template_note'))}` : null,
  );

  const rows = [
    [button(suggested ? t('b.btn.rewrite') : t('b.btn.write_it'), 'dgen', postId)],
    [button(t('b.btn.edit_text'), 'ded', postId)],
  ];
  if (suggested?.properties?.length || suggested?.tags?.length) {
    rows.push([button(t('b.btn.add_details'), 'dap', postId)]);
  }
  // Same "generate images" button as the quick-add review and the
  // post-publish screen, reused here so a mockup can still be added before
  // this draft ever reaches the channel.
  if (product.images?.length) rows.push([button(t('b.btn.generate_images'), 'mkgen', draft.storeId, product.id)]);
  rows.push([button(t('b.btn.post_to_channel'), 'dok', postId)]);
  rows.push([button(t('b.btn.discard'), 'ddel', postId), button(t('b.nav.back'), 'ch', storeId)]);

  // A photo preview is the honest preview — that is what subscribers will see.
  if (product.images?.[0] && !ctx.state.__noPhoto) {
    try {
      return await ctx.photoScreen(product.images[0], text, keyboard(rows));
    } catch {
      // Falls through to text when the image URL is unreachable.
    }
  }
  return ctx.screen(text, keyboard(rows));
}

export async function generate(ctx, postId) {
  await ctx.answer(ctx.t('b.draft.writing'));
  await ctx.typing();
  try {
    // Worded in the shop's language by the core — which is not necessarily the
    // language this person's Telegram happens to be reading right now.
    await ctx.core.generateDraft(ctx.account.id, ctx.state.sellerStoreId, postId, { tone: 'friendly' });
  } catch (err) {
    await ctx.reply(`⚠️ ${esc(ctx.err(err))}`);
  }
  return showDraft(ctx, postId);
}

export async function promptEdit(ctx, postId) {
  const { t } = ctx;
  await ctx.setState({ awaiting: 'draftcaption', draftPostId: postId });
  await ctx.answer();
  return ctx.reply(
    lines(b(t('b.draft.edit_title')), '', i(t('b.draft.edit_prompt'))),
    keyboard([[button(t('b.nav.cancel'), 'dr', postId)]]),
  );
}

export async function handleDraftInput(ctx) {
  if (ctx.state.awaiting !== 'draftcaption') return false;
  const postId = ctx.state.draftPostId;
  const text = (ctx.text || '').trim();
  if (!text) {
    await ctx.reply(ctx.t('b.draft.need_text'));
    return true;
  }
  await ctx.core.setDraftCaption(ctx.account.id, ctx.state.sellerStoreId, postId, text);
  await ctx.clearState(['awaiting', 'draftPostId']);
  await showDraft(ctx, postId);
  return true;
}

export async function applySuggestions(ctx, postId) {
  try {
    const product = await ctx.core.applyDraftSuggestions(ctx.account.id, ctx.state.sellerStoreId, postId);
    await ctx.answer(ctx.t('b.draft.details_added', { count: product.properties?.length || 0 }));
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
  }
  return showDraft(ctx, postId);
}

export async function approve(ctx, postId) {
  const { t } = ctx;
  const storeId = ctx.state.sellerStoreId;
  try {
    await ctx.core.approveDraft(ctx.account.id, storeId, postId);
    await ctx.answer(t('b.draft.posting'));
  } catch (err) {
    await ctx.answer(ctx.err(err), { alert: true });
    return showDraft(ctx, postId);
  }
  return ctx.reply(
    lines(b(t('b.draft.on_its_way')), '', i(t('b.draft.appears'))),
    keyboard([[button(t('b.btn.next_waiting'), 'drs', storeId)], [button(t('b.btn.dashboard'), 'sd', storeId)]]),
  );
}

export async function discard(ctx, postId) {
  const { storeId } = await ctx.core.discardDraft(ctx.account.id, ctx.state.sellerStoreId, postId);
  await ctx.answer(ctx.t('b.draft.discarded'));
  return showDrafts(ctx, storeId || ctx.state.sellerStoreId);
}

export async function toggleReview(ctx, storeId) {
  const channel = await ctx.core.getChannel(ctx.account.id, storeId);
  const next = channel?.reviewBeforePost === false;
  await ctx.core.setChannelReview(ctx.account.id, storeId, next);
  await ctx.answer(next ? ctx.t('b.draft.review_on_toast') : ctx.t('b.draft.review_off_toast'));
  return { reviewBeforePost: next };
}
