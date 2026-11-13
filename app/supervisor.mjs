import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * One container, several processes: the core, the website server, the Telegram bot and (when a VPN subscription is
 * given) the Telegram proxy. This keeps each one alive - restarting it with a growing pause when it dies - starts them
 * in the right order and stops them together. Run it as the container's only command: `node supervisor.mjs`.
 */

const stamp = () => new Date().toISOString();

/** Keeps `spec.command` running. Returns { stop() }. Restart pauses grow 1s, 2s, 4s ... up to 30s and reset after a minute of calm. */
export function keepAlive(spec, { log = console.log, spawnImpl = spawn, maxDelayMs = 30000, stableMs = 60000 } = {}) {
  let child = null;
  let stopped = false;
  let delay = 1000;
  let startedAt = 0;
  let timer = null;

  function start() {
    if (stopped) return;
    startedAt = Date.now();
    child = spawnImpl(spec.command, spec.args || [], { cwd: spec.cwd, env: { ...process.env, ...(spec.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const tag = `[${spec.name}]`;
    const pipe = (stream) => stream?.on('data', (chunk) => { for (const line of String(chunk).split(/\r?\n/)) if (line) log(`${tag} ${line}`); });
    pipe(child.stdout);
    pipe(child.stderr);
    child.on('error', (err) => log(`${tag} could not start: ${err.message}`));
    child.on('exit', (code, signal) => {
      child = null;
      if (stopped) return;
      if (Date.now() - startedAt > stableMs) delay = 1000;
      log(`${tag} exited (${signal || code}); restarting in ${Math.round(delay / 1000)}s`);
      timer = setTimeout(start, delay);
      delay = Math.min(delay * 2, maxDelayMs);
    });
    log(`${stamp()} ${tag} started`);
  }
  start();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      return new Promise((resolve) => {
        if (!child) return resolve();
        const kill = setTimeout(() => child?.kill('SIGKILL'), 10000);
        child.once('exit', () => { clearTimeout(kill); resolve(); });
        child.kill('SIGTERM');
      });
    },
    get running() { return Boolean(child); },
  };
}

/** Polls until `url` answers (any status below 500), or gives up after `timeoutMs`. */
export async function waitFor(url, { timeoutMs = 90000, intervalMs = 750, fetchImpl = fetch } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { const res = await fetchImpl(url, { signal: AbortSignal.timeout(3000) }); if (res.status < 500) return true; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/** A value that must survive restarts (the signing secret, the bot's service key): kept in the data volume, made once. */
export function persisted(file, make = () => crypto.randomBytes(32).toString('hex')) {
  try { const v = fs.readFileSync(file, 'utf8').trim(); if (v) return v; } catch { /* first run */ }
  const value = make();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, { mode: 0o600 });
  return value;
}

async function main() {
  const env = process.env;
  const app = path.dirname(fileURLToPath(import.meta.url));
  const data = env.QBAZZ_DATA_DIR || '/data';
  fs.mkdirSync(path.join(data, 'uploads'), { recursive: true });

  // a data export staged by core/scripts/restore-data.js is swapped in now, while nothing is running
  try {
    const { applyPendingRestore, seedOnce } = await import(pathToFileURL(path.join(app, 'core/src/util/dataTransfer.js')).href);
    // a brand-new server: the shop's data baked into the image (encrypted) is brought in once, when its passphrase is given
    const seeded = await seedOnce({ dataDir: data, seedDir: path.join(app, 'seed'), pass: env.QBAZZ_SEED_PASS }).catch((err) => { console.log(`[supervisor] seed not applied: ${err.message}`); return null; });
    if (seeded) console.log(`[supervisor] seed staged: ${seeded.photos} photos`);
    const done = applyPendingRestore(data);
    if (done) console.log(`[supervisor] restored data: ${done.photos} photos${done.backedUp ? `, the previous database kept as ${done.backedUp}` : ''}`);
  } catch (err) {
    console.log(`[supervisor] restoring staged data failed: ${err.message}`);
  }

  const publicPort = String(env.PORT || env.QBAZZ_WEB_PORT || 8000);
  const secret = env.QBAZZ_SECRET || persisted(path.join(data, '.secret'));
  const serviceKey = env.QBAZZ_SERVICE_KEY || persisted(path.join(data, '.service-key'));
  const publicUrl = (env.QBAZZ_WEB_URL || '').replace(/\/$/, '');
  if (!publicUrl) console.log('[supervisor] QBAZZ_WEB_URL is not set - links, QR codes and payment returns need the public address (https://...).');

  const shared = {
    NODE_ENV: 'production',
    QBAZZ_HOST: '127.0.0.1',
    QBAZZ_PORT: '8080',
    QBAZZ_STORAGE: 'json',
    QBAZZ_STORAGE_FILE: path.join(data, 'qbazz.json'),
    QBAZZ_UPLOAD_DIR: path.join(data, 'uploads'),
    QBAZZ_SECRET: secret,
    QBAZZ_SERVICE_KEY: serviceKey,
    QBAZZ_SERVICE_KEYS: serviceKey,
    QBAZZ_CORE_URL: 'http://127.0.0.1:8080',
    QBAZZ_CORE_MODE: 'http',
    QBAZZ_WEB_HOST: '0.0.0.0',
    QBAZZ_WEB_PORT: publicPort,
    ...(publicUrl ? { QBAZZ_API_URL: `${publicUrl}/api`, QBAZZ_PAY_RETURN_URL: publicUrl } : {}),
  };

  const running = [];
  const log = (line) => console.log(line);

  // The Telegram proxy first, so the core and the bot find it already listening.
  const subscription = env.QBAZZ_PROXY_SUBSCRIPTION;
  if (subscription) {
    try {
      const { singBoxConfig } = await import(pathToFileURL(path.join(app, 'core/src/util/proxyConfig.js')).href);
      const configFile = '/tmp/qbazz-proxy.json';
      const refresh = async () => {
        const res = await fetch(subscription, { headers: { 'user-agent': 'v2rayN/6.0' }, signal: AbortSignal.timeout(30000) });
        const config = singBoxConfig(await res.text(), { port: 10809 });
        if (!config) throw new Error('no usable server in the subscription');
        fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
      };
      await refresh();
      const proxy = keepAlive({ name: 'proxy', command: 'sing-box', args: ['run', '-c', configFile] }, { log });
      running.push(proxy);
      shared.TELEGRAM_PROXY = 'http://127.0.0.1:10809';
      // a fresh server list every six hours: sing-box rereads its file on restart
      setInterval(() => refresh().then(() => { console.log('[proxy] server list refreshed'); }).catch((err) => console.log(`[proxy] refresh failed: ${err.message}`)), 6 * 3600 * 1000).unref();
    } catch (err) {
      console.log(`[supervisor] the Telegram proxy was not started: ${err.message}`);
    }
  }

  running.push(keepAlive({ name: 'core', command: 'node', args: ['src/server.js'], cwd: path.join(app, 'core'), env: shared }, { log }));
  if (!(await waitFor('http://127.0.0.1:8080/categories'))) console.log('[supervisor] core did not answer in time; starting the rest anyway');
  running.push(keepAlive({ name: 'web', command: 'node', args: ['serve.mjs'], cwd: path.join(app, 'web'), env: shared }, { log }));

  if (env.TELEGRAM_BOT_TOKEN) {
    running.push(keepAlive({ name: 'bot', command: 'node', args: ['src/index.js'], cwd: path.join(app, 'telegram-integration'), env: shared }, { log }));
  } else {
    console.log('[supervisor] TELEGRAM_BOT_TOKEN is not set - the bot is not started.');
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('[supervisor] stopping ...');
    // bot and web first, the core last, so it can write its database in peace
    for (const proc of [...running].reverse()) await proc.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
