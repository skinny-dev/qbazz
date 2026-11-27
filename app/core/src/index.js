import { loadConfig } from './config.js';
import { createStore } from './store/json-file.js';
import { EventBus } from './util/events.js';
import { createLogger } from './util/logger.js';

import { createAccountsService } from './services/accounts.js';
import { createOtpService } from './services/otp.js';
import { createWalletService } from './services/wallet.js';
import { createSubscriptionsService } from './services/subscriptions.js';
import { createTopupsService } from './services/topups.js';
import { createPaymentsService } from './services/payments.js';
import { createStoreCardsService } from './services/storeCards.js';
import { createPriceRequestsService } from './services/priceRequests.js';
import { createCommentsService } from './services/comments.js';
import { createGatewayService } from './services/gateway.js';
import { createContentService } from './services/content.js';
import { createUploadsService } from './services/uploads.js';
import { createVideosService } from './services/videos.js';
import { createTelegramService } from './services/telegram.js';
import { createStoresService } from './services/stores.js';
import { createCatalogService } from './services/catalog.js';
import { createCartsService } from './services/carts.js';
import { createOrdersService } from './services/orders.js';
import { createCustomersService } from './services/customers.js';
import { createDiscoveryService } from './services/discovery.js';
import { createSeoService } from './services/seo.js';
import { createOnboardingService } from './services/onboarding.js';
import { createIntegrationsService } from './services/integrations.js';
import { createNotificationsService } from './services/notifications.js';
import { createAnalyticsService } from './services/analytics.js';
import { createAdminService } from './services/admin.js';
import { createUserProfileService } from './services/userProfile.js';
import { createGeoService } from './services/geo.js';
import { createChannelsService } from './services/channels.js';
import { createAccessService } from './services/access.js';
import { createAiService } from './services/ai.js';
import { createMockupsService } from './services/mockups.js';
import { createChannelImportService } from './services/channelImport.js';
import { createSyncService } from './sync/outbox.js';
import { wireReactions } from './reactions.js';
import { bootstrapAdmins } from './bootstrap.js';

/**
 * Builds the Qbazz core.
 *
 * The result is a plain object of services. The HTTP API in `api/http.js` is a
 * thin shell over it, and the Telegram integration can either import this
 * directly (single process) or talk to the HTTP API (separate processes) —
 * the surface is identical either way.
 *
 *   const core = await createCore();
 *   const feed = await core.services.discovery.homeFeed({ channel: 'telegram' });
 */
export async function createCore({ env = process.env, config: overrides = {}, store: injectedStore = null } = {}) {
  const config = loadConfig(env, overrides);
  const log = createLogger('core', config.logLevel);
  const store = injectedStore || createStore(config);
  const events = new EventBus();

  // Services are constructed with a shared context and reference each other
  // through `ctx.services`, which is populated before any method can run.
  const ctx = { config, store, events, log, services: {} };

  ctx.services.geo = createGeoService(ctx);
  ctx.services.telegram = createTelegramService(ctx);
  ctx.services.ai = createAiService(ctx);
  ctx.services.mockups = createMockupsService(ctx);
  ctx.services.channelImport = createChannelImportService(ctx);
  ctx.services.accounts = createAccountsService(ctx);
  ctx.services.otp = createOtpService(ctx);
  ctx.services.wallet = createWalletService(ctx);
  ctx.services.subscriptions = createSubscriptionsService(ctx);
  ctx.services.payments = createPaymentsService(ctx);
  ctx.services.topups = createTopupsService(ctx);
  ctx.services.stores = createStoresService(ctx);
  ctx.services.storeCards = createStoreCardsService(ctx);
  ctx.services.catalog = createCatalogService(ctx);
  ctx.services.carts = createCartsService(ctx);
  ctx.services.customers = createCustomersService(ctx);
  ctx.services.orders = createOrdersService(ctx);
  ctx.services.gateway = createGatewayService(ctx);
  ctx.services.content = createContentService(ctx);
  ctx.services.discovery = createDiscoveryService(ctx);
  ctx.services.seo = createSeoService(ctx);
  ctx.services.onboarding = createOnboardingService(ctx);
  ctx.services.integrations = createIntegrationsService(ctx);
  ctx.services.channels = createChannelsService(ctx);
  ctx.services.access = createAccessService(ctx);
  ctx.services.priceRequests = createPriceRequestsService(ctx);
  ctx.services.comments = createCommentsService(ctx);
  ctx.services.uploads = createUploadsService(ctx);
  ctx.services.videos = createVideosService(ctx);
  ctx.services.notifications = createNotificationsService(ctx);
  ctx.services.analytics = createAnalyticsService(ctx);
  ctx.services.admin = createAdminService(ctx);
  ctx.services.userProfile = createUserProfileService(ctx);
  ctx.services.sync = createSyncService(ctx);

  wireReactions(ctx);
  await ctx.services.subscriptions.init();
  await ctx.services.payments.init();
  await ctx.services.sync.init();
  await ctx.services.catalog.syncTaxonomy();
  await ctx.services.channels.migrateFrozenDefaultButtons();
  await ctx.services.stores.migratePaymentMethods();
  await ctx.services.content.seedDefaults();
  await ctx.services.channelImport.recover();
  await ctx.services.mockups.recover();
  await ctx.services.videos.recover();
  try {
    const moved = await ctx.services.uploads.rebase();
    if (moved) log.info(`${moved} record(s) pointed at ${config.platform.apiBaseUrl}/media/u/`);
  } catch (err) {
    log.warn(`image address check skipped: ${err.message}`);
  }
  await bootstrapAdmins(ctx);
  try {
    const healed = await ctx.services.accounts.reconcilePhones();
    if (healed.merged || healed.rewritten) log.info(`phone numbers reconciled: ${healed.merged} duplicate account(s) merged, ${healed.rewritten} number(s) rewritten`);
  } catch (err) {
    log.warn(`phone reconcile skipped: ${err.message}`);
  }

  log.info(`${config.platform.name} core ready (storage: ${config.storage.driver}, env: ${config.env})`);

  return {
    config,
    log,
    events,
    store,
    services: ctx.services,
    async close() {
      await store.close?.();
    },
  };
}

export { loadConfig } from './config.js';
export * from './errors.js';
export * from './models/schemas.js';
export { formatMoney, toMinor, fromMinor } from './util/money.js';
export { TOPICS, topicOf } from './sync/outbox.js';
