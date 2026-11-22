import { Router } from '../router.js';
import { requireAuth, status } from '../http.js';
import { pageParams } from '../../util/paginate.js';

/** The admin system. Authorisation is enforced inside every service call. */
export function registerAdminRoutes(root, core) {
  const { services } = core;
  const router = new Router();

  router.get('/overview', async (ctx) => {
    const account = requireAuth(ctx);
    await services.admin.assertAdmin(account.id, { allowSupport: true });
    return {
      platform: await services.analytics.platformOverview({ days: Number(ctx.query.days) || 30 }),
      topStores: await services.analytics.topStores({ limit: 10 }),
      reviewQueueSize: (await services.admin.reviewQueue(account.id, { limit: 1 })).total,
    };
  });

  router.get('/review-queue', async (ctx) => {
    const account = requireAuth(ctx);
    const { limit, offset } = pageParams(ctx.query);
    return services.admin.reviewQueue(account.id, { limit, offset });
  });

  router.post('/stores/:id/approve', async (ctx) => services.admin.approveStore(requireAuth(ctx).id, ctx.params.id, { note: ctx.body.note || '' }));

  router.post('/stores/:id/reject', async (ctx) => services.admin.rejectStore(requireAuth(ctx).id, ctx.params.id, ctx.body.reason || ''));

  router.post('/stores/:id/suspend', async (ctx) => services.admin.suspendStore(requireAuth(ctx).id, ctx.params.id, ctx.body.reason || ''));

  router.post('/stores/:id/feature', async (ctx) => services.admin.setFeatured(requireAuth(ctx).id, ctx.params.id, ctx.body.featured !== false));

  router.post('/stores/:id/verify', async (ctx) => services.admin.setVerified(requireAuth(ctx).id, ctx.params.id, ctx.body.verified !== false));

  router.get('/stores', async (ctx) => {
    const { limit, offset } = pageParams(ctx.query);
    return services.admin.listStores(requireAuth(ctx).id, { q: ctx.query.q || '', status: ctx.query.status || null, limit, offset });
  });

  router.get('/accounts', async (ctx) => {
    const account = requireAuth(ctx);
    await services.admin.assertAdmin(account.id, { allowSupport: true });
    const { limit, offset } = pageParams(ctx.query);
    return services.accounts.list({ limit, offset });
  });

  router.put('/accounts/:id/avatar', async (ctx) => services.admin.setAvatar(requireAuth(ctx).id, ctx.params.id, ctx.body?.avatarUrl));

  router.post('/accounts/:id/avatar/from-telegram', async (ctx) => services.admin.avatarFromTelegram(requireAuth(ctx).id, ctx.params.id));

  router.post('/accounts/:id/suspend', async (ctx) => services.admin.suspendAccount(requireAuth(ctx).id, ctx.params.id, ctx.body.reason || ''));

  router.post('/accounts/:id/restore', async (ctx) => services.admin.restoreAccount(requireAuth(ctx).id, ctx.params.id));

  router.post('/accounts/:id/role', async (ctx) => services.admin.grantRole(requireAuth(ctx).id, ctx.params.id, ctx.body.role));

  // Files products under the category their words name. Dry run unless {"apply": true}; {"storeId"} narrows it to one shop.
  router.post('/catalog/recategorize', async (ctx) => {
    await services.admin.assertAdmin(requireAuth(ctx).id);
    return services.catalog.recategorize({ apply: ctx.body?.apply === true, storeId: ctx.body?.storeId || null, assignments: Array.isArray(ctx.body?.assignments) ? ctx.body.assignments : null });
  });

  router.get('/lookup', async (ctx) => services.admin.lookup(requireAuth(ctx).id, ctx.query.q));

  router.get('/audit', async (ctx) => {
    const { limit, offset } = pageParams(ctx.query);
    return services.admin.auditTrail(requireAuth(ctx).id, { limit, offset, action: ctx.query.action || null });
  });

  router.post('/broadcast', async (ctx) => services.admin.broadcast(requireAuth(ctx).id, {
    title: ctx.body.title,
    body: ctx.body.body || '',
    audience: ctx.body.audience || 'all',
    data: ctx.body.data || {},
  }));

  // -- Subscriptions, wallets and full store management ------------------
  //
  // qbazz-core is shared infrastructure — every account is a tenant on a
  // plan. Editing a user's store already works through the ordinary seller
  // route (`PATCH /stores/:id`): a platform admin bypasses the store-role
  // check there automatically, so it needs no admin-specific twin.

  router.get('/users', async (ctx) => {
    const { limit, offset } = pageParams(ctx.query);
    return services.admin.listUsers(requireAuth(ctx).id, { q: ctx.query.q || '', kind: ctx.query.kind || '', limit, offset });
  });

  router.get('/users/:id', async (ctx) => services.userProfile.get(requireAuth(ctx).id, ctx.params.id));

  router.get('/subscriptions', async (ctx) => {
    const { limit, offset } = pageParams(ctx.query);
    return services.admin.listSubscriptions(requireAuth(ctx).id, { limit, offset });
  });

  // -- Content: pages, tutorials, FAQ, landing pages and the footer ---------------------------

  router.get('/pages', async (ctx) => services.content.listAll(requireAuth(ctx).id));
  router.get('/pages/:id', async (ctx) => services.content.get(requireAuth(ctx).id, ctx.params.id));
  router.post('/pages', async (ctx) => status(201, await services.content.create(requireAuth(ctx).id, ctx.body)));
  router.patch('/pages/:id', async (ctx) => services.content.update(requireAuth(ctx).id, ctx.params.id, ctx.body));
  router.delete('/pages/:id', async (ctx) => services.content.remove(requireAuth(ctx).id, ctx.params.id));
  router.get('/site', async (ctx) => services.content.getSite(requireAuth(ctx).id));
  router.patch('/site', async (ctx) => services.content.updateSite(requireAuth(ctx).id, ctx.body));

  // -- Platform payment methods ------------------------------------------------
  router.get('/sale-units', async (ctx) => services.admin.getSaleUnits(requireAuth(ctx).id, { locale: ctx.locale || 'fa' }));

  router.put('/sale-units', async (ctx) => services.admin.setSaleUnits(requireAuth(ctx).id, ctx.body || {}));

  router.get('/mockup-prompts', async (ctx) => services.admin.getMockupPrompts(requireAuth(ctx).id, { locale: ctx.locale || 'fa' }));

  router.put('/mockup-prompts', async (ctx) => services.admin.setMockupPrompts(requireAuth(ctx).id, ctx.body || {}));

  router.get('/payments', async (ctx) => services.admin.getPayments(requireAuth(ctx).id));

  router.patch('/payments/settings', async (ctx) => services.admin.updatePaymentSettings(requireAuth(ctx).id, ctx.body));

  router.post('/payments/cards', async (ctx) => status(201, await services.admin.createPaymentCard(requireAuth(ctx).id, ctx.body)));

  router.patch('/payments/cards/:id', async (ctx) => services.admin.updatePaymentCard(requireAuth(ctx).id, ctx.params.id, ctx.body));

  router.delete('/payments/cards/:id', async (ctx) => services.admin.archivePaymentCard(requireAuth(ctx).id, ctx.params.id));

  router.get('/topups', async (ctx) => {
    const { limit, offset } = pageParams(ctx.query);
    return services.admin.listTopups(requireAuth(ctx).id, { status: ctx.query.status || null, limit, offset });
  });

  router.post('/topups/:id/approve', async (ctx) => services.admin.decideTopup(requireAuth(ctx).id, ctx.params.id, 'approve'));

  router.post('/topups/:id/decline', async (ctx) => services.admin.decideTopup(requireAuth(ctx).id, ctx.params.id, 'decline', { reason: ctx.body.reason || '' }));

  router.get('/plans', async (ctx) => services.admin.listPlans(requireAuth(ctx).id));

  router.post('/plans', async (ctx) => status(201, await services.admin.createPlan(requireAuth(ctx).id, ctx.body)));

  router.patch('/plans/:id', async (ctx) => services.admin.updatePlan(requireAuth(ctx).id, ctx.params.id, ctx.body));

  router.post('/accounts/:id/plan', async (ctx) => services.admin.setAccountPlan(requireAuth(ctx).id, ctx.params.id, ctx.body.planId));

  router.post('/accounts/:id/wallet', async (ctx) => services.admin.adjustWallet(
    requireAuth(ctx).id,
    ctx.params.id,
    Number(ctx.body.amountMinor),
    { reason: ctx.body.reason || 'admin_adjustment' },
  ));

  router.post('/accounts/:id/stores', async (ctx) => {
    const record = await services.admin.createStoreFor(requireAuth(ctx).id, ctx.params.id, ctx.body);
    return status(201, record);
  });

  router.post('/stores/:id/destroy', async (ctx) => services.admin.destroyStore(requireAuth(ctx).id, ctx.params.id, { confirmName: ctx.body?.confirmName }));

  router.post('/stores/:id/delete', async (ctx) => services.admin.deleteStore(requireAuth(ctx).id, ctx.params.id, ctx.body.reason || ''));

  router.get('/categories', async () => ({ items: await services.catalog.listCategories({ withCounts: true }) }));

  router.post('/categories', async (ctx) => {
    const account = requireAuth(ctx);
    await services.admin.assertAdmin(account.id);
    return services.catalog.createCategory(ctx.body);
  });

  router.patch('/categories/:id', async (ctx) => {
    const account = requireAuth(ctx);
    await services.admin.assertAdmin(account.id);
    return services.catalog.updateCategory(ctx.params.id, ctx.body);
  });

  root.use('/admin', router);
}
