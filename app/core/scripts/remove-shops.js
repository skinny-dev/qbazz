/**
 * Removes every shop except the ones that belong to a phone number - for taking test and demo shops off a real site.
 *
 *   node --env-file=../.env scripts/remove-shops.js --keep-phone 09118055243          list what would go (changes nothing)
 *   node --env-file=../.env scripts/remove-shops.js --keep-phone 09118055243 --yes    do it
 *   node --env-file=../.env scripts/remove-shops.js --keep-name سروین --keep-name آیسان [--keep-phone ...] [--yes]
 *       --keep-name keeps a shop whose name contains the text (spaces, half-spaces and ي/ی differences ignored); both options repeat
 *
 * A shop is kept when its public phone is that number, or when its owner or a team member signs in with it. Everything
 * that belongs to a removed shop goes with it: products, orders, carts, reviews, comments, channel data, prompts. A
 * person's account goes only when it is a bare demo owner (no phone, no email, not staff) left with no shop; buyers and
 * staff stay. The JSON database is copied to <file>.bak-<time> first. Stop the core server first.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const all = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
const keepPhones = all('--keep-phone');
const squash = (t) => String(t || '').replace(/[‌\s]/g, '').replace(/ي/g, 'ی').replace(/ك/g, 'ک').toLowerCase();
const keepNames = all('--keep-name').map(squash);
const apply = args.includes('--yes');
if (!keepPhones.length && !keepNames.length) { console.error('usage: remove-shops.js [--keep-phone 09118055243] [--keep-name سروین] [--yes]'); process.exit(1); }

const { createCore } = await import('../src/index.js');
const { COLLECTIONS } = await import('../src/models/schemas.js');
const { phoneVariants } = await import('../src/util/phone.js');

const core = await createCore();
const db = core.store;
const variants = new Set(keepPhones.flatMap((p) => phoneVariants(p)));
const isKept = (phone) => Boolean(phone) && phoneVariants(phone).some((v) => variants.has(v));

const accounts = await db.collection(COLLECTIONS.accounts).find({});
const accountById = new Map(accounts.map((a) => [a.id, a]));
const memberships = await db.collection(COLLECTIONS.memberships).find({});
const identities = await db.collection(COLLECTIONS.identities).find({});
const phoneOf = (accountId) => accountById.get(accountId)?.phone || identities.find((i) => i.accountId === accountId && i.channel === 'phone')?.externalId || '';

const stores = await db.collection(COLLECTIONS.stores).find({});
const keep = [];
const drop = [];
for (const shop of stores) {
  const people = [shop.ownerAccountId, ...memberships.filter((m) => m.storeId === shop.id).map((m) => m.accountId)];
  const named = keepNames.some((n) => n && squash(shop.name).includes(n));
  const why = named ? 'its name' : isKept(shop.contact?.phone) ? 'its public phone' : people.some((id) => isKept(phoneOf(id))) ? 'its owner or team signs in with it' : null;
  (why ? keep : drop).push({ shop, why });
}

console.log(`Keeping ${keep.length}:`);
for (const { shop, why } of keep) console.log(`  + ${shop.name} (${shop.slug}) - ${why}`);
console.log(`Removing ${drop.length}:`);
for (const { shop } of drop) console.log(`  - ${shop.name} (${shop.slug})`);

if (!keep.length) { console.error('\nNothing would be kept - nothing matches any shop. Refusing to go on.'); await core.close(); process.exit(1); }
if (!apply) { console.log('\nDry run: nothing changed. Add --yes to remove them.'); await core.close(); process.exit(0); }

if (core.config.storage.driver === 'json' && fs.existsSync(core.config.storage.file)) {
  const backup = `${core.config.storage.file}.bak-${Date.now()}`;
  fs.copyFileSync(core.config.storage.file, backup);
  console.log(`\nBacked up the database to ${backup}`);
}

const storeIds = drop.map((d) => d.shop.id);
const gone = new Set(storeIds);

// who is left without a shop and is only a demo owner
const keptIds = new Set(keep.map((k) => k.shop.id));
const ownerCandidates = new Set(drop.map((d) => d.shop.ownerAccountId));
const demoOwners = [...ownerCandidates].filter((id) => {
  const a = accountById.get(id);
  if (!a || a.role !== 'user' || a.phone || a.email) return false;
  if (identities.some((i) => i.accountId === id && ['phone', 'email'].includes(i.channel))) return false;
  const stillMember = memberships.some((m) => m.accountId === id && keptIds.has(m.storeId));
  return !stillMember;
});

let files = 0;
for (const row of await db.collection(COLLECTIONS.uploads).find({ where: { accountId: { $in: demoOwners } } })) {
  try { fs.unlinkSync(path.join(core.config.uploads.dir, row.name)); files += 1; } catch { /* already gone */ }
}

const skip = new Set([COLLECTIONS.categories, COLLECTIONS.events, COLLECTIONS.auditLogs, COLLECTIONS.searchLogs, COLLECTIONS.accounts, COLLECTIONS.stores, COLLECTIONS.platformSettings, COLLECTIONS.plans]);
for (const name of Object.values(COLLECTIONS)) {
  if (skip.has(name)) continue;
  const collection = core.store.collection(name);
  await collection.deleteWhere({ storeId: { $in: storeIds } });
  if (name === COLLECTIONS.identities || name === COLLECTIONS.subscriptions || name === COLLECTIONS.sessions || name === COLLECTIONS.walletTransactions || name === COLLECTIONS.notifications) {
    await collection.deleteWhere({ accountId: { $in: demoOwners } });
  }
}
await db.collection(COLLECTIONS.memberships).deleteWhere({ accountId: { $in: demoOwners } });
for (const row of await db.collection(COLLECTIONS.platformSettings).find({})) {
  if ([...gone].some((id) => String(row.id).endsWith(`:${id}`))) await db.collection(COLLECTIONS.platformSettings).delete(row.id);
}
await db.collection(COLLECTIONS.stores).deleteWhere({ id: { $in: storeIds } });
await db.collection(COLLECTIONS.accounts).deleteWhere({ id: { $in: demoOwners } });

console.log(`Removed ${storeIds.length} shops, ${demoOwners.length} demo owner accounts and ${files} photo files.`);
await core.close();
