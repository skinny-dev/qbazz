import { Router } from '../router.js';
import { requireAuth, status } from '../http.js';
import { ForbiddenError } from '../../errors.js';

export function registerAuthRoutes(root, core) {
  const { services } = core;
  const router = new Router();

  // -- Web sign-up / sign-in -------------------------------------------------

  router.post('/register', async ({ body }) => {
    const { account, session } = await services.accounts.registerWithEmail(body);
    return status(201, { account, session });
  });

  router.post('/login', async ({ body }) => services.accounts.loginWithEmail(body));

  // -- Phone / OTP (the primary way in on the web) ---------------------------

  router.post('/otp/request', async ({ body }) => services.accounts.requestPhoneOtp(body.phone));

  router.post('/otp/verify', async ({ body }) => services.accounts.loginWithPhoneOtp({ phone: body.phone, code: body.code }));

  router.post('/logout', async ({ req }) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    return services.accounts.revokeSession(token);
  });

  /**
   * Trusted-integration entry point. The Telegram bot calls this on first
   * contact with a chat: it proves the external identity, and gets back the
   * unified account. Idempotent, so it is safe to call on every update.
   */
  router.post('/identity/resolve', async ({ body, auth }) => {
    if (!auth?.service) return status(403, { error: { code: 'forbidden', message: 'Service key required' } });
    return services.accounts.resolveChannelIdentity(body);
  });

  // -- Cross-channel account linking ----------------------------------------

  router.post('/link/code', async (ctx) => {
    const account = requireAuth(ctx);
    return services.accounts.issueLinkCode(account.id, { meta: { channel: ctx.channel } });
  });

  /** Redeemed by the *other* surface, which supplies its own channel identity. */
  router.post('/link/redeem', async ({ body }) => services.accounts.redeemLinkCode(body.code, {
    channel: body.channel,
    externalId: body.externalId,
    profile: body.profile || {},
  }));

  /**
   * Telegram says this phone number belongs to this person (they shared their own contact).
   * Only the bot may vouch for that, so a browser cannot claim a number it does not hold.
   */
  router.post('/phone/verified', async (ctx) => {
    if (!ctx.auth?.service || !ctx.auth.account) throw new ForbiddenError('err.forbidden');
    return services.accounts.linkVerifiedPhone(ctx.auth.account.id, ctx.body.phone);
  });

  // -- Handoff between surfaces ---------------------------------------------

  router.post('/handoff', async (ctx) => {
    const account = requireAuth(ctx);
    return services.integrations.createHandoff({
      accountId: account.id,
      to: ctx.body.to || 'web',
      path: ctx.body.path || '/',
      meta: ctx.body.meta || {},
    });
  });

  router.post('/handoff/consume', async ({ body, channel }) => services.integrations.consumeHandoff(body.token, { channel }));

  router.get('/session', async (ctx) => {
    const account = requireAuth(ctx);
    return {
      account,
      identities: (await services.accounts.listIdentities(account.id)).map(({ id, channel, verified, profile }) => ({ id, channel, verified, profile })),
      stores: await services.stores.listForAccount(account.id),
      onboarding: await services.onboarding.state(account.id),
    };
  });

  root.use('/auth', router);
}
