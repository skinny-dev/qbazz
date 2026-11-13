import { Router } from '../router.js';
import { ForbiddenError } from '../../errors.js';

/**
 * Service-key-only endpoints for channel integrations (the Telegram bot).
 *
 * Conversation state lives here rather than in the bot process, so the bot can
 * be restarted or run in several instances without a user losing their place —
 * and so the web app can read "this person was halfway through checkout in
 * Telegram" when it ships.
 */
export function registerChannelRoutes(root, core) {
  const { services } = core;
  const router = new Router();

  const assertService = (ctx) => {
    if (!ctx.auth?.service) throw new ForbiddenError('Service key required');
  };

  /**
   * Reverse lookup: which chats can we reach this account on? The notification
   * worker needs it to turn an account-addressed notification into a chat id.
   */
  router.get('/by-account/:accountId', async (ctx) => {
    assertService(ctx);
    const rows = await services.integrations.sessionsForAccount(ctx.params.accountId);
    const channel = ctx.query.channel || null;
    return { items: channel ? rows.filter((row) => row.channel === channel) : rows };
  });

  router.get('/:channel/:externalId', async (ctx) => {
    assertService(ctx);
    const session = await services.integrations.getChannelSession(ctx.params.channel, ctx.params.externalId);
    return session || { state: {}, accountId: null };
  });

  router.post('/:channel/:externalId', async (ctx) => {
    assertService(ctx);
    return services.integrations.touchChannelSession({
      channel: ctx.params.channel,
      externalId: ctx.params.externalId,
      accountId: ctx.body.accountId || null,
      state: ctx.body.state || null,
      meta: ctx.body.meta || {},
    });
  });

  router.delete('/:channel/:externalId/state', async (ctx) => {
    assertService(ctx);
    return services.integrations.clearChannelState(ctx.params.channel, ctx.params.externalId, ctx.body.keys || null);
  });

  root.use('/channels', router);
}
