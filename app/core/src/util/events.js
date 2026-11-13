/**
 * In-process event bus. Services publish domain events; the outbox subscribes
 * to persist them for cursor sync, and integrations subscribe to react
 * (notify a buyer on Telegram, push a webhook to the web app).
 */
export class EventBus {
  #handlers = new Map();
  #wildcard = new Set();

  on(type, handler) {
    if (type === '*') {
      this.#wildcard.add(handler);
      return () => this.#wildcard.delete(handler);
    }
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(handler);
    return () => this.#handlers.get(type)?.delete(handler);
  }

  once(type, handler) {
    const off = this.on(type, async (...args) => {
      off();
      await handler(...args);
    });
    return off;
  }

  /** Never rejects: a broken subscriber must not roll back a completed write. */
  async emit(type, payload) {
    const event = { type, payload, at: new Date().toISOString() };
    const targets = [...(this.#handlers.get(type) || []), ...this.#wildcard];
    await Promise.all(
      targets.map(async (handler) => {
        try {
          await handler(event);
        } catch (err) {
          console.error(`[events] handler for ${type} failed:`, err?.message || err);
        }
      }),
    );
    return event;
  }
}
