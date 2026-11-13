/**
 * Inline keyboard helpers.
 *
 * Callback data is capped at 64 bytes by Telegram, so actions are short codes
 * and ids are passed raw. `cb()` throws in development if a button would be
 * silently dropped by the client — that failure mode is miserable to debug.
 *
 * Rows are written in *logical* order — first button first — and never mirrored
 * here. Telegram lays every row out left to right, which reads backwards in
 * Persian, so the send layer (session.js) reverses each row for right-to-left
 * readers. Doing it once, at the edge, is why no flow has to care.
 */
export function cb(action, ...args) {
  const data = [action, ...args.filter((a) => a !== undefined && a !== null)].join(':');
  if (Buffer.byteLength(data) > 64) {
    throw new Error(`callback_data too long (${Buffer.byteLength(data)}B): ${data}`);
  }
  return data;
}

export function parseCb(data) {
  const [action, ...args] = String(data || '').split(':');
  return { action, args };
}

export const button = (text, action, ...args) => ({ text, callback_data: cb(action, ...args) });
export const urlButton = (text, url) => ({ text, url });
export const webAppButton = (text, url) => ({ text, web_app: { url } });

export function keyboard(rows) {
  return { inline_keyboard: rows.filter((row) => row && row.length) };
}

/** Lays flat buttons into rows of `perRow`. */
export function grid(buttons, perRow = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
  return rows;
}

/**
 * Prev/next row for any paged list. Omitted entirely when there is one page.
 * `tx` supplies the labels and the digits, so "1/3" reads "۱ از ۳" in Persian.
 */
export function pager(tx, action, { offset, limit, total }, ...args) {
  if (total <= limit) return [];
  const row = [];
  if (offset > 0) row.push(button(tx.t('b.pager.prev'), action, ...args, String(Math.max(0, offset - limit))));
  row.push({
    text: tx.t('b.pager.page', { page: Math.floor(offset / limit) + 1, pages: Math.ceil(total / limit) }),
    callback_data: 'noop',
  });
  if (offset + limit < total) row.push(button(tx.t('b.pager.next'), action, ...args, String(offset + limit)));
  return row;
}

export const homeRow = (tx) => [button(tx.t('b.nav.home'), 'home'), button(tx.t('b.nav.search'), 'search')];

/** Reply keyboards for the two inputs Telegram can supply natively. */
export const requestContactKeyboard = (text) => ({
  keyboard: [[{ text, request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
});

export const requestLocationKeyboard = (text) => ({
  keyboard: [[{ text, request_location: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
});

export const removeKeyboard = () => ({ remove_keyboard: true });
