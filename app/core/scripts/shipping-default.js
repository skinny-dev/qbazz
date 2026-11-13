/**
 * Puts every shop on the platform's default for shipping: the customer pays the carrier, no fixed fee shown.
 * Earlier demo imports carried made-up fees (100,000-150,000 toman); shops that cover shipping themselves are left alone.
 *
 *   node --env-file=../.env scripts/shipping-default.js --dry     list what would change
 *   node --env-file=../.env scripts/shipping-default.js           change it
 *
 * Stop the core server first when the database is a JSON file; the server holds it in memory.
 */
const { createCore } = await import('../src/index.js');
const { COLLECTIONS } = await import('../src/models/schemas.js');

const dry = process.argv.includes('--dry');
const core = await createCore();
const stores = core.store.collection(COLLECTIONS.stores);

let changed = 0;
for (const shop of await stores.find({})) {
  const s = shop.settings || {};
  if (s.shippingPayer === 'seller') continue;
  if (s.shippingPayer === 'buyer' && !s.deliveryFee) continue;
  console.log(`${dry ? 'would change' : 'changing'}: ${shop.name} (fee ${s.deliveryFee || 0} -> 0, payer ${s.shippingPayer || '-'} -> buyer)`);
  if (!dry) await stores.update(shop.id, { settings: { ...s, shippingPayer: 'buyer', deliveryFee: 0 } });
  changed += 1;
}
console.log(`${changed} shop(s) ${dry ? 'would be' : 'were'} updated.`);
await core.close();
