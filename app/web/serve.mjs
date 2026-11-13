import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { inject, CORE } from './seo-inject.mjs';

/**
 * Production web server: the built app from dist/, with each public page's head and readable body filled in by core
 * (see seo-inject.mjs), real 404s for pages that do not exist, and sitemap.xml / robots.txt passed through from core.
 * Run after `npm run build`:  npm run serve --workspace qbazz-web
 */
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const PORT = Number(process.env.QBAZZ_WEB_PORT) || 5190;
const HOST = process.env.QBAZZ_WEB_HOST || '0.0.0.0';
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

/** Text assets go out Brotli- or gzip-compressed (the app's JS shrinks to about a quarter); built once per file and kept. */
const COMPRESSIBLE = new Set(['.js', '.css', '.svg', '.json', '.txt']);
const packed = new Map();
function pack(file, data, accept) {
  const kind = /br/.test(accept) ? 'br' : /gzip/.test(accept) ? 'gzip' : null;
  if (!kind || !COMPRESSIBLE.has(path.extname(file)) || data.length < 1024) return { data, kind: null };
  const key = `${kind}:${file}:${data.length}`;
  if (!packed.has(key)) packed.set(key, kind === 'br' ? zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }) : zlib.gzipSync(data, { level: 9 }));
  return { data: packed.get(key), kind };
}

/** One public address for everything: /api/* goes to core (without the prefix), so a single open port is enough. */
function proxyToCore(req, res, url) {
  const target = new URL(url.pathname.replace(/^\/api/, '') + url.search, CORE);
  const upstream = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (back) => {
    res.writeHead(back.statusCode || 502, back.headers);
    back.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":{"code":"unavailable","message":"core is not reachable"}}'); });
  req.pipe(upstream);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) { proxyToCore(req, res, url); return; }
    if (url.pathname === '/sitemap.xml' || url.pathname === '/robots.txt') {
      const upstream = await fetch(`${CORE}${url.pathname}`);
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'text/plain', 'cache-control': 'public, max-age=900' }).end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    const file = path.join(DIST, path.normalize(url.pathname).replace(/^([/\\])+/, ''));
    if (file.startsWith(DIST) && path.extname(file)) {
      try {
        const data = await fs.readFile(file);
        const immutable = url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/');
        const out = pack(file, data, String(req.headers['accept-encoding'] || ''));
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600', vary: 'accept-encoding', ...(out.kind ? { 'content-encoding': out.kind } : {}) }).end(out.data);
        return;
      } catch { /* not a file: fall through to the app */ }
    }
    // The app talks to core through this same server.
    const template = (await fs.readFile(path.join(DIST, 'index.html'), 'utf8')).replace('<head>', '<head>\n    <script>window.__QBAZZ_API__ = "/api";</script>');
    const { html, status } = await inject(template, url.pathname);
    const accept = String(req.headers['accept-encoding'] || '');
    const kind = /br/.test(accept) ? 'br' : /gzip/.test(accept) ? 'gzip' : null;
    const body = kind === 'br' ? zlib.brotliCompressSync(Buffer.from(html), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }) : kind === 'gzip' ? zlib.gzipSync(html) : html;
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=0, must-revalidate', vary: 'accept-encoding', ...(kind ? { 'content-encoding': kind } : {}), ...(status === 404 ? { 'x-robots-tag': 'noindex' } : {}) }).end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err?.message || err));
  }
}).listen(PORT, HOST, () => console.log(`qbazz-web serving dist on http://localhost:${PORT} (core: ${CORE})`));
