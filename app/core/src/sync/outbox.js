import { COLLECTIONS } from '../models/schemas.js';
import { newId } from '../util/ids.js';
import { hmac } from '../util/crypto.js';
import { NotFoundError, ValidationError } from '../errors.js';

/**
 * The sync backbone.
 *
 * Every domain event is appended to an ordered log with a monotonic `seq`.
 * Any surface — the Telegram bot today, the web app and its service worker
 * tomorrow, a partner integration later — catches up by asking for everything
 * after the last seq it saw. No surface needs to know the others exist.
 *
 * Three delivery modes, one log:
 *   • pull     — GET /sync/events?since=N            (web polling, bot startup)
 *   • stream   — GET /sync/stream?since=N            (SSE, live dashboards)
 *   • push     — registered webhooks, HMAC-signed    (server-to-server)
 */

/** Events a client is allowed to subscribe to, grouped into topics. */
export const TOPICS = {
  store: ['store.created', 'store.updated', 'store.status_changed', 'store.submitted', 'store.member_added', 'store.member_removed'],
  product: ['product.created', 'product.updated', 'product.archived', 'product.stock_changed'],
  order: ['order.created', 'order.status_changed', 'order.payment_changed', 'order.rated'],
  cart: ['cart.updated'],
  account: ['account.created', 'account.updated', 'account.merged', 'identity.linked', 'account.suspended'],
  onboarding: ['onboarding.started', 'onboarding.step_completed', 'onboarding.completed', 'onboarding.abandoned'],
  notification: ['notification.queued'],
  discovery: ['search.performed', 'store.viewed', 'product.viewed', 'item.saved'],
};

const TOPIC_OF = new Map();
for (const [topic, types] of Object.entries(TOPICS)) for (const type of types) TOPIC_OF.set(type, topic);

export function topicOf(type) {
  return TOPIC_OF.get(type) || type.split('.')[0];
}

export function createSyncService(ctx) {
  const { store: db, config, events, log } = ctx;
  const eventLog = db.collection(COLLECTIONS.events);
  const webhooks = db.collection(COLLECTIONS.webhooks);

  let seq = 0;
  const streams = new Set();

  /** Called once at boot so `seq` continues from the persisted log. */
  async function init() {
    const [latest] = await eventLog.find({ sort: [['seq', 'desc']], limit: 1 });
    seq = latest?.seq || 0;
    events.on('*', (event) => record(event).catch((err) => log.error(`outbox append failed: ${err.message}`)));
    log.info(`sync outbox ready at seq ${seq}`);
    return { seq };
  }

  async function record(event) {
    seq += 1;
    const entry = await eventLog.insert({
      id: newId('evt'),
      seq,
      type: event.type,
      topic: topicOf(event.type),
      payload: event.payload,
      // Scope keys let a client subscribe narrowly: "just my store", "just me".
      storeId: event.payload?.storeId || null,
      accountId: event.payload?.accountId || null,
      at: event.at,
    });

    for (const stream of streams) {
      try {
        if (matchesFilter(entry, stream.filter)) stream.send(entry);
      } catch {
        streams.delete(stream);
      }
    }

    dispatchWebhooks(entry).catch((err) => log.error(`webhook dispatch failed: ${err.message}`));
    await prune();
    return entry;
  }

  async function prune() {
    const retain = config.sync.retainEvents;
    if (seq % 500 !== 0) return; // amortise: only check every 500 events
    const total = await eventLog.count();
    if (total <= retain) return;
    const stale = await eventLog.find({ sort: [['seq', 'asc']], limit: total - retain });
    for (const row of stale) await eventLog.delete(row.id);
  }

  // -- Pull ------------------------------------------------------------------

  /**
   * Cursor read. A client that has been offline passes its last seq and gets
   * everything since, in order, plus the new cursor to store.
   */
  async function since(cursor = 0, { topics = null, storeId = null, accountId = null, limit = 200 } = {}) {
    const filter = { topics, storeId, accountId };
    const rows = await eventLog.find({
      where: (doc) => doc.seq > Number(cursor) && matchesFilter(doc, filter),
      sort: [['seq', 'asc']],
      limit,
    });
    return {
      events: rows,
      cursor: rows.length ? rows[rows.length - 1].seq : Number(cursor),
      latest: seq,
      hasMore: rows.length === limit,
    };
  }

  /**
   * Full state for a cold client (a freshly installed web app, a bot that lost
   * its cursor). Returns data plus the cursor it is consistent with, so the
   * client can snapshot once and then follow the log.
   */
  async function snapshot({ accountId = null, storeId = null } = {}) {
    const cursor = seq;
    const out = { cursor, at: new Date().toISOString() };

    if (accountId) {
      out.account = await ctx.services.accounts.get(accountId);
      out.identities = (await ctx.services.accounts.listIdentities(accountId)).map(({ id, channel, verified }) => ({ id, channel, verified }));
      out.carts = await ctx.services.carts.listOpen(accountId);
      out.orders = (await ctx.services.orders.listForBuyer(accountId, { limit: 20 })).items;
      out.stores = await ctx.services.stores.listForAccount(accountId);
      out.onboarding = await ctx.services.onboarding.state(accountId);
      out.notifications = await ctx.services.notifications.listForAccount(accountId, { limit: 20 });
    }

    if (storeId) {
      out.store = await ctx.services.stores.get(storeId);
      out.products = (await ctx.services.catalog.listProducts({ storeId, limit: 100 })).items;
      out.openOrders = (await ctx.services.orders.listForStore(storeId, { status: ['pending', 'confirmed', 'preparing', 'ready'], limit: 50 })).items;
    }

    return out;
  }

  // -- Stream (SSE) ----------------------------------------------------------

  function subscribe(send, filter = {}) {
    const stream = { send, filter };
    streams.add(stream);
    return () => streams.delete(stream);
  }

  // -- Push (webhooks) -------------------------------------------------------

  async function registerWebhook({ url, topics = Object.keys(TOPICS), storeId = null, secret = null, actorAccountId = null }) {
    try {
      new URL(url);
    } catch {
      throw new ValidationError({ url: 'A valid https URL is required' });
    }
    const record = await webhooks.insert({
      id: newId('whk'),
      url,
      topics,
      storeId,
      secret: secret || newId('whs'),
      status: 'active',
      createdBy: actorAccountId,
      stats: { sent: 0, failed: 0 },
      lastError: null,
      lastDeliveryAt: null,
    });
    log.info(`webhook registered for ${topics.join(',')} -> ${url}`);
    return record;
  }

  async function listWebhooks({ storeId = null } = {}) {
    return webhooks.find({ where: storeId ? { storeId } : undefined });
  }

  async function deleteWebhook(id) {
    const deleted = await webhooks.delete(id);
    if (!deleted) throw new NotFoundError('Webhook', id);
    return { deleted: true };
  }

  async function dispatchWebhooks(entry) {
    const targets = await webhooks.find({ where: { status: 'active' } });
    await Promise.all(targets
      .filter((hook) => hook.topics.includes(entry.topic) && (!hook.storeId || hook.storeId === entry.storeId))
      .map((hook) => deliver(hook, entry)));
  }

  async function deliver(hook, entry, attempt = 1) {
    const body = JSON.stringify({ id: entry.id, seq: entry.seq, type: entry.type, topic: entry.topic, payload: entry.payload, at: entry.at });
    const timestamp = String(Date.now());
    const signature = hmac(hook.secret, `${timestamp}.${body}`);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.sync.webhookTimeoutMs);
      const response = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-qbazz-event': entry.type,
          'x-qbazz-timestamp': timestamp,
          'x-qbazz-signature': signature,
          'x-qbazz-delivery': entry.id,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      await webhooks.mutate(hook.id, (draft) => {
        draft.stats = { ...draft.stats, sent: (draft.stats?.sent || 0) + 1 };
        draft.lastDeliveryAt = new Date().toISOString();
        draft.lastError = null;
        return draft;
      });
    } catch (err) {
      if (attempt < config.sync.webhookRetries) {
        // Exponential backoff; the timer is unref'd so it never holds the process open.
        const timer = setTimeout(() => deliver(hook, entry, attempt + 1), 2 ** attempt * 1000);
        if (timer.unref) timer.unref();
        return;
      }
      await webhooks.mutate(hook.id, (draft) => {
        draft.stats = { ...draft.stats, failed: (draft.stats?.failed || 0) + 1 };
        draft.lastError = err.message;
        // Park a consistently broken endpoint rather than retrying forever.
        if ((draft.stats.failed || 0) > 50) draft.status = 'paused';
        return draft;
      });
      log.warn(`webhook ${hook.url} failed after ${attempt} attempts: ${err.message}`);
    }
  }

  /** Receivers use this to verify `x-qbazz-signature`. */
  function verifySignature(secret, timestamp, rawBody, signature) {
    const expected = hmac(secret, `${timestamp}.${rawBody}`);
    return expected === signature && Math.abs(Date.now() - Number(timestamp)) < 300000;
  }

  return {
    init,
    since,
    snapshot,
    subscribe,
    registerWebhook,
    listWebhooks,
    deleteWebhook,
    verifySignature,
    get cursor() {
      return seq;
    },
  };
}

function matchesFilter(entry, filter = {}) {
  if (filter.topics?.length && !filter.topics.includes(entry.topic)) return false;
  if (filter.storeId && entry.storeId !== filter.storeId) return false;
  if (filter.accountId && entry.accountId !== filter.accountId) return false;
  return true;
}
