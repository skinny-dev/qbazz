export const MAX_LIMIT = 100;

export function pageParams(query = {}) {
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), MAX_LIMIT);
  const offset = Math.max(Number(query.offset) || 0, 0);
  return { limit, offset };
}

export function paged(items, total, { limit, offset }) {
  return {
    items,
    page: {
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
      nextOffset: offset + items.length < total ? offset + limit : null,
    },
  };
}
