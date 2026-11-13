import { COLLECTIONS } from '../models/schemas.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../util/ids.js';

const MAX_LENGTH = 500;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 8;
const MAX_REPLIES_SHOWN = 100;

/**
 * Comments on a product, the way people expect them from a social feed.
 *
 * - One flat level of replies: answering a reply lands under the same top-level
 *   comment, with the person you answered named (`replyToName`).
 * - Hearts on anything. A heart is one row per (comment, person) so counting is
 *   exact and a double-tap can never count twice.
 * - A shop's team is marked as such, a person who really bought the product is
 *   marked as a buyer, and a manager can pin one comment to the top.
 * - Order ratings that came with a written comment appear in the same feed as
 *   top-level items (with their stars), so there is one place to read what people said.
 */
export function createCommentsService(ctx) {
  const { store: db, events, services } = ctx;
  const comments = db.collection(COLLECTIONS.comments);
  const hearts = db.collection(COLLECTIONS.commentLikes);
  const reviews = db.collection(COLLECTIONS.reviews);
  const orders = db.collection(COLLECTIONS.orders);
  const accounts = db.collection(COLLECTIONS.accounts);

  /** A purchase that stands: not cancelled or refunded, and - for an online order - actually paid. */
  const standsAsPurchase = (order, productId) => !['cancelled', 'refunded'].includes(order.status)
    && (order.paymentMethod !== 'online' || order.paymentStatus === 'paid' || Boolean(order.paidAt))
    && (order.items || []).some((line) => line.productId === productId);
  async function boughtSet(productId, accountIds) {
    if (!accountIds.length) return new Set();
    const rows = await orders.find({ where: (o) => accountIds.includes(o.accountId) && standsAsPurchase(o, productId) });
    return new Set(rows.map((o) => o.accountId));
  }

  const clean = (text) => String(text ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  /** A comment or a written rating, normalised to one shape. */
  async function findTarget(id) {
    const comment = await comments.get(id);
    if (comment) return { kind: 'comment', row: comment };
    const review = await reviews.get(id);
    if (review?.comment) return { kind: 'review', row: review };
    return null;
  }

  const asItem = (kind, row) => (kind === 'review'
    ? { id: row.id, kind, accountId: row.accountId, text: row.comment, rating: row.rating, createdAt: row.createdAt, editedAt: null, pinned: false, parentId: null, replyToName: null }
    : { id: row.id, kind, storedType: row.type || null, accountId: row.accountId, text: row.text, rating: null, createdAt: row.createdAt, editedAt: row.editedAt || null, pinned: Boolean(row.pinned), parentId: row.parentId || null, replyToName: row.replyToName || null });

  /** Everything the page needs to draw one conversation, for one viewer. */
  async function list(productIdOrSlug, { accountId = null, sort = 'top', limit = 10, offset = 0, type = 'all' } = {}) {
    const product = await services.catalog.getProductOrFail(productIdOrSlug);
    const [commentRows, reviewRows] = await Promise.all([
      comments.find({ where: { productId: product.id } }),
      reviews.find({ where: (row) => row.productIds?.includes(product.id) && Boolean(row.comment) }),
    ]);

    const tops = [
      ...commentRows.filter((row) => !row.parentId).map((row) => asItem('comment', row)),
      ...reviewRows.map((row) => asItem('review', row)),
    ];
    const replies = commentRows.filter((row) => row.parentId).map((row) => asItem('comment', row));

    // Only someone who bought it writes a review; everyone else is asking a question (and a shop's own post is a note).
    const writers = [...new Set([...tops, ...replies].map((item) => item.accountId))];
    const bought = await boughtSet(product.id, writers);
    const staffIds = new Set((await Promise.all(writers.map(async (id) => [id, await services.stores.roleOf(product.storeId, id)]))).filter(([, role]) => role).map(([id]) => id));
    for (const item of tops) {
      if (item.kind === 'review') item.type = 'review';
      else item.type = item.storedType && item.storedType !== 'reply' ? item.storedType : (staffIds.has(item.accountId) ? 'note' : bought.has(item.accountId) ? 'review' : 'question');
    }
    const counts = { reviews: tops.filter((t) => t.type === 'review').length, questions: tops.filter((t) => t.type !== 'review').length };
    const shown = type === 'reviews' ? tops.filter((t) => t.type === 'review') : type === 'questions' ? tops.filter((t) => t.type !== 'review') : tops;
    const ratings = reviewRows.map((r) => r.rating).filter(Boolean);

    const ids = [...tops, ...replies].map((item) => item.id);
    const heartRows = ids.length ? await hearts.find({ where: (row) => ids.includes(row.targetId) }) : [];
    const heartCount = new Map();
    const mine = new Set();
    for (const row of heartRows) {
      heartCount.set(row.targetId, (heartCount.get(row.targetId) || 0) + 1);
      if (accountId && row.accountId === accountId) mine.add(row.targetId);
    }
    const repliesByParent = new Map();
    for (const reply of replies) {
      if (!repliesByParent.has(reply.parentId)) repliesByParent.set(reply.parentId, []);
      repliesByParent.get(reply.parentId).push(reply);
    }

    const rank = (item) => (heartCount.get(item.id) || 0) * 2 + (repliesByParent.get(item.id)?.length || 0);
    shown.sort((a, b) => (Number(b.pinned) - Number(a.pinned))
      || (sort === 'new' ? String(b.createdAt).localeCompare(String(a.createdAt)) : (rank(b) - rank(a)) || String(b.createdAt).localeCompare(String(a.createdAt))));
    const page = shown.slice(offset, offset + limit);

    // Replies read top to bottom, oldest first, like a conversation.
    const shownReplies = page.flatMap((top) => (repliesByParent.get(top.id) || []).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(0, MAX_REPLIES_SHOWN));
    const authorIds = [...new Set([...page, ...shownReplies].map((item) => item.accountId))];
    const [authors, roles] = await Promise.all([
      Promise.all(authorIds.map((id) => accounts.get(id))),
      Promise.all(authorIds.map((id) => services.stores.roleOf(product.storeId, id))),
    ]);
    const authorById = new Map(authorIds.map((id, i) => [id, authors[i]]));
    const roleById = new Map(authorIds.map((id, i) => [id, roles[i]]));
    const boughtBy = bought;

    const viewerRole = accountId ? await services.stores.roleOf(product.storeId, accountId) : null;
    const viewer = accountId ? await accounts.get(accountId) : null;
    const isStaff = Boolean(viewerRole) || viewer?.role === 'admin';
    const canModerate = ['owner', 'manager'].includes(viewerRole) || viewer?.role === 'admin';

    const present = (item) => {
      const author = authorById.get(item.accountId);
      return {
        id: item.id,
        kind: item.kind,
        type: item.type || 'reply',
        text: item.text,
        rating: item.rating,
        createdAt: item.createdAt,
        edited: Boolean(item.editedAt),
        pinned: item.pinned,
        replyToName: item.replyToName,
        likeCount: heartCount.get(item.id) || 0,
        liked: mine.has(item.id),
        mine: Boolean(accountId) && item.accountId === accountId,
        canDelete: item.kind === 'comment' && ((Boolean(accountId) && item.accountId === accountId) || canModerate),
        author: {
          id: item.accountId,
          name: author?.displayName || null,
          avatarUrl: author?.avatarUrl || null,
          isSeller: Boolean(roleById.get(item.accountId)),
          verifiedBuyer: item.kind === 'review' || boughtBy.has(item.accountId),
        },
      };
    };

    const items = page.map((top) => {
      const mineReplies = (repliesByParent.get(top.id) || []);
      return {
        ...present(top),
        replyCount: mineReplies.length,
        replies: shownReplies.filter((reply) => reply.parentId === top.id).map(present),
      };
    });

    return {
      items,
      page: { total: shown.length, limit, offset, hasMore: offset + items.length < shown.length },
      counts,
      rating: ratings.length ? { average: Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10, count: ratings.length } : null,
      count: tops.length + replies.length,
      viewer: { canPin: canModerate, isStaff, isBuyer: accountId ? bought.has(accountId) || (await boughtSet(product.id, [accountId])).has(accountId) : false },
    };
  }

  async function create(accountId, productIdOrSlug, { text, parentId = null, as = 'review' } = {}) {
    const product = await services.catalog.getProductOrFail(productIdOrSlug);
    const body = clean(text);
    if (body.length < 1 || body.length > MAX_LENGTH) throw ValidationError.of('text', 'err.comment_length', { max: MAX_LENGTH });

    const since = Date.now() - RATE_WINDOW_MS;
    const recent = await comments.count((row) => row.accountId === accountId && new Date(row.createdAt).getTime() > since);
    if (recent >= RATE_MAX) throw new ConflictError('err.comment_rate');

    let attach = null;
    let replyTo = null;
    if (parentId) {
      const parent = await findTarget(parentId);
      const belongs = parent && (parent.kind === 'review' ? parent.row.productIds?.includes(product.id) : parent.row.productId === product.id);
      if (!belongs) throw new NotFoundError('Comment', parentId);
      // One level only: answering a reply files it under the same thread.
      attach = parent.kind === 'comment' && parent.row.parentId ? parent.row.parentId : parent.row.id;
      replyTo = { accountId: parent.row.accountId, id: parent.row.id };
    }
    const replyToAccount = replyTo ? await accounts.get(replyTo.accountId) : null;

    // Asking to post a review without having bought is not refused: it is simply a question.
    const isStaff = Boolean(await services.stores.roleOf(product.storeId, accountId));
    const isBuyer = !isStaff && (await boughtSet(product.id, [accountId])).has(accountId);
    const type = attach ? 'reply' : isStaff ? 'note' : (as === 'review' && isBuyer ? 'review' : 'question');

    const record = await comments.insert({
      id: newId('cmt'),
      type,
      productId: product.id,
      storeId: product.storeId,
      accountId,
      parentId: attach,
      text: body,
      pinned: false,
      replyToAccountId: replyTo?.accountId || null,
      replyToName: replyTo && replyTo.accountId !== accountId ? (replyToAccount?.displayName || null) : null,
    });

    const author = await accounts.get(accountId);
    const authorIsStaff = Boolean(await services.stores.roleOf(product.storeId, accountId));
    const snippet = body.length > 140 ? `${body.slice(0, 137)}…` : body;
    const data = { commentId: record.id, parentId: attach, productId: product.id, storeId: product.storeId, productSlug: product.slug, storeSlug: product.storeSlug, action: 'view_comment' };

    if (replyTo && replyTo.accountId !== accountId) {
      await services.notifications.queue({
        accountId: replyTo.accountId,
        storeId: product.storeId,
        type: 'comment.replied',
        render: (t) => ({ title: t('notif.comment.replied.title', { name: author?.displayName || '', product: product.title }), body: snippet }),
        data,
      });
    }
    if (!authorIsStaff && !(replyTo && replyTo.accountId !== accountId && await services.stores.roleOf(product.storeId, replyTo.accountId))) {
      // The shop's team hears about a comment from a customer once - not again when it is a reply they were already told about.
      await services.notifications.queueForStoreTeam(product.storeId, {
        type: 'comment.new',
        render: (t) => ({ title: t('notif.comment.new.title', { name: author?.displayName || '', product: product.title }), body: snippet }),
        data,
      });
    }
    await events.emit('comment.created', { commentId: record.id, productId: product.id, storeId: product.storeId, accountId, replyTo: replyTo?.accountId || null });

    const fresh = await list(product.id, { accountId, sort: 'new', limit: 1000 });
    const flat = [...fresh.items, ...fresh.items.flatMap((item) => item.replies)];
    return flat.find((item) => item.id === record.id);
  }

  /** Heart or un-heart. The answer says where it stands, so the page can simply show it. */
  async function toggleLike(accountId, targetId) {
    const target = await findTarget(targetId);
    if (!target) throw new NotFoundError('Comment', targetId);
    const id = `${targetId}:${accountId}`;
    const existing = await hearts.get(id);
    if (existing) await hearts.delete(id);
    else await hearts.insert({ id, targetId, accountId });
    const likeCount = await hearts.count({ targetId });
    if (!existing && target.row.accountId !== accountId) await events.emit('comment.liked', { commentId: targetId, accountId });
    return { liked: !existing, likeCount };
  }

  async function remove(accountId, commentId) {
    const row = await comments.get(commentId);
    if (!row) throw new NotFoundError('Comment', commentId);
    const role = await services.stores.roleOf(row.storeId, accountId);
    const viewer = await accounts.get(accountId);
    const allowed = row.accountId === accountId || ['owner', 'manager'].includes(role) || viewer?.role === 'admin';
    if (!allowed) throw new ForbiddenError('err.comment_not_yours');

    const thread = await comments.find({ where: (c) => c.id === row.id || c.parentId === row.id });
    for (const item of thread) {
      await hearts.deleteWhere({ targetId: item.id });
      await comments.delete(item.id);
    }
    await events.emit('comment.removed', { commentId: row.id, productId: row.productId, by: accountId });
    return { removed: thread.length };
  }

  /** One pinned comment per product; pinning another moves the pin. */
  async function pin(accountId, commentId, pinned = true) {
    const row = await comments.get(commentId);
    if (!row) throw new NotFoundError('Comment', commentId);
    if (row.parentId) throw new ConflictError('err.comment_pin_reply');
    await services.stores.assertCan(row.storeId, accountId, 'products.manage');
    if (pinned) {
      const others = await comments.find({ where: { productId: row.productId, pinned: true } });
      for (const other of others) if (other.id !== row.id) await comments.update(other.id, { pinned: false });
    }
    await comments.update(row.id, { pinned: Boolean(pinned) });
    return { id: row.id, pinned: Boolean(pinned) };
  }

  return { list, create, toggleLike, remove, pin };
}
