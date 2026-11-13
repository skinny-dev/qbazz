import { COLLECTIONS, ONBOARDING_FLOWS, PAYMENT_METHODS, FULFILLMENT_METHODS, SHIPPING_PAYER } from '../models/schemas.js';
import { ConflictError, NotFoundError, ValidationError, localizeError } from '../errors.js';
import { newId } from '../util/ids.js';
import { toMinor } from '../util/money.js';
import { tryValidateField } from '../util/validate.js';
import { effectiveLocale, hasKey, translate } from '../i18n/index.js';

/**
 * Channel-agnostic onboarding.
 *
 * A flow is a list of steps; a session is a cursor over that list plus the
 * answers so far, stored in the core rather than in bot memory. The consequence
 * is the one the product needs: a seller can answer four questions in Telegram,
 * open the web dashboard, and land on question five with their answers intact —
 * and the same is true in reverse once the web version ships.
 *
 * A client renders `step.render` however it likes (inline keyboard, HTML form)
 * and posts the answer back to `answer()`. Validation, branching and the
 * completion side effects all happen here, once.
 *
 * Wording is not in this file. A step names itself (`seller` + `storeName`) and
 * its title, prompt, help and placeholder are looked up as
 * `onb.<flow>.<step>.<part>` in the catalog for the *account's* language, so a
 * seller who started in Persian on Telegram sees the same Persian step on the
 * web, and a validation failure is worded in their language too.
 */
export function createOnboardingService(ctx) {
  const { store: db, config, events, services } = ctx;
  const sessions = db.collection(COLLECTIONS.onboardings);

  const FLOWS = buildFlows(config);

  function flowDefinition(flow) {
    const definition = FLOWS[flow];
    if (!definition) throw new ValidationError({ flow: `Flow must be one of: ${ONBOARDING_FLOWS.join(', ')}` });
    return definition;
  }

  /** The language this person reads: their choice, else the platform's. */
  async function localeFor(accountId, override = null) {
    if (override) return override;
    const account = accountId ? await db.collection(COLLECTIONS.accounts).get(accountId) : null;
    return effectiveLocale(account, config.platform.defaultLocale);
  }

  async function start(accountId, flow = 'seller', { channel = 'web', seed = {}, restart = false } = {}) {
    const definition = flowDefinition(flow);
    const existing = await sessions.findOne({ accountId, flow, status: 'in_progress' });

    if (existing && !restart) return state(existing.id, { channel });
    // Better to say "your plan is full" before six steps of typing than after.
    if (flow === 'seller') await services.subscriptions.checkLimit(accountId, 'stores');
    if (existing && restart) await sessions.update(existing.id, { status: 'abandoned' });

    const owner = await db.collection(COLLECTIONS.accounts).get(accountId);
    const knownPhone = owner?.phone || null;

    const session = await sessions.insert({
      id: newId('onb'),
      accountId,
      flow,
      stepId: definition.steps[0].id,
      data: { ...(definition.seed?.(seed) || {}), ...(flow === 'seller' && knownPhone ? { phone: knownPhone, phoneKnown: true } : {}), ...seed },
      status: 'in_progress',
      channel,
      lastChannel: channel,
      startedAt: new Date().toISOString(),
      completedAt: null,
      result: null,
    });

    await events.emit('onboarding.started', { accountId, flow, sessionId: session.id, channel });
    return state(session.id, { channel });
  }

  /** Resume point. `state()` is what a client calls on every screen render. */
  async function state(sessionIdOrAccount, { flow = null, channel = null, locale = null } = {}) {
    const session = await resolveSession(sessionIdOrAccount, flow);
    if (!session) return null;
    if (channel && channel !== session.lastChannel) {
      await sessions.update(session.id, { lastChannel: channel });
      session.lastChannel = channel;
    }

    const definition = flowDefinition(session.flow);
    const steps = visibleSteps(definition, session.data);
    const index = Math.max(0, steps.findIndex((s) => s.id === session.stepId));

    if (session.status === 'completed') {
      return { sessionId: session.id, flow: session.flow, status: 'completed', data: session.data, result: session.result, progress: { current: steps.length, total: steps.length, percent: 100 }, step: null };
    }

    const step = steps[index];
    const loc = await localeFor(session.accountId, locale);
    return {
      sessionId: session.id,
      flow: session.flow,
      status: session.status,
      data: session.data,
      lastChannel: session.lastChannel,
      progress: { current: index + 1, total: steps.length, percent: Math.round(((index) / steps.length) * 100) },
      canGoBack: index > 0,
      step: step ? presentStep(definition, step, session.data, loc) : null,
    };
  }

  async function answer(sessionIdOrAccount, value, { channel = null, flow = null, locale = null, trusted = false, flags = null } = {}) {
    const session = await resolveSession(sessionIdOrAccount, flow);
    if (!session) throw new NotFoundError('Onboarding session');
    if (session.status !== 'in_progress') throw new ConflictError('err.onboarding_finished');

    const definition = flowDefinition(session.flow);
    const steps = visibleSteps(definition, session.data);
    const index = Math.max(0, steps.findIndex((s) => s.id === session.stepId));
    const step = steps[index];
    if (!step) throw new ConflictError('err.onboarding_step');

    const loc = await localeFor(session.accountId, locale);
    const reject = async (message) => ({ ...(await state(session.id, { channel, locale: loc })), error: message });

    // A step that makes a claim about the outside world ("I administer this channel") is checked
    // here for anyone who is not a trusted service — a browser's word for it counts for nothing.
    if (step.verify && !trusted) {
      try {
        value = await step.verify(value, session, ctx);
      } catch (err) {
        return reject(localizeError(err, loc));
      }
    }

    // Validate before writing so a rejected answer leaves the cursor untouched.
    let parsed = value;
    if (step.rule) {
      const result = tryValidateField(value, step.rule, step.field || step.id, { locale: loc });
      if (!result.ok) return reject(result.error);
      parsed = result.value;
    }
    if (step.parse) {
      try {
        parsed = await step.parse(parsed, session.data, ctx);
      } catch (err) {
        return reject(localizeError(err, loc));
      }
    }
    if (step.check) {
      const verdict = await step.check(parsed, session.data, ctx);
      if (verdict !== true) {
        // A check answers with a catalog key, a sentence, or a plain "no".
        const message = typeof verdict === 'string' && hasKey('en', verdict)
          ? translate(loc, verdict)
          : typeof verdict === 'string' ? verdict : localizeError(ValidationError.of(step.field || step.id, 'validation.invalid'), loc);
        return reject(message);
      }
    }

    const data = { ...session.data, [step.field || step.id]: parsed };
    // A side choice that rides along with an answer (the "improve with AI" tick under the description).
    if (flags && typeof flags.aiPolish === 'boolean') data.aiPolish = flags.aiPolish;
    const nextSteps = visibleSteps(definition, data);
    const nextIndex = nextSteps.findIndex((s) => s.id === step.id) + 1;
    const nextStep = nextSteps[nextIndex];

    await sessions.update(session.id, { data, stepId: nextStep ? nextStep.id : step.id, lastChannel: channel || session.lastChannel });
    await events.emit('onboarding.step_completed', { accountId: session.accountId, flow: session.flow, sessionId: session.id, stepId: step.id, channel });

    if (!nextStep) return complete(session.id, { channel });
    return state(session.id, { channel, locale: loc });
  }

  async function skip(sessionIdOrAccount, { channel = null, flow = null, locale = null } = {}) {
    const session = await resolveSession(sessionIdOrAccount, flow);
    if (!session) throw new NotFoundError('Onboarding session');
    const definition = flowDefinition(session.flow);
    const steps = visibleSteps(definition, session.data);
    const index = Math.max(0, steps.findIndex((s) => s.id === session.stepId));
    const step = steps[index];
    const loc = await localeFor(session.accountId, locale);
    if (!step?.optional) return { ...(await state(session.id, { channel, locale: loc })), error: translate(loc, 'err.step_required') };

    const data = { ...session.data, [step.field || step.id]: step.skipValue ?? null };
    const nextSteps = visibleSteps(definition, data);
    const nextStep = nextSteps[nextSteps.findIndex((s) => s.id === step.id) + 1];
    await sessions.update(session.id, { data, stepId: nextStep ? nextStep.id : step.id });
    if (!nextStep) return complete(session.id, { channel });
    return state(session.id, { channel, locale: loc });
  }

  async function back(sessionIdOrAccount, { channel = null, flow = null, locale = null } = {}) {
    const session = await resolveSession(sessionIdOrAccount, flow);
    if (!session) throw new NotFoundError('Onboarding session');
    const definition = flowDefinition(session.flow);
    const steps = visibleSteps(definition, session.data);
    const index = Math.max(0, steps.findIndex((s) => s.id === session.stepId));
    if (index === 0) return state(session.id, { channel, locale });
    await sessions.update(session.id, { stepId: steps[index - 1].id });
    return state(session.id, { channel, locale });
  }

  async function complete(sessionId, { channel = null } = {}) {
    const session = await sessions.get(sessionId);
    if (!session) throw new NotFoundError('Onboarding session', sessionId);
    if (session.status === 'completed') return state(session.id, { channel });

    const definition = flowDefinition(session.flow);
    const result = definition.onComplete ? await definition.onComplete(session, ctx) : null;

    await sessions.update(session.id, { status: 'completed', completedAt: new Date().toISOString(), result });
    await events.emit('onboarding.completed', { accountId: session.accountId, flow: session.flow, sessionId: session.id, result, channel });
    return { ...(await state(session.id, { channel })), result };
  }

  async function cancel(sessionIdOrAccount, { flow = null } = {}) {
    const session = await resolveSession(sessionIdOrAccount, flow);
    if (!session) return { cancelled: false };
    await sessions.update(session.id, { status: 'abandoned' });
    await events.emit('onboarding.abandoned', { accountId: session.accountId, flow: session.flow, sessionId: session.id });
    return { cancelled: true };
  }

  /**
   * Accepts a session id or an account id. Prefers the live session, but falls
   * back to the most recent finished one so a client reconnecting after
   * completion still gets the "you're done" state instead of null.
   */
  async function resolveSession(sessionIdOrAccount, flow) {
    if (!sessionIdOrAccount) return null;
    const direct = await sessions.get(sessionIdOrAccount);
    if (direct) return direct;
    const base = { accountId: sessionIdOrAccount };
    if (flow) base.flow = flow;
    const active = await sessions.findOne({ ...base, status: 'in_progress' }, [['createdAt', 'desc']]);
    return active || (await sessions.findOne(base, [['createdAt', 'desc']]));
  }

  async function listForAccount(accountId) {
    return sessions.find({ where: { accountId }, sort: [['createdAt', 'desc']] });
  }

  /** The flows on offer, named for `locale` — what a "get started" screen lists. */
  function describeFlows(locale = config.platform.defaultLocale) {
    return Object.values(FLOWS).map((flow) => ({
      id: flow.id,
      title: translate(locale, `onb.flow.${flow.id}.title`),
      description: translate(locale, `onb.flow.${flow.id}.description`),
      stepCount: flow.steps.length,
    }));
  }

  /** Admin/analytics: where do people drop out? */
  async function funnel(flow = 'seller') {
    const rows = await sessions.find({ where: { flow } });
    const byStep = {};
    for (const row of rows) {
      const key = row.status === 'completed' ? 'completed' : row.stepId;
      byStep[key] = (byStep[key] || 0) + 1;
    }
    return {
      flow,
      started: rows.length,
      completed: rows.filter((r) => r.status === 'completed').length,
      inProgress: rows.filter((r) => r.status === 'in_progress').length,
      abandoned: rows.filter((r) => r.status === 'abandoned').length,
      byStep,
    };
  }

  return { flows: FLOWS, describeFlows, start, state, answer, skip, back, complete, cancel, listForAccount, funnel };
}

// ---------------------------------------------------------------------------
// Step presentation
// ---------------------------------------------------------------------------

/** "@name", "instagram.com/name" and a full profile URL all mean the same page. Null when it is not one. */
export const MAX_PHOTOS = 10;

/** A photo answer as a clean list: nothing, one link, or several. */
export function photoList(input) {
  return [].concat(input ?? []).map((src) => String(src ?? '').trim()).filter(Boolean).slice(0, MAX_PHOTOS + 1);
}

export function instagramHandle(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  const match = text.match(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:\?.*)?$/i) || text.match(/^@?([A-Za-z0-9._]{1,30})$/);
  return match ? match[1].toLowerCase() : null;
}

function visibleSteps(definition, data) {
  return definition.steps.filter((step) => !step.showIf || step.showIf(data));
}

/**
 * Strips the functions off a step so it can cross a network boundary, and
 * words it for `locale`. `render` is the contract clients build their UI from.
 */
function presentStep(definition, step, data, locale) {
  const keyOf = (part) => `onb.${definition.id}.${step.id}.${part}`;
  const t = (part, params) => translate(locale, keyOf(part), params);
  const has = (part) => hasKey(locale, keyOf(part)) || hasKey('en', keyOf(part));
  const params = step.params ? step.params(data) : {};

  return {
    id: step.id,
    field: step.field || step.id,
    title: t('title', params),
    prompt: t('prompt', params),
    help: has('help') ? t('help', params) : null,
    optional: Boolean(step.optional),
    value: data[step.field || step.id] ?? null,
    render: {
      input: step.input || 'text',
      // A long answer gets a multi-line box on the web (the bot just takes a message).
      multiline: Boolean(step.multiline),
      placeholder: has('placeholder') ? t('placeholder', params) : null,
      options: typeof step.options === 'function' ? step.options(data, (key, p) => translate(locale, key, p)) : step.options || null,
      // When options are dynamic (the category list), the client fetches them
      // from the matching public endpoint instead of receiving them inline.
      optionsSource: step.optionsSource || null,
      // Query for that endpoint when the choices depend on an earlier answer
      // (the sub-categories of the group the seller just picked).
      optionsQuery: step.optionsQuery ? step.optionsQuery(data) : null,
      multiple: Boolean(step.multiple),
      min: step.rule?.min ?? null,
      max: step.rule?.max ?? null,
      suffix: step.suffix || null,
      /**
       * For a location step, what the client may send back. Telegram uses its
       * share-location button, the web uses navigator.geolocation or a map
       * pin; both post `{ lat, lng }` and get the city resolved server-side.
       * Typing a place name stays valid on both.
       */
      accepts: step.rule?.type === 'location'
        ? { coordinates: true, text: true, searchEndpoint: '/geo/search', reverseEndpoint: '/geo/reverse' }
        : step.input === 'telegram_channel'
          // Only a Telegram client can prove who administers a channel, so a
          // web client hands this one step to the bot rather than faking it.
          ? { verifiedBy: 'server', checkEndpoint: '/onboarding/channel/check', skippable: true }
          : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Flow definitions
// ---------------------------------------------------------------------------

function buildFlows(config) {
  return {
    /**
     * Seller: as light as opening an Instagram page. A name, what you sell, a
     * first product — and the shop has its own address, link and QR. Payment,
     * delivery, a Telegram channel and Instagram are all things to add *after*
     * the shop exists (the dashboard checklist walks through them), never
     * questions standing between someone and their first page.
     *
     * Already-known facts are not asked again: the phone the person signed in
     * with is used as the shop's contact.
     */
    seller: {
      id: 'seller',
      seed: (seed) => ({ currency: config.platform.defaultCurrency, ...seed }),
      steps: [
        {
          id: 'storeName',
          rule: { type: 'string', required: true, min: 2, max: 80 },
        },
        {
          id: 'categoryId',
          input: 'choice',
          rule: { type: 'string', required: true },
          options: () => null, // filled by the client from GET /categories
          optionsSource: 'categories',
          check: async (value, _data, ctx) => {
            const category = await ctx.services.catalog.getCategory(value);
            return category ? true : 'err.pick_category';
          },
          parse: async (value, _data, ctx) => (await ctx.services.catalog.getCategory(value)).id,
        },
        {
          // Skipped when the person signed in with a phone number (the web's only way in): that
          // verified number is the contact.
          id: 'phone',
          showIf: (data) => !data.phoneKnown,
          input: 'contact',
          rule: { type: 'phone', required: true },
        },
        {
          // Optional: buyers near you find you by city, but a shop works without one.
          id: 'location',
          input: 'location',
          optional: true,
          skipValue: null,
          rule: { type: 'location', required: true },
          // Coordinates from either picker are resolved here, once.
          parse: (value, _data, ctx) => ctx.services.geo.resolve(value),
        },
        {
          /**
           * Only asked when the answer came from a picker. Geocoders disagree
           * about what the "city" of a point is, so the pin stays exact and the
           * person confirms the name buyers will see.
           */
          id: 'locationCity',
          showIf: (data) => data.location?.lat !== undefined && data.location?.lat !== null,
          input: 'choice',
          options: (data) => (data.location?.candidates || []).map((name) => ({ value: name, label: name })),
          rule: { type: 'string', required: true, min: 2, max: 80 },
        },
        {
          id: 'firstProductTitle',
          rule: { type: 'string', required: true, min: 2, max: 140 },
        },
        {
          id: 'firstProductPrice',
          params: (data) => ({ title: data.firstProductTitle }),
          input: 'number',
          rule: { type: 'number', required: true, min: 0 },
          parse: (value, data) => toMinor(value, data.currency || config.platform.defaultCurrency),
        },
        {
          id: 'firstProductDescription',
          params: (data) => ({ title: data.firstProductTitle }),
          multiline: true,
          optional: true,
          skipValue: '',
          rule: { type: 'string', max: 2000 },
        },
        {
          id: 'firstProductPhoto',
          params: (data) => ({ title: data.firstProductTitle }),
          input: 'photo',
          optional: true,
          skipValue: [],
          // One photo (the bot sends one) or an album (the web sends several): either way a list of links,
          // each to an image we hold or Telegram holds - anything else is not a photo.
          parse: (value) => photoList(value),
          check: (value) => (value.length <= MAX_PHOTOS && value.every((src) => /^https?:\/\//.test(src) && src.length <= 500) ? true : 'err.upload_type'),
        },
        {
          // Their Instagram page: shown on the shop, and the shop's link goes in its bio.
          id: 'instagram',
          optional: true,
          skipValue: null,
          rule: { type: 'string', max: 200 },
          check: (value) => (!value || instagramHandle(value) ? true : 'err.instagram_handle'),
        },
      ],

      /**
       * Creates the store with its first product and submits it for review.
       * Everything the old flow asked up front gets a sensible default here and
       * is adjusted from the dashboard.
       */
      onComplete: async (session, ctx) => {
        const { services, config: cfg } = ctx;
        const data = session.data;

        const categories = await services.catalog.listCategories();
        const categoryName = categories.find((c) => c.id === data.categoryId)?.name || '';

        const record = await services.stores.create(session.accountId, {
          name: data.storeName,
          // A line to start with; the seller rewrites it in Settings when they want to.
          description: data.description || (categoryName ? `${data.storeName} — ${categoryName}` : data.storeName),
          currency: data.currency || cfg.platform.defaultCurrency,
          categoryIds: data.categoryId ? [data.categoryId] : [],
          location: {
            // The confirmed name wins over the geocoder's first guess.
            city: data.locationCity || data.location?.city,
            country: data.location?.country || undefined,
            address: data.location?.address || undefined,
            lat: data.location?.lat ?? undefined,
            lng: data.location?.lng ?? undefined,
          },
          contact: { phone: data.phone, ...(instagramHandle(data.instagram) ? { instagram: instagramHandle(data.instagram) } : {}) },
          // Safe defaults - a shop can take orders the moment it is live. Card-to-card needs a
          // card, so it is offered in the dashboard checklist rather than assumed here.
          settings: {
            paymentMethods: ['online'],
            fulfillmentMethods: ['delivery', 'pickup'],
            deliveryFee: 0,
            shippingPayer: 'buyer',
          },
        });

        // The same number becomes the account's own phone too, when it does
        // not already have one - so logging into the web app with it lands
        // straight in this seller's existing (Telegram-linked) account
        // instead of a second, disconnected one.
        const owner = await services.accounts.get(session.accountId);
        if (owner && !owner.phone) await services.accounts.update(session.accountId, { phone: data.phone });

        // Search-ready title, description and page metadata - unless the seller turned that off. A failure here must
        // never stop a shop from being created, so it falls back to what they typed.
        let title = data.firstProductTitle;
        let description = data.firstProductDescription || '';
        let seo;
        if (data.aiPolish !== false) {
          const result = await services.ai.optimizeListing({
            product: { title, description, price: data.firstProductPrice, currency: record.currency, images: photoList(data.firstProductPhoto), properties: [], tags: [] },
            store: record,
            categoryName: categoryName || '',
            locale: record.locale,
          }).catch(() => null);
          if (result) {
            seo = { ...result.seo, optimizedAt: new Date().toISOString(), provider: result.provider, original: { title, description } };
            title = result.title || title;
            description = result.description || description;
          }
        }

        const product = await services.catalog.createProduct(record.id, {
          title,
          price: data.firstProductPrice,
          categoryId: data.categoryId,
          images: photoList(data.firstProductPhoto),
          status: 'active',
          description,
          ...(seo ? { seo } : {}),
        });

        const seoApplied = Boolean(seo);
        let store = await services.stores.get(record.id);
        let missing = [];
        try {
          store = await services.stores.submitForReview(record.id, session.accountId);
        } catch (err) {
          missing = err.fields?.store?.params?.missing || [];
        }

        await services.accounts.update(session.accountId, { onboarded: true });
        await services.notifications.queue({
          accountId: session.accountId,
          storeId: record.id,
          type: 'store.created',
          render: (t) => ({
            title: t('notif.store.created.title', { name: record.name }),
            body: store.status === 'pending_review'
              ? t('notif.store.created.review.body')
              : store.status === 'active'
                ? t('notif.store.created.ready.body')
                : t('notif.store.created.incomplete.body', { missing }),
          }),
          data: { storeId: record.id },
        });

        return {
          storeId: record.id,
          storeSlug: record.slug,
          productId: product?.id || null,
          status: store.status,
          // What's still needed before the shop can be submitted, if anything.
          missing,
          dashboardUrl: `${cfg.platform.webBaseUrl}/manage`,
          storefrontUrl: `${cfg.platform.webBaseUrl}/s/${record.slug}`,
          seoPolished: seoApplied,
        };
      },
    },

    /** Buyer: three light questions that make the home feed useful immediately. */
    buyer: {
      id: 'buyer',
      steps: [
        {
          id: 'displayName',
          rule: { type: 'string', required: true, min: 2, max: 80 },
        },
        {
          id: 'location',
          input: 'location',
          optional: true,
          skipValue: null,
          rule: { type: 'location' },
          parse: (value, _data, ctx) => ctx.services.geo.resolve(value),
        },
        {
          id: 'locationCity',
          showIf: (data) => data.location?.lat !== undefined && data.location?.lat !== null,
          input: 'choice',
          optional: true,
          skipValue: null,
          options: (data) => (data.location?.candidates || []).map((name) => ({ value: name, label: name })),
          rule: { type: 'string', min: 2, max: 80 },
        },
        {
          id: 'interests',
          input: 'choice',
          multiple: true,
          optional: true,
          skipValue: [],
          rule: { type: 'array', of: { type: 'string' } },
          optionsSource: 'categories',
        },
        {
          id: 'notifications',
          input: 'confirm',
          rule: { type: 'bool' },
          options: (_data, t) => [
            { value: true, label: t('onb.buyer.notifications.yes') },
            { value: false, label: t('onb.buyer.notifications.no') },
          ],
        },
      ],

      onComplete: async (session, ctx) => {
        const data = session.data;
        const place = data.location || null;
        await ctx.services.accounts.update(session.accountId, {
          displayName: data.displayName,
          onboarded: true,
          prefs: {
            city: data.locationCity || place?.city || null,
            // Kept so the feed can rank by distance later without re-asking.
            coords: place?.lat ? { lat: place.lat, lng: place.lng } : null,
            interests: data.interests || [],
            notifications: data.notifications !== false,
          },
        });
        return { onboarded: true, city: data.locationCity || place?.city || null, interests: data.interests || [] };
      },
    },
  };
}
