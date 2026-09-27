'use strict';
/**
 * lib/resilience/retry.js
 *
 * Exponential backoff with full jitter for calls to external cloud APIs
 * (Microsoft Graph / OneDrive, Cloudflare R2, image hosts).
 *
 *   await withRetry(() => axios.put(url, chunk), { label: 'onedrive.chunk' });
 *
 * Only transient failures are retried: network errors, 408, 429 and 5xx.
 * A 429/503 carrying Retry-After is honoured instead of the computed delay.
 * Anything else (400/401/403/404/409…) fails fast — retrying a bad request
 * only burns time and quota.
 */
const logger = require('../../utils/logger').child({ module: 'retry' });

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ERR_NETWORK',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableError = (err) => {
  const status = err?.response?.status ?? err?.$metadata?.httpStatusCode ?? err?.statusCode;
  if (status) return status === 408 || status === 429 || status >= 500;
  return TRANSIENT_NETWORK_CODES.has(err?.code) || err?.name === 'TimeoutError';
};

const retryAfterMs = (err) => {
  const header = err?.response?.headers?.['retry-after'];
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
};

/** Delay before attempt n+1 (n is 1-based): min(maxMs, baseMs * 2^(n-1)) with full jitter. */
const backoffDelay = (attempt, { baseMs = 500, maxMs = 30_000 } = {}) => {
  const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
};

const withRetry = async (fn, {
  retries = 4,
  baseMs = 500,
  maxMs = 30_000,
  label = 'external-call',
  isRetryable = isRetryableError,
  onRetry,
} = {}) => {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt > retries || !isRetryable(err)) throw err;
      const delay = Math.min(maxMs, retryAfterMs(err) ?? backoffDelay(attempt, { baseMs, maxMs }));
      logger.warn('Transient failure — retrying', {
        label, attempt, nextAttemptInMs: delay,
        status: err?.response?.status, code: err?.code, error: err.message,
      });
      onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
};

module.exports = { withRetry, isRetryableError, backoffDelay, sleep };
