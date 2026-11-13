import { createCore } from './index.js';
import { createHttpApi } from './api/http.js';

/** Entry point: `node qbazz-core/src/server.js`. */
const core = await createCore();
const api = createHttpApi(core);
await api.listen();

// Online orders nobody paid for lapse, and their stock goes back on the shelf.
// Plans that ran out: lapse what is due and tell owners, once, about each step (only when the platform enforces subscriptions).
setInterval(() => core.services.subscriptions.sweep().catch((err) => core.log.error(`subscription sweep failed: ${err.message}`)), 3_600_000).unref();
setTimeout(() => core.services.subscriptions.sweep().catch(() => {}), 30_000).unref();
setInterval(() => core.services.gateway.sweepExpired().catch((err) => core.log.error(`payment sweep failed: ${err.message}`)), 60_000).unref();

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    core.log.info(`${signal} received — flushing and shutting down`);
    await api.close();
    await core.close();
    process.exit(0);
  });
}

process.on('unhandledRejection', (err) => core.log.error(`unhandled rejection: ${err?.message || err}`));
