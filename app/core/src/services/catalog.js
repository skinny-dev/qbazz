import { COLLECTIONS, PRODUCT_STATUS, categorySchema, productSchema } from '../models/schemas.js';
import { LEGACY_CATEGORY_SLUGS, flattenTaxonomy } from '../models/taxonomy.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../util/ids.js';
import { slugify, uniqueSlug } from '../util/slug.js';
import { validate } from '../util/validate.js';
import { normalizeText } from '../util/text.js';
import { buildCategoryGuesser } from '../util/categoryGuess.js';
import { translate, hasKey } from '../i18n/index.js';

/**
 * Categories (platform taxonomy) and products (per store).
 *
 * Products carry a denormalised `searchText` and `storeName`, written on save.
 * Discovery reads those instead of joining at query time, which is what lets
 * the bot answer a search in one round trip.
 */
export function createCatalogService(ctx) {
  const { store: db, config, events, services } = ctx;
  const categories = db.collection(COLLECTIONS.categories);
  const products = db.collection(COLLECTIONS.products);
  const stores = db.collection(COLLECTIONS.stores);
  const settingsDb = db.collection(COLLECTIONS.platformSettings);
  const SALE_UNITS_ID = 'sale-units';

  // -- Categories ------------------------------------------------------------

  /**
   * Makes the stored categories match the taxonomy in models/taxonomy.js, on
   * every boot. It is idempotent and only writes what differs, so an unchanged
   * database is left alone.
   *
   * Categories the platform used to ship (before it narrowed to fashion) are
   * retired when a shop or product still points at them - hidden from every
   * list and picker, but not deleted, so nothing dangles - and removed when
   * nothing does. Categories an admin created by hand are never touched.
   */
  async function syncTaxonomy() {
    const idBySlug = new Map();
    for (const row of flattenTaxonomy()) {
      const parentId = row.parentSlug ? idBySlug.get(row.parentSlug) : null;
      const fields = { name: row.en, icon: row.icon, parentId, order: row.order, builtin: true, retired: false };
      const existing = await categories.findOne({ slug: row.slug });
      if (!existing) {
        const record = await categories.insert({ id: newId('cat'), slug: row.slug, description: '', productCount: 0, storeCount: 0, ...fields });
        idBySlug.set(row.slug, record.id);
        continue;
      }
      const changed = Object.keys(fields).some((key) => (existing[key] ?? null) !== fields[key]);
      if (changed) await categories.update(existing.id, fields);
      idBySlug.set(row.slug, existing.id);
    }

    for (const slug of LEGACY_CATEGORY_SLUGS) {
      if (idBySlug.has(slug)) continue;
      const old = await categories.findOne({ slug });
      if (!old) continue;
      const inUse = (await products.count({ categoryId: old.id })) + (await stores.count({ categoryIds: { $contains: old.id } }));
      if (!inUse) await categories.delete(old.id);
      else if (!old.retired) await categories.update(old.id, { retired: true });
    }
    return listCategories();
  }

  /**
   * The platform's own categories are stored once, in English, and named per
   * reader here. A category an admin created by hand has no catalog entry and
   * keeps the name it was given.
   */
  function localizeCategory(category, locale) {
    if (!category || !locale) return category;
    const key = `category.${category.slug}`;
    return hasKey(locale, key) || hasKey('en', key) ? { ...category, name: translate(locale, key) } : category;
  }

  /**
   * `parentId: null` is the top level, `parent` is the same thing by id or slug
   * ("the children of upper-body"), and `tree` nests children under their
   * group. A group's `productCount` covers everything filed under it.
   */
  async function listCategories({ parentId = undefined, parent = null, withCounts = false, tree = false, locale = null, includeRetired = false } = {}) {
    if (parent) {
      const found = await getCategory(parent);
      if (!found) return [];
      parentId = found.id;
    }
    const all = (await categories.find({ sort: [['order', 'asc'], ['name', 'asc']] })).filter((row) => includeRetired || !row.retired);
    const childrenOf = groupByParent(all);

    const decorate = async (row) => {
      const named = localizeCategory(row, locale);
      if (!withCounts) return named;
      const ids = subtreeIds(row.id, childrenOf);
      return { ...named, productCount: await products.count({ categoryId: { $in: ids }, status: 'active' }) };
    };

    if (tree) {
      return Promise.all((childrenOf.get(null) || []).map(async (root) => ({
        ...(await decorate(root)),
        children: await Promise.all((childrenOf.get(root.id) || []).map(decorate)),
      })));
    }

    const rows = parentId === undefined ? all : all.filter((row) => (row.parentId ?? null) === parentId);
    return Promise.all(rows.map(decorate));
  }

  /** A category's own id plus every id beneath it - what "in this category" means. */
  async function descendantIds(idOrSlug) {
    const found = await getCategory(idOrSlug);
    if (!found) return [];
    const all = await categories.find();
    return subtreeIds(found.id, groupByParent(all));
  }

  async function getCategory(idOrSlug) {
    if (!idOrSlug) return null;
    return (await categories.get(idOrSlug)) || (await categories.findOne({ slug: String(idOrSlug).toLowerCase() }));
  }

  async function createCategory(input) {
    const data = validate(input, categorySchema);
    const slug = await uniqueSlug(input.slug || data.name, async (c) => Boolean(await categories.findOne({ slug: c })));
    const record = await categories.insert({ id: newId('cat'), slug, ...data, productCount: 0, storeCount: 0 });
    await events.emit('category.created', { categoryId: record.id, category: record });
    return record;
  }

  async function updateCategory(id, patch) {
    const data = validate(patch, categorySchema, { partial: true });
    const updated = await categories.update(id, data);
    if (!updated) throw new NotFoundError('Category', id);
    return updated;
  }

  async function deleteCategory(id) {
    if (await categories.count({ parentId: id })) throw new ConflictError('err.category_has_children');
    const inUse = await products.count({ categoryId: id });
    if (inUse) throw new ConflictError('err.category_in_use', { count: inUse });
    const deleted = await categories.delete(id);
    if (!deleted) throw new NotFoundError('Category', id);
    return { deleted: true };
  }

  async function requireUsableCategory(idOrSlug) {
    const category = await getCategory(idOrSlug);
    if (!category) throw ValidationError.of('categoryId', 'err.category_unknown');
    if (category.retired) throw ValidationError.of('categoryId', 'err.category_retired');
    return category;
  }

  /** Both languages, leaf and group - so a Persian and an English search find the same products. */
  async function namesFor(category) {
    if (!category) return [];
    const chain = [category];
    if (category.parentId) chain.push(await categories.get(category.parentId));
    return chain.filter(Boolean).flatMap((row) => [localizeCategory(row, 'fa').name, localizeCategory(row, 'en').name]);
  }

  /**
   * A shop is filed under the groups it actually sells in. Listing a product
   * adds that product's group to the shop (never removes one), so a shop that
   * started with shirts and added a skirt turns up under both.
   */
  async function filedUnderStore(store, categoryId) {
    if (!store || !categoryId) return;
    const category = await categories.get(categoryId);
    if (!category) return;
    const groupId = category.parentId || category.id;
    const current = store.categoryIds || [];
    if (current.includes(groupId)) return;
    const live = [];
    for (const id of current) {
      const known = await categories.get(id);
      if (known && !known.retired) live.push(id);
    }
    await services.stores.update(store.id, { categoryIds: [...live, groupId] });
  }

  // -- Products --------------------------------------------------------------

  const MAX_VARIANTS = 60;

  /** A product's total stock from its options: unlimited as soon as one option is, else the sum. */
  function stockOf(variants) {
    if (variants.some((v) => v.stock === null || v.stock === undefined)) return null;
    return variants.reduce((n, v) => n + v.stock, 0);
  }

  /**
   * Options a buyer picks (size, colour, set...): each has a name, its own stock (empty = unlimited) and, when it differs,
   * its own price. Rows without an id get one; the product's own stock then follows the options.
   */
  function normalizeVariants(rows) {
    if (!Array.isArray(rows)) throw ValidationError.of('variants', 'validation.invalid', { field: 'Variants' });
    if (rows.length > MAX_VARIANTS) throw ValidationError.of('variants', 'err.variants_many', { max: MAX_VARIANTS });
    const seen = new Set();
    const whole = (value, key) => {
      if (value === null || value === undefined || value === '') return null;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) throw ValidationError.of('variants', key);
      return n;
    };
    return rows.map((row) => {
      const title = String(row?.title ?? '').trim();
      if (!title || title.length > 60) throw ValidationError.of('variants', 'err.variant_title');
      const key = title.toLowerCase();
      if (seen.has(key)) throw ValidationError.of('variants', 'err.variant_dup', { title });
      seen.add(key);
      return { id: row.id || newId('var'), title, stock: whole(row.stock, 'err.variant_stock'), price: whole(row.price, 'err.variant_price') };
    });
  }

  const PIECE = { kind: 'piece' };

  /** `pack` needs a size of 2 or more and a name; anything else is a single piece. */
  function normalizeSaleUnit(unit) {
    if (!unit || unit.kind !== 'pack') return { ...PIECE };
    const size = Number(unit.size);
    if (!Number.isInteger(size) || size < 2 || size > 1000) throw ValidationError.of('saleUnit', 'err.sale_unit_size');
    const label = String(unit.label ?? '').trim().slice(0, 20) || (config.platform.defaultLocale === 'fa' ? 'بسته' : 'pack');
    return { kind: 'pack', size, label };
  }

  async function groupSlugOf(categoryId) {
    if (!categoryId) return null;
    const category = await getCategory(categoryId).catch(() => null);
    if (!category) return null;
    const group = category.parentId ? await getCategory(category.parentId).catch(() => null) : category;
    return group?.slug || null;
  }

  async function customSaleUnits() {
    const row = await settingsDb.get(SALE_UNITS_ID);
    return { default: row?.default || null, groups: row?.groups || {} };
  }

  /** What a new product in this category is sold by unless the seller says otherwise: the category's custom, else the platform's, else a piece. */
  async function saleUnitFor(categoryId) {
    const mine = await customSaleUnits();
    const slug = await groupSlugOf(categoryId);
    return (slug && mine.groups[slug]) || mine.default || { ...PIECE };
  }

  /** Every category group with the unit it uses and whether the admin chose it, for the admin editor. */
  async function listSaleUnits({ locale = 'fa' } = {}) {
    const mine = await customSaleUnits();
    const fallback = mine.default || { ...PIECE };
    const groups = await listCategories({ parentId: null, locale });
    return {
      default: { saleUnit: fallback, custom: Boolean(mine.default) },
      groups: groups.map((g) => ({ slug: g.slug, name: g.name, saleUnit: mine.groups[g.slug] || fallback, custom: Boolean(mine.groups[g.slug]) })),
    };
  }

  /** `{ default?: unit, groups?: { [slug]: unit | null } }`; null puts a category back to the platform's. */
  async function setSaleUnits(patch = {}) {
    const mine = await customSaleUnits();
    if (patch.default !== undefined) mine.default = patch.default && patch.default.kind === 'pack' ? normalizeSaleUnit(patch.default) : null;
    if (patch.groups) {
      const known = new Set((await listCategories({ parentId: null })).map((g) => g.slug));
      for (const [slug, unit] of Object.entries(patch.groups)) {
        if (!known.has(slug)) throw new NotFoundError('Category', slug);
        if (unit === null || unit === undefined) delete mine.groups[slug];
        else mine.groups[slug] = normalizeSaleUnit(unit);
      }
    }
    await settingsDb.upsert(SALE_UNITS_ID, { default: mine.default, groups: mine.groups });
    return listSaleUnits();
  }

  /** With options, the product's stock is theirs; without any, the seller's own number stands. */
  function applyVariants(data) {
    if (data.variants === undefined) return;
    data.variants = normalizeVariants(data.variants);
    if (!data.variants.length) return;
    data.stock = stockOf(data.variants);
    if (data.stock === 0 && data.status === 'active') data.status = 'out_of_stock';
  }

  /** What a chosen video means for the product: our own file and its still frame, or none. */
  async function videoFields(url) {
    if (!url) return { videoUrl: '', videoPoster: '' };
    const video = await services.videos.resolveUrl(url);
    return { videoUrl: video.url, videoPoster: video.poster || '' };
  }

  async function createProduct(storeId, input, { actorAccountId, skipChannelSync = false } = {}) {
    if (actorAccountId) await services.stores.assertCan(storeId, actorAccountId, 'products.manage');
    const parent = await services.stores.resolve(storeId);
    // Billed to whoever owns the shop, not whoever clicked the button — a
    // staff member's product still counts against the owner's plan, the same
    // as the shop's other resources.
    const data = validate(input, productSchema);
    applyVariants(data);
    if (data.saleUnit !== undefined) data.saleUnit = normalizeSaleUnit(data.saleUnit);
    // Wholesale (private) pricing is a plan feature; checked before the quota is spent.
    if (data.priceVisibility === 'private') await services.subscriptions.requireFeature(parent.ownerAccountId, 'privatePricing');
    await services.subscriptions.consume(parent.ownerAccountId, 'products');

    let categoryTerms = [];
    if (data.categoryId) {
      const category = await requireUsableCategory(data.categoryId);
      data.categoryId = category.id;
      categoryTerms = await namesFor(category);
    }
    // A price is required unless the product is explicitly "price on request" —
    // a real number here is what makes checkout math possible at all. `price`
    // reads as undefined when the caller omits it and null when they say so
    // explicitly; either way, nothing to check against. `private` still has a
    // real price — it is just hidden until access is granted — so it needs
    // one exactly like `public` does.
    if (['public', 'private'].includes(data.priceVisibility || 'public') && data.price == null) {
      throw ValidationError.of('price', 'err.price_required');
    }
    if (data.compareAtPrice && data.price != null && data.compareAtPrice <= data.price) {
      throw ValidationError.of('compareAtPrice', 'err.compare_price');
    }

    const slug = await uniqueSlug(input.slug || data.title, async (c) => Boolean(await products.findOne({ storeId: parent.id, slug: c })));
    if (data.videoUrl) Object.assign(data, await videoFields(data.videoUrl));
    const record = await products.insert({
      id: newId('prd'),
      storeId: parent.id,
      storeSlug: parent.slug,
      storeName: parent.name,
      slug,
      ...data,
      currency: data.currency || parent.currency || config.platform.defaultCurrency,
      searchText: buildSearchText({ ...data, storeName: parent.name }, categoryTerms),
      stats: { views: 0, orders: 0, unitsSold: 0, ratingSum: 0, ratingCount: 0 },
      publishedAt: data.status === 'active' ? new Date().toISOString() : null,
    });

    await filedUnderStore(parent, data.categoryId);
    await services.stores.refreshDiscoverability(parent.id);
    await events.emit('product.created', { storeId: parent.id, productId: record.id, product: record, skipChannelSync });
    return record;
  }

  async function updateProduct(productId, patch, { actorAccountId } = {}) {
    const current = await products.get(productId);
    if (!current) throw new NotFoundError('Product', productId);
    if (actorAccountId) await services.stores.assertCan(current.storeId, actorAccountId, 'products.manage');

    const data = validate(patch, productSchema, { partial: true });
    applyVariants(data);
    if (data.saleUnit !== undefined) data.saleUnit = normalizeSaleUnit(data.saleUnit);
    if (data.priceVisibility === 'private' && current.priceVisibility !== 'private') {
      const owner = await stores.get(current.storeId);
      await services.subscriptions.requireFeature(owner.ownerAccountId, 'privatePricing');
    }
    if (patch.slug && patch.slug !== current.slug) {
      const taken = await products.findOne({ storeId: current.storeId, slug: slugify(patch.slug) });
      if (taken) throw new ConflictError('err.slug_taken_product', { field: 'slug' });
      data.slug = slugify(patch.slug);
    }
    if (data.categoryId) {
      const category = await requireUsableCategory(data.categoryId);
      data.categoryId = category.id;
    }

    const next = { ...current, ...data };
    if (['public', 'private'].includes(next.priceVisibility || 'public') && next.price == null) {
      throw ValidationError.of('price', 'err.price_required');
    }
    if (next.compareAtPrice && next.price != null && next.compareAtPrice <= next.price) {
      throw ValidationError.of('compareAtPrice', 'err.compare_price');
    }
    data.searchText = buildSearchText(next, await namesFor(await getCategory(next.categoryId)));
    if (data.status === 'active' && !current.publishedAt) data.publishedAt = new Date().toISOString();

    // (an empty string means "take the video off" - read from the patch, where it still is)
    if (patch.videoUrl !== undefined && (patch.videoUrl || '') !== (current.videoUrl || '')) {
      Object.assign(data, await videoFields(patch.videoUrl));
      if (patch.telegramVideoId === undefined) data.telegramVideoId = '';
    }

    // `telegramFileIds` is indexed like `images`. When the album is edited, keep the file ids of the photos that stayed
    // (so Telegram can resend them cheaply); if any photo is new, fall back to plain links for the whole post.
    if (Array.isArray(data.images)) {
      const known = new Map((current.images || []).map((src, i) => [src, current.telegramFileIds?.[i] || null]));
      const ids = data.images.map((src) => known.get(src) || null);
      data.telegramFileIds = ids.every(Boolean) ? ids : [];
    }
    const updated = await products.update(productId, data);
    if (data.categoryId) await filedUnderStore(await stores.get(current.storeId), data.categoryId);
    await services.stores.refreshDiscoverability(current.storeId);
    await events.emit('product.updated', { storeId: current.storeId, productId, product: updated, changed: Object.keys(data) });
    return updated;
  }

  async function setProductStatus(productId, status, { actorAccountId } = {}) {
    if (!PRODUCT_STATUS.includes(status)) throw new ValidationError({ status: `Status must be one of: ${PRODUCT_STATUS.join(', ')}` });
    return updateProduct(productId, { status }, { actorAccountId });
  }

  /**
   * A percentage off, expressed the way every surface already renders one: the
   * old price kept in `compareAtPrice` (struck through), the new one in
   * `price`. Always computed from the undiscounted price, so applying 20% and
   * then 30% gives 30% off the original, not 30% off the 20%-off price.
   */
  async function applyDiscount(productId, percent, { actorAccountId } = {}) {
    const value = Number(percent);
    if (!Number.isFinite(value) || value <= 0 || value >= 100) throw ValidationError.of('percent', 'err.discount_range');
    const current = await products.get(productId);
    if (!current) throw new NotFoundError('Product', productId);
    if (current.price == null) throw ValidationError.of('price', 'err.price_required');

    const original = current.compareAtPrice > current.price ? current.compareAtPrice : current.price;
    const price = Math.round(original * (1 - value / 100));
    if (price >= original) throw ValidationError.of('percent', 'err.discount_range');
    return updateProduct(productId, { price, compareAtPrice: original }, { actorAccountId });
  }

  /** Back to the undiscounted price. A product with no discount is returned as-is. */
  async function clearDiscount(productId, { actorAccountId } = {}) {
    const current = await products.get(productId);
    if (!current) throw new NotFoundError('Product', productId);
    if (!(current.compareAtPrice > current.price)) return current;
    return updateProduct(productId, { price: current.compareAtPrice, compareAtPrice: 0 }, { actorAccountId });
  }

  /**
   * One offer across the shop: every live product that has a price, or just
   * `productIds`. A percent of 0 ends the offer. Returns how many changed.
   */
  async function discountStore(storeId, percent, { actorAccountId, productIds = null } = {}) {
    const record = await services.stores.resolve(storeId);
    if (actorAccountId) await services.stores.assertCan(record.id, actorAccountId, 'products.manage');
    const only = Array.isArray(productIds) ? new Set(productIds) : null;
    const { items } = await listProducts({ storeId: record.id, status: ['active', 'out_of_stock'], limit: 500 });
    let updated = 0;
    for (const product of items) {
      if ((only && !only.has(product.id)) || product.price == null) continue;
      if (Number(percent) > 0) await applyDiscount(product.id, percent, { actorAccountId });
      else await clearDiscount(product.id, { actorAccountId });
      updated += 1;
    }
    return { updated };
  }

  async function deleteProduct(productId, { actorAccountId } = {}) {
    const current = await products.get(productId);
    if (!current) throw new NotFoundError('Product', productId);
    if (actorAccountId) await services.stores.assertCan(current.storeId, actorAccountId, 'products.manage');
    // A product nobody ever ordered is removed for good, with what hung on it. One that appears on an order is
    // archived instead: the order keeps pointing at that row.
    const ordered = (await db.collection(COLLECTIONS.orders).find({ where: { storeId: current.storeId } }))
      .some((order) => (order.items || []).some((item) => item.productId === productId));
    if (!ordered) {
      for (const name of [COLLECTIONS.savedItems, COLLECTIONS.comments, COLLECTIONS.reviews, COLLECTIONS.priceRequests]) {
        await db.collection(name).deleteWhere({ productId });
      }
      const carts = db.collection(COLLECTIONS.carts);
      for (const cart of await carts.find({})) {
        if ((cart.items || []).some((item) => item.productId === productId)) await carts.update(cart.id, { items: cart.items.filter((item) => item.productId !== productId) });
      }
      await products.delete(productId);
      await services.stores.refreshDiscoverability(current.storeId);
      await events.emit('product.deleted', { storeId: current.storeId, productId, channelLink: current.channelLink || null });
      return { ...current, deleted: true };
    }
    const archived = await products.update(productId, { status: 'archived' });
    await services.stores.refreshDiscoverability(current.storeId);
    await events.emit('product.archived', { storeId: current.storeId, productId, channelLink: current.channelLink || null });
    return archived;
  }

  /**
   * Files existing products under the category their own words name. Only products with NO category, a retired one, or
   * the import fallback ("tunic") are moved - what a seller chose on purpose is left alone - and only when the title,
   * tags or properties actually name a garment. Dry run unless `apply`.
   */
  async function recategorize({ apply = false, storeId = null, limit = 5000, assignments = null } = {}) {
    const rows = flattenTaxonomy().filter((row) => row.parentSlug);
    const guess = buildCategoryGuesser(rows.map((row) => ({ slug: row.slug, nameFa: row.fa })));
    const all = await categories.find({});
    const bySlug = new Map(all.map((c) => [c.slug, c]));
    const byId = new Map(all.map((c) => [c.id, c]));
    const list = await products.find({ where: storeId ? { storeId } : {}, limit });

    const result = { total: list.length, changed: 0, unchanged: 0, noClue: 0, byCategory: {}, samples: [], applied: Boolean(apply) };
    // a decision someone already made (a person looked at the photo): taken as given, whatever the product has now
    const decided = new Map((assignments || []).map((x) => [x.productId, x.slug]));
    for (const product of list) {
      const current = byId.get(product.categoryId);
      const replaceable = !current || current.retired || current.slug === 'tunic' || decided.has(product.id);
      if (!replaceable) { result.unchanged += 1; continue; }
      const slug = decided.get(product.id) || guess(product);
      if (!slug) { result.noClue += 1; continue; }
      if (slug === current?.slug) { result.unchanged += 1; continue; }
      const target = bySlug.get(slug);
      if (!target) continue;
      result.changed += 1;
      result.byCategory[slug] = (result.byCategory[slug] || 0) + 1;
      if (result.samples.length < 12) result.samples.push({ title: product.title, from: current?.slug || null, to: slug });
      if (apply) await updateProduct(product.id, { categoryId: target.id });
    }
    return result;
  }

  async function getProduct(idOrSlug, { storeId } = {}) {
    if (!idOrSlug) return null;
    const byId = await products.get(idOrSlug);
    if (byId) return byId;
    const where = storeId ? { storeId, slug: String(idOrSlug).toLowerCase() } : { slug: String(idOrSlug).toLowerCase() };
    return products.findOne(where);
  }

  async function getProductOrFail(idOrSlug, opts) {
    const found = await getProduct(idOrSlug, opts);
    if (!found) throw new NotFoundError('Product', idOrSlug);
    return found;
  }

  async function listProducts({ storeId, status, categoryId, limit = 20, offset = 0, sort = [['createdAt', 'desc']] } = {}) {
    const where = {};
    if (storeId) where.storeId = storeId;
    if (status) where.status = Array.isArray(status) ? { $in: status } : status;
    if (categoryId) where.categoryId = categoryId;
    const [items, total] = await Promise.all([products.find({ where, limit, offset, sort }), products.count(where)]);
    return { items, total };
  }

  /**
   * Stock is decremented at order creation and restored on cancellation.
   * `stock: null` means "untracked" — a service or made-to-order item.
   */
  /** `variantId`: the change is to that option's stock, and the product's total follows. */
  async function adjustStock(productId, delta, { reason = 'manual', variantId = null } = {}) {
    const updated = await products.mutate(productId, (draft) => {
      const option = variantId ? (draft.variants || []).find((v) => v.id === variantId) : null;
      if (option) {
        if (option.stock !== null && option.stock !== undefined) option.stock = Math.max(0, option.stock + delta);
        draft.stock = stockOf(draft.variants);
      } else {
        if (draft.stock === null || draft.stock === undefined) return draft;
        draft.stock = Math.max(0, draft.stock + delta);
      }
      if (draft.stock === null || draft.stock === undefined) return draft;
      if (draft.stock === 0 && draft.status === 'active') draft.status = 'out_of_stock';
      if (draft.stock > 0 && draft.status === 'out_of_stock') draft.status = 'active';
      return draft;
    });
    if (!updated) throw new NotFoundError('Product', productId);
    await events.emit('product.stock_changed', { productId, storeId: updated.storeId, stock: updated.stock, delta, reason, variantId });
    return updated;
  }

  async function bumpProductStats(productId, patch) {
    return products.mutate(productId, (draft) => {
      draft.stats = draft.stats || {};
      for (const [key, delta] of Object.entries(patch)) draft.stats[key] = (draft.stats[key] || 0) + delta;
      return draft;
    });
  }

  /** Keeps denormalised store fields on products in step after a store rename. */
  async function syncStoreDenormalisation(storeId) {
    const parent = await stores.get(storeId);
    if (!parent) return 0;
    const rows = await products.find({ where: { storeId } });
    for (const row of rows) {
      await products.update(row.id, {
        storeName: parent.name,
        storeSlug: parent.slug,
        searchText: buildSearchText({ ...row, storeName: parent.name }),
      });
    }
    return rows.length;
  }

  /** The category's name in the shop's language, for the AI to know what kind of thing it is writing about. */
  async function categoryNameFor(categoryId, locale) {
    const category = categoryId ? await getCategory(categoryId) : null;
    return category ? localizeCategory(category, locale)?.name || category.name : '';
  }

  /**
   * AI/SEO rewrite of a title and description plus the page metadata. With `apply: false` it only returns the
   * suggestion (the editor shows it before anything is saved); with `apply: true` it is written to the product,
   * and the seller's original words are kept so they can be put back.
   */
  async function optimizeProduct(productId, { actorAccountId, apply = true } = {}) {
    const product = await products.get(productId);
    if (!product) throw new NotFoundError('Product', productId);
    if (actorAccountId) await services.stores.assertCan(product.storeId, actorAccountId, 'products.manage');
    const store = await stores.get(product.storeId);
    const result = await services.ai.optimizeListing({ product, store, categoryName: await categoryNameFor(product.categoryId, store?.locale), locale: store?.locale });
    if (!apply) return { result, product };
    const updated = await updateProduct(productId, {
      title: result.title,
      description: result.description,
      seo: { ...result.seo, optimizedAt: new Date().toISOString(), provider: result.provider, original: product.seo?.original || { title: product.title, description: product.description || '' } },
    }, { actorAccountId });
    return { result, product: updated };
  }

  /** The same suggestion for something not saved yet (the "new product" form). */
  async function previewOptimization(storeId, input, { actorAccountId } = {}) {
    if (actorAccountId) await services.stores.assertCan(storeId, actorAccountId, 'products.manage');
    const store = await services.stores.resolve(storeId);
    const draft = { title: String(input.title || '').trim(), description: String(input.description || ''), price: input.price ?? null, currency: store.currency, images: input.images || [], properties: input.properties || [], tags: input.tags || [] };
    if (draft.title.length < 2) throw ValidationError.of('title', 'validation.required', { field: 'Title' });
    return services.ai.optimizeListing({ product: draft, store, categoryName: await categoryNameFor(input.categoryId, store.locale), locale: store.locale });
  }

  /** Back to exactly what the seller wrote. */
  async function revertOptimization(productId, { actorAccountId } = {}) {
    const product = await products.get(productId);
    if (!product) throw new NotFoundError('Product', productId);
    const original = product.seo?.original;
    if (!original) throw new ConflictError('err.nothing_to_revert');
    return updateProduct(productId, { title: original.title, description: original.description, seo: { ...product.seo, original: undefined, optimizedAt: undefined, provider: undefined } }, { actorAccountId });
  }

  return {
    saleUnitFor,
    listSaleUnits,
    setSaleUnits,
    optimizeProduct,
    previewOptimization,
    revertOptimization,
    syncTaxonomy,
    listCategories,
    descendantIds,
    getCategory,
    createCategory,
    updateCategory,
    deleteCategory,
    createProduct,
    updateProduct,
    setProductStatus,
    applyDiscount,
    clearDiscount,
    discountStore,
    deleteProduct,
    recategorize,
    getProduct,
    getProductOrFail,
    listProducts,
    adjustStock,
    bumpProductStats,
    syncStoreDenormalisation,
    localizeCategory,
  };
}

function groupByParent(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.parentId ?? null;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function subtreeIds(id, childrenOf) {
  return [id, ...(childrenOf.get(id) || []).flatMap((child) => subtreeIds(child.id, childrenOf))];
}

function buildSearchText(product, extraTerms = []) {
  // Properties (material, size, colour) are what buyers actually search for.
  const properties = (product.properties || []).flatMap((entry) => [entry.name, entry.value]);
  return normalizeText([product.title, product.description, product.storeName, product.sku, ...(product.tags || []), ...properties, ...extraTerms]
    .filter(Boolean)
    .join(' '))
    .slice(0, 2000);
}
