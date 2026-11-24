/**
 * Reads a public Telegram channel's history through Telegram's own public preview page (https://t.me/s/<channel>) -
 * the page anyone can open without an account. The Bot API cannot read what was posted before a bot joined; this can,
 * for any channel that has a public username. Nothing here logs in as anyone, and nothing is read that the page
 * does not already show.
 */
const NAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const UA = 'Mozilla/5.0 (compatible; QbazzImport/1.0; +https://qbazz.app)';

/** "@shop", "t.me/shop", "https://t.me/s/shop/123" or "shop" -> "shop"; null when it is not a public channel name. */
export function channelName(input) {
  const text = String(input || '').trim();
  const m = text.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{3,31})(?:\/\d+)?\/?(?:\?.*)?$/i) || text.match(/^@?([A-Za-z][A-Za-z0-9_]{3,31})$/);
  return m && NAME.test(m[1]) ? m[1] : null;
}

/** Photos are only ever fetched from Telegram's own picture hosts - never from an address a page merely mentions. */
export const isTelegramPhoto = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)(telesco\.pe|cdn-telegram\.org|telegram-cdn\.org)$/i.test(u.hostname);
  } catch { return false; }
};

const ENTITIES = { '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&laquo;': '«', '&raquo;': '»' };
const decode = (s) => s.replace(/&(quot|lt|gt|nbsp|laquo|raquo|#39);/g, (m) => ENTITIES[m] || m).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const textOf = (html) => decode(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div)>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/**
 * One preview page -> its messages (an album is one message with several photos) and the cursor for the page before.
 * `{ posts: [{ id, date, text, photos, replyTo, video }], before }`
 */
export function parsePage(html, username) {
  const posts = [];
  for (const chunk of html.split('<div class="tgme_widget_message_wrap').slice(1)) {
    const post = chunk.match(/data-post="([^"/]+)\/(\d+)"/);
    if (!post || post[1].toLowerCase() !== username.toLowerCase()) continue;
    const text = (chunk.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1];
    const photos = [...chunk.matchAll(/tgme_widget_message_photo_wrap[^"]*"[^>]*style="[^"]*background-image:url\('([^']+)'\)/g)].map((m) => decode(m[1])).filter(isTelegramPhoto);
    const reply = (chunk.match(/<a class="tgme_widget_message_reply[^"]*"[^>]*href="[^"]*\/(\d+)"/) || [])[1];
    posts.push({
      id: Number(post[2]),
      date: (chunk.match(/<time[^>]*datetime="([^"]+)"/) || [])[1] || null,
      text: text ? textOf(text) : '',
      photos: [...new Set(photos)],
      replyTo: reply ? Number(reply) : null,
      video: /tgme_widget_message_video|tgme_widget_message_roundvideo/.test(chunk),
    });
  }
  const before = (html.match(/data-before="(\d+)"/) || [])[1];
  return { posts, before: before ? Number(before) : null };
}

/**
 * Walks a channel from its newest post backwards. Polite on purpose: one request at a time, a pause between pages,
 * and hard caps on pages and posts, so a channel with ten years of history cannot hold a server up.
 */
export async function crawlChannel(username, { fetchImpl = fetch, maxPages = 300, maxPosts = 3000, delayMs = 350, signal, onPage, since = null } = {}) {
  const sinceMs = since ? Date.parse(since) : null;
  const found = new Map();
  let before = null;
  let pages = 0;
  for (; pages < maxPages && found.size < maxPosts; ) {
    const url = `https://t.me/s/${username}${before ? `?before=${before}` : ''}`;
    // A dropped connection or a hiccup from Telegram costs a retry, not the whole import; if a page still will not load, the
    // pages already read are kept (the seller is told the list may be incomplete).
    let page = null;
    for (let attempt = 1; attempt <= 4 && !page; attempt++) {
      try {
        const res = await fetchImpl(url, { headers: { 'user-agent': UA, 'accept-language': 'fa,en;q=0.8' }, signal: signal || AbortSignal.timeout(25_000), redirect: 'follow' });
        if (!res.ok && res.status !== 429 && res.status < 500) throw Object.assign(new Error(`Telegram answered ${res.status}`), { code: 'telegram_unavailable', final: true });
        if (res.ok) page = parsePage(await res.text(), username);
        else throw new Error(`Telegram answered ${res.status}`);
      } catch (err) {
        if (err.final || attempt === 4) {
          if (pages === 0) throw Object.assign(err, { code: err.code || 'telegram_unavailable' });
          return { posts: joinNeighbours([...found.values()].sort((a, b) => a.id - b.id)), pages, truncated: true, incomplete: true };
        }
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
    pages += 1;
    if (pages === 1 && !page.posts.length) throw Object.assign(new Error('This channel has no public preview (private channel, or the name is wrong).'), { code: 'no_public_preview' });
    for (const post of page.posts) found.set(post.id, post);
    onPage?.({ pages, posts: found.size });
    // a date range: this page already reaches back before its start, so nothing older is wanted
    if (sinceMs !== null) {
      const dated = page.posts.map((p) => Date.parse(p.date)).filter(Number.isFinite);
      if (dated.length && Math.min(...dated) < sinceMs) break;
    }
    if (!page.before || (before !== null && page.before >= before)) break;
    before = page.before;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { posts: joinNeighbours([...found.values()].sort((a, b) => a.id - b.id)), pages, truncated: pages >= maxPages || found.size >= maxPosts };
}

/**
 * Sellers often send the album and the words as separate messages. A caption-less album within ten minutes of a text-only
 * post (before it, or right after it) is that post's photos; the pair becomes one post.
 */
export function joinNeighbours(posts, windowMs = 10 * 60 * 1000) {
  const near = (a, b) => a.date && b.date && Math.abs(Date.parse(a.date) - Date.parse(b.date)) <= windowMs;
  const out = [];
  let waiting = null; // a photo-only post that has not found its words yet
  for (const post of posts) {
    const photoOnly = !post.text && post.photos.length && !post.replyTo;
    const textOnly = post.text && !post.photos.length && !post.replyTo;
    if (textOnly && waiting && near(waiting, post)) { out.push({ ...post, photos: waiting.photos, id: post.id }); waiting = null; continue; }
    if (waiting) { out.push(waiting); waiting = null; }
    if (photoOnly) {
      const last = out.at(-1);
      if (last && last.text && !last.photos.length && near(last, post)) last.photos = post.photos;
      else waiting = post;
      continue;
    }
    out.push(post);
  }
  if (waiting) out.push(waiting);
  return out;
}
