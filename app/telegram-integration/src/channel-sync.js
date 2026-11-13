/**
 * The other direction from channel-poster.js: a post the seller sends to
 * their own Telegram channel, turned into a product, for any shop that opted
 * into it (`channel.syncPosts`).
 *
 * `channel_post` updates never come through session.js/router.js — there is
 * no "user" or chat session on a channel post, just a channel and a message —
 * so this is its own small entry point, called directly from index.js.
 *
 * An album arrives as one update per photo, all sharing a `media_group_id`,
 * with the caption on only one of them. Those are held briefly and handed to
 * the core as ONE post carrying every photo — otherwise each photo would be
 * read as its own (caption-less, product-less) post and the gallery lost.
 */
const ALBUM_SETTLE_MS = 1500;

export function createChannelSync({ core, api, log, albumSettleMs = ALBUM_SETTLE_MS }) {
  const albums = new Map();

  async function ingest(posts) {
    const first = posts[0];
    try {
      const text = posts.map((p) => p.text || p.caption || '').find(Boolean) || '';
      const fileIds = posts.filter((p) => p.photo?.length).map((p) => p.photo[p.photo.length - 1].file_id);
      // Largest rendition last, same convention as everywhere else a photo is read.
      const photos = (await Promise.all(fileIds.map((id) => api.fileUrl(id).catch(() => null)))).filter(Boolean);

      const { product } = await core.ingestChannelPost({
        chatId: String(first.chat.id),
        text,
        photo: photos[0] || null,
        photos,
        fileIds,
        messageId: Math.max(...posts.map((p) => p.message_id)),
        messageIds: posts.map((p) => p.message_id),
        // "ناموجود شد" written as a reply under a product post: the core reads it as availability, not as a new product
        replyToMessageId: posts.map((p) => p.reply_to_message?.message_id).find(Boolean) || null,
      });

      if (product) log.info(`channel post ${first.message_id} in ${first.chat.id} synced as product "${product.title}" (${photos.length} photo${photos.length === 1 ? '' : 's'})`);
    } catch (err) {
      // A shop's own channel chatter must never crash the bot — log and move on.
      log.warn(`channel post sync failed (chat ${first.chat.id}, message ${first.message_id}): ${err.message}`);
    }
  }

  async function handlePost(post) {
    if (!post?.chat?.id) return;
    if (!post.media_group_id) return ingest([post]);

    const key = `${post.chat.id}:${post.media_group_id}`;
    const entry = albums.get(key) || { posts: [], timer: null };
    entry.posts.push(post);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      albums.delete(key);
      ingest(entry.posts.sort((a, b) => a.message_id - b.message_id));
    }, albumSettleMs);
    if (entry.timer.unref) entry.timer.unref();
    albums.set(key, entry);
  }

  /**
   * The seller edited a post in their channel. The core decides whether that
   * post became a product it should follow; edits to posts we wrote ourselves
   * are ignored there, so our own edits never bounce back.
   */
  async function handleEdit(post) {
    if (!post?.chat?.id) return;
    try {
      const text = post.text || post.caption || '';
      if (!text) return;
      const { product } = await core.ingestChannelEdit({ chatId: String(post.chat.id), messageId: post.message_id, text });
      if (product) log.info(`channel post ${post.message_id} edited — product "${product.title}" updated`);
    } catch (err) {
      log.warn(`channel edit sync failed (chat ${post.chat.id}, message ${post.message_id}): ${err.message}`);
    }
  }

  return { handlePost, handleEdit };
}
