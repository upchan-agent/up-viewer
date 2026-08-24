// ─── Shared concurrency limiter ─────────────────────────────
// Bounds parallel async fetches (RPC / IPFS / indexer fallbacks).
// Used by both asset-image-cache and profile-image-cache.

interface QueueItem {
  fn: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class ConcurrencyLimiter {
  private _active = 0;
  private readonly _queue: QueueItem[] = [];

  constructor(private readonly maxConcurrent: number) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this._queue.push({ fn: fn as () => Promise<unknown>, resolve: resolve as (v: unknown) => void, reject });
      this._drain();
    });
  }

  private _drain() {
    while (this._active < this.maxConcurrent && this._queue.length > 0) {
      const { fn, resolve, reject } = this._queue.shift()!;
      this._active++;
      fn()
        .then(resolve)
        .catch(reject)
        .finally(() => { this._active--; this._drain(); });
    }
  }
}
