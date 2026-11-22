/**
 * Files products under the category their own words name (title, tags, properties). Products with no category, a
 * retired one or the import fallback ("tunic") are the only ones moved; a seller's deliberate choice is left alone.
 *
 *   node --env-file=../.env scripts/recategorize.js            what would change (changes nothing)
 *   node --env-file=../.env scripts/recategorize.js --yes      do it
 *   node --env-file=../.env scripts/recategorize.js --store str_...   one shop only
 *
 * On a running site the same thing is POST /admin/catalog/recategorize (admin), {"apply": true} to do it.
 * Stop the core server first when running this on a JSON database; it is copied to <file>.bak-<time> before changes.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const apply = args.includes('--yes');
const store = args.includes('--store') ? args[args.indexOf('--store') + 1] : null;

const { createCore } = await import('../src/index.js');
const core = await createCore();
const file = core.config?.storage?.file;
if (apply && file && fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${Math.floor(Date.now() / 1000)}`);

const r = await core.services.catalog.recategorize({ apply, storeId: store });
console.log(JSON.stringify({ ...r, mode: apply ? 'applied' : 'dry run' }, null, 2));
await core.close?.();
process.exit(0);
