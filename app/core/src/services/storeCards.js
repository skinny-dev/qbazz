import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { COLLECTIONS } from '../models/schemas.js';
import { newId } from '../util/ids.js';
import { toLatinDigits } from '../util/digits.js';

const MAX_CARDS = 10;

/**
 * A shop's own cards for card-to-card payments — as many as it wants.
 *
 * Buyers pay one card per order: when a shop has several active ones, the
 * order id picks (stable, so the card an order showed never changes) and the
 * load spreads over the cards. The receipt records which card the buyer was
 * told to pay, so a seller with five cards knows where to look for the money.
 *
 * Cards live in `store.settings.paymentCards`. A shop from before this
 * feature has a single `settings.paymentCard`; it is read as a one-card list
 * and folded into the list the first time anything is changed.
 */
export function createStoreCardsService(ctx) {
  const { store: db, services } = ctx;
  const stores = db.collection(COLLECTIONS.stores);

  function cleanNumber(raw) {
    const digits = toLatinDigits(String(raw ?? '')).replace(/[\s-]/g, '');
    // 16 for a bank card; account numbers elsewhere run shorter or longer.
    if (!/^\d{8,24}$/.test(digits)) throw ValidationError.of('number', 'err.store_card_number');
    return digits;
  }

  const format = (number) => (/^\d{16}$/.test(number) ? number.replace(/(\d{4})(?=\d)/g, '$1-') : number);

  /** Every card the shop has, legacy single card included. */
  function cardsOf(record) {
    const list = record?.settings?.paymentCards;
    if (Array.isArray(list) && list.length) return list;
    const legacy = record?.settings?.paymentCard;
    if (!Array.isArray(list) && legacy?.number) {
      return [{ id: 'legacy', number: String(legacy.number), holder: legacy.holder || '', bank: '', active: true, createdAt: record.createdAt }];
    }
    return [];
  }

  const present = (card) => ({ ...card, display: format(card.number), last4: card.number.slice(-4) });

  async function write(storeId, mutator) {
    const updated = await stores.mutate(storeId, (draft) => {
      const settings = draft.settings || {};
      const current = cardsOf(draft).map((c) => (c.id === 'legacy' ? { ...c, id: newId('scd') } : c));
      settings.paymentCards = mutator(current);
      // The list is the single source of truth from here on.
      settings.paymentCard = {};
      draft.settings = settings;
      return draft;
    });
    if (!updated) throw new NotFoundError('Store', storeId);
    return updated;
  }

  async function list(storeId, { actorAccountId }) {
    const record = await services.stores.resolve(storeId);
    await services.stores.assertCan(record.id, actorAccountId, 'store.update');
    return { items: cardsOf(record).map(present) };
  }

  async function add(storeId, input = {}, { actorAccountId }) {
    const record = await services.stores.resolve(storeId);
    await services.stores.assertCan(record.id, actorAccountId, 'store.update');
    const number = cleanNumber(input.number);
    const holder = String(input.holder || '').trim();
    if (holder.length < 2) throw ValidationError.of('holder', 'validation.required', { field: 'Holder' });
    const existing = cardsOf(record);
    if (existing.length >= MAX_CARDS) throw new ConflictError('err.store_cards_max', { max: MAX_CARDS }, { max: MAX_CARDS });
    if (existing.some((c) => c.number === number)) throw new ConflictError('err.card_exists');

    const card = {
      id: newId('scd'),
      number,
      holder: holder.slice(0, 80),
      bank: String(input.bank || '').trim().slice(0, 40),
      active: input.active !== false,
      createdAt: new Date().toISOString(),
    };
    await write(record.id, (cards) => [...cards, card]);
    return present(card);
  }

  async function update(storeId, cardId, patch = {}, { actorAccountId }) {
    const record = await services.stores.resolve(storeId);
    await services.stores.assertCan(record.id, actorAccountId, 'store.update');
    const exists = cardsOf(record).find((c) => c.id === cardId || (cardId === 'legacy' && c.id === 'legacy'));
    if (!exists) throw new NotFoundError('Card', cardId);

    const next = {};
    if (patch.number !== undefined) next.number = cleanNumber(patch.number);
    if (patch.holder !== undefined) {
      const holder = String(patch.holder).trim();
      if (holder.length < 2) throw ValidationError.of('holder', 'validation.required', { field: 'Holder' });
      next.holder = holder.slice(0, 80);
    }
    if (patch.bank !== undefined) next.bank = String(patch.bank).trim().slice(0, 40);
    if (patch.active !== undefined) next.active = Boolean(patch.active);
    if (next.number && cardsOf(record).some((c) => c.number === next.number && c.id !== exists.id)) throw new ConflictError('err.card_exists');

    let result = null;
    await write(record.id, (cards) => cards.map((c) => {
      // A legacy card was re-id'd by `write`; match it by position of the old id.
      const match = c.id === cardId || (cardId === 'legacy' && cards.length === 1);
      if (!match) return c;
      result = { ...c, ...next };
      return result;
    }));
    return present(result);
  }

  async function remove(storeId, cardId, { actorAccountId }) {
    const record = await services.stores.resolve(storeId);
    await services.stores.assertCan(record.id, actorAccountId, 'store.update');
    if (!cardsOf(record).some((c) => c.id === cardId)) throw new NotFoundError('Card', cardId);
    await write(record.id, (cards) => cards.filter((c) => c.id !== cardId));
    return { removed: true };
  }

  const hash = (text) => [...String(text)].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);

  /** The card an order tells its buyer to pay. Null when the shop has no active card. */
  function cardForOrder(record, orderId) {
    const active = cardsOf(record).filter((c) => c.active !== false);
    if (!active.length) return null;
    return active[hash(orderId) % active.length];
  }

  const hasActiveCard = (record) => cardsOf(record).some((c) => c.active !== false);

  return { list, add, update, remove, cardsOf, cardForOrder, hasActiveCard, format };
}
