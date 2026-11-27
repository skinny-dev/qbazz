import { Router } from '../router.js';
import { requireAuth } from '../http.js';
import { TOPICS } from '../../sync/outbox.js';

/**
 * The sync surface. This is the contract the web app will be built against:
 * snapshot once, then follow the event log by cursor (poll) or by stream (SSE).
 */
export function registerSyncRoutes(root, core) {
  const { services } = core;
  const router = new Router();

  router.get('/topics', async () => ({ topics: TOPICS, cursor: services.sync.cursor }));

  /** Cursor read. A client stores `cursor` and passes it back as `since`. */
  router.get('/events', async (ctx) => {
    const account = ctx.auth?.account;
    const scopedStore = ctx.query.storeId || null;
    if (scopedStore && account) await services.stores.assertCan(scopedStore, account.id, 'store.view');

    return services.sync.since(Number(ctx.query.since) || 0, {
      topics: ctx.query.topics ? ctx.query.topics.split(',') : null,
      storeId: scopedStore,
      // Without a store scope, a signed-in client only ever sees its own events.
      accountId: scopedStore ? null : account?.id || null,
      limit: Math.min(Number(ctx.query.limit) || 200, 500),
    });
  });

  /** Cold-start state, consistent with the cursor it returns. */
  router.get('/snapshot', async (ctx) => {
    const account = requireAuth(ctx);
    const storeId = ctx.query.storeId || null;
    if (storeId) await services.stores.assertCan(storeId, account.id, 'store.view');
    return services.sync.snapshot({ accountId: account.id, storeId });
  });

  /** Server-sent events for live dashboards. Replays from `since` before streaming. */
  router.get('/stream', async (ctx) => {
    const account = ctx.auth?.account;
    const storeId = ctx.query.storeId || null;
    if (storeId && account) await services.stores.assertCan(storeId, account.id, 'store.view');

    const { res } = ctx;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const filter = {
      topics: ctx.query.topics ? ctx.query.topics.split(',') : null,
      storeId,
      accountId: storeId ? null : account?.id || null,
    };

    const write = (event) => res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

    const backlog = await services.sync.since(Number(ctx.query.since) || services.sync.cursor, { ...filter, limit: 100 });
    for (const event of backlog.events) write(event);
    res.write(`event: ready\ndata: ${JSON.stringify({ cursor: services.sync.cursor })}\n\n`);

    const unsubscribe = services.sync.subscribe(write, filter);
    // Proxies drop idle connections; a comment frame every 25s keeps it warm.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);

    ctx.req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // -- Webhooks --------------------------------------------------------------

  router.get('/webhooks', async (ctx) => {
    const account = requireAuth(ctx);
    const storeId = ctx.query.storeId || null;
    if (storeId) await services.stores.assertCan(storeId, account.id, 'store.update');
    else await services.admin.assertAdmin(account.id);
    return { items: await services.sync.listWebhooks({ storeId }) };
  });

  router.post('/webhooks', async (ctx) => {
    const account = requireAuth(ctx);
    const storeId = ctx.body.storeId || null;
    if (storeId) await services.stores.assertCan(storeId, account.id, 'store.update');
    else await services.admin.assertAdmin(account.id);
    return services.sync.registerWebhook({
      url: ctx.body.url,
      topics: ctx.body.topics || Object.keys(TOPICS),
      storeId,
      actorAccountId: account.id,
    });
  });

  router.delete('/webhooks/:id', async (ctx) => {
    const account = requireAuth(ctx);
    await services.admin.assertAdmin(account.id);
    return services.sync.deleteWebhook(ctx.params.id);
  });

  // -- Notification drain (integrations) ------------------------------------

  /**
   * Channel workers claim queued notifications here and report delivery.
   * The Telegram bot polls this to know what to send.
   */
  router.get('/notifications/pending', async (ctx) => {
    if (!ctx.auth?.service) await services.admin.assertAdmin(requireAuth(ctx).id);
    return { items: await services.notifications.pending({ channel: ctx.query.channel || 'telegram', limit: Number(ctx.query.limit) || 50 }) };
  });

  /**
   * Channel post queue, drained by the bot's channel poster. Same shape as the
   * notification drain: the core says what to post, the bot posts it.
   */
  router.get('/channel-posts/pending', async (ctx) => {
    if (!ctx.auth?.service) await services.admin.assertAdmin(requireAuth(ctx).id);
    return { items: await services.channels.pending({ limit: Number(ctx.query.limit) || 20 }) };
  });

  /**
   * The other direction: a `channel_post` update the bot received gets handed
   * here, and a synced shop turns it into a product. Only the bot (or another
   * trusted integration) calls this — it is not something a signed-in user
   * triggers themselves.
   */
  router.post('/channel-posts/ingest', async (ctx) => {
    if (!ctx.auth?.service) await services.admin.assertAdmin(requireAuth(ctx).id);
    const product = await services.channels.ingestChannelPost({
      chatId: ctx.body.chatId,
      text: ctx.body.text || '',
      photo: ctx.body.photo || null,
      photos: ctx.body.photos || null,
      video: ctx.body.video || null,
      fileIds: ctx.body.fileIds || null,
      messageId: ctx.body.messageId || null,
      messageIds: ctx.body.messageIds || null,
      replyToMessageId: ctx.body.replyToMessageId || null,
    });
    return { product };
  });

  /** The bot was made an administrator of a channel by someone: remember it, and connect it when that person has a shop. */
  router.post('/channel-claims', async (ctx) => {
    if (!ctx.auth?.service) await services.admin.assertAdmin(requireAuth(ctx).id);
    return services.telegram.botAdded({ telegramUserId: ctx.body.telegramUserId, chat: ctx.body.chat, canPost: ctx.body.canPost !== false });
  });

  /** The seller edited a post in their channel. */
  router.post('/channel-posts/edited', async (ctx) => {
    if (!ctx.auth?.service) await services.admin.assertAdmin(requireAuth(ctx).id);
    const product = await services.channels.applyChannelEdit({ chatId: ctx.body.chatId, messageId: ctx.body.messageId, text: ctx.body.text || '' });
    return { product };
  });

  router.post('/channel-posts/:id/posted', async (ctx) => {
    if (!ctx.auth?.service) await services.admin.assertAdmin(requireAuth(ctx).id);
    return services.channels.markPosted(ctx.params.id, {
      ok: ctx.body.ok !== false,
      messageId: ctx.body.messageId || null,
      error: ctx.body.error || null,
      hasPhoto: Boolean(ctx.body.hasPhoto),
      gone: Boolean(ctx.body.gone),
    });
  });

  router.post('/notifications/:id/delivered', async (ctx) => {
    if (!ctx.auth?.service) await services.admin.assertAdmin(requireAuth(ctx).id);
    return services.notifications.markDelivered(ctx.params.id, ctx.body.channel || 'telegram', {
      ok: ctx.body.ok !== false,
      error: ctx.body.error || null,
      ref: ctx.body.ref || null,
    });
  });

  root.use('/sync', router);
}
