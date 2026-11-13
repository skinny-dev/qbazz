import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MemoryStore } from './memory.js';

/**
 * MemoryStore that persists to a single JSON file. Writes are debounced and
 * atomic (tmp file + rename) so a crash mid-flush cannot truncate the database.
 * Good enough for development and a pilot launch; swap the driver when volume
 * outgrows a single file.
 */
export class JsonFileStore extends MemoryStore {
  constructor({ file, flushMs = 250 } = {}) {
    super({ onChange: () => this.#schedule() });
    this.file = file;
    this.flushMs = flushMs;
    this.timer = null;
    this.writing = null;
    this.dirty = false;
    this.#restore();
  }

  #restore() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        if (raw.trim()) this.load(JSON.parse(raw));
      }
    } catch (err) {
      // A corrupt file must not take the API down; keep a copy and start clean.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, backup);
        console.error(`[store] ${this.file} was unreadable (${err.message}); moved to ${backup}`);
      } catch {
        console.error(`[store] ${this.file} was unreadable: ${err.message}`);
      }
    }
  }

  #schedule() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((err) => console.error('[store] flush failed:', err.message));
    }, this.flushMs);
    if (this.timer.unref) this.timer.unref();
  }

  async flush() {
    if (this.writing) return this.writing;
    if (!this.dirty) return;
    this.dirty = false;
    this.writing = (async () => {
      const payload = JSON.stringify(this.snapshot(), null, 2);
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, payload, 'utf8');
      await fsp.rename(tmp, this.file);
    })();
    try {
      await this.writing;
    } finally {
      this.writing = null;
    }
  }

  async close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirty = true;
    await this.flush();
  }
}

export function createStore(config) {
  const driver = config?.storage?.driver || 'memory';
  if (driver === 'memory') return new MemoryStore();
  if (driver === 'json') return new JsonFileStore(config.storage);
  throw new Error(`Unknown storage driver: ${driver}`);
}
