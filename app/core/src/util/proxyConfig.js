/**
 * Turns a VPN subscription (the list a provider hands out: vless://, vmess://, trojan://, ss:// links, usually base64'd,
 * or already a sing-box config) into a sing-box config that does ONE thing: an HTTP proxy on 127.0.0.1 that sends
 * Telegram through the best working server of the subscription and everything else straight out. The bot and the core
 * point TELEGRAM_PROXY at it; nothing else on the server is rerouted.
 */

// Telegram, and the AI providers that refuse requests from Iran (Google's Gemini, OpenAI, Anthropic)
const TELEGRAM_DOMAINS = ['telegram.org', 't.me', 'telegram.me', 'telegra.ph', 'tg.dev', 'generativelanguage.googleapis.com', 'api.openai.com', 'api.anthropic.com'];

const b64 = (text) => Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const looksBase64 = (text) => /^[A-Za-z0-9+/=_\-\s]+$/.test(text) && text.replace(/\s/g, '').length % 4 !== 1;

function transportOf(type, params) {
  switch (type) {
    case 'ws': return { type: 'ws', path: params.path || '/', ...(params.host ? { headers: { Host: params.host } } : {}) };
    case 'grpc': return { type: 'grpc', service_name: params.serviceName || params.path || '' };
    case 'httpupgrade': return { type: 'httpupgrade', path: params.path || '/', ...(params.host ? { host: params.host } : {}) };
    case 'tcp': case '': case undefined: case 'none': return null;
    default: return undefined; // a transport sing-box cannot do (xhttp, kcp, quic ...): skip the server
  }
}

function tlsOf(params, host) {
  const security = params.security || '';
  if (security !== 'tls' && security !== 'reality') return null;
  const tls = { enabled: true, server_name: params.sni || params.peer || params.host || host };
  if (params.fp) tls.utls = { enabled: true, fingerprint: params.fp };
  if (params.alpn) tls.alpn = params.alpn.split(',');
  if (params.allowInsecure === '1' || params.insecure === '1') tls.insecure = true;
  if (security === 'reality') {
    if (!params.pbk) return undefined;
    tls.reality = { enabled: true, public_key: params.pbk, short_id: params.sid || '' };
    tls.utls = tls.utls || { enabled: true, fingerprint: 'chrome' };
  }
  return tls;
}

function withTransport(out, type, params, tls) {
  const transport = transportOf(type, params);
  if (transport === undefined || tls === undefined) return null;
  if (transport) out.transport = transport;
  if (tls) out.tls = tls;
  return out;
}

/** One share link -> one sing-box outbound, or null when it is a kind this cannot use. */
export function parseLink(raw) {
  const link = String(raw || '').trim();
  const scheme = link.match(/^([a-z0-9]+):\/\//i)?.[1]?.toLowerCase();
  try {
    if (scheme === 'vmess') {
      const j = JSON.parse(b64(link.slice(8)));
      const params = { host: j.host, path: j.path, serviceName: j.path, sni: j.sni, alpn: j.alpn, fp: j.fp, security: j.tls === 'tls' ? 'tls' : '' };
      const out = { type: 'vmess', tag: j.ps || `${j.add}:${j.port}`, server: j.add, server_port: Number(j.port), uuid: j.id, security: j.scy || 'auto', alter_id: Number(j.aid) || 0 };
      return withTransport(out, j.net === 'h2' ? 'http' : j.net, params, tlsOf(params, j.add));
    }
    if (scheme === 'ss') {
      const url = new URL(link);
      let method; let password; let host; let port;
      if (url.username) {
        const cred = url.password ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : b64(decodeURIComponent(url.username));
        method = cred.slice(0, cred.indexOf(':'));
        password = cred.slice(cred.indexOf(':') + 1);
        host = url.hostname; port = url.port;
      } else {
        const body = b64(link.slice(5).split('#')[0]);
        const m = body.match(/^([^:]+):(.*)@([^@:]+):(\d+)$/);
        if (!m) return null;
        [, method, password, host, port] = m;
      }
      return { type: 'shadowsocks', tag: decodeURIComponent(url.hash.slice(1)) || `${host}:${port}`, server: host, server_port: Number(port), method, password };
    }
    if (scheme === 'vless' || scheme === 'trojan') {
      const url = new URL(link);
      const params = Object.fromEntries(url.searchParams);
      const tag = decodeURIComponent(url.hash.slice(1)) || `${url.hostname}:${url.port}`;
      const out = { type: scheme, tag, server: url.hostname.replace(/^\[|\]$/g, ''), server_port: Number(url.port) };
      if (scheme === 'vless') { out.uuid = decodeURIComponent(url.username); if (params.flow) out.flow = params.flow; } else out.password = decodeURIComponent(url.username);
      const tls = tlsOf(params, url.hostname) ?? (scheme === 'trojan' ? tlsOf({ ...params, security: 'tls' }, url.hostname) : null);
      return withTransport(out, params.type, params, tls);
    }
  } catch { /* a link this cannot read: skipped */ }
  return null;
}

/** The subscription's text -> its outbounds (de-duplicated tags). Understands a list of links, base64 of one, or a sing-box config. */
export function outboundsFrom(text, { limit = 40 } = {}) {
  const body = String(text || '').trim();
  let outs = [];
  if (body.startsWith('{')) {
    try { outs = (JSON.parse(body).outbounds || []).filter((o) => !['direct', 'block', 'dns', 'selector', 'urltest'].includes(o.type)); } catch { outs = []; }
  } else {
    const decoded = /^[a-z0-9]+:\/\//i.test(body) ? body : (looksBase64(body) ? b64(body) : body);
    outs = decoded.split(/\r?\n/).map(parseLink).filter(Boolean);
  }
  const seen = new Set();
  return outs.filter((o) => o.server && o.server_port).map((o) => {
    let tag = String(o.tag || `${o.server}:${o.server_port}`);
    while (seen.has(tag)) tag += '+';
    seen.add(tag);
    return { ...o, tag };
  }).slice(0, limit);
}

/** The finished sing-box config: an HTTP inbound, the best-of-all outbound for Telegram, direct for the rest. */
export function singBoxConfig(subscriptionText, { port = 10809, limit = 40 } = {}) {
  const proxies = outboundsFrom(subscriptionText, { limit });
  if (!proxies.length) return null;
  return {
    log: { level: 'warn' },
    inbounds: [{ type: 'http', tag: 'in', listen: '127.0.0.1', listen_port: port }],
    outbounds: [
      ...proxies,
      { type: 'urltest', tag: 'auto', outbounds: proxies.map((o) => o.tag), url: 'https://api.telegram.org', interval: '3m', tolerance: 100 },
      { type: 'direct', tag: 'direct' },
    ],
    route: { rules: [{ domain_suffix: TELEGRAM_DOMAINS, outbound: 'auto' }], final: 'direct' },
  };
}
