import { COLLECTIONS } from '../models/schemas.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../util/ids.js';
import { toLatinDigits } from '../util/digits.js';

const SETTINGS_ID = 'payments';
const STRATEGIES = ['primary', 'rotate'];

const DEFAULT_SETTINGS = {
  topup: {
    // Master switch for card-to-card wallet top-ups.
    enabled: true,
    // 'primary': everyone sees the primary card. 'rotate': sellers are spread across
    // the active cards (stable per seller, so the card they were shown does not change).
    cardStrategy: 'rotate',
    minAmount: 10000,
    maxAmount: 100000000,
  },
};

/**
 * Where the platform takes money, as data a super admin manages.
 *
 * Today that is one method — card-to-card wallet top-ups — with any number of
 * cards behind it. Cards can be switched off, archived or made primary at any
 * time, and the top-up switch, amount limits and card-picking rule are
 * settings, not deploy-time config. `QBAZZ_TOPUP_CARD` only seeds the first
 * card on an install that has none.
 *
 * Reading the list needs staff access; changing anything needs a full admin,
 * and every change is written to the audit log by the admin service.
 */
export function createPaymentsService(ctx) {
  const { store: db, config, services } = ctx;
  const cards = db.collection(COLLECTIONS.paymentCards);
  const settingsDb = db.collection(COLLECTIONS.platformSettings);

  async function init() {
    const seed = config.platform.topupCard;
    if (seed?.number && (await cards.count()) === 0) {
      const number = cleanNumber(seed.number, { lenient: true });
      if (number) await cards.insert({ id: newId('crd'), number, holder: seed.holder || '', bank: '', label: '', active: true, primary: true, archived: false, lastShownAt: null });
    }
  }

  function cleanNumber(raw, { lenient = false } = {}) {
    const digits = toLatinDigits(String(raw ?? '')).replace(/[\s-]/g, '');
    if (!/^\d{16}$/.test(digits)) {
      if (lenient) return null;
      throw ValidationError.of('number', 'err.card_number');
    }
    return digits;
  }

  const format = (number) => number.replace(/(\d{4})(?=\d)/g, '$1-');

  /** Staff see the full number — they have to match it against receipts. */
  const present = (card) => ({ ...card, display: format(card.number), last4: card.number.slice(-4) });

  async function getSettings() {
    const row = await settingsDb.get(SETTINGS_ID);
    return { topup: { ...DEFAULT_SETTINGS.topup, ...(row?.topup || {}) } };
  }

  async function updateSettings(patch = {}) {
    const current = await getSettings();
    const topup = { ...current.topup };
    const p = patch.topup || {};
    if (p.enabled !== undefined) topup.enabled = Boolean(p.enabled);
    if (p.cardStrategy !== undefined) {
      if (!STRATEGIES.includes(p.cardStrategy)) throw ValidationError.of('cardStrategy', 'validation.invalid', { field: 'Strategy' });
      topup.cardStrategy = p.cardStrategy;
    }
    for (const field of ['minAmount', 'maxAmount']) {
      if (p[field] === undefined) continue;
      const n = Number(p[field]);
      if (!Number.isInteger(n) || n < 1) throw ValidationError.of(field, 'validation.number', { field });
      topup[field] = n;
    }
    if (topup.minAmount > topup.maxAmount) throw new ConflictError('err.payment_limits');
    await settingsDb.upsert(SETTINGS_ID, { topup });
    return { topup };
  }

  async function listCards(actorAccountId) {
    await services.admin.assertAdmin(actorAccountId, { allowSupport: true });
    const rows = await cards.find({ where: { archived: false }, sort: [['createdAt', 'asc']] });
    return { items: rows.map(present) };
  }

  async function createCard(input = {}) {
    const number = cleanNumber(input.number);
    const holder = String(input.holder || '').trim();
    if (holder.length < 2) throw ValidationError.of('holder', 'validation.required', { field: 'Holder' });
    if ((await cards.findOne({ number, archived: false }))) throw new ConflictError('err.card_exists');
    const first = (await cards.count({ archived: false })) === 0;
    const row = await cards.insert({
      id: newId('crd'),
      number,
      holder: holder.slice(0, 80),
      bank: String(input.bank || '').trim().slice(0, 40),
      label: String(input.label || '').trim().slice(0, 60),
      active: input.active !== false,
      primary: first,
      archived: false,
      lastShownAt: null,
    });
    return present(row);
  }

  async function getCard(id) {
    const row = await cards.get(id);
    if (!row || row.archived) throw new NotFoundError('Card', id);
    return row;
  }

  async function updateCard(id, patch = {}) {
    const card = await getCard(id);
    const next = {};
    if (patch.number !== undefined) {
      next.number = cleanNumber(patch.number);
      const clash = await cards.findOne({ number: next.number, archived: false });
      if (clash && clash.id !== id) throw new ConflictError('err.card_exists');
    }
    if (patch.holder !== undefined) {
      const holder = String(patch.holder).trim();
      if (holder.length < 2) throw ValidationError.of('holder', 'validation.required', { field: 'Holder' });
      next.holder = holder.slice(0, 80);
    }
    if (patch.bank !== undefined) next.bank = String(patch.bank).trim().slice(0, 40);
    if (patch.label !== undefined) next.label = String(patch.label).trim().slice(0, 60);
    if (patch.active !== undefined) next.active = Boolean(patch.active);

    if (patch.primary === true) {
      // One primary at a time; making a card primary also makes it usable.
      for (const other of await cards.find({ where: { primary: true } })) if (other.id !== id) await cards.update(other.id, { primary: false });
      next.primary = true;
      next.active = true;
    }
    if (patch.primary === false && card.primary) throw new ConflictError('err.card_primary_needed');
    if (next.active === false && card.primary) throw new ConflictError('err.card_primary_needed');

    const updated = await cards.update(id, next);
    return present(updated);
  }

  /** Archive, never destroy: old top-up requests still point at the card they were shown. */
  async function archiveCard(id) {
    const card = await getCard(id);
    if (card.primary) {
      const another = (await cards.find({ where: { archived: false, active: true } })).find((c) => c.id !== id);
      if (another) await cards.update(another.id, { primary: true });
    }
    await cards.update(id, { archived: true, active: false, primary: false });
    return { archived: true };
  }

  const hash = (text) => [...String(text)].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);

  /** The card this account should pay. Null when top-ups are off or no card is usable. */
  async function cardFor(accountId) {
    const usable = (await cards.find({ where: { archived: false, active: true }, sort: [['createdAt', 'asc']] }));
    if (!usable.length) return null;
    const { topup } = await getSettings();
    if (topup.cardStrategy === 'rotate' && usable.length > 1 && accountId) return usable[hash(accountId) % usable.length];
    return usable.find((c) => c.primary) || usable[0];
  }

  /** What a seller is told when topping up. Never exposes anything but the one card they should use. */
  async function topupInstructions(accountId) {
    const { topup } = await getSettings();
    const card = topup.enabled ? await cardFor(accountId) : null;
    return {
      enabled: topup.enabled,
      configured: Boolean(card),
      cardId: card?.id || null,
      cardNumber: card ? format(card.number) : null,
      holder: card?.holder || null,
      bank: card?.bank || null,
      minAmount: topup.minAmount,
      maxAmount: topup.maxAmount,
      currency: 'IRT',
    };
  }

  /** The snapshot recorded on a top-up so a later card edit cannot rewrite what the seller was told. */
  async function snapshot(cardId) {
    if (!cardId) return null;
    const row = await cards.get(cardId);
    return row ? { id: row.id, last4: row.number.slice(-4), holder: row.holder, bank: row.bank || null } : null;
  }

  function assertEnabled(settings) {
    if (!settings.topup.enabled) throw new ForbiddenError('err.topup_disabled');
  }

  return {
    init, getSettings, updateSettings, listCards, createCard, updateCard, archiveCard,
    topupInstructions, snapshot, assertEnabled,
  };
}
