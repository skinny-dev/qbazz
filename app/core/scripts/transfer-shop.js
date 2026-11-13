/**
 * Hands a shop to the person who signs in with a phone number: they become its owner and can manage it (products, orders,
 * QR, settings); the account that owned it before stays on as an ordinary account with no access to it.
 *
 *   node --env-file=../.env scripts/transfer-shop.js aysan-zabihi --to-phone 09118055243
 *
 * The person's account is created when nobody has used the number yet. Their other shops, if any, stay theirs. The JSON
 * database is copied to <file>.bak-<time> first. Stop the core server first.
 */
import fs from 'node:fs';

const [slug, ...rest] = process.argv.slice(2);
const at = rest.indexOf('--to-phone');
const phone = at >= 0 ? rest[at + 1] : null;
if (!slug || !phone) { console.error('usage: transfer-shop.js <slug> --to-phone 0912...'); process.exit(1); }

const { createCore } = await import('../src/index.js');
const { COLLECTIONS } = await import('../src/models/schemas.js');
const core = await createCore();
const { services } = core;

const shop = (await core.store.collection(COLLECTIONS.stores).find({ where: { slug } }))[0];
if (!shop) { console.error(`no shop with the address "${slug}"`); await core.close(); process.exit(1); }

if (core.config.storage.driver === 'json' && fs.existsSync(core.config.storage.file)) {
  const backup = `${core.config.storage.file}.bak-${Date.now()}`;
  fs.copyFileSync(core.config.storage.file, backup);
  console.log(`Backed up the database to ${backup}`);
}

const person = await services.accounts.findOrCreateByPhone(phone);
if (shop.ownerAccountId === person.id) { console.log('That account already owns this shop.'); await core.close(); process.exit(0); }

const memberships = core.store.collection(COLLECTIONS.memberships);
const before = shop.ownerAccountId;
await core.store.collection(COLLECTIONS.stores).update(shop.id, { ownerAccountId: person.id });
await services.stores.addMember(shop.id, person.id, 'owner');
await memberships.deleteWhere({ storeId: shop.id, accountId: before });

const owner = (await memberships.find({ where: { storeId: shop.id, role: 'owner' } })).map((m) => m.accountId);
console.log(`${shop.name}: owner is now ${person.displayName} (${person.phone || phone}); was ${before}. Owners on record: ${owner.length}.`);
await core.close();
