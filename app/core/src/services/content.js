import { COLLECTIONS } from '../models/schemas.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../util/ids.js';
import { DEFAULT_PAGES, DEFAULT_SITE } from './content-defaults.js';

export const PAGE_KINDS = ['page', 'tutorial', 'faq', 'landing', 'legal', 'link'];
export const FOOTER_GROUPS = ['company', 'sellers', 'help', 'legal'];
const SITE_ID = 'site';
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The words around the product: About, FAQ, landing pages, legal pages and step-by-step tutorials - written and
 * linked by the platform's admins, shown on the site and in its footer, and listed for search engines.
 *
 * A page is plain text in a small, safe markup (headings, lists, bold, links) so nothing an editor pastes can run
 * as code. `kind: 'link'` is not a page at all - just a footer entry that points somewhere else.
 */
export function createContentService(ctx) {
  const { store: db, services, events } = ctx;
  const pages = db.collection(COLLECTIONS.pages);
  const settings = db.collection(COLLECTIONS.platformSettings);

  async function assertAdmin(accountId) {
    const account = accountId ? await db.collection(COLLECTIONS.accounts).get(accountId) : null;
    if (account?.role !== 'admin') throw new ForbiddenError('err.admin_required');
    return account;
  }

  const clean = (value, max) => String(value ?? '').trim().slice(0, max);

  function normalize(input, current = null) {
    const data = {};
    if (input.title !== undefined || !current) {
      data.title = clean(input.title, 120);
      if (data.title.length < 2) throw ValidationError.of('title', 'validation.required', { field: 'Title' });
    }
    if (input.slug !== undefined || !current) {
      const slug = clean(input.slug, 80).toLowerCase();
      if (!SLUG.test(slug)) throw ValidationError.of('slug', 'err.slug_format');
      data.slug = slug;
    }
    if (input.kind !== undefined || !current) {
      const kind = input.kind || 'page';
      if (!PAGE_KINDS.includes(kind)) throw ValidationError.of('kind', 'validation.invalid');
      data.kind = kind;
    }
    if (input.summary !== undefined) data.summary = clean(input.summary, 300);
    if (input.body !== undefined) data.body = String(input.body ?? '').replace(/\r\n/g, '\n').slice(0, 40000);
    if (input.icon !== undefined) data.icon = clean(input.icon, 40) || null;
    if (input.category !== undefined) data.category = clean(input.category, 60) || null;
    if (input.order !== undefined) data.order = Math.max(0, Math.min(9999, Number(input.order) || 0));
    if (input.status !== undefined) {
      if (!['draft', 'published'].includes(input.status)) throw ValidationError.of('status', 'validation.invalid');
      data.status = input.status;
    }
    if (input.href !== undefined) {
      const href = clean(input.href, 300);
      if (href && !/^(\/(?!\/)|https?:\/\/|mailto:|tel:)/.test(href)) throw ValidationError.of('href', 'err.link_invalid');
      data.href = href || null;
    }
    if (input.faq !== undefined) {
      data.faq = (Array.isArray(input.faq) ? input.faq : [])
        .map((item) => ({ q: clean(item?.q, 200), a: String(item?.a ?? '').trim().slice(0, 2000) }))
        .filter((item) => item.q && item.a)
        .slice(0, 60);
    }
    if (input.footer !== undefined) {
      const group = input.footer?.group || null;
      if (group && !FOOTER_GROUPS.includes(group)) throw ValidationError.of('footer', 'validation.invalid');
      data.footer = group ? { group, order: Math.max(0, Math.min(9999, Number(input.footer.order) || 0)) } : null;
    }
    if (input.seo !== undefined) {
      data.seo = { metaTitle: clean(input.seo?.metaTitle, 70), metaDescription: clean(input.seo?.metaDescription, 170) };
    }
    if (input.related !== undefined) data.related = (Array.isArray(input.related) ? input.related : []).map((s) => clean(s, 80)).filter(Boolean).slice(0, 8);
    return data;
  }

  const publicView = (row, { full = false } = {}) => ({
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    title: row.title,
    summary: row.summary || '',
    icon: row.icon || null,
    category: row.category || null,
    href: row.kind === 'link' ? row.href : `/p/${row.slug}`,
    updatedAt: row.updatedAt,
    ...(full ? { body: row.body || '', faq: row.faq || [], seo: row.seo || null, related: row.related || [] } : {}),
  });

  // -- Public reads --------------------------------------------------------------------------

  async function listPublished({ kind = null } = {}) {
    const rows = await pages.find({ where: (p) => p.status === 'published' && p.kind !== 'link' && (!kind || p.kind === kind) });
    return rows.sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.title).localeCompare(String(b.title))).map((row) => publicView(row));
  }

  async function getPublished(slug) {
    const row = await pages.findOne((p) => p.slug === slug && p.status === 'published' && p.kind !== 'link');
    if (!row) throw new NotFoundError('Page', slug);
    const related = row.related?.length ? (await Promise.all(row.related.map((s) => pages.findOne((p) => p.slug === s && p.status === 'published')))).filter(Boolean).map((r) => publicView(r)) : [];
    return { ...publicView(row, { full: true }), related };
  }

  /** What the site needs on every page: the footer's link groups and the platform's own contact links. */
  async function site() {
    const stored = (await settings.get(SITE_ID)) || {};
    const config = { ...DEFAULT_SITE, ...stored, social: { ...DEFAULT_SITE.social, ...(stored.social || {}) } };
    const linked = await pages.find({ where: (p) => p.status === 'published' && p.footer?.group });
    const groups = FOOTER_GROUPS.map((id) => ({
      id,
      title: config.footerTitles?.[id] || DEFAULT_SITE.footerTitles[id],
      links: linked
        .filter((p) => p.footer.group === id)
        .sort((a, b) => (a.footer.order || 0) - (b.footer.order || 0))
        .map((p) => ({ title: p.title, href: p.kind === 'link' ? p.href : `/p/${p.slug}`, external: p.kind === 'link' && /^https?:/.test(p.href || '') })),
    })).filter((g) => g.links.length);
    return { name: config.name, tagline: config.tagline, about: config.about, social: config.social, copyright: config.copyright, footer: groups };
  }

  // -- Admin ---------------------------------------------------------------------------------

  async function listAll(actorAccountId) {
    await assertAdmin(actorAccountId);
    const rows = await pages.find({});
    return { items: rows.sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || (a.order || 0) - (b.order || 0)) };
  }

  async function get(actorAccountId, id) {
    await assertAdmin(actorAccountId);
    const row = await pages.get(id);
    if (!row) throw new NotFoundError('Page', id);
    return row;
  }

  async function create(actorAccountId, input) {
    await assertAdmin(actorAccountId);
    const data = normalize(input);
    if (await pages.findOne((p) => p.slug === data.slug)) throw new ConflictError('err.page_slug_taken');
    const status = data.status || 'draft';
    const row = await pages.insert({
      id: newId('pg'), body: '', summary: '', faq: [], order: 0, footer: null, seo: null, related: [], icon: null, category: null, href: null,
      ...data, status, publishedAt: status === 'published' ? new Date().toISOString() : null, createdBy: actorAccountId,
    });
    await events.emit('content.changed', { pageId: row.id, action: 'created', by: actorAccountId });
    return row;
  }

  async function update(actorAccountId, id, input) {
    await assertAdmin(actorAccountId);
    const current = await pages.get(id);
    if (!current) throw new NotFoundError('Page', id);
    const data = normalize(input, current);
    if (data.slug && data.slug !== current.slug && await pages.findOne((p) => p.slug === data.slug && p.id !== id)) throw new ConflictError('err.page_slug_taken');
    if (data.status === 'published' && !current.publishedAt) data.publishedAt = new Date().toISOString();
    const row = await pages.update(id, data);
    await events.emit('content.changed', { pageId: id, action: 'updated', by: actorAccountId });
    return row;
  }

  async function remove(actorAccountId, id) {
    await assertAdmin(actorAccountId);
    if (!(await pages.get(id))) throw new NotFoundError('Page', id);
    await pages.delete(id);
    await events.emit('content.changed', { pageId: id, action: 'deleted', by: actorAccountId });
    return { removed: true };
  }

  async function getSite(actorAccountId) {
    await assertAdmin(actorAccountId);
    const stored = (await settings.get(SITE_ID)) || {};
    return { ...DEFAULT_SITE, ...stored, social: { ...DEFAULT_SITE.social, ...(stored.social || {}) }, footerTitles: { ...DEFAULT_SITE.footerTitles, ...(stored.footerTitles || {}) } };
  }

  async function updateSite(actorAccountId, input) {
    await assertAdmin(actorAccountId);
    const current = await getSite(actorAccountId);
    const social = { ...current.social };
    for (const key of Object.keys(DEFAULT_SITE.social)) if (input.social?.[key] !== undefined) social[key] = clean(input.social[key], 200);
    const footerTitles = { ...current.footerTitles };
    for (const key of FOOTER_GROUPS) if (input.footerTitles?.[key] !== undefined) footerTitles[key] = clean(input.footerTitles[key], 40) || DEFAULT_SITE.footerTitles[key];
    const next = {
      name: clean(input.name ?? current.name, 40) || DEFAULT_SITE.name,
      tagline: clean(input.tagline ?? current.tagline, 120),
      about: clean(input.about ?? current.about, 400),
      copyright: clean(input.copyright ?? current.copyright, 160),
      social,
      footerTitles,
    };
    await settings.upsert(SITE_ID, next);
    return next;
  }

  /** On a fresh install the site already has its About, FAQ, legal pages and first tutorials. */
  async function seedDefaults() {
    if (await pages.count()) return 0;
    for (const [index, page] of DEFAULT_PAGES.entries()) {
      await pages.insert({
        id: newId('pg'), summary: '', body: '', faq: [], footer: null, seo: null, related: [], icon: null, category: null, href: null, order: index,
        ...page, status: 'published', publishedAt: new Date().toISOString(), createdBy: 'system',
      });
    }
    return DEFAULT_PAGES.length;
  }

  /** Every published page, for the sitemap. */
  async function sitemapEntries() {
    const rows = await pages.find({ where: (p) => p.status === 'published' && p.kind !== 'link' });
    return rows.map((row) => ({ path: `/p/${row.slug}`, updatedAt: row.updatedAt }));
  }

  return { listPublished, getPublished, site, listAll, get, create, update, remove, getSite, updateSite, seedDefaults, sitemapEntries };
}
