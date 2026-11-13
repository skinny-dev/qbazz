import { button, grid, keyboard, requestContactKeyboard, requestLocationKeyboard, urlButton } from '../telegram/keyboard.js';
import { b, esc, i, lines, onboardingText, truncate } from '../render.js';
import { verifyForOnboarding, howToLines } from './channel.js';

/**
 * Renders the core's onboarding steps as Telegram screens.
 *
 * There is no flow logic here — no step order, no validation, no branching, and
 * no wording. The core hands over a step, already in the person's language, with
 * a `render` hint, and this file draws it. That is what makes the web version a
 * rendering job rather than a rewrite: the same session, the same steps, a
 * different set of widgets.
 */

export async function startOnboarding(ctx, flow = 'seller', { restart = false } = {}) {
  let state;
  try {
    state = await ctx.core.onboardingStart(ctx.account.id, flow, { restart });
  } catch (err) {
    // A full plan is the one expected refusal: say so and point at the way out.
    if (err.status !== 409 && err.code !== 'conflict') throw err;
    await ctx.answer();
    const message = ctx.err(err);
    ctx.limitHit = null; // this reply carries its own buttons
    return ctx.reply(
      `⚠️ ${esc(message)}`,
      keyboard([[button(ctx.t('b.btn.change_plan'), 'billplans', ctx.state.sellerStoreId || '-')], [button(ctx.t('b.nav.home'), 'home')]]),
    );
  }
  await ctx.setState({ awaiting: 'onboarding', onbFlow: flow, onbSelection: [] });
  return renderStep(ctx, state);
}

export async function resumeOnboarding(ctx, flow = 'seller') {
  const state = await ctx.core.onboardingState(ctx.account.id, flow);
  if (!state || state.status !== 'in_progress') return startOnboarding(ctx, flow);
  await ctx.setState({ awaiting: 'onboarding', onbFlow: flow, onbSelection: [] });
  return renderStep(ctx, state);
}

export async function renderStep(ctx, state) {
  const { tx, t } = ctx;
  if (!state || state.status === 'completed' || !state.step) return renderCompletion(ctx, state);

  const step = state.step;
  const render = step.render;

  // Steps that need a native Telegram widget get a reply keyboard.
  if (render.input === 'contact') {
    await ctx.reply(onboardingText(tx, state), requestContactKeyboard(t('b.kb.share_number')));
    return null;
  }
  if (render.input === 'location') {
    await ctx.reply(onboardingText(tx, state), requestLocationKeyboard(t('b.kb.share_location')));
    return null;
  }

  // Connecting a channel needs a Telegram-side check, so this step gets its
  // own screen rather than a generic text prompt.
  if (render.input === 'telegram_channel') {
    return ctx.screen(
      lines(
        onboardingText(tx, state),
        '',
        b(t('b.onb.how_to')),
        ...howToLines(t).map((line) => esc(line)),
      ),
      keyboard([[button(t('b.btn.skip_for_now'), 'onbskip')], [button(t('b.btn.cancel_setup'), 'onbcancel')]]),
    );
  }

  const rows = await optionRows(ctx, step);
  const controls = [];
  if (state.canGoBack) controls.push(button(t('b.nav.back'), 'onbback'));
  if (step.optional) controls.push(button(t('b.btn.skip'), 'onbskip'));
  if (controls.length) rows.push(controls);
  rows.push([button(t('b.btn.cancel_setup'), 'onbcancel')]);

  const hint = render.input === 'photo'
    ? i(t('b.onb.hint_photo'))
    : render.input === 'number'
      ? i(t('b.onb.hint_number'))
      : rows.length > 2 ? null : i(t('b.onb.hint_type'));

  return ctx.screen(lines(onboardingText(tx, state), hint ? `\n${hint}` : null), keyboard(rows));
}

/**
 * Multi-select needs the pending choices somewhere; channel state holds them
 * until the user taps Done, at which point one answer goes to the core.
 */
async function optionRows(ctx, step) {
  const render = step.render;
  let options = render.options;

  if (!options && render.optionsSource === 'categories') {
    // The client is scoped to this person's language, so names arrive translated.
    const { items } = await ctx.core.categories(render.optionsQuery || {});
    options = items.map((category) => ({ value: category.id, label: `${category.icon || ''} ${category.name}`.trim() }));
  }
  if (!options) return [];

  if (!render.multiple) {
    return grid(options.map((option) => button(truncate(option.label, 24), 'onbpick', String(option.value))), options.length > 4 ? 2 : 1);
  }

  const selected = ctx.state.onbSelection || [];
  const rows = grid(
    options.map((option) => {
      const on = selected.includes(String(option.value));
      return button(`${on ? '☑️' : '▫️'} ${truncate(option.label, 20)}`, 'onbtog', String(option.value));
    }),
    2,
  );
  if (selected.length) rows.push([button(ctx.t('b.btn.done_n', { count: selected.length }), 'onbdone')]);
  return rows;
}

export async function pickOption(ctx, value) {
  await ctx.answer();
  return submit(ctx, coerce(value));
}

export async function toggleOption(ctx, value) {
  const selected = new Set(ctx.state.onbSelection || []);
  if (selected.has(value)) selected.delete(value);
  else selected.add(value);
  await ctx.setState({ onbSelection: [...selected] });
  await ctx.answer();

  const state = await ctx.core.onboardingState(ctx.account.id, ctx.state.onbFlow);
  return renderStep(ctx, state);
}

export async function submitSelection(ctx) {
  const selected = ctx.state.onbSelection || [];
  if (!selected.length) {
    await ctx.answer(ctx.t('b.onb.pick_one'), { alert: true });
    return null;
  }
  await ctx.setState({ onbSelection: [] });
  await ctx.answer();
  return submit(ctx, selected);
}

export async function goBack(ctx) {
  await ctx.answer();
  await ctx.setState({ onbSelection: [] });
  const state = await ctx.core.onboardingBack(ctx.account.id, { flow: ctx.state.onbFlow });
  return renderStep(ctx, state);
}

export async function skipStep(ctx) {
  await ctx.answer();
  const state = await ctx.core.onboardingSkip(ctx.account.id, { flow: ctx.state.onbFlow });
  return renderStep(ctx, state);
}

export async function cancelOnboarding(ctx) {
  const { t } = ctx;
  await ctx.core.onboardingCancel(ctx.account.id, { flow: ctx.state.onbFlow });
  await ctx.clearState(['awaiting', 'onbFlow', 'onbSelection']);
  await ctx.answer(t('b.onb.cancelled_toast'));
  await ctx.dropKeyboard(t('b.onb.cancelled_msg'));
  return ctx.reply(
    lines(i(t('b.onb.cancelled_hint'))),
    keyboard([[button(t('b.nav.home'), 'home')]]),
  );
}

/**
 * Free-text, contact, location and photo answers all land here from the router.
 * Returns true when the message was consumed by onboarding.
 */
export async function handleOnboardingInput(ctx) {
  if (ctx.state.awaiting !== 'onboarding') return false;
  const { t } = ctx;

  let value = ctx.text?.trim();

  if (ctx.contact) value = ctx.contact.phone_number;
  // Telegram's location picker gives a point; the core resolves it to a city,
  // exactly as it does for a pin dropped in the web picker.
  if (ctx.location) value = { lat: ctx.location.latitude, lng: ctx.location.longitude };
  if (ctx.venue) value = { lat: ctx.venue.location.latitude, lng: ctx.venue.location.longitude, address: ctx.venue.address };
  if (ctx.photo?.length) {
    // Largest rendition last; store a stable URL so the web storefront can use it too.
    const fileId = ctx.photo[ctx.photo.length - 1].file_id;
    try {
      value = await ctx.api.fileUrl(fileId);
    } catch (err) {
      await ctx.reply(t('b.onb.photo_failed'));
      return true;
    }
  }

  // The channel step submits proof, not raw text: verify with Telegram first
  // and keep the user on the step with an explanation if it does not check out.
  const current = await ctx.core.onboardingState(ctx.account.id, ctx.state.onbFlow);
  if (current?.step?.render?.input === 'telegram_channel') {
    const { payload, error } = await verifyForOnboarding(ctx);
    if (error) {
      await ctx.reply(lines(`⚠️ ${error}`, '', i(t('b.onb.channel_fix'))));
      return true;
    }
    await submit(ctx, payload);
    return true;
  }

  if (value === undefined || value === '') return false;
  if (ctx.contact || ctx.location || ctx.venue) await ctx.dropKeyboard('👍');

  await submit(ctx, value, { fromPicker: Boolean(ctx.location || ctx.venue) });
  return true;
}

async function submit(ctx, value, { fromPicker = false } = {}) {
  const state = await ctx.core.onboardingAnswer(ctx.account.id, value, { flow: ctx.state.onbFlow });

  // A dropped pin is worth echoing back — the user picked a point and needs to
  // see which city we read from it before they carry on.
  if (fromPicker && !state.error && state.data?.location?.city) {
    const place = state.data.location;
    const separator = ctx.tx.rtl ? '، ' : ', ';
    await ctx.reply(ctx.t('b.onb.got_it', { place: esc([place.city, place.country].filter(Boolean).join(separator)) }));
  }

  return renderStep(ctx, state);
}

async function renderCompletion(ctx, state) {
  const { t, tx } = ctx;
  await ctx.clearState(['awaiting', 'onbFlow', 'onbSelection']);
  const result = state?.result || {};

  if (result.storeId) {
    // Three outcomes, not two: submitted for review, genuinely live (only
    // when the platform skips review), or — new since a channel-first shop
    // can finish onboarding with nothing left to submit — still needs
    // something before it can be submitted at all.
    const statusLine = result.status === 'pending_review'
      ? t('b.onb.seller_pending')
      : result.status === 'active'
        ? t('b.onb.seller_live')
        : t('b.onb.seller_incomplete', { missing: result.missing || [] });
    return ctx.reply(
      lines(
        b(t('b.onb.seller_done')),
        '',
        esc(statusLine),
        '',
        `🔗 ${esc(tx.ltr(result.storefrontUrl))}`,
        '',
        i(t('b.onb.seller_more')),
      ),
      keyboard([
        [button(t('b.btn.my_dashboard'), 'sd', result.storeId)],
        [button(t('b.btn.add_another'), 'padd', result.storeId)],
        [urlButton(t('b.btn.web_dashboard'), result.dashboardUrl || ctx.config.webAppUrl)],
        [button(t('b.nav.home'), 'home')],
      ]),
    );
  }

  return ctx.reply(
    lines(b(t('b.onb.buyer_done')), '', esc(t('b.onb.buyer_done_body'))),
    keyboard([[button(t('b.btn.show_me'), 'home')]]),
  );
}

function coerce(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}
