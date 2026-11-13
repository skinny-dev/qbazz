import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

/**
 * `fetch` for Telegram only, optionally through an HTTP proxy (the local port of a VPN client such as v2rayN's
 * "http 10809", or a sing-box/xray inbound). Everything else the server talks to - the SMS gateway, the payment
 * provider - keeps going out directly, which is why this is not a global proxy setting.
 *
 *   TELEGRAM_PROXY=http://127.0.0.1:10809
 *
 * Without a proxy this is plain `fetch`. HTTP proxies only (CONNECT); a SOCKS-only port needs an HTTP inbound beside it.
 */
export function telegramFetch(proxyUrl) {
  if (!proxyUrl) return (...args) => fetch(...args);
  const proxy = new URL(proxyUrl);
  const auth = proxy.username ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` : null;

  function tunnel(target, signal) {
    return new Promise((resolve, reject) => {
      const port = target.port || (target.protocol === 'https:' ? 443 : 80);
      const req = http.request({
        host: proxy.hostname,
        port: proxy.port || 80,
        method: 'CONNECT',
        path: `${target.hostname}:${port}`,
        headers: { host: `${target.hostname}:${port}`, ...(auth ? { 'proxy-authorization': auth } : {}) },
        timeout: 15000,
        signal,
      });
      req.on('connect', (res, socket) => {
        if (res.statusCode === 200) resolve(socket);
        else { socket.destroy(); reject(new Error(`proxy refused the connection (${res.statusCode})`)); }
      });
      req.on('timeout', () => req.destroy(new Error('proxy did not answer in time')));
      req.on('error', reject);
      req.end();
    });
  }

  return async function proxiedFetch(input, init = {}) {
    const target = new URL(typeof input === 'string' ? input : input.url);
    const signal = init.signal;
    const socket = await tunnel(target, signal);
    const secure = target.protocol === 'https:';
    const agent = new (secure ? https : http).Agent({ keepAlive: false });
    agent.createConnection = () => (secure ? tls.connect({ socket, servername: target.hostname }) : socket);

    const body = init.body === undefined || init.body === null ? null : Buffer.isBuffer(init.body) ? init.body : Buffer.from(typeof init.body === 'string' ? init.body : await new Response(init.body).arrayBuffer());
    const headers = Object.fromEntries(new Headers(init.headers || {}));
    if (body && !headers['content-length']) headers['content-length'] = String(body.length);

    return new Promise((resolve, reject) => {
      const req = (secure ? https : http).request(target, { method: init.method || 'GET', headers, agent, signal }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const out = new Headers();
          for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) out.set(key, Array.isArray(value) ? value.join(', ') : value);
          // a Response may not carry a body for these
          const empty = [101, 204, 205, 304].includes(res.statusCode);
          resolve(new Response(empty ? null : Buffer.concat(chunks), { status: res.statusCode, statusText: res.statusMessage, headers: out }));
        });
      });
      req.on('error', (err) => { socket.destroy(); reject(err); });
      if (body) req.write(body);
      req.end();
    });
  };
}
