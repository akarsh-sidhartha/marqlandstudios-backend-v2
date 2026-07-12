'use strict';
/**
 * middleware/security/rateLimiter.js
 *
 * Token Bucket rate limiter. Each client key (by default, IP address) owns
 * a bucket of `capacity` tokens that refill continuously at `refillPerSec`
 * tokens/sec. Every request consumes 1 token; once the bucket is empty the
 * request is rejected with 429 + Retry-After. Bursts up to `capacity` are
 * allowed, smoothing out to `refillPerSec` sustained — this is what makes
 * token bucket a better fit than a fixed window here: a user double-
 * clicking submit isn't punished, but a script hammering the endpoint hits
 * the sustained ceiling immediately.
 *
 * Storage is in-process (Map), which is correct for a single-instance
 * deployment. If this API ever runs multiple instances behind a load
 * balancer, swap `InMemoryBucketStore` for a Redis-backed store (e.g. a
 * Lua script doing the same refill math atomically so concurrent
 * instances share one bucket) — `createRateLimiter` itself doesn't need
 * to change, only the store it's given.
 */

const AppError = require('../../lib/errors/AppError');
const logger = require('../../utils/logger').child({ module: 'rateLimiter' });

class TokenBucket {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefill = now;
  }

  consume(cost = 1) {
    this._refill();
    if (this.tokens < cost) {
      const deficit = cost - this.tokens;
      const retryAfterSec = Math.max(1, Math.ceil(deficit / this.refillPerSec));
      return { allowed: false, retryAfterSec, remaining: Math.floor(this.tokens) };
    }
    this.tokens -= cost;
    return { allowed: true, retryAfterSec: 0, remaining: Math.floor(this.tokens) };
  }
}

// Keyed store with lazy idle eviction, so buckets for clients that stop
// sending traffic don't accumulate in memory forever.
class InMemoryBucketStore {
  constructor({ capacity, refillPerSec, idleTtlMs = 10 * 60 * 1000 }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.idleTtlMs = idleTtlMs;
    this.buckets = new Map(); // key -> { bucket, lastSeen }
    this.sweepTimer = setInterval(() => this._sweep(), idleTtlMs);
    this.sweepTimer.unref?.(); // never keep the process alive just for this
  }

  _sweep() {
    const cutoff = Date.now() - this.idleTtlMs;
    for (const [key, entry] of this.buckets) {
      if (entry.lastSeen < cutoff) this.buckets.delete(key);
    }
  }

  consume(key, cost = 1) {
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = { bucket: new TokenBucket(this.capacity, this.refillPerSec), lastSeen: 0 };
      this.buckets.set(key, entry);
    }
    entry.lastSeen = Date.now();
    return entry.bucket.consume(cost);
  }
}

const defaultKeyGenerator = (req) => req.ip;

/**
 * createRateLimiter({ capacity, refillPerSec, keyGenerator, message })
 *
 * Returns Express middleware backed by its own independent bucket store.
 * Mount separate instances (with separate limits) on different route
 * groups — e.g. a loose global limiter on the whole app plus a tight one
 * on /api/auth for brute-force resistance.
 */
const createRateLimiter = ({
  capacity,
  refillPerSec,
  keyGenerator = defaultKeyGenerator,
  message = 'Too many requests. Please slow down and try again shortly.',
} = {}) => {
  if (!capacity || !refillPerSec) {
    throw new Error('createRateLimiter requires capacity and refillPerSec');
  }
  const store = new InMemoryBucketStore({ capacity, refillPerSec });

  return (req, res, next) => {
    const key = keyGenerator(req);
    const { allowed, retryAfterSec, remaining } = store.consume(key);

    res.setHeader('X-RateLimit-Limit', capacity);
    res.setHeader('X-RateLimit-Remaining', remaining);

    if (!allowed) {
      res.setHeader('Retry-After', retryAfterSec);
      logger.warn('Rate limit exceeded', { key, path: req.path, retryAfterSec });
      return next(AppError.tooManyRequests(message, { retryAfterSec }));
    }
    next();
  };
};

module.exports = { createRateLimiter, TokenBucket };
