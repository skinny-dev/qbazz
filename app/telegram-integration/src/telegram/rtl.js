/**
 * Right-to-left rendering for Telegram.
 *
 * Telegram lays each line out by the first *strong* character in it. In Persian
 * text that is usually right, but not always: a line that opens with an emoji
 * ("🛒 سبد خرید"), a Latin word ("QB-4F2K9A تأیید شد") or a number is neutral or
 * left-to-right at its start, and the whole line — punctuation, ordering,
 * alignment — comes out flipped. The fix is the standard one: start every line
 * with an invisible RIGHT-TO-LEFT MARK, which is a strong RTL character that
 * takes up no space.
 *
 * Inline keyboards are the other half. Telegram lays a row out left to right no
 * matter the language, so a row written [first, second] puts "first" on the
 * left — backwards for a Persian reader, where the first item belongs at the
 * right. Rather than make every flow think about direction, flows write rows in
 * logical order and the send layer mirrors them here.
 */
export const RLM = '‏';
export const LRM = '‎';

/** Prefixes every non-empty line with an RLM. A no-op for left-to-right text. */
export function bidiText(text, rtl) {
  if (!rtl || text === undefined || text === null || text === '') return text;
  return String(text)
    .split('\n')
    .map((line) => (line.trim() === '' || line.startsWith(RLM) ? line : `${RLM}${line}`))
    .join('\n');
}

/**
 * Wraps a token that must stay left-to-right inside right-to-left text — an
 * order code, a phone number, a @handle, a URL. Without the marks, the
 * punctuation next to it (a trailing full stop, brackets) attaches to the wrong
 * side.
 */
export const ltr = (text) => `${LRM}${text}${LRM}`;

/** Reverses each row of an inline keyboard so the first button sits at the right. */
export function mirrorMarkup(markup, rtl) {
  if (!rtl || !markup || !Array.isArray(markup.inline_keyboard)) return markup;
  return { ...markup, inline_keyboard: markup.inline_keyboard.map((row) => [...row].reverse()) };
}

/** A callback-query toast or alert is a single line of plain text. */
export const bidiToast = (text, rtl) => (rtl && text ? `${RLM}${text}` : text);
