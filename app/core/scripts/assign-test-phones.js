import { createCore } from '../src/index.js';

/** One-off: backfill phone numbers onto a few existing seeded accounts so
 * they're reachable by the new phone/OTP login, for manual testing of
 * different personas (seller with a live store, plain buyer, platform admin
 * with no store). Run once, not part of the regular boot sequence. */
const core = await createCore();
const { services } = core;

const assignments = [
  { accountId: 'acc_01M2ZRG93ZQK2QX46B', phone: '+989120000000', note: 'Qbazz Admin (platform admin, no store)' },
  { storeSlug: 'mezon-setareh', phone: '+989120000001', note: 'مزون ستاره — seller with a live store' },
  { accountId: 'acc_01M3P3EAAX79C0809A', phone: '+989120000002', note: 'Test Buyer — plain buyer, no store' },
];

for (const a of assignments) {
  let accountId = a.accountId;
  if (a.storeSlug) {
    const store = await services.stores.resolve(a.storeSlug).catch(() => null);
    if (!store) { console.log(`skip: store "${a.storeSlug}" not found`); continue; }
    accountId = store.ownerAccountId;
  }
  const account = await services.accounts.get(accountId);
  if (!account) { console.log(`skip: account ${accountId} not found`); continue; }
  await services.accounts.update(accountId, { phone: a.phone });
  console.log(`${a.phone} -> ${account.displayName} (${account.role}) — ${a.note}`);
}

await core.close();
