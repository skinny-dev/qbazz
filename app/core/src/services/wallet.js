import { COLLECTIONS } from '../models/schemas.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../util/ids.js';

/**
 * An account's wallet: one balance, in IRT (the platform's own currency —
 * separate from whatever currency a seller's products are priced in), and an
 * append-only ledger of every change to it. This is an internal ledger, not a
 * payment gateway: a top-up is recorded here once money has already changed
 * hands elsewhere (support, an admin action, a future payment provider) —
 * nothing in this file moves real money on its own.
 *
 * The balance itself lives on the account record (`account.wallet.balanceMinor`),
 * cached for fast reads; the ledger is the source of truth for history and audit.
 */
export function createWalletService(ctx) {
  const { store: db, events } = ctx;
  const accounts = db.collection(COLLECTIONS.accounts);
  const ledger = db.collection(COLLECTIONS.walletTransactions);

  async function getBalance(accountId) {
    const account = await accounts.get(accountId);
    if (!account) throw new NotFoundError('Account', accountId);
    if (account.wallet) return account.wallet;
    // First touch: give it a wallet rather than asking every caller to check.
    const updated = await accounts.update(accountId, { wallet: { balanceMinor: 0, currency: 'IRT' } });
    return updated.wallet;
  }

  /**
   * `mutate` reads, changes and writes a document within a single tick — the
   * same pattern `catalog.adjustStock` uses — so two changes to one balance
   * arriving together cannot both read the same starting number and silently
   * drop one of them.
   */
  async function applyChange(accountId, delta, { type, reason, actorAccountId, meta }) {
    let balanceAfter = null;
    const updated = await accounts.mutate(accountId, (draft) => {
      draft.wallet = draft.wallet || { balanceMinor: 0, currency: 'IRT' };
      const next = draft.wallet.balanceMinor + delta;
      if (next < 0) throw new ConflictError('err.insufficient_balance', { balanceMinor: draft.wallet.balanceMinor, amountMinor: -delta });
      draft.wallet = { ...draft.wallet, balanceMinor: next };
      balanceAfter = next;
      return draft;
    });
    if (!updated) throw new NotFoundError('Account', accountId);

    const entry = await ledger.insert({
      id: newId('wtx'),
      accountId,
      type,
      amountMinor: Math.abs(delta),
      currency: updated.wallet.currency,
      balanceAfter,
      reason,
      actorAccountId,
      meta,
    });
    await events.emit(`wallet.${type}ed`, { accountId, amountMinor: Math.abs(delta), balanceAfter, reason, entry });
    return updated.wallet;
  }

  /** A positive amount added to the balance — a top-up, a refund, a credit note. */
  async function credit(accountId, amountMinor, { reason = 'topup', actorAccountId = null, meta = null } = {}) {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw ValidationError.of('amount', 'err.amount_positive');
    return applyChange(accountId, amountMinor, { type: 'credit', reason, actorAccountId, meta });
  }

  /** A positive amount removed from the balance — a plan charge, a credit purchase. Never overdraws. */
  async function debit(accountId, amountMinor, { reason = 'charge', actorAccountId = null, meta = null } = {}) {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw ValidationError.of('amount', 'err.amount_positive');
    return applyChange(accountId, -amountMinor, { type: 'debit', reason, actorAccountId, meta });
  }

  async function listTransactions(accountId, { limit = 20, offset = 0 } = {}) {
    const [items, total] = await Promise.all([
      ledger.find({ where: { accountId }, sort: [['createdAt', 'desc']], limit, offset }),
      ledger.count({ accountId }),
    ]);
    return { items, total };
  }

  return { getBalance, credit, debit, listTransactions };
}
