/**
 * In-memory limiter for failed authentications. Failures are counted per key (the caller
 * uses one key per client address and one per token prefix) in a fixed window; once a key has
 * `maxFailures` in the window it is refused until the window ends, and the answer says how many
 * seconds to wait (`Retry-After`). Memory is bounded: at most `maxKeys` keys are tracked and the
 * oldest window is dropped first, so spraying random prefixes cannot grow the process.
 *
 * It is per process: with several replicas each keeps its own count, which only loosens the limit.
 */
export interface FailureLimiterOptions {
  /** Failures allowed per key and window (default 10). */
  readonly maxFailures?: number;
  /** Window length in milliseconds (default 60 000). */
  readonly windowMs?: number;
  /** Most keys tracked at once (default 10 000). */
  readonly maxKeys?: number;
  /** Clock, for tests (default `Date.now`). */
  readonly now?: () => number;
}

export type LimitCheck =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

interface Window {
  count: number;
  resetAt: number;
}

export class FailureLimiter {
  readonly #maxFailures: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  /** Map iteration order is insertion order, so the first key is the oldest window. */
  readonly #windows = new Map<string, Window>();

  constructor(options: FailureLimiterOptions = {}) {
    this.#maxFailures = options.maxFailures ?? 10;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#maxKeys = options.maxKeys ?? 10_000;
    this.#now = options.now ?? Date.now;
    if (!Number.isInteger(this.#maxFailures) || this.#maxFailures < 1) {
      throw new RangeError("maxFailures must be a positive integer");
    }
    if (!Number.isFinite(this.#windowMs) || this.#windowMs <= 0) {
      throw new RangeError("windowMs must be a positive number");
    }
    if (!Number.isInteger(this.#maxKeys) || this.#maxKeys < 1) {
      throw new RangeError("maxKeys must be a positive integer");
    }
  }

  /** Whether any of `keys` is over its limit; the wait is the longest of the blocked ones. */
  check(keys: readonly string[]): LimitCheck {
    const now = this.#now();
    let waitMs = 0;
    for (const key of keys) {
      const window = this.#live(key, now);
      if (window !== undefined && window.count >= this.#maxFailures) {
        waitMs = Math.max(waitMs, window.resetAt - now);
      }
    }
    return waitMs > 0
      ? { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) }
      : { allowed: true };
  }

  /** Counts one failure against every key. */
  recordFailure(keys: readonly string[]): void {
    const now = this.#now();
    for (const key of keys) {
      const window = this.#live(key, now);
      if (window === undefined) {
        this.#windows.set(key, { count: 1, resetAt: now + this.#windowMs });
        this.#evict();
      } else {
        window.count += 1;
      }
    }
  }

  /** Number of keys currently tracked (for tests and metrics). */
  get size(): number {
    return this.#windows.size;
  }

  #live(key: string, now: number): Window | undefined {
    const window = this.#windows.get(key);
    if (window !== undefined && window.resetAt <= now) {
      this.#windows.delete(key);
      return undefined;
    }
    return window;
  }

  #evict(): void {
    while (this.#windows.size > this.#maxKeys) {
      const oldest = this.#windows.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.#windows.delete(oldest.value);
    }
  }
}
