import fs from 'node:fs/promises';
import path from 'node:path';
import { COLLECTIONS } from '../models/schemas.js';
import { ConflictError, ValidationError } from '../errors.js';
import { newId } from '../util/ids.js';
import { randomToken } from '../util/crypto.js';

const MAX_BYTES = 1_500_000; // after decoding; the web client resizes well below this

/** What the file really is, from its first bytes — never from what the client says it is. */
function sniff(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', type: 'image/png' };
  if (buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return null;
}

/**
 * Images uploaded from the website (a product photo during onboarding, later a
 * logo). They are written to disk next to the data file and served back from
 * `/media/u/<name>`; the URL is what products store, exactly like a Telegram
 * photo URL. Only JPEG, PNG and WebP are accepted, identified by content.
 */
export function createUploadsService(ctx) {
  const { store: db, config } = ctx;
  const rows = db.collection(COLLECTIONS.uploads);
  const dir = config.uploads.dir;

  async function saveImage(accountId, base64) {
    if (typeof base64 !== 'string' || !base64) throw ValidationError.of('data', 'validation.required', { field: 'Image' });
    const buffer = Buffer.from(base64.replace(/^data:[^,]*,/, ''), 'base64');
    if (!buffer.length || buffer.length > MAX_BYTES) throw ValidationError.of('data', 'err.upload_size');
    const kind = sniff(buffer);
    if (!kind) throw ValidationError.of('data', 'err.upload_type');
    if ((await rows.count({ accountId })) >= (config.uploads.maxPerAccount || 3000)) throw new ConflictError('err.upload_limit');

    const name = `${randomToken(12).replace(/[^A-Za-z0-9]/g, '').slice(0, 16)}${Date.now().toString(36)}.${kind.ext}`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), buffer);
    const record = await rows.insert({ id: newId('upl'), accountId, name, type: kind.type, bytes: buffer.length });
    return { id: record.id, name, url: `${config.platform.apiBaseUrl}/media/u/${name}`, bytes: buffer.length, type: kind.type };
  }

  async function read(name) {
    if (!/^[A-Za-z0-9]+\.(jpg|png|webp)$/.test(name)) return null;
    try {
      const buffer = await fs.readFile(path.join(dir, name));
      return { buffer, type: sniff(buffer)?.type || 'application/octet-stream' };
    } catch {
      return null;
    }
  }

  /**
   * Uploaded images are stored with the address they were served from. When the site moves (a new host or port),
   * point them at where this core serves them now; anything not ours (a Telegram photo URL) is left alone.
   */
  async function rebase() {
    const base = `${config.platform.apiBaseUrl}/media/u/`;
    const ours = /^https?:\/\/[^?#]*?\/media\/u\//;
    const fix = (url) => (typeof url === 'string' && ours.test(url) && !url.startsWith(base) ? url.replace(ours, base) : url);
    let changed = 0;
    const apply = async (collection, fields) => {
      for (const row of await db.collection(collection).find({ where: (r) => fields.some((f) => (Array.isArray(r[f]) ? r[f].some((u) => fix(u) !== u) : fix(r[f]) !== r[f])) })) {
        const patch = {};
        for (const f of fields) patch[f] = Array.isArray(row[f]) ? row[f].map(fix) : fix(row[f]);
        await db.collection(collection).update(row.id, patch);
        changed++;
      }
    };
    await apply(COLLECTIONS.products, ['images']);
    await apply(COLLECTIONS.stores, ['logoUrl', 'bannerUrl']);
    await apply(COLLECTIONS.accounts, ['avatarUrl']);
    return changed;
  }

  return { saveImage, read, rebase };
}
