/**
 * Makes every product of one shop show its price, and gives the ones without a price a provisional one:
 * the median of that shop's own priced products. The seller should correct them in the panel.
 *
 *   node --env-file=../.env scripts/public-prices.js --shop aysan-zabihi --dry   list what would change
 *   node --env-file=../.env scripts/public-prices.js --shop aysan-zabihi         change it
 *   --price <toman>   use this price instead of the median
 *
 * Stop the core server first when the database is a JSON file; the server holds it in memory.
 */
const { createCore } = await import('../src/index.js');
const { COLLECTIONS } = await import('../src/models/schemas.js');

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const dry = process.argv.includes('--dry');
const slug = arg('--shop');
if (!slug) { console.error('--shop <slug> is required'); process.exit(1); }

const core = await createCore();
const stores = core.store.collection(COLLECTIONS.stores);
const products = core.store.collection(COLLECTIONS.products);

const shop = (await stores.find({})).find((s) => s.slug === slug);
if (!shop) { console.error(`no shop with slug ${slug}`); await core.close(); process.exit(1); }

const rows = await products.find({ where: { storeId: shop.id } });
const priced = rows.map((p) => p.price).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
const fallback = Number(arg('--price')) || priced[Math.floor(priced.length / 2)];
if (!fallback) { console.error('no priced product to take a median from; pass --price'); await core.close(); process.exit(1); }

let shown = 0;
let given = 0;
for (const p of rows) {
  const patch = {};
  if ((p.priceVisibility || 'public') !== 'public') patch.priceVisibility = 'public';
  if (!(p.price > 0)) patch.price = fallback;
  if (!Object.keys(patch).length) continue;
  if (patch.priceVisibility) shown += 1;
  if (patch.price) given += 1;
  if (!dry) await products.update(p.id, patch);
}
console.log(`${shop.name}: ${rows.length} products; price made public on ${shown}; ${given} given ${fallback}${dry ? ' (dry run, nothing changed)' : ''}`);
await core.close();
