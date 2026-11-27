import http from 'node:http';
import { Router } from './router.js';
import { AppError, UnauthorizedError, isAppError } from '../errors.js';
import { effectiveLocale, isSupported, normalizeLocale, translate } from '../i18n/index.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDiscoveryRoutes } from './routes/discovery.js';
import { registerMeRoutes } from './routes/me.js';
import { registerStoreRoutes } from './routes/stores.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerSyncRoutes } from './routes/sync.js';
import { telegramFetch } from '../util/telegramFetch.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { registerChannelRoutes } from './routes/channels.js';

/**
 * HTTP shell over the core.
 *
 * Two ways to authenticate:
 *  • `Authorization: Bearer <session token>` — a real user (web app).
 *  • `X-Qbazz-Service-Key: <key>` plus `X-Qbazz-Account: <accountId>` — a
 *    trusted integration acting for a user. The Telegram bot uses this: it has
 *    already proven who the user is via their Telegram id, so it should not
 *    have to hold a session token per chat.
 */
export function createHttpApi(core) {
  const { config, log } = core;
  publicApiBase = config.platform.apiBaseUrl;
  const router = new Router();

  router.get('/health', async () => ({
    ok: true,
    name: config.platform.name,
    env: config.env,
    cursor: core.services.sync.cursor,
    uptimeSec: Math.round(process.uptime()),
  }));

  registerAuthRoutes(router, core);
  registerDiscoveryRoutes(router, core);
  registerMeRoutes(router, core);
  registerStoreRoutes(router, core);
  registerOnboardingRoutes(router, core);
  registerAdminRoutes(router, core);
  registerSyncRoutes(router, core);
  registerChannelRoutes(router, core);

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    setCors(res, req, config);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/media/tg') return proxyTelegramFile(res, url, config, log);
    if (req.method === 'GET' && url.pathname.startsWith('/media/u/')) {
      const name = url.pathname.slice('/media/u/'.length);
      return name.endsWith('.mp4') ? serveVideo(req, res, name, core) : serveUpload(res, name, core);
    }

    const matched = router.match(req.method, url.pathname);
    if (!matched) return send(res, 404, { error: { code: 'not_found', message: `No route for ${req.method} ${url.pathname}` } });
    if (matched.methodMismatch) return send(res, 405, { error: { code: 'method_not_allowed', message: `${req.method} is not allowed here` } });

    // Known before auth, so even a 401 is worded for the reader.
    const query = Object.fromEntries(url.searchParams);
    let locale = requestLocale(req, query, null, config);

    try {
      // a raw route (a video upload) reads the request itself, after the caller is known
      const body = matched.route.options?.raw ? {} : await readBody(req);
      const auth = await authenticate(req, core, matched.route.options);
      locale = requestLocale(req, query, auth, config);

      const context = {
        req,
        res,
        params: matched.params,
        query,
        body,
        auth,
        accountId: auth?.account?.id || null,
        // The language this caller reads. Services take it as an option, so the
        // same payload comes back worded for whoever asked.
        locale,
        // Which surface the call came from — recorded on carts, orders and events.
        channel: req.headers['x-qbazz-channel'] || query.channel || 'web',
        url,
      };

      const result = await matched.route.handler(context);
      if (res.writableEnded) return; // handler streamed (SSE) or replied itself
      if (result?.__raw) { res.writeHead(200, { 'content-type': result.__raw.type, 'cache-control': 'public, max-age=900' }).end(scrubTelegramUrls(String(result.__raw.body))); return; }
      if (result?.__redirect) { res.writeHead(302, { location: result.__redirect }).end(); return; }
      return send(res, result?.__status || 200, result?.__body ?? result ?? { ok: true });
    } catch (err) {
      return fail(res, err, log, locale);
    } finally {
      log.debug(`${req.method} ${url.pathname} ${Date.now() - started}ms`);
    }
  });

  return {
    server,
    router,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          log.info(`API listening on http://${host}:${port}`);
          resolve(server);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------------------------------------------------------------------------

async function authenticate(req, core, options = {}) {
  const { config, services } = core;
  const serviceKey = req.headers['x-qbazz-service-key'];

  if (serviceKey) {
    if (!config.auth.serviceKeys.includes(serviceKey)) throw new UnauthorizedError('Invalid service key');
    const onBehalfOf = req.headers['x-qbazz-account'];
    if (!onBehalfOf) return { service: true, account: null };
    const account = await services.accounts.get(onBehalfOf);
    if (!account) throw new UnauthorizedError('Unknown account for service call');
    return { service: true, account };
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    if (options.auth === 'required') throw new UnauthorizedError();
    return null;
  }
  return services.accounts.authenticate(token);
}

/** Routes declare `{ auth: 'required' }`; this enforces it after resolution. */
export function requireAuth(ctx) {
  if (!ctx.auth?.account) throw new UnauthorizedError();
  return ctx.auth.account;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'DELETE') return resolve({});
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(new AppError('Request body too large', { status: 413, code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      const type = req.headers['content-type'] || '';
      try {
        if (type.includes('application/x-www-form-urlencoded')) {
          return resolve(Object.fromEntries(new URLSearchParams(raw)));
        }
        resolve(JSON.parse(raw));
      } catch {
        reject(new AppError('Invalid JSON body', { status: 400, code: 'invalid_json' }));
      }
    });
    req.on('error', reject);
  });
}

function setCors(res, req, config) {
  // The web app and the bot are separate origins; allow credentials-free CORS.
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-qbazz-service-key,x-qbazz-account,x-qbazz-channel,x-qbazz-locale,accept-language');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// Telegram's own file URLs embed the bot token, and products store them that
// way. Anything leaving the public API is rewritten to a media URL on this
// server instead, so a browser never sees the token.
// Stops at a quote, a backslash (inside JSON), a tag or a space, so it works on XML (the sitemap) as well as JSON.
const TG_FILE_URL = /https:\/\/api\.telegram\.org\/file\/bot[^/"\\<\s]+\/([^"\\<\s]+)/g;
let publicApiBase = 'http://localhost:8080';

export function scrubTelegramUrls(json) {
  return json.replace(TG_FILE_URL, (_m, path) => `${publicApiBase}/media/tg?p=${encodeURIComponent(path)}`);
}

/** A video is streamed from disk, in the byte ranges a player asks for (Safari will not play one otherwise). */
async function serveVideo(req, res, name, core) {
  const file = core.services.videos.pathOf(name);
  const info = file ? await stat(file).catch(() => null) : null;
  if (!info) return send(res, 404, { error: { code: 'not_found', message: 'No such media' } });
  const head = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, info.size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), info.size - 1) : info.size - 1;
    if (start >= info.size || start > end) { res.writeHead(416, { 'content-range': `bytes */${info.size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1 });
    return createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  }
  res.writeHead(200, { ...head, 'content-length': info.size });
  return createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

async function serveUpload(res, name, core) {
  const file = await core.services.uploads.read(name);
  if (!file) return send(res, 404, { error: { code: 'not_found', message: 'No such media' } });
  res.writeHead(200, { 'content-type': file.type, 'content-length': file.buffer.length, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
  res.end(file.buffer);
}

async function proxyTelegramFile(res, url, config, log) {
  const path = url.searchParams.get('p') || '';
  if (!config.telegram?.botToken || !/^[\w\-./]+$/.test(path) || path.includes('..')) {
    return send(res, 404, { error: { code: 'not_found', message: 'No such media' } });
  }
  try {
    const upstream = await telegramFetch(config.telegram.proxy)(`${String(config.telegram.apiBase || 'https://api.telegram.org').replace(/\/+$/, '')}/file/bot${config.telegram.botToken}/${path}`);
    if (!upstream.ok) return send(res, 404, { error: { code: 'not_found', message: 'No such media' } });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    // Telegram serves these as octet-stream; say what they actually are.
    const upstreamType = upstream.headers.get('content-type') || '';
    const type = upstreamType.startsWith('image/') ? upstreamType : (/\.png$/i.test(path) ? 'image/png' : /\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg');
    res.writeHead(200, { 'content-type': type, 'content-length': buffer.length, 'cache-control': 'public, max-age=86400' });
    res.end(buffer);
  } catch (err) {
    log.warn(`media proxy failed for ${path}: ${err.message}`);
    send(res, 502, { error: { code: 'bad_gateway', message: 'Media unavailable' } });
  }
}

function send(res, status, payload) {
  const body = scrubTelegramUrls(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function fail(res, err, log, locale = 'en') {
  if (isAppError(err)) {
    if (err.status >= 500) log.error(`${err.code}: ${err.message}`, err.stack);
    return send(res, err.status, err.toJSON(locale));
  }
  log.error(`unhandled: ${err?.message}`, err?.stack);
  return send(res, 500, { error: { code: 'internal_error', message: translate(locale, 'err.internal') } });
}

/**
 * Which language to answer in. In order: an explicit request (`X-Qbazz-Locale`
 * header or `?lang=`), the signed-in person's own setting, the browser's
 * `Accept-Language`, then the platform default.
 */
function requestLocale(req, query, auth, config) {
  const explicit = req.headers['x-qbazz-locale'] || query.lang;
  if (explicit && isSupported(normalizeLocale(explicit, ''))) return normalizeLocale(explicit);
  if (auth?.account) return effectiveLocale(auth.account, config.platform.defaultLocale);
  for (const part of String(req.headers['accept-language'] || '').split(',')) {
    const tag = normalizeLocale(part.split(';')[0].trim(), '');
    if (tag) return tag;
  }
  return normalizeLocale(config.platform.defaultLocale);
}

/** Handlers return `status(201, body)` when they need a non-200 code. */
export function status(code, body) {
  return { __status: code, __body: body };
}
