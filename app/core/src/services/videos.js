import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { COLLECTIONS } from '../models/schemas.js';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../util/ids.js';
import { randomToken } from '../util/crypto.js';

/**
 * Product videos. A phone clip arrives large and in whatever codec the phone likes; what is kept is a web copy:
 * H.264 + AAC in MP4, at most 720 pixels on the short side, a modest bitrate, the index at the front so it starts
 * playing while it downloads, and a still frame to show before anyone presses play. The original is thrown away.
 *
 * Upload answers at once ("processing"); the conversion runs in the background, one at a time so a small server keeps
 * serving pages, and the caller asks for the status until it is "ready" or "failed".
 */

/** What the file really is, from its first bytes: MP4 / MOV / 3GP ("ftyp"), or WebM / Matroska. */
export function sniffVideo(head) {
  if (head.length >= 12 && head.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'webm';
  return null;
}

/** The ffmpeg arguments, in one place. Dimensions stay even (H.264 needs it) and nothing is ever scaled up. */
export function encodeArgs(input, output, { maxSeconds }) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    // only local files may be opened: a crafted container cannot make ffmpeg fetch an address
    '-protocol_whitelist', 'file,pipe', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?', '-t', String(maxSeconds),
    '-vf', "scale='if(gt(iw,ih),-2,min(720,iw))':'if(gt(iw,ih),min(720,ih),-2)',scale=trunc(iw/2)*2:trunc(ih/2)*2",
    '-fpsmax', '30', // a 60 fps clip is halved; a slower one is left as it is
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-maxrate', '1800k', '-bufsize', '3600k', '-pix_fmt', 'yuv420p', '-profile:v', 'main',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
    '-map_metadata', '-1', '-movflags', '+faststart', '-threads', '2', output,
  ];
}

const run = (bin, args, timeout) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    if (err) reject(Object.assign(new Error(String(stderr || err.message).slice(-600)), { missing: err.code === 'ENOENT' }));
    else resolve(stdout);
  });
});

/** The real converter. A caller may inject another (tests). */
export function ffmpegTranscoder({ ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' } = {}) {
  return {
    async probe(file) {
      const out = await run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-print_format', 'json', '-show_format', '-show_streams', file], 30_000);
      const info = JSON.parse(out);
      const video = (info.streams || []).find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
      return { hasVideo: Boolean(video), seconds: Number(info.format?.duration || video?.duration || 0), width: video?.width || 0, height: video?.height || 0 };
    },
    async convert(input, output, options) { await run(ffmpeg, encodeArgs(input, output, options), 10 * 60_000); },
    async poster(video, output) {
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-ss', '0.3', '-i', video, '-frames:v', '1', '-q:v', '4', output], 60_000);
    },
  };
}

export function createVideosService(ctx) {
  const { store: db, config, log, events } = ctx;
  const rows = db.collection(COLLECTIONS.uploads);
  const dir = config.uploads.dir;
  const settings = config.video || {};
  const transcoder = settings.transcoder || ffmpegTranscoder(settings);
  const maxBytes = settings.maxBytes || 60_000_000;
  const maxSeconds = settings.maxSeconds || 90;
  const base = () => `${config.platform.apiBaseUrl}/media/u/`;

  const view = (r) => ({
    id: r.id, status: r.status, error: r.error || null, seconds: r.seconds || null, bytes: r.bytes || 0,
    url: r.status === 'ready' ? `${base()}${r.name}` : null,
    poster: r.status === 'ready' && r.posterName ? `${base()}${r.posterName}` : null,
  });

  let queue = Promise.resolve();
  const enqueue = (id) => { queue = queue.then(() => process1(id)).catch((err) => log?.warn?.(`video ${id}: ${err.message}`)); return queue; };

  /**
   * Takes the bytes (a request stream, or a buffer from Telegram), keeps them aside, and starts the conversion.
   * Refused early: too large, or not a video at all.
   */
  async function save(accountId, source) {
    if ((await rows.count({ accountId, kind: 'video' })) >= (settings.maxPerAccount || 300)) throw new ConflictError('err.upload_limit');
    await fs.mkdir(dir, { recursive: true });
    const name = `${randomToken(12).replace(/[^A-Za-z0-9]/g, '').slice(0, 16)}${Date.now().toString(36)}`;
    const raw = path.join(dir, `${name}.src`);
    let size = 0;
    let head = Buffer.alloc(0);
    const gate = new Transform({
      transform(chunk, _enc, done) {
        size += chunk.length;
        if (head.length < 12) head = Buffer.concat([head, chunk]).subarray(0, 12);
        if (size > maxBytes) return done(new AppError('Video too large', { status: 413, code: 'payload_too_large', key: 'err.video_size', params: { mb: Math.floor(maxBytes / 1_000_000) } }));
        return done(null, chunk);
      },
    });
    try {
      await pipeline(Buffer.isBuffer(source) ? Readable.from([source]) : source, gate, createWriteStream(raw));
      if (!size || !sniffVideo(head)) throw ValidationError.of('video', 'err.video_type');
    } catch (err) {
      await fs.rm(raw, { force: true });
      throw err;
    }
    const record = await rows.insert({ id: newId('upl'), accountId, kind: 'video', status: 'processing', name: `${name}.mp4`, posterName: null, source: `${name}.src`, type: 'video/mp4', bytes: size });
    enqueue(record.id);
    return view(record);
  }

  async function process1(id) {
    const record = await rows.get(id);
    if (!record || record.status !== 'processing') return;
    const raw = path.join(dir, record.source);
    const out = path.join(dir, record.name);
    const posterName = record.name.replace(/\.mp4$/, '.jpg');
    const fail = async (key, detail) => {
      log?.warn?.(`video ${id} not converted: ${detail || key}`);
      await fs.rm(out, { force: true });
      await rows.update(id, { status: 'failed', error: key });
    };
    try {
      const info = await transcoder.probe(raw);
      if (!info.hasVideo) { await fail('err.video_type'); return; }
      if (info.seconds > maxSeconds + 1) { await fail('err.video_long'); return; }
      await transcoder.convert(raw, out, { maxSeconds });
      await transcoder.poster(out, path.join(dir, posterName)).catch((err) => log?.warn?.(`video ${id}: no poster (${err.message})`));
      const { size } = await fs.stat(out);
      const hasPoster = await fs.stat(path.join(dir, posterName)).then(() => true, () => false);
      await rows.update(id, { status: 'ready', error: null, posterName: hasPoster ? posterName : null, bytes: size, seconds: Math.round(info.seconds) });
      await events.emit('video.ready', { videoId: id, accountId: record.accountId });
    } catch (err) {
      await fail(err.missing ? 'err.video_unavailable' : 'err.video_failed', err.message);
    } finally {
      await fs.rm(raw, { force: true });
    }
  }

  async function get(accountId, id) {
    const record = await rows.get(id);
    if (!record || record.kind !== 'video' || record.accountId !== accountId) throw new NotFoundError('Video', id);
    return view(record);
  }

  /** Waits for the queue (the bot and tests want the finished thing). */
  async function ready(accountId, id) {
    await queue;
    return get(accountId, id);
  }

  /** A product may only point at a video this server made. Returns the url and its poster, or throws. */
  async function resolveUrl(url) {
    const name = String(url || '').split('/media/u/')[1];
    const record = name ? await rows.findOne({ name, kind: 'video' }) : null;
    if (!record || record.status !== 'ready') throw ValidationError.of('videoUrl', 'err.video_type');
    return view(record);
  }

  /** A server that stopped mid-conversion starts those again. */
  async function recover() {
    const stuck = await rows.find({ where: (r) => r.kind === 'video' && r.status === 'processing' });
    for (const record of stuck) enqueue(record.id);
    return stuck.length;
  }

  /** The file on disk for a public name, for streaming. */
  const pathOf = (name) => (/^[A-Za-z0-9]+\.mp4$/.test(name) ? path.join(dir, name) : null);

  return { save, get, ready, resolveUrl, recover, pathOf };
}
