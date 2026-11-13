/**
 * Sets a shop's public phone number and/or logo straight in the database - for a shop whose owner sent them over.
 *
 *   node --env-file=../.env scripts/set-shop-profile.js aysan-zabihi --phone 09118055243 --logo scripts/seed-logos/aysan-zabihi.png
 *
 * Stop the core server first when the database is a JSON file; the server holds it in memory.
 */
import fs from 'node:fs';
import path from 'node:path';

const [slug, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : null; };
const phone = opt('phone');
const logo = opt('logo');
if (!slug || (!phone && !logo)) { console.error('usage: set-shop-profile.js <slug> [--phone 0912...] [--logo file.png]'); process.exit(1); }
if (logo && !fs.existsSync(logo)) { console.error(`logo file not found: ${logo}`); process.exit(1); }

const { createCore } = await import('../src/index.js');
const { COLLECTIONS } = await import('../src/models/schemas.js');
const core = await createCore();
const { services } = core;

const shop = (await core.store.collection(COLLECTIONS.stores).find({ where: { slug } }))[0];
if (!shop) { console.error(`no shop with the address "${slug}"`); await core.close(); process.exit(1); }

const patch = {};
if (phone) patch.contact = { ...(shop.contact || {}), phone };
if (logo) patch.logoUrl = (await services.uploads.saveImage(shop.ownerAccountId, fs.readFileSync(logo).toString('base64'))).url;
const updated = await services.stores.update(shop.id, patch);
console.log(`${updated.name}: ${phone ? `phone ${updated.contact.phone}` : ''}${phone && logo ? ', ' : ''}${logo ? `logo ${path.basename(logo)} -> ${updated.logoUrl}` : ''}`);
await core.close();
