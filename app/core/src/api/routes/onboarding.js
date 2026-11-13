import { Router } from '../router.js';
import { requireAuth } from '../http.js';

/**
 * Onboarding is a four-verb API — start, read, answer, go back. Both the bot
 * and the web app drive the same session, which is what lets a seller switch
 * device mid-flow and carry on where they were.
 */
export function registerOnboardingRoutes(root, core) {
  const { services } = core;
  const router = new Router();

  router.post('/start', async (ctx) => {
    const account = requireAuth(ctx);
    return services.onboarding.start(account.id, ctx.body.flow || 'seller', {
      channel: ctx.channel,
      seed: ctx.body.seed || {},
      restart: Boolean(ctx.body.restart),
    });
  });

  /** The screen-render call: safe to poll, returns null when nothing is running. */
  router.get('/', async (ctx) => {
    const account = requireAuth(ctx);
    const state = await services.onboarding.state(account.id, { flow: ctx.query.flow || null, channel: ctx.channel, locale: ctx.locale });
    return state || { step: null, status: 'none' };
  });

  router.get('/flows', async ({ locale }) => ({ items: services.onboarding.describeFlows(locale) }));

  router.post('/answer', async (ctx) => {
    const account = requireAuth(ctx);
    return services.onboarding.answer(ctx.body.sessionId || account.id, ctx.body.value, {
      channel: ctx.channel,
      flow: ctx.body.flow || null,
      locale: ctx.locale,
      // The bot has already proven things inside Telegram; a browser has not.
      trusted: Boolean(ctx.auth?.service),
      flags: ctx.body.flags || null,
    });
  });

  /** Where a person stands on connecting a channel — the web's live "check" button. */
  router.post('/channel/check', async (ctx) => {
    const account = requireAuth(ctx);
    return services.telegram.inspectChannel(ctx.body.reference, { accountId: account.id });
  });

  /** The quick way in: is Telegram linked, the one-tap links, and any channel the person has already added the bot to. */
  router.get('/channel/claims', async (ctx) => services.telegram.claimsFor(requireAuth(ctx).id));

  router.post('/back', async (ctx) => {
    const account = requireAuth(ctx);
    return services.onboarding.back(ctx.body.sessionId || account.id, { channel: ctx.channel, flow: ctx.body.flow || null, locale: ctx.locale });
  });

  router.post('/skip', async (ctx) => {
    const account = requireAuth(ctx);
    return services.onboarding.skip(ctx.body.sessionId || account.id, { channel: ctx.channel, flow: ctx.body.flow || null, locale: ctx.locale });
  });

  router.post('/cancel', async (ctx) => {
    const account = requireAuth(ctx);
    return services.onboarding.cancel(ctx.body.sessionId || account.id, { flow: ctx.body.flow || null });
  });

  root.use('/onboarding', router);
}
