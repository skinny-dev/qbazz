import { COLLECTIONS, ACCOUNT_ROLES, accountSchema } from '../models/schemas.js';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../errors.js';
import { newId, humanCode } from '../util/ids.js';
import { hashPassword, verifyPassword, randomToken } from '../util/crypto.js';
import { validate } from '../util/validate.js';
import { canonicalPhone, phoneVariants } from '../util/phone.js';
import { telegramFetch } from '../util/telegramFetch.js';
import { SUPPORTED_LOCALES, effectiveLocale, isSupported } from '../i18n/index.js';

/**
 * Accounts, channel identities and sessions.
 *
 * One account, many identities. A shopper who starts on Telegram gets an
 * account keyed to `telegram:123456`; when they later sign in on the web with
 * an email, `redeemLinkCode` attaches `email:...` to the *same* account rather
 * than creating a second one. Everything downstream (carts, orders, stores)
 * references `accountId`, so the two surfaces are the same user by construction.
 */
export function createAccountsService(ctx) {
  const { store, config, events } = ctx;
  const accounts = store.collection(COLLECTIONS.accounts);
  const identities = store.collection(COLLECTIONS.identities);
  const sessions = store.collection(COLLECTIONS.sessions);
  const linkCodes = store.collection(COLLECTIONS.linkCodes);

  const identityKey = (channel, externalId) => `${channel}:${String(externalId).toLowerCase()}`;
  const present = (account) => publicAccount(account, config.platform.defaultLocale);

  async function create(input = {}) {
    const data = validate(input, accountSchema);
    if (data.email) {
      const existing = await accounts.findOne({ email: data.email });
      if (existing) throw new ConflictError('err.email_taken', { field: 'email' });
    }
    const account = await accounts.insert({
      id: newId('acc'),
      ...data,
      // Only an explicit choice counts as one. A locale sniffed from a client
      // (Telegram's language_code, a browser header) is a guess, and a guess
      // must not override the platform language for someone who never asked.
      locale: data.locale && isSupported(data.locale) ? data.locale : config.platform.defaultLocale,
      localeSource: data.locale && isSupported(data.locale) ? 'user' : 'default',
      passwordHash: input.password ? hashPassword(input.password) : null,
      prefs: { notifications: true, currency: config.platform.defaultCurrency, ...(input.prefs || {}) },
      stats: { orders: 0, spentMinor: 0 },
      onboarded: Boolean(input.onboarded),
      lastSeenAt: new Date().toISOString(),
    });
    await events.emit('account.created', { accountId: account.id, account: present(account) });
    return present(account);
  }

  async function get(id, { internal = false } = {}) {
    const account = await accounts.get(id);
    if (!account) return null;
    return internal ? account : present(account);
  }

  async function getOrFail(id) {
    const account = await get(id);
    if (!account) throw new NotFoundError('Account', id);
    return account;
  }

  async function update(id, patch) {
    const data = validate(patch, accountSchema, { partial: true });
    // An empty string is how a picture is taken away; the validator treats it as "not given".
    if (patch.avatarUrl === '') data.avatarUrl = '';
    if (data.locale !== undefined) {
      if (!isSupported(data.locale)) {
        throw ValidationError.of('locale', 'err.locale_unsupported', { values: SUPPORTED_LOCALES.join(', ') });
      }
      data.localeSource = 'user';
    }
    if (patch.prefs) data.prefs = { ...(await accounts.get(id))?.prefs, ...patch.prefs };
    if (patch.onboarded !== undefined) data.onboarded = Boolean(patch.onboarded);
    const updated = await accounts.update(id, data);
    if (!updated) throw new NotFoundError('Account', id);
    await events.emit('account.updated', { accountId: id, account: present(updated) });
    return present(updated);
  }

  /**
   * The bot's entry point: called on every incoming update. Idempotent —
   * returns the existing account when the identity is known, creates one
   * otherwise, and refreshes the cached channel profile either way.
   */
  async function resolveChannelIdentity({ channel, externalId, profile = {}, meta = {}, verified = channel === 'telegram' }) {
    if (!channel || externalId === undefined || externalId === null) {
      throw new ValidationError({ externalId: 'channel and externalId are required' });
    }
    const key = identityKey(channel, externalId);
    const existing = await identities.findOne({ key });

    if (existing) {
      const account = await accounts.get(existing.accountId);
      if (!account) {
        // Dangling identity (account hard-deleted): rebuild rather than 500.
        await identities.delete(existing.id);
      } else {
        await identities.update(existing.id, {
          profile: { ...existing.profile, ...profile },
          meta: { ...existing.meta, ...meta },
          lastSeenAt: new Date().toISOString(),
          // Once proven, stays proven — never flips back to false here.
          ...(verified ? { verified: true } : {}),
        });
        await accounts.update(account.id, { lastSeenAt: new Date().toISOString() });
        return { account: present(account), identity: existing, created: false };
      }
    }

    const account = await create({
      displayName: profile.displayName || profile.firstName || `${channel} user`,
      avatarUrl: profile.avatarUrl,
      email: channel === 'email' ? externalId : undefined,
      phone: channel === 'phone' ? externalId : undefined,
    });

    const identity = await identities.insert({
      id: newId('idn'),
      key,
      accountId: account.id,
      channel,
      externalId: String(externalId),
      profile,
      meta,
      verified,
      lastSeenAt: new Date().toISOString(),
    });

    await events.emit('identity.linked', { accountId: account.id, channel, externalId: String(externalId), firstTouch: true });
    return { account, identity, created: true };
  }

  /**
   * The person's Telegram profile photo as their picture, copied into our own storage (nothing with the bot token is
   * kept). Fails plainly when no Telegram is linked or the photo is hidden / not set.
   */
  async function useTelegramPhoto(accountId) {
    const telegram = (await listIdentities(accountId)).find((i) => i.channel === 'telegram');
    if (!telegram) throw new ConflictError('err.telegram_not_linked');
    const url = await ctx.services.telegram.userPhotoUrl(telegram.externalId);
    if (!url) throw new ConflictError('err.telegram_no_photo');
    const res = await telegramFetch(config.telegram?.proxy)(String(url).replace('https://api.telegram.org', config.telegram?.apiBase || 'https://api.telegram.org'), { signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (!res?.ok) throw new ConflictError('err.telegram_no_photo');
    const saved = await ctx.services.uploads.saveImage(accountId, Buffer.from(await res.arrayBuffer()).toString('base64'));
    return update(accountId, { avatarUrl: saved.url });
  }

  async function listIdentities(accountId) {
    return identities.find({ where: { accountId }, sort: [['createdAt', 'asc']] });
  }

  async function findByIdentity(channel, externalId) {
    const identity = await identities.findOne({ key: identityKey(channel, externalId) });
    if (!identity) return null;
    const account = await accounts.get(identity.accountId);
    return account ? present(account) : null;
  }

  // -- Cross-channel linking -------------------------------------------------

  /**
   * Issues a short code the user types on the *other* surface.
   * Telegram → web: "/link" prints a code, the web sign-in page redeems it.
   * Web → Telegram: dashboard prints a code, the user sends it to the bot.
   */
  async function issueLinkCode(accountId, { purpose = 'link_account', ttlSec = config.auth.linkCodeTtlSec, meta = {} } = {}) {
    await getOrFail(accountId);
    await linkCodes.deleteWhere({ accountId, purpose });
    const code = humanCode(6);
    const record = await linkCodes.insert({
      id: newId('lnk'),
      code,
      accountId,
      purpose,
      meta,
      expiresAt: new Date(Date.now() + ttlSec * 1000).toISOString(),
      usedAt: null,
    });
    return { code: record.code, expiresAt: record.expiresAt, deepLink: `${config.platform.webBaseUrl}/link/${record.code}` };
  }

  /**
   * The code a person already holds, if it still has time left; a new one only when it does not.
   * Anything that asks repeatedly (the web page polling while someone is off in Telegram) must use
   * this: issuing a fresh code each time would invalidate the link they are about to tap.
   */
  async function currentLinkCode(accountId, { purpose = 'link_account', minRemainingSec = 120 } = {}) {
    const existing = await linkCodes.findOne({ accountId, purpose });
    if (existing && !existing.usedAt && new Date(existing.expiresAt).getTime() - Date.now() > minRemainingSec * 1000) {
      return { code: existing.code, expiresAt: existing.expiresAt };
    }
    return issueLinkCode(accountId, { purpose });
  }

  async function redeemLinkCode(code, { channel, externalId, profile = {} }) {
    const record = await linkCodes.findOne({ code: String(code).toUpperCase().trim() });
    if (!record) throw new NotFoundError('Link code');
    if (record.usedAt) throw new ConflictError('err.link_used');
    if (new Date(record.expiresAt) < new Date()) throw new ConflictError('err.link_expired');

    const target = await accounts.get(record.accountId);
    if (!target) throw new NotFoundError('Account', record.accountId);

    const key = identityKey(channel, externalId);
    const existing = await identities.findOne({ key });

    if (existing && existing.accountId !== target.id) {
      // The redeeming channel already had its own account — fold it in.
      await mergeAccounts(target.id, existing.accountId);
    } else if (!existing) {
      await identities.insert({
        id: newId('idn'),
        key,
        accountId: target.id,
        channel,
        externalId: String(externalId),
        profile,
        meta: {},
        verified: true,
        lastSeenAt: new Date().toISOString(),
      });
    }

    await linkCodes.update(record.id, { usedAt: new Date().toISOString(), redeemedBy: key });
    await events.emit('identity.linked', { accountId: target.id, channel, externalId: String(externalId), firstTouch: false });
    return { account: present(await accounts.get(target.id)), linked: { channel, externalId: String(externalId) } };
  }

  /**
   * Folds `sourceId` into `targetId`: identities, memberships, carts and orders
   * are repointed, then the source is tombstoned. Called during link redemption
   * when both surfaces had already minted an account for the same human.
   */
  async function mergeAccounts(targetId, sourceId) {
    if (targetId === sourceId) return present(await accounts.get(targetId));
    const target = await accounts.get(targetId);
    const source = await accounts.get(sourceId);
    if (!target || !source) throw new NotFoundError('Account', target ? sourceId : targetId);

    for (const name of [COLLECTIONS.identities, COLLECTIONS.memberships, COLLECTIONS.carts, COLLECTIONS.orders, COLLECTIONS.customers, COLLECTIONS.onboardings, COLLECTIONS.savedItems, COLLECTIONS.channelSessions]) {
      const col = store.collection(name);
      const rows = await col.find({ where: { accountId: sourceId } });
      for (const row of rows) await col.update(row.id, { accountId: targetId });
    }

    // Things that belong to a person but are not keyed by `accountId`: the shops they own, who
    // asked for wholesale access, their top-up requests, notifications and wallet history.
    const repoint = async (name, field) => {
      const col = store.collection(name);
      for (const row of await col.find({ where: { [field]: sourceId } })) await col.update(row.id, { [field]: targetId });
    };
    await repoint(COLLECTIONS.stores, 'ownerAccountId');
    await repoint(COLLECTIONS.accessRequests, 'buyerAccountId');
    await repoint(COLLECTIONS.topups, 'accountId');
    await repoint(COLLECTIONS.notifications, 'accountId');
    await repoint(COLLECTIONS.walletTransactions, 'accountId');
    await repoint(COLLECTIONS.mockups, 'accountId');

    // One wallet, one plan: balances add up, and the better plan survives.
    const walletTotal = (target.wallet?.balanceMinor || 0) + (source.wallet?.balanceMinor || 0);
    const subs = store.collection(COLLECTIONS.subscriptions);
    const [keepSub, dropSub] = [await subs.findOne({ accountId: targetId }), await subs.findOne({ accountId: sourceId })];
    if (dropSub) {
      const rank = (s) => ctx.services.subscriptions.getPlan(s?.planId)?.order ?? -1;
      if (keepSub && rank(dropSub) > rank(keepSub)) {
        await subs.delete(keepSub.id);
        await subs.update(dropSub.id, { accountId: targetId });
      } else if (keepSub) {
        await subs.delete(dropSub.id);
      } else {
        await subs.update(dropSub.id, { accountId: targetId });
      }
    }

    const merged = await accounts.update(targetId, {
      ...(walletTotal || target.wallet || source.wallet ? { wallet: { balanceMinor: walletTotal, currency: 'IRT' } } : {}),
      email: target.email || source.email,
      phone: target.phone || source.phone,
      avatarUrl: target.avatarUrl || source.avatarUrl,
      passwordHash: target.passwordHash || source.passwordHash,
      stats: {
        orders: (target.stats?.orders || 0) + (source.stats?.orders || 0),
        spentMinor: (target.stats?.spentMinor || 0) + (source.stats?.spentMinor || 0),
      },
      onboarded: target.onboarded || source.onboarded,
    });
    await accounts.update(sourceId, { status: 'deleted', mergedInto: targetId, displayName: `(merged) ${source.displayName}` });
    await events.emit('account.merged', { targetId, sourceId });
    return present(merged);
  }

  // -- Sessions --------------------------------------------------------------

  async function createSession(accountId, { channel = 'web', ttlSec = config.auth.sessionTtlSec, meta = {} } = {}) {
    await getOrFail(accountId);
    const session = await sessions.insert({
      id: newId('ses'),
      accountId,
      token: randomToken(32),
      channel,
      meta,
      expiresAt: new Date(Date.now() + ttlSec * 1000).toISOString(),
      revokedAt: null,
    });
    return { token: session.token, expiresAt: session.expiresAt, accountId };
  }

  async function authenticate(token) {
    if (!token) throw new UnauthorizedError();
    const session = await sessions.findOne({ token });
    if (!session || session.revokedAt || new Date(session.expiresAt) < new Date()) throw new UnauthorizedError('err.session_expired');
    const account = await accounts.get(session.accountId);
    if (!account || account.status !== 'active') throw new UnauthorizedError('err.account_unavailable');
    return { account: present(account), session };
  }

  async function revokeSession(token) {
    const session = await sessions.findOne({ token });
    if (session) await sessions.update(session.id, { revokedAt: new Date().toISOString() });
    return { revoked: Boolean(session) };
  }

  // -- Email/password (the web surface) --------------------------------------

  async function registerWithEmail({ email, password, displayName }) {
    const data = validate({ email, displayName }, { email: { type: 'email', required: true }, displayName: { type: 'string', required: true, min: 1, max: 80 } });
    if (!password || String(password).length < 8) throw ValidationError.of('password', 'err.password_short');

    const existing = await identities.findOne({ key: identityKey('email', data.email) });
    if (existing) throw new ConflictError('err.email_taken');

    const account = await create({ ...data, password, onboarded: false });
    await identities.insert({
      id: newId('idn'),
      key: identityKey('email', data.email),
      accountId: account.id,
      channel: 'email',
      externalId: data.email,
      profile: { displayName: data.displayName },
      meta: {},
      verified: false,
      lastSeenAt: new Date().toISOString(),
    });
    const session = await createSession(account.id, { channel: 'web' });
    return { account, session };
  }

  async function loginWithEmail({ email, password }) {
    const normalized = String(email || '').trim().toLowerCase();
    const identity = await identities.findOne({ key: identityKey('email', normalized) });
    if (!identity) throw new UnauthorizedError('err.invalid_credentials');
    const account = await accounts.get(identity.accountId);
    if (!account || !verifyPassword(String(password || ''), account.passwordHash)) throw new UnauthorizedError('err.invalid_credentials');
    if (account.status !== 'active') throw new ForbiddenError('err.account_suspended');
    const session = await createSession(account.id, { channel: 'web' });
    return { account: present(account), session };
  }

  // -- Phone / OTP (the web surface's primary sign-in) -----------------------
  //
  // Telegram already proves identity implicitly (a chat only exists because
  // someone controls that Telegram account), so the bot never needs this. The
  // web app has no such proof, so a phone number plus a code sent to it is
  // the equivalent: whoever received the SMS controls the number.

  async function requestPhoneOtp(phone) {
    return ctx.services.otp.requestCode(phone);
  }

  /**
   * A phone number can be known for an account before it is ever used to log
   * in — a Telegram seller whose number is already on their account, an admin
   * granted by phone in config, one entered by hand on the dashboard. None of
   * that goes through `resolveChannelIdentity`, so no `phone:` identity row
   * exists for it yet. Rather than mint a second, disconnected account the
   * first time that number is used to sign in, this attaches the proven
   * identity to the account that already claims the number — the same "fold
   * into the existing account" rule `redeemLinkCode` applies when a second
   * surface turns out to be the same person.
   */
  /** Who holds this number — under any spelling it may have been stored with before numbers were canonicalised. */
  async function phoneHolder(phone) {
    const variants = phoneVariants(phone);
    for (const variant of variants) {
      const identity = await identities.findOne({ key: identityKey('phone', variant) });
      if (identity) {
        const account = await accounts.get(identity.accountId);
        if (account && account.status !== 'deleted') return account;
      }
    }
    return accounts.findOne({ phone: { $in: variants }, status: { $ne: 'deleted' } });
  }

  async function attachOrCreatePhoneIdentity(rawPhone) {
    const normalizedPhone = canonicalPhone(rawPhone);
    const known = await phoneHolder(normalizedPhone);
    if (!known) return resolveChannelIdentity({ channel: 'phone', externalId: normalizedPhone, verified: true });

    // An account that stored the number the old way is brought onto the canonical spelling.
    if (known.phone !== normalizedPhone) await accounts.update(known.id, { phone: normalizedPhone });
    const already = await identities.findOne({ key: identityKey('phone', normalizedPhone) });
    if (!already) {
      await identities.insert({
        id: newId('idn'),
        key: identityKey('phone', normalizedPhone),
        accountId: known.id,
        channel: 'phone',
        externalId: normalizedPhone,
        profile: {},
        meta: {},
        verified: true,
        lastSeenAt: new Date().toISOString(),
      });
    }
    await accounts.update(known.id, { lastSeenAt: new Date().toISOString() });
    return { account: present(known), created: false };
  }

  /**
   * The account behind a phone number, created (without a session) if nobody
   * has used that number yet — so a seller can seat a team member by phone
   * before that person has ever signed in.
   */
  async function findOrCreateByPhone(phone) {
    const normalized = canonicalPhone(validate({ phone }, { phone: { type: 'phone', required: true } }).phone);
    const { account } = await attachOrCreatePhoneIdentity(normalized);
    return account;
  }

  /**
   * Telegram vouches for a phone number when someone shares their *own* contact
   * (the bot only calls this in that case). That makes the number as good as an
   * SMS code, so it can be tied to the account — and if a web account already
   * uses the number, the two are the same person and become one: the Telegram
   * account is folded into the one that held the number first. The returned
   * account is the survivor; callers should use its id from then on.
   */
  async function linkVerifiedPhone(accountId, rawPhone) {
    // Telegram sends digits without a plus ("98912…"); canonicalising makes it the same number the website typed ("0912…").
    const phone = canonicalPhone(rawPhone);
    validate({ phone }, { phone: { type: 'phone', required: true } });
    const me = await getOrFail(accountId);

    const holderAccount = await phoneHolder(phone);
    const otherId = holderAccount && holderAccount.id !== accountId ? holderAccount.id : null;

    if (otherId) {
      const other = await accounts.get(otherId);
      if (other && other.status === 'active') {
        const merged = await mergeAccounts(other.id, accountId);
        await identities.findOne({ key: identityKey('phone', phone) }) || await attachOrCreatePhoneIdentity(phone);
        return { account: merged, merged: true };
      }
    }
    if (me.phone !== phone) await accounts.update(accountId, { phone });
    if (!(await identities.findOne({ key: identityKey('phone', phone) }))) {
      await identities.insert({
        id: newId('idn'), key: identityKey('phone', phone), accountId, channel: 'phone', externalId: phone,
        profile: {}, meta: {}, verified: true, lastSeenAt: new Date().toISOString(),
      });
    }
    await events.emit('identity.linked', { accountId, channel: 'phone', externalId: phone, firstTouch: false });
    return { account: present(await accounts.get(accountId)), merged: false };
  }

  /**
   * Heals data from before phone numbers had one spelling: every number is
   * rewritten canonically, and accounts that turn out to share a number — a web
   * sign-in typed as 0912… and a Telegram account that shared 98912… — are
   * folded into one. The survivor is the account people actually use: the one
   * with a Telegram identity, then one that owns shops, then the oldest. Safe to
   * run on every boot; with nothing to fix it changes nothing.
   */
  async function reconcilePhones() {
    const live = await accounts.find({ where: { status: { $ne: 'deleted' } } });
    const groups = new Map();
    for (const account of live) {
      const canonical = canonicalPhone(account.phone);
      if (!canonical) continue;
      if (!groups.has(canonical)) groups.set(canonical, []);
      groups.get(canonical).push(account);
    }

    let merged = 0;
    let rewritten = 0;
    for (const [canonical, list] of groups) {
      const scored = [];
      for (const account of list) {
        const ids = await identities.find({ where: { accountId: account.id } });
        const owns = await store.collection(COLLECTIONS.stores).count({ ownerAccountId: account.id });
        scored.push({ account, score: (ids.some((i) => i.channel === 'telegram') ? 4 : 0) + (owns ? 2 : 0) + (account.role === 'admin' ? 1 : 0) });
      }
      scored.sort((a, b) => b.score - a.score || String(a.account.createdAt).localeCompare(String(b.account.createdAt)));
      const survivor = scored[0].account;
      for (const { account } of scored.slice(1)) {
        await mergeAccounts(survivor.id, account.id);
        merged += 1;
      }
      if (survivor.phone !== canonical) {
        await accounts.update(survivor.id, { phone: canonical });
        rewritten += 1;
      }
    }
    return { merged, rewritten };
  }

  async function loginWithPhoneOtp({ phone, code }) {
    const normalized = await ctx.services.otp.verifyCode(phone, code);
    const { account } = await attachOrCreatePhoneIdentity(normalized);
    if (account.status !== 'active') throw new ForbiddenError('err.account_suspended');
    const session = await createSession(account.id, { channel: 'web' });
    return { account: present(account), session };
  }

  /** The person's own choice of language — the only thing that overrides the platform default. */
  async function setLocale(accountId, locale) {
    return update(accountId, { locale });
  }

  async function setRole(accountId, role) {
    if (!ACCOUNT_ROLES.includes(role)) throw new ValidationError({ role: `Role must be one of: ${ACCOUNT_ROLES.join(', ')}` });
    const updated = await accounts.update(accountId, { role });
    if (!updated) throw new NotFoundError('Account', accountId);
    await events.emit('account.role_changed', { accountId, role });
    return present(updated);
  }

  async function list({ where, limit = 20, offset = 0, sort = [['createdAt', 'desc']] } = {}) {
    const [items, total] = await Promise.all([accounts.find({ where, limit, offset, sort }), accounts.count(where)]);
    return { items: items.map(present), total };
  }

  return {
    create,
    get,
    getOrFail,
    update,
    useTelegramPhoto,
    list,
    resolveChannelIdentity,
    listIdentities,
    findByIdentity,
    issueLinkCode,
    currentLinkCode,
    redeemLinkCode,
    mergeAccounts,
    createSession,
    authenticate,
    revokeSession,
    registerWithEmail,
    loginWithEmail,
    requestPhoneOtp,
    findOrCreateByPhone,
    reconcilePhones,
    linkVerifiedPhone,
    loginWithPhoneOtp,
    setLocale,
    setRole,
  };
}

/** Strips secrets. Anything the bot or storefront may render goes through here. */
export function publicAccount(account, defaultLocale = null) {
  if (!account) return null;
  const { passwordHash, ...rest } = account;
  // Report the language the person actually sees, not a stale stored guess.
  if (defaultLocale) rest.locale = effectiveLocale(account, defaultLocale);
  return rest;
}
