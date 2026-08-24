// ─── TTL + LRU cache utility ────────────────────────────────
// Shared caching primitive for module-level client caches.
//
// Design:
// - True LRU: get() refreshes recency (Map iteration order trick).
// - Per-entry TTL: expired entries are treated as absent and lazily evicted.
// - Negative results (null) can use a shorter TTL so transient failures
//   are retried after a bounded interval instead of being cached forever.

export interface TtlLruCacheOptions {
  maxSize: number;
  /** TTL for positive (defined) values, ms */
  ttlMs: number;
  /** TTL for negative results (null), ms. Defaults to ttlMs. */
  negativeTtlMs?: number;
}

interface Entry<V> {
  value: V | null;
  ts: number;
}

export class TtlLruCache<V> {
  private readonly _map = new Map<string, Entry<V>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;

  constructor(options: TtlLruCacheOptions) {
    this.maxSize = options.maxSize;
    this.ttlMs = options.ttlMs;
    this.negativeTtlMs = options.negativeTtlMs ?? options.ttlMs;
  }

  /** Returns the value if present and fresh; undefined if absent/expired. */
  get(key: string): V | null | undefined {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    const ttl = entry.value === null ? this.negativeTtlMs : this.ttlMs;
    if (Date.now() - entry.ts > ttl) {
      this._map.delete(key);
      return undefined;
    }
    // LRU refresh: delete + re-insert moves the key to the end (most recent)
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  /** True if the key exists and is fresh. */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Insert/overwrite, evicting the least-recently-used entry when full. */
  set(key: string, value: V | null): void {
    if (this._map.has(key)) this._map.delete(key);
    else if (this._map.size >= this.maxSize) {
      const oldest = this._map.keys().next().value;
      if (oldest !== undefined) this._map.delete(oldest);
    }
    this._map.set(key, { value, ts: Date.now() });
  }

  delete(key: string): void {
    this._map.delete(key);
  }

  clear(): void {
    this._map.clear();
  }

  get size(): number {
    // Lazy eviction on size read keeps the count honest enough for logging
    return this._map.size;
  }
}
