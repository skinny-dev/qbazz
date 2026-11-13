import { COLLECTIONS, CHANNELS } from '../models/schemas.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../util/ids.js';
import { randomToken, signPayload, verifyPayload } from '../util/crypto.js';

/**
 * Channel integrations and conversation state.
 *
 * Two jobs:
 *  1. Registry — which channels are wired up (the platform bot, a store's own
 *     bot, a web domain, an outbound webhook), with their credentials.
 *  2. Channel sessions — the "where is this person in the conversation" cursor,
 *     kept in the core instead of in bot process memory. The bot can restart,
 *     scale to several instances, or hand a user over to the web app mid-flow
 *     without losing their place.
 */
export function createIntegrationsService(ctx) {
  const { store: db, config, events } = ctx;
  const integrations = db.collection(COLLECTIONS.integrations);
  const channelSessions = db.collection(COLLECTIONS.channelSessions);

  const INTEGRATION_TYPES = ['telegram_bot', 'telegram_channel', 'web_domain', 'webhook', 'payment'];

  async function register({ type, storeId = null, name, credentials = {}, settings = {}, actorAccountId = null }) {
    if (!INTEGRATION_TYPES.includes(type)) {
      throw new ValidationError({ type: `Type must be one of: ${INTEGRATION_TYPES.join(', ')}` });
    }
    const existing = storeId ? await integrations.findOne({ storeId, type }) : await integrations.findOne({ type, scope: 'platform' });
    if (existing) return update(existing.id, { name, credentials, settings });

    const record = await integrations.insert({
      id: newId('itg'),
      type,
      scope: storeId ? 'store' : 'platform',
      storeId,
      name: name || type,
      credentials,
      settings,
      status: 'active',
      secret: randomToken(24),
      createdBy: actorAccountId,
      lastSyncAt: null,
      stats: { calls: 0, errors: 0 },
    });
    await events.emit('integration.registered', { integrationId: record.id, type, storeId });
    return redact(record);
  }

  async function update(id, patch) {
    const current = await integrations.get(id);
    if (!current) throw new NotFoundError('Integration', id);
    const updated = await integrations.update(id, {
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      credentials: { ...current.credentials, ...(patch.credentials || {}) },
      settings: { ...current.settings, ...(patch.settings || {}) },
    });
    return redact(updated);
  }

  async function get(id) {
    const record = await integrations.get(id);
    return record ? redact(record) : null;
  }

  /** Internal callers (the bot at boot) need the credentials, so this is unredacted. */
  async function getRaw({ type, storeId = null }) {
    return storeId ? integrations.findOne({ storeId, type }) : integrations.findOne({ type, scope: 'platform' });
  }

  async function listForStore(storeId) {
    const rows = await integrations.find({ where: { storeId } });
    return rows.map(redact);
  }

  async function recordCall(id, { ok = true } = {}) {
    return integrations.mutate(id, (draft) => {
      draft.stats = { calls: (draft.stats?.calls || 0) + 1, errors: (draft.stats?.errors || 0) + (ok ? 0 : 1) };
      draft.lastSyncAt = new Date().toISOString();
      return draft;
    });
  }

  // -- Channel sessions ------------------------------------------------------

  const sessionKey = (channel, externalId) => `${channel}:${externalId}`;

  /**
   * Upserts the conversation cursor for one chat. `state` is a free-form bag
   * the channel owns (current screen, pending input, last message id);
   * `accountId` ties it back to the unified account.
   */
  async function touchChannelSession({ channel, externalId, accountId = null, state = null, meta = {} }) {
    if (!CHANNELS.includes(channel)) throw new ValidationError({ channel: `Channel must be one of: ${CHANNELS.join(', ')}` });
    const key = sessionKey(channel, externalId);
    const existing = await channelSessions.findOne({ key });
    if (existing) {
      return channelSessions.update(existing.id, {
        accountId: accountId || existing.accountId,
        state: state === null ? existing.state : { ...existing.state, ...state },
        meta: { ...existing.meta, ...meta },
        lastSeenAt: new Date().toISOString(),
      });
    }
    return channelSessions.insert({
      id: newId('chs'),
      key,
      channel,
      externalId: String(externalId),
      accountId,
      state: state || {},
      meta,
      lastSeenAt: new Date().toISOString(),
    });
  }

  async function getChannelSession(channel, externalId) {
    return channelSessions.findOne({ key: sessionKey(channel, externalId) });
  }

  async function setChannelState(channel, externalId, state) {
    const session = await getChannelSession(channel, externalId);
    if (!session) return touchChannelSession({ channel, externalId, state });
    return channelSessions.update(session.id, { state: { ...session.state, ...state }, lastSeenAt: new Date().toISOString() });
  }

  async function clearChannelState(channel, externalId, keys = null) {
    const session = await getChannelSession(channel, externalId);
    if (!session) return null;
    if (!keys) return channelSessions.update(session.id, { state: {} });
    const state = { ...session.state };
    for (const key of keys) delete state[key];
    return channelSessions.update(session.id, { state });
  }

  /** Every channel session for one account — used to push a live update everywhere. */
  async function sessionsForAccount(accountId) {
    return channelSessions.find({ where: { accountId } });
  }

  // -- Cross-surface handoff -------------------------------------------------

  /**
   * Builds a signed deep link that carries the account (and optionally a
   * destination) from one surface to another: a "Open in browser" button in the
   * bot, or a "Continue in Telegram" button on the web. The receiving side
   * calls `consumeHandoff` and gets a real session without a second login.
   */
  function createHandoff({ accountId, to = 'web', path = '/', ttlSec = 600, meta = {} }) {
    const token = signPayload(config.auth.secret, { accountId, to, path, meta }, ttlSec);
    const url = to === 'web'
      ? `${config.platform.webBaseUrl}/handoff?t=${encodeURIComponent(token)}`
      : `https://t.me/${config.platform.botUsername || 'qbazz_bot'}?start=h_${token}`;
    return { token, url, expiresInSec: ttlSec };
  }

  async function consumeHandoff(token, { channel = 'web' } = {}) {
    const payload = verifyPayload(config.auth.secret, token);
    if (!payload) throw new ConflictError('err.handoff_expired');
    const session = await ctx.services.accounts.createSession(payload.accountId, { channel, meta: { via: 'handoff' } });
    await events.emit('handoff.consumed', { accountId: payload.accountId, channel, path: payload.path });
    return { accountId: payload.accountId, path: payload.path || '/', session, meta: payload.meta || {} };
  }

  return {
    INTEGRATION_TYPES,
    register,
    update,
    get,
    getRaw,
    listForStore,
    recordCall,
    touchChannelSession,
    getChannelSession,
    setChannelState,
    clearChannelState,
    sessionsForAccount,
    createHandoff,
    consumeHandoff,
  };
}

/** Never let a bot token leave the core through a read API. */
function redact(record) {
  if (!record) return null;
  const credentials = {};
  for (const [key, value] of Object.entries(record.credentials || {})) {
    credentials[key] = typeof value === 'string' && value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-2)}` : '***';
  }
  const { secret, ...rest } = record;
  return { ...rest, credentials };
}
