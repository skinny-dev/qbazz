const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));
const bool = (v, fallback) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v));

export function loadBotConfig(env = process.env) {
  return {
    token: env.TELEGRAM_BOT_TOKEN || '',
    apiBase: env.TELEGRAM_API_BASE || 'https://api.telegram.org',
    proxy: env.TELEGRAM_PROXY || '',
    username: env.TELEGRAM_BOT_USERNAME || 'qbazz_bot',

    /**
     * 'direct' imports @qbazz/core into this process — one command to run the
     * whole product in development. 'http' talks to a separately deployed core,
     * which is what production uses. The flows are identical either way.
     */
    coreMode: env.QBAZZ_CORE_MODE || (env.QBAZZ_CORE_URL ? 'http' : 'direct'),
    coreUrl: env.QBAZZ_CORE_URL || 'http://127.0.0.1:8080',
    serviceKey: env.QBAZZ_SERVICE_KEY || 'dev-service-key',

    polling: {
      enabled: bool(env.TELEGRAM_POLLING, true),
      timeoutSec: num(env.TELEGRAM_POLL_TIMEOUT, 30),
      // channel_post: the other direction of channel sync — a post the seller
      // sends to their own connected channel, which a synced shop turns into
      // a product (see channel-sync.js).
      allowedUpdates: ['message', 'callback_query', 'inline_query', 'my_chat_member', 'channel_post', 'edited_channel_post'],
    },

    // Set a public URL to use webhooks instead of long polling.
    webhookUrl: env.TELEGRAM_WEBHOOK_URL || '',
    webhookPort: num(env.TELEGRAM_WEBHOOK_PORT, 8081),
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || '',

    // How often to drain the core's notification queue into Telegram.
    notifyIntervalMs: num(env.QBAZZ_NOTIFY_INTERVAL, 5000),

    webAppUrl: env.QBAZZ_WEB_URL || 'https://qbazz.app',
    // A Telegram Mini App URL; when set, buttons open the web storefront in-chat.
    miniAppUrl: env.QBAZZ_MINIAPP_URL || '',

    // Persian unless told otherwise. A person's own /language choice overrides it.
    defaultLocale: env.QBAZZ_LOCALE || 'fa',
    defaultCurrency: env.QBAZZ_CURRENCY || ((env.QBAZZ_LOCALE || 'fa') === 'fa' ? 'IRT' : 'USD'),
    supportHandle: env.QBAZZ_SUPPORT || '@qbazz_support',

    pageSize: num(env.QBAZZ_PAGE_SIZE, 6),
    logLevel: env.QBAZZ_LOG_LEVEL || 'info',
    dropPendingUpdates: bool(env.TELEGRAM_DROP_PENDING, false),
  };
}
