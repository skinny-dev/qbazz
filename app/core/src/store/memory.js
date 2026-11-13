import { newId } from '../util/ids.js';

/**
 * In-memory collection store with a deliberately small, async query surface.
 * Every service talks to this interface only — swapping in Postgres or Mongo
 * later means implementing `collection()` with the same six methods.
 *
 * Query shape:
 *   { where: { field: value | { $in, $nin, $gt, $gte, $lt, $lte, $ne, $exists, $contains, $icontains } }
 *     | (doc) => boolean,
 *     sort: [['createdAt', 'desc']], limit, offset }
 */
export class MemoryStore {
  constructor({ snapshot = null, onChange = null } = {}) {
    this.data = new Map();
    this.onChange = onChange;
    if (snapshot) this.load(snapshot);
  }

  #map(name) {
    if (!this.data.has(name)) this.data.set(name, new Map());
    return this.data.get(name);
  }

  #touched() {
    if (this.onChange) this.onChange();
  }

  collection(name) {
    const map = this.#map(name);
    const store = this;
    return {
      name,

      async insert(doc) {
        const now = new Date().toISOString();
        const record = {
          id: doc.id || newId(name.slice(0, 3)),
          ...doc,
          createdAt: doc.createdAt || now,
          updatedAt: doc.updatedAt || now,
        };
        map.set(record.id, record);
        store.#touched();
        return clone(record);
      },

      async insertMany(docs) {
        const out = [];
        for (const doc of docs) out.push(await this.insert(doc));
        return out;
      },

      async get(id) {
        const found = map.get(id);
        return found ? clone(found) : null;
      },

      async update(id, patch) {
        const current = map.get(id);
        if (!current) return null;
        const next = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
        map.set(id, next);
        store.#touched();
        return clone(next);
      },

      /** Read-modify-write under a single tick — the only safe way to mutate nested state. */
      async mutate(id, mutator) {
        const current = map.get(id);
        if (!current) return null;
        const draft = clone(current);
        const result = await mutator(draft);
        const next = { ...(result || draft), id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
        map.set(id, next);
        store.#touched();
        return clone(next);
      },

      async upsert(id, doc) {
        return map.has(id) ? this.update(id, doc) : this.insert({ ...doc, id });
      },

      async delete(id) {
        const existed = map.delete(id);
        if (existed) store.#touched();
        return existed;
      },

      async deleteWhere(where) {
        let n = 0;
        for (const [id, doc] of map) {
          if (matches(doc, where)) {
            map.delete(id);
            n += 1;
          }
        }
        if (n) store.#touched();
        return n;
      },

      async find(query = {}) {
        const { where, sort, limit, offset = 0 } = query;
        let rows = [...map.values()].filter((doc) => matches(doc, where));
        if (sort) rows = sortRows(rows, sort);
        if (offset) rows = rows.slice(offset);
        if (limit !== undefined) rows = rows.slice(0, limit);
        return rows.map(clone);
      },

      async findOne(where, sort) {
        const rows = await this.find({ where, sort, limit: 1 });
        return rows[0] || null;
      },

      async count(where) {
        if (!where) return map.size;
        let n = 0;
        for (const doc of map.values()) if (matches(doc, where)) n += 1;
        return n;
      },
    };
  }

  /** Whole-database snapshot, used by the JSON driver and by tests. */
  snapshot() {
    const out = {};
    for (const [name, map] of this.data) out[name] = [...map.values()];
    return out;
  }

  load(snapshot) {
    this.data = new Map();
    for (const [name, rows] of Object.entries(snapshot || {})) {
      const map = new Map();
      for (const row of rows || []) map.set(row.id, row);
      this.data.set(name, map);
    }
  }

  async close() {}
}

function clone(value) {
  return structuredClone(value);
}

export function matches(doc, where) {
  if (!where) return true;
  if (typeof where === 'function') return Boolean(where(doc));
  for (const [field, condition] of Object.entries(where)) {
    if (!matchField(readPath(doc, field), condition)) return false;
  }
  return true;
}

function matchField(value, condition) {
  if (condition === undefined) return true;
  if (condition === null) return value === null || value === undefined;
  if (Array.isArray(condition)) return condition.includes(value);
  if (typeof condition === 'object') {
    for (const [op, operand] of Object.entries(condition)) {
      switch (op) {
        case '$in': if (!operand.includes(value)) return false; break;
        case '$nin': if (operand.includes(value)) return false; break;
        case '$ne': if (value === operand) return false; break;
        case '$gt': if (!(value > operand)) return false; break;
        case '$gte': if (!(value >= operand)) return false; break;
        case '$lt': if (!(value < operand)) return false; break;
        case '$lte': if (!(value <= operand)) return false; break;
        case '$exists': if ((value !== undefined && value !== null) !== operand) return false; break;
        case '$contains': if (!Array.isArray(value) || !value.includes(operand)) return false; break;
        case '$containsAny': if (!Array.isArray(value) || !operand.some((o) => value.includes(o))) return false; break;
        case '$icontains': if (!String(value ?? '').toLowerCase().includes(String(operand).toLowerCase())) return false; break;
        default: return false;
      }
    }
    return true;
  }
  return value === condition;
}

export function readPath(doc, path) {
  if (!path.includes('.')) return doc?.[path];
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), doc);
}

function sortRows(rows, sort) {
  const specs = Array.isArray(sort[0]) ? sort : [sort];
  return [...rows].sort((a, b) => {
    for (const [field, dir = 'asc'] of specs) {
      const av = readPath(a, field);
      const bv = readPath(b, field);
      if (av === bv) continue;
      const less = av === undefined || av === null ? true : bv === undefined || bv === null ? false : av < bv;
      return (less ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}
