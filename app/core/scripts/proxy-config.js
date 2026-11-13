/**
 * Reads a VPN subscription on stdin and writes the sing-box config for Qbazz's Telegram proxy to stdout
 * (see src/util/proxyConfig.js). Used by deploy/enable-proxy.sh.
 *
 *   curl -sSL "<subscription url>" | node scripts/proxy-config.js [port]
 */
import { outboundsFrom, singBoxConfig } from '../src/util/proxyConfig.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const text = Buffer.concat(chunks).toString('utf8');
const port = Number(process.argv[2]) || 10809;

const config = singBoxConfig(text, { port });
if (!config) { console.error('No usable server found in that subscription (vless, vmess, trojan and shadowsocks links are understood).'); process.exit(1); }
const kinds = {};
for (const o of outboundsFrom(text)) kinds[o.type] = (kinds[o.type] || 0) + 1;
console.error(`Found ${config.outbounds.length - 2} servers: ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}`);
process.stdout.write(JSON.stringify(config, null, 2));
