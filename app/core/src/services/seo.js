import { COLLECTIONS } from '../models/schemas.js';
import { NotFoundError } from '../errors.js';

/**
 * What a search engine reads, built once here: the <head> (title, description, canonical, Open Graph, JSON-LD) and a
 * plain, readable body for a page. The website is a single-page app, so a crawler that does not run scripts - and the
 * preview a chat app builds from a pasted link - would otherwise see an empty page. The web server asks for
 * `render(path)` and puts the result into the page it serves; the browser's own app then takes over.
 *
 * Schema.org follows Google's merchant guidance: a Product carries name, images, an Offer with price, currency and
 * availability, plus brand, sku, rating and review only when they are real (never invented), shipping details from
 * the shop's own settings, and the specifications as property values.
 */
export function createSeoService(ctx) {
  const { store: db, config, services } = ctx;
  const stores = db.collection(COLLECTIONS.stores);
  const products = db.collection(COLLECTIONS.products);

  const web = () => config.platform.webBaseUrl.replace(/\/$/, '');
  const abs = (src) => (src ? new URL(src, `${web()}/`).href : undefined);
  const esc = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const plain = (text) => String(text || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[•*#>]/g, ' ').replace(/\s+/g, ' ').trim();
  const clip = (text, max) => {
    const t = plain(text);
    if (t.length <= max) return t;
    const cut = t.slice(0, max - 1);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max * 0.6))}…`;
  };
  const fa = (n) => Number(n).toLocaleString('fa-IR');

  /** schema.org wants ISO currencies; the Toman is a tenth of a rial. */
  function schemaPrice(minor, currency) {
    const code = String(currency || 'IRT').toUpperCase();
    if (code === 'IRT') return { price: Number(minor) * 10, currency: 'IRR' };
    const zero = ['IRR', 'JPY', 'KRW', 'VND', 'CLP', 'UGX'].includes(code);
    return { price: zero ? Number(minor) : Number(minor) / 100, currency: code };
  }

  const ratingOf = (stats) => (stats?.ratingCount ? Math.round((stats.ratingSum / stats.ratingCount) * 10) / 10 : null);

  const breadcrumbs = (items) => ({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: item.name, item: abs(item.path) })),
  });

  /** What delivery costs and how soon it leaves, from the shop's own settings - nothing is assumed. */
  function shippingDetails(store) {
    const s = store.settings || {};
    if (!(s.fulfillmentMethods || []).some((m) => ['delivery', 'courier', 'post'].includes(m)) && s.deliveryFee == null) return undefined;
    // Shipping the buyer pays to the carrier has no price the shop knows: claiming "free" would be false, so say nothing.
    if (s.shippingPayer !== 'seller' && !(s.deliveryFee > 0)) return undefined;
    const currency = store.currency || config.platform.defaultCurrency;
    const fee = schemaPrice(s.deliveryFee || 0, currency);
    return {
      '@type': 'OfferShippingDetails',
      shippingRate: { '@type': 'MonetaryAmount', value: fee.price, currency: fee.currency },
      shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'IR' },
      ...(s.prepTimeMinutes ? { deliveryTime: { '@type': 'ShippingDeliveryTime', handlingTime: { '@type': 'QuantitativeValue', minValue: 0, maxValue: Math.max(1, Math.ceil(s.prepTimeMinutes / 1440)), unitCode: 'DAY' } } } : {}),
    };
  }

  /** Real buyers' reviews of a delivered order (never a seller's, never a question). */
  async function buyerReviews(productId, limit = 5) {
    const reviews = db.collection(COLLECTIONS.reviews);
    const rows = await reviews.find({ where: (row) => row.productIds?.includes(productId) && row.rating, sort: [['createdAt', 'desc']], limit });
    return Promise.all(rows.map(async (row) => {
      const author = await db.collection(COLLECTIONS.accounts).get(row.accountId);
      return { '@type': 'Review', reviewRating: { '@type': 'Rating', ratingValue: row.rating, bestRating: 5, worstRating: 1 }, author: { '@type': 'Person', name: author?.displayName || 'خریدار' }, datePublished: String(row.createdAt || '').slice(0, 10) || undefined, ...(row.comment ? { reviewBody: String(row.comment).slice(0, 600) } : {}) };
    }));
  }

  async function productSchema(product, store) {
    const path = `/s/${store.slug}/p/${product.slug}`;
    const images = (product.images || []).filter(Boolean).map(abs);
    const visible = (product.priceVisibility || 'public') === 'public' && product.price != null;
    const offer = visible ? schemaPrice(product.price, product.currency || store.currency) : null;
    const rating = ratingOf(product.stats);
    const reviews = rating ? await buyerReviews(product.id) : [];
    const inStock = product.stock === null || product.stock === undefined ? true : product.stock > 0;
    const shipping = shippingDetails(store);
    return {
      '@context': 'https://schema.org',
      '@type': 'Product',
      '@id': `${abs(path)}#product`,
      name: product.title,
      description: clip(product.description, 5000) || `${product.title} در فروشگاه ${store.name}`,
      ...(images.length ? { image: images } : {}),
      sku: product.sku || product.id,
      url: abs(path),
      brand: { '@type': 'Brand', name: store.name },
      ...(product.seo?.keywords?.length ? { keywords: product.seo.keywords.join(', ') } : {}),
      ...((product.properties || []).length ? { additionalProperty: product.properties.slice(0, 20).map((p) => ({ '@type': 'PropertyValue', name: p.name || p.label || p.key, value: String(p.value ?? '') })).filter((p) => p.name && p.value) } : {}),
      ...(rating ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: rating, reviewCount: product.stats.ratingCount, bestRating: 5, worstRating: 1 } } : {}),
      ...(reviews.length ? { review: reviews } : {}),
      ...(offer ? {
        offers: {
          '@type': 'Offer',
          url: abs(path),
          price: offer.price,
          priceCurrency: offer.currency,
          availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
          itemCondition: 'https://schema.org/NewCondition',
          seller: { '@type': 'Organization', name: store.name, url: abs(`/s/${store.slug}`) },
          ...(shipping ? { shippingDetails: shipping } : {}),
        },
      } : {}),
    };
  }

  function storeSchema(store, items) {
    const path = `/s/${store.slug}`;
    const sameAs = [store.contact?.instagram ? `https://instagram.com/${String(store.contact.instagram).replace(/^@/, '')}` : null, store.channels?.telegram?.username ? `https://t.me/${store.channels.telegram.username}` : null].filter(Boolean);
    const rating = ratingOf(store.stats);
    return {
      '@context': 'https://schema.org',
      '@type': 'Store',
      '@id': `${abs(path)}#store`,
      name: store.name,
      description: clip(store.description || store.tagline, 300) || `${store.name} — فروشگاه آنلاین`,
      url: abs(path),
      ...(store.logoUrl ? { image: abs(store.logoUrl), logo: abs(store.logoUrl) } : {}),
      ...(store.location?.city ? { address: { '@type': 'PostalAddress', addressLocality: store.location.city, addressCountry: 'IR' } } : {}),
      ...(store.location?.lat && store.location?.lng ? { geo: { '@type': 'GeoCoordinates', latitude: store.location.lat, longitude: store.location.lng } } : {}),
      ...(sameAs.length ? { sameAs } : {}),
      ...(rating ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: rating, reviewCount: store.stats.ratingCount, bestRating: 5, worstRating: 1 } } : {}),
      ...(items.length ? { hasOfferCatalog: { '@type': 'OfferCatalog', name: store.name, itemListElement: items.slice(0, 12).map((p) => ({ '@type': 'Offer', itemOffered: { '@type': 'Product', name: p.title, url: abs(`${path}/p/${p.slug}`), ...(p.images?.[0] ? { image: abs(p.images[0]) } : {}) } })) } } : {}),
    };
  }

  const siteSchema = (site) => [
    { '@context': 'https://schema.org', '@type': 'Organization', '@id': `${web()}/#org`, name: site.name, url: `${web()}/`, logo: abs('/favicon.svg'), sameAs: Object.values(site.social || {}).filter((u) => /^https?:\/\//.test(u || '')) },
    { '@context': 'https://schema.org', '@type': 'WebSite', '@id': `${web()}/#site`, name: site.name, url: `${web()}/`, inLanguage: 'fa-IR', potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${web()}/search?q={search_term_string}` }, 'query-input': 'required name=search_term_string' } },
  ];

  const liveStores = () => stores.find({ where: { status: 'active', discoverable: true } });
  const productLink = (store, p) => `<li><a href="${esc(`/s/${store.slug}/p/${p.slug}`)}">${p.images?.[0] ? `<img src="${esc(abs(p.images[0]))}" alt="${esc(p.seo?.imageAlt || p.title)}" width="160" height="160" loading="lazy">` : ''}<span>${esc(p.title)}</span></a></li>`;

  /** Tags, canonical and structured data for one page, as an HTML string for <head>. */
  function headHtml({ title, description, image, path, type = 'website', jsonLd = [], noindex = false }) {
    const site = 'کیوباز';
    const long = `${title} | ${site} | بازار عمده‌فروشی`;
    const full = title.includes(site) ? title : (long.length <= 62 ? long : `${title} | ${site}`);
    const url = abs(path);
    const tags = [
      `<title data-ssr>${esc(full)}</title>`,
      description ? `<meta data-ssr name="description" content="${esc(description)}">` : '',
      noindex ? '<meta data-ssr name="robots" content="noindex, nofollow">' : '<meta data-ssr name="robots" content="index, follow, max-image-preview:large">',
      `<link data-ssr rel="canonical" href="${esc(url)}">`,
      `<link data-ssr rel="alternate" hreflang="fa" href="${esc(url)}">`,
      `<link data-ssr rel="alternate" hreflang="x-default" href="${esc(url)}">`,
      `<meta data-ssr property="og:title" content="${esc(full)}">`,
      description ? `<meta data-ssr property="og:description" content="${esc(description)}">` : '',
      `<meta data-ssr property="og:type" content="${type}">`,
      `<meta data-ssr property="og:url" content="${esc(url)}">`,
      `<meta data-ssr property="og:site_name" content="${site}">`,
      '<meta data-ssr property="og:locale" content="fa_IR">',
      image ? `<meta data-ssr property="og:image" content="${esc(abs(image))}">` : '',
      `<meta data-ssr name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
      ...(Array.isArray(jsonLd) ? jsonLd : [jsonLd]).map((ld) => `<script data-ssr type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`),
    ];
    return tags.filter(Boolean).join('\n    ');
  }

  async function renderProduct(storeSlug, productSlug) {
    const store = await services.stores.resolve(storeSlug);
    if (store.status !== 'active') throw new NotFoundError('Store', storeSlug);
    const product = await services.catalog.getProductOrFail(productSlug, { storeId: store.id });
    if (product.status === 'draft' || product.status === 'archived') throw new NotFoundError('Product', productSlug);
    const path = `/s/${store.slug}/p/${product.slug}`;
    const description = product.seo?.metaDescription || clip(product.description, 155) || `${product.title} در فروشگاه ${store.name}`;
    const images = (product.images || []).filter(Boolean);
    const related = (await products.find({ where: { status: 'active', storeId: store.id, id: { $ne: product.id } }, limit: 8, sort: [['stats.orders', 'desc']] }));
    const visible = (product.priceVisibility || 'public') === 'public' && product.price != null;
    const money = visible ? await priceText(product.price, product.currency || store.currency) : null;
    const jsonLd = [await productSchema(product, store), breadcrumbs([{ name: 'کیوباز', path: '/' }, { name: store.name, path: `/s/${store.slug}` }, { name: product.title, path }])];
    const body = `<main class="seo-static">
<nav aria-label="مسیر"><a href="/">کیوباز</a> › <a href="/s/${esc(store.slug)}">${esc(store.name)}</a> › <span>${esc(product.title)}</span></nav>
<article>
<h1>${esc(product.title)}</h1>
${images.map((src, i) => `<img src="${esc(abs(src))}" alt="${esc(i === 0 && product.seo?.imageAlt ? product.seo.imageAlt : `${product.title} — تصویر ${fa(i + 1)}`)}" width="640" height="640"${i ? ' loading="lazy"' : ''}>`).join('\n')}
${money ? `<p><strong>${esc(money)}</strong></p>` : '<p>قیمت: با درخواست از فروشنده</p>'}
<p>فروشنده: <a href="/s/${esc(store.slug)}">${esc(store.name)}</a>${store.location?.city ? ` — ${esc(store.location.city)}` : ''}</p>
${String(product.description || '').split(/\n{2,}/).filter(Boolean).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n')}
${(product.properties || []).length ? `<h2>مشخصات</h2><dl>${product.properties.map((p) => `<dt>${esc(p.name || p.label || p.key)}</dt><dd>${esc(p.value)}</dd>`).join('')}</dl>` : ''}
</article>
${related.length ? `<section><h2>محصولات دیگر ${esc(store.name)}</h2><ul>${related.map((p) => productLink(store, p)).join('')}</ul></section>` : ''}
</main>`;
    return { status: 200, head: headHtml({ title: product.seo?.metaTitle || `${product.title} | ${store.name} | کیوباز`, description, image: images[0], path, type: 'product', jsonLd }), body };
  }

  async function priceText(minor, currency) {
    const { formatMoney } = await import('../util/money.js');
    return formatMoney(minor, currency || config.platform.defaultCurrency, config.platform.defaultLocale);
  }

  async function renderStore(slug) {
    const store = await services.stores.resolve(slug);
    if (store.status !== 'active') throw new NotFoundError('Store', slug);
    const items = await products.find({ where: { storeId: store.id, status: 'active' }, sort: [['createdAt', 'desc']], limit: 48 });
    const path = `/s/${store.slug}`;
    const description = clip(store.description || store.tagline, 155) || `${store.name} — فروشگاه آنلاین${store.location?.city ? ` در ${store.location.city}` : ''}`;
    const jsonLd = [storeSchema(store, items), breadcrumbs([{ name: 'کیوباز', path: '/' }, { name: store.name, path }])];
    const body = `<main class="seo-static">
<nav aria-label="مسیر"><a href="/">کیوباز</a> › <span>${esc(store.name)}</span></nav>
<h1>${esc(store.name)}${store.location?.city ? ` — فروشگاه آنلاین در ${esc(store.location.city)}` : ''}</h1>
${store.logoUrl ? `<img src="${esc(abs(store.logoUrl))}" alt="لوگوی ${esc(store.name)}" width="120" height="120">` : ''}
${store.tagline ? `<p>${esc(store.tagline)}</p>` : ''}
${store.description ? `<p>${esc(store.description)}</p>` : ''}
<h2>محصولات ${esc(store.name)}</h2>
<ul>${items.map((p) => productLink(store, p)).join('')}</ul>
</main>`;
    return { status: 200, head: headHtml({ title: `${store.name} — فروشگاه عمده‌فروشی${store.location?.city ? ` ${store.location.city}` : ''}`, description, image: store.logoUrl, path, jsonLd }), body };
  }

  async function renderHome() {
    const site = await services.content.site();
    const list = (await liveStores()).slice(0, 24);
    const latest = await products.find({ where: { status: 'active' }, sort: [['createdAt', 'desc']], limit: 36 });
    const bySlug = new Map(list.map((s) => [s.id, s]));
    const shown = latest.filter((p) => bySlug.has(p.storeId)).slice(0, 24);
    const description = clip(site.about || site.tagline, 155) || 'بازار عمده‌فروشی کیوباز: مستقیم از تولیدی‌ها و عمده‌فروش‌های پوشاک خرید کنید، یا فروشگاه خودتان را همین امروز بسازید.';
    const jsonLd = [...siteSchema(site), { '@context': 'https://schema.org', '@type': 'ItemList', name: 'فروشگاه‌های کیوباز', itemListElement: list.slice(0, 12).map((s, i) => ({ '@type': 'ListItem', position: i + 1, url: abs(`/s/${s.slug}`), name: s.name })) }];
    const body = `<main class="seo-static">
<h1>کیوباز — بازار عمده‌فروشی</h1>
<p>${esc(description)}</p>
<h2>فروشگاه‌ها</h2>
<ul>${list.map((s) => `<li><a href="/s/${esc(s.slug)}">${esc(s.name)}</a>${s.tagline ? ` — ${esc(s.tagline)}` : ''}</li>`).join('')}</ul>
<h2>جدیدترین محصولات</h2>
<ul>${shown.map((p) => productLink(bySlug.get(p.storeId), p)).join('')}</ul>
</main>`;
    return { status: 200, head: headHtml({ title: 'کیوباز | بازار عمده‌فروشی پوشاک و خرید مستقیم از تولیدی‌ها', description, path: '/', jsonLd }), body };
  }

  /** A markup body ("## heading", "- bullet", "1. step") as the same words in plain HTML. */
  function markupHtml(text) {
    const out = [];
    let list = null;
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const inline = (t) => esc(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]]+)\]\((\/[^)\s]*|https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    for (const raw of String(text || '').split('\n')) {
      const line = raw.trim();
      if (!line) { close(); continue; }
      let m;
      if ((m = line.match(/^(#{2,3})\s+(.+)/))) { close(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
      if ((m = line.match(/^[-•]\s+(.+)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
      if ((m = line.match(/^\d+[.)]\s+(.+)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
      close();
      out.push(`<p>${inline(line.replace(/^>\s*/, ''))}</p>`);
    }
    close();
    return out.join('\n');
  }

  async function renderPage(slug) {
    const page = await services.content.getPublished(slug);
    const path = `/p/${page.slug}`;
    const faq = (page.faq || []).filter((f) => f.q && f.a);
    const kind = { tutorial: 'HowTo', faq: 'FAQPage' }[page.kind];
    const steps = page.kind === 'tutorial' ? String(page.body || '').split('\n').map((l) => l.trim().match(/^\d+[.)]\s+(.+)/)?.[1]).filter(Boolean) : [];
    const jsonLd = [
      { '@context': 'https://schema.org', '@type': kind === 'HowTo' && steps.length ? 'HowTo' : 'Article', headline: page.title, name: page.title, description: page.summary || undefined, inLanguage: 'fa-IR', url: abs(path), mainEntityOfPage: abs(path), ...(page.updatedAt ? { dateModified: page.updatedAt } : {}), ...(page.publishedAt ? { datePublished: page.publishedAt } : {}), publisher: { '@type': 'Organization', name: 'کیوباز' }, ...(kind === 'HowTo' && steps.length ? { step: steps.map((text, i) => ({ '@type': 'HowToStep', position: i + 1, text })) } : {}) },
      ...(faq.length ? [{ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) }] : []),
      breadcrumbs([{ name: 'کیوباز', path: '/' }, ...(page.kind === 'tutorial' ? [{ name: 'آموزش‌ها', path: '/learn' }] : []), { name: page.title, path }]),
    ];
    const body = `<main class="seo-static"><article><h1>${esc(page.title)}</h1>${page.summary ? `<p>${esc(page.summary)}</p>` : ''}${markupHtml(page.body)}${faq.length ? `<h2>سوالات متداول</h2>${faq.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join('')}` : ''}</article></main>`;
    return { status: 200, head: headHtml({ title: page.seo?.metaTitle || page.title, description: page.seo?.metaDescription || clip(page.summary || page.body, 155), path, type: 'article', jsonLd }), body };
  }

  async function renderLearn() {
    const items = await services.content.listPublished({ kind: 'tutorial' });
    const body = `<main class="seo-static"><h1>آموزش‌های کیوباز</h1><ul>${items.map((p) => `<li><a href="/p/${esc(p.slug)}">${esc(p.title)}</a>${p.summary ? ` — ${esc(p.summary)}` : ''}</li>`).join('')}</ul></main>`;
    return { status: 200, head: headHtml({ title: 'آموزش ساخت فروشگاه و فروش عمده', description: 'آموزش قدم‌به‌قدم ساخت فروشگاه عمده‌فروشی، افزودن محصول، دریافت پرداخت و فروش از طریق تلگرام و اینستاگرام.', path: '/learn', jsonLd: [breadcrumbs([{ name: 'کیوباز', path: '/' }, { name: 'آموزش‌ها', path: '/learn' }])] }), body };
  }

  const notFound = () => ({ status: 404, head: headHtml({ title: 'صفحه پیدا نشد', description: '', path: '/', noindex: true }), body: '<main class="seo-static"><h1>صفحه پیدا نشد</h1><p><a href="/">بازگشت به کیوباز</a></p></main>' });

  /** The pieces for any public address; `status` is what the web server should answer with (a missing shop is a real 404). */
  async function render(pathname) {
    const path = String(pathname || '/').split('?')[0].replace(/\/+$/, '') || '/';
    try {
      let m;
      if (path === '/') return await renderHome();
      if (path === '/learn') return await renderLearn();
      if ((m = path.match(/^\/s\/([^/]+)\/p\/([^/]+)$/))) return await renderProduct(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      if ((m = path.match(/^\/s\/([^/]+)$/))) return await renderStore(decodeURIComponent(m[1]));
      if ((m = path.match(/^\/p\/([^/]+)$/))) return await renderPage(decodeURIComponent(m[1]));
      return null; // not a page worth prerendering (cart, account, manage…): the app alone answers
    } catch (err) {
      if (err instanceof NotFoundError || err?.status === 404 || err?.code === 'not_found') return notFound();
      throw err;
    }
  }

  return { render, headHtml, productSchema, storeSchema, schemaPrice, markupHtml };
}
