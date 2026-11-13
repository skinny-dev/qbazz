/**
 * Config resolution. Everything has a working default so `npm run core`
 * boots with zero setup; production overrides come from the environment.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));
const bool = (v, fallback) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v));
const list = (v, fallback) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : fallback);

export function loadConfig(env = process.env, overrides = {}) {
  const cfg = {
    env: env.NODE_ENV || 'development',
    port: num(env.QBAZZ_PORT, 8080),
    host: env.QBAZZ_HOST || '0.0.0.0',

    // Storage: 'memory' (tests) or 'json' (single-file persistence, good for dev/pilot).
    storage: {
      driver: env.QBAZZ_STORAGE || 'json',
      file: env.QBAZZ_STORAGE_FILE || path.join(pkgRoot, 'data', 'qbazz.json'),
      flushMs: num(env.QBAZZ_STORAGE_FLUSH_MS, 250),
    },

    payments: {
      gateway: {
        // 'sandbox' is a pretend gateway for development; 'zarinpal' is real money and needs a merchant id.
        provider: env.QBAZZ_PAY_PROVIDER || 'sandbox',
        merchantId: env.QBAZZ_ZARINPAL_MERCHANT || '',
        sandbox: bool(env.QBAZZ_ZARINPAL_SANDBOX, false),
        // Where the buyer lands after paying. Defaults to the public web address.
        returnUrl: env.QBAZZ_PAY_RETURN_URL || '',
        // An online order nobody pays for in this long is cancelled and its stock released.
        unpaidMinutes: num(env.QBAZZ_PAY_WINDOW_MINUTES, 30),
      },
    },

    // Images uploaded from the website live beside the data file.
    uploads: { maxPerAccount: num(env.QBAZZ_UPLOADS_PER_ACCOUNT, 3000), dir: env.QBAZZ_UPLOAD_DIR || path.join(path.dirname(env.QBAZZ_STORAGE_FILE || path.join(pkgRoot, 'data', 'qbazz.json')), 'uploads') },

    auth: {
      // Signs session tokens and Telegram WebApp deep-link payloads.
      secret: env.QBAZZ_SECRET || 'dev-insecure-secret-change-me',
      sessionTtlSec: num(env.QBAZZ_SESSION_TTL, 60 * 60 * 24 * 30),
      linkCodeTtlSec: num(env.QBAZZ_LINK_CODE_TTL, 60 * 15),
      // Service keys let trusted integrations (the bot) act on behalf of accounts.
      serviceKeys: list(env.QBAZZ_SERVICE_KEYS, ['dev-service-key']),
      // Phone login: how long a sent code is valid, the minimum gap between
      // two sends to the same number (an SMS costs money — this is the guard
      // against a resend button turned into a bombing button), and how many
      // wrong guesses a code tolerates before it is burned outright.
      otpTtlSec: num(env.QBAZZ_OTP_TTL, 300),
      otpResendCooldownSec: num(env.QBAZZ_OTP_RESEND_COOLDOWN, 60),
      otpMaxAttempts: num(env.QBAZZ_OTP_MAX_ATTEMPTS, 5),
    },

    /**
     * SMS delivery for phone login codes. Without a key, 'console' logs the
     * code to the server log instead of sending it — same "still works, just
     * degraded" trade-off as every other unconfigured provider in this app —
     * so phone login is testable from a fresh checkout with zero setup.
     */
    sms: {
      provider: env.QBAZZ_SMS_PROVIDER || (env.SMS_API_KEY ? 'kavenegar' : 'console'),
      apiKey: env.QBAZZ_SMS_API_KEY || env.SMS_API_KEY || '',
      sender: env.SMS_SENDER || '',
      // provider 'http': any gateway with a JSON endpoint (api.ir and similar). The address and the body come from the
      // gateway's own documentation; {phone} {phoneLocal} {phoneIntl} {code} {text} are filled in per message.
      url: env.QBAZZ_SMS_URL || '',
      method: env.QBAZZ_SMS_METHOD || 'POST',
      body: env.QBAZZ_SMS_BODY || '{"mobile":"{phoneLocal}","code":"{code}"}',
      headers: env.QBAZZ_SMS_HEADERS || '',
      // How the key is sent: "bearer" (Authorization: Bearer <key>), "header:Name" (Name: <key>), or "none".
      auth: env.QBAZZ_SMS_AUTH || 'bearer',
      text: env.QBAZZ_SMS_TEXT || 'کد ورود کیوباز: {code}',
    },

    platform: {
      name: env.QBAZZ_NAME || 'Qbazz',
      // Persian first: it is the platform's default language, and Toman is the
      // unit its shops price in. Set QBAZZ_LOCALE=en / QBAZZ_CURRENCY=USD to change.
      defaultLocale: env.QBAZZ_LOCALE || 'fa',
      defaultCurrency: env.QBAZZ_CURRENCY || ((env.QBAZZ_LOCALE || 'fa') === 'fa' ? 'IRT' : 'USD'),
      botUsername: env.TELEGRAM_BOT_USERNAME || 'qbazz_bot',
      // When true a new store must be approved in the admin system before it goes live.
      storeApprovalRequired: bool(env.QBAZZ_STORE_APPROVAL, true),
      // When true, a shop whose owner's plan has lapsed (a paid plan that could not renew, or a free trial that ended) stops
      // taking NEW orders once the grace period is over. Orders already placed carry on. Off by default so that turning it on
      // is a decision, made after the accounts that should keep selling have a plan.
      enforceSubscriptions: bool(env.QBAZZ_ENFORCE_SUBSCRIPTIONS, false),
      subscriptionGraceDays: num(env.QBAZZ_SUBSCRIPTION_GRACE_DAYS, 3),
      // AI credits every account gets once, on top of its plan (a photo made by the image provider, or a generated caption, spends
      // one each). Unlike a plan's allowance they never reset. On a production server this is 10 unless the environment says
      // otherwise; elsewhere (development, tests) 0, so numbers in a test do not move.
      welcomeAiCredits: num(env.QBAZZ_WELCOME_AI_CREDITS, env.NODE_ENV === 'production' ? 10 : 0),
      commissionBps: num(env.QBAZZ_COMMISSION_BPS, 500), // 5.00%
      webBaseUrl: env.QBAZZ_WEB_URL || 'https://qbazz.app',
      // Where this API is reachable from a browser (used in proxied media URLs).
      apiBaseUrl: env.QBAZZ_API_URL || `http://localhost:${num(env.QBAZZ_PORT, 8080)}`,
      supportHandle: env.QBAZZ_SUPPORT || '@qbazz_support',
      // Where sellers send money to top up their wallet (card-to-card). Shown only to the
      // person topping up; an admin approves each receipt before any balance is added.
      topupCard: { number: env.QBAZZ_TOPUP_CARD || '', holder: env.QBAZZ_TOPUP_HOLDER || '' },

      /**
       * Platform staff, granted on every boot. Declaring them here rather than
       * flipping a row by hand means a fresh database — a new environment, a
       * restored backup — comes up with the same people in charge.
       */
      adminTelegramIds: list(env.QBAZZ_ADMIN_TELEGRAM_IDS, []),
      adminEmails: list(env.QBAZZ_ADMIN_EMAILS, []),
      // "09121234567=Name, 09351234567=Name": people who sign in with a phone code and are platform admins.
      adminPhones: list(env.QBAZZ_ADMIN_PHONES, []),
    },

    /**
     * Turns picker coordinates into a city name. 'nominatim' is OpenStreetMap's
     * free service (no key, ~1 req/s, wants a real User-Agent); 'none' keeps
     * coordinates and leaves the city blank; a function swaps in Google/Mapbox.
     */
    geo: {
      provider: env.QBAZZ_GEO_PROVIDER || 'nominatim',
      userAgent: env.QBAZZ_GEO_USER_AGENT || '',
      timeoutMs: num(env.QBAZZ_GEO_TIMEOUT, 5000),
      minIntervalMs: num(env.QBAZZ_GEO_MIN_INTERVAL, 1100),
      cacheTtlMs: num(env.QBAZZ_GEO_CACHE_TTL, 86400000),
    },

    /**
     * Listing generation. Without any key it runs a deterministic template
     * generator, so the feature works on every install — a key upgrades it.
     * Three real providers are supported; `provider` picks one explicitly,
     * or (left unset) whichever key is actually present decides — Anthropic
     * first, then OpenAI, then Gemini, if more than one is set.
     */
    ai: {
      provider: env.QBAZZ_AI_PROVIDER || null,
      apiKey: env.ANTHROPIC_API_KEY || '',
      model: env.QBAZZ_AI_MODEL || 'claude-opus-5',
      apiKeyOpenAI: env.OPENAI_API_KEY || '',
      modelOpenAI: env.QBAZZ_AI_MODEL_OPENAI || 'gpt-4o-mini',
      apiKeyGemini: env.GEMINI_API_KEY || '',
      modelGemini: env.QBAZZ_AI_MODEL_GEMINI || 'gemini-3.8-flash',
      language: env.QBAZZ_AI_LANGUAGE || 'English',
      // Google and OpenAI refuse requests from some countries; a server there sends them through the same proxy as Telegram.
      proxy: env.QBAZZ_AI_PROXY || env.TELEGRAM_PROXY || '',
    },

    /**
     * Product mockups: a flat product photo turned into a photo of it worn.
     * Each fashion category could in principle use a different provider —
     * for now there is only one, fashn.ai, used for every category. Without
     * a key the feature is simply unavailable, same trade-off as `ai` above,
     * except there is no offline fallback for image generation.
     */
    mockups: {
      provider: 'fashn',
      apiKey: env.FASHN_API_KEY || '',
      baseUrl: env.FASHN_BASE_URL || 'https://api.fashn.ai/v1',
      pollIntervalMs: num(env.QBAZZ_MOCKUP_POLL_INTERVAL, 2000),
      timeoutMs: num(env.QBAZZ_MOCKUP_TIMEOUT, 90000),
    },

    // Only used to proxy Telegram-hosted product photos to the public web, so the
    // bot token never appears in a URL a browser can read.
    telegram: { botToken: env.TELEGRAM_BOT_TOKEN || '', apiBase: env.TELEGRAM_API_BASE || 'https://api.telegram.org', proxy: env.TELEGRAM_PROXY || '' },

    sync: {
      // How many outbox events to retain for cursor-based catch-up.
      retainEvents: num(env.QBAZZ_SYNC_RETAIN, 10000),
      webhookTimeoutMs: num(env.QBAZZ_WEBHOOK_TIMEOUT, 5000),
      webhookRetries: num(env.QBAZZ_WEBHOOK_RETRIES, 3),
    },

    logLevel: env.QBAZZ_LOG_LEVEL || 'info',
  };

  return deepMerge(cfg, overrides);
}

function deepMerge(base, patch) {
  if (!patch) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && base[k] !== null
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}
