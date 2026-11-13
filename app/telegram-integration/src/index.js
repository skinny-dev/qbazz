import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadBotConfig } from './config.js';
import { TelegramApi, sleep } from './telegram/api.js';
import { createCoreClient } from './core-client.js';
import { createContext } from './session.js';
import { route, commandList } from './router.js';
import { makeTx } from './i18n/index.js';
import { bidiText } from './telegram/rtl.js';
import { isAppError, localizeError } from '../../qbazz-core/src/errors.js';
import { createNotifier } from './notifier.js';
import { offerLimitHelp } from './flows/billing.js';
import { createChannelPoster } from './channel-poster.js';
import { createChannelSync } from './channel-sync.js';
import { createChannelClaim } from './channel-claim.js';
import { createLogger } from '../../qbazz-core/src/util/logger.js';
import { telegramFetch } from '../../qbazz-core/src/util/telegramFetch.js';

/**
 * Bot process.
 *
 * Long polling by default (nothing to configure, works behind any firewall);
 * webhooks when `TELEGRAM_WEBHOOK_URL` is set. Either way an update ends up in
 * `handleUpdate`, so the two paths cannot drift.
 */
export async function startBot({ env = process.env, core: injectedCore = null } = {}) {
  const config = loadBotConfig(env);
  const log = createLogger('bot', config.logLevel);

  if (!config.token) {
    log.error('TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and add a token from @BotFather.');
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const api = new TelegramApi(config.token, { log, apiBase: config.apiBase, fetchImpl: telegramFetch(config.proxy) });
  const core = await createCoreClient(config, { core: injectedCore, log });

  // A network blip here (a flaky local proxy, a DNS hiccup) used to crash the
  // whole process before the bot ever got going — the exact failure the
  // polling loop below already shrugs off. Same retry, same backoff, just
  // once at the door instead of forever once we're inside.
  const me = await retryStartup(() => api.getMe(), { log, what: 'connect to Telegram' });
  config.username = me.username || config.username;
  log.info(`connected as @${config.username}`);

  // The menu and the profile text are in the platform language. Telegram picks
  // them by the *client's* language, not the person's choice in the bot, so one
  // consistent list is less confusing than two that disagree with the replies.
  const platform = makeTx(config.defaultLocale);
  await api.setMyCommands(commandList(platform.t)).catch((err) => log.warn(`setMyCommands failed: ${err.message}`));
  await api.setMyDescription(platform.t('b.bot.about')).catch((err) => log.warn(`setMyDescription failed: ${err.message}`));
  await api.setMyShortDescription(platform.t('b.bot.short')).catch((err) => log.warn(`setMyShortDescription failed: ${err.message}`));

  const notifier = createNotifier({ core, api, config, log });
  notifier.start();

  const channelPoster = createChannelPoster({ core, api, config, log });
  channelPoster.start();

  const channelSync = createChannelSync({ core, api, log });
  const channelClaim = createChannelClaim({ core, api, config, log });

  async function handleUpdate(update) {
    // A channel post has no user and no chat session — it is not something
    // session.js/router.js can make sense of — so it is handled on its own,
    // before anything assumes a private chat with a person.
    if (update.channel_post) return channelSync.handlePost(update.channel_post);
    if (update.edited_channel_post) return channelSync.handleEdit(update.edited_channel_post);
    // The bot was made an administrator of a channel: the quick connect.
    if (update.my_chat_member) return channelClaim.handle(update.my_chat_member);

    let ctx = null;
    try {
      ctx = await createContext({ update, api, core, config, log });
      if (!ctx) return;
      await route(ctx);
      await offerLimitHelp(ctx);
    } catch (err) {
      log.error(`update ${update.update_id} failed: ${err.message}`, err.stack);
      await notifyUser(update, err, { api, log, config, ctx });
      // ctx.err() inside notifyUser noted a plan limit if that was the cause.
      if (ctx) await offerLimitHelp(ctx).catch(() => null);
    }
  }

  let stopped = false;
  let pollingTask = null;
  let server = null;

  if (config.webhookUrl) {
    await retryStartup(() => api.setWebhook(config.webhookUrl, config.webhookSecret, config.polling.allowedUpdates), { log, what: 'set the webhook' });
    server = createWebhookServer({ config, log, handleUpdate });
    await new Promise((resolve) => server.listen(config.webhookPort, resolve));
    log.info(`webhook mode on port ${config.webhookPort} -> ${config.webhookUrl}`);
  } else {
    await retryStartup(() => api.deleteWebhook(config.dropPendingUpdates), { log, what: 'clear any webhook' });
    pollingTask = poll();
    log.info('long polling started');
  }

  async function poll() {
    let offset = 0;
    let backoff = 1000;
    while (!stopped) {
      try {
        const updates = await api.getUpdates(offset, config.polling.timeoutSec, config.polling.allowedUpdates);
        backoff = 1000;
        for (const update of updates) {
          offset = update.update_id + 1;
          // Sequential per batch: two taps from one user must not race on state.
          await handleUpdate(update);
        }
      } catch (err) {
        if (stopped) break;
        log.warn(`polling error: ${err.message} — retrying in ${backoff}ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }

  return {
    config,
    api,
    core,
    handleUpdate,
    async stop() {
      stopped = true;
      notifier.stop();
      channelPoster.stop();
      if (server) await new Promise((resolve) => server.close(resolve));
      if (pollingTask) await Promise.race([pollingTask, sleep(100)]);
      log.info('bot stopped');
    },
  };
}

/**
 * Retries a startup call forever with capped exponential backoff — the same
 * shape `poll()` already uses for the exact same class of failure (a proxy or
 * DNS hiccup), just applied before the bot is up instead of once it's running.
 */
async function retryStartup(fn, { log, what, maxDelayMs = 30000 } = {}) {
  let delay = 1000;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      log.warn(`failed to ${what}: ${err.message} — retrying in ${delay}ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}

function createWebhookServer({ config, log, handleUpdate }) {
  return http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    // Telegram echoes the secret; reject anything that cannot produce it.
    if (config.webhookSecret && req.headers['x-telegram-bot-api-secret-token'] !== config.webhookSecret) {
      res.writeHead(401).end();
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      // Acknowledge immediately; Telegram retries anything slower than 60s.
      res.writeHead(200).end();
      try {
        handleUpdate(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        log.warn(`bad webhook payload: ${err.message}`);
      }
    });
  });
}

/**
 * A user should never be left staring at a spinner because we threw — and the
 * apology should be in their language. When the failure happened before we knew
 * who they were (context creation itself), fall back to the platform language.
 */
async function notifyUser(update, err, { api, log, config, ctx }) {
  const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
  const callbackId = update.callback_query?.id;
  const tx = ctx?.tx || makeTx(config.defaultLocale);
  const friendly = ctx
    ? ctx.err(err)
    : isAppError(err) || err?.status < 500 ? localizeError(err, tx.locale) : tx.t('b.common.error_generic');
  try {
    if (callbackId) await api.answerCallbackQuery(callbackId, { text: bidiText(friendly.slice(0, 200), tx.rtl), show_alert: true });
    else if (chatId) await api.sendMessage(chatId, bidiText(`⚠️ ${friendly}`, tx.rtl));
  } catch (sendErr) {
    log.debug?.(`could not deliver error to user: ${sendErr.message}`);
  }
}

// Run directly: `node telegram-integration/src/index.js`
// pathToFileURL handles Windows backslashes and drive letters, which naive
// string comparison against import.meta.url does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bot = await startBot();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await bot.stop();
      process.exit(0);
    });
  }
}
