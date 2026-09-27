'use strict';
/**
 * lib/jobs/jobQueue.js
 *
 * MongoDB-backed background job queue + in-process worker pool.
 *
 *   // at boot (server.js)
 *   jobQueue.registerHandler('product.video.upload', handler, { concurrency: 1 });
 *   jobQueue.start();
 *
 *   // in a controller
 *   const job = await jobQueue.enqueue({ type: 'product.video.upload', payload, owner, idempotencyKey });
 *   return accepted(res, job);                        // 202 + { jobId, statusUrl }
 *
 * Handler contract:
 *   async (job, ctx) => result
 *     ctx.progress(percent, stage, message)   throttled progress write (front end shows it)
 *     ctx.heartbeat()                         extend the lease during long steps
 *     ctx.signal                              AbortSignal — set when the worker shuts down
 *   Throw PermanentJobError for failures a retry can never fix (bad input,
 *   missing file). Any other error is retried with exponential backoff until
 *   maxAttempts, then the job is marked 'failed' (the user can retry it from
 *   the UI via POST /api/v2/jobs/:id/retry).
 *
 * Reliability:
 *   - claims are atomic (findOneAndUpdate), so a job never runs twice at once
 *   - a lease + heartbeat means a crashed/restarted worker's job is re-queued
 *   - jobs with local-disk input are pinned to the host that holds the file
 *   - graceful shutdown hands running jobs back to the queue
 */
const os = require('os');
const { EventEmitter } = require('events');
const Job = require('../../models/Job');
const { backoffDelay } = require('../resilience/retry');
const logger = require('../../utils/logger').child({ module: 'jobQueue' });

const HOST = os.hostname();
const WORKER_ID = `${HOST}:${process.pid}`;
const LEASE_MS = 2 * 60 * 1000;
const POLL_MIN_MS = 1000;
const POLL_MAX_MS = 5000;
const PROGRESS_WRITE_INTERVAL_MS = 750;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

class PermanentJobError extends Error {
  constructor(message, code = 'PERMANENT_FAILURE') {
    super(message);
    this.name = 'PermanentJobError';
    this.code = code;
  }
}

const handlers = new Map();     // type -> { fn, concurrency, maxAttempts }
const running = new Map();      // type -> count
const active = new Map();       // jobId -> AbortController
const events = new EventEmitter();
events.setMaxListeners(100);

let started = false;
let stopping = false;
let pollTimer = null;
let pollDelay = POLL_MIN_MS;

const registerHandler = (type, fn, { concurrency = 1, maxAttempts = 5 } = {}) => {
  handlers.set(type, { fn, concurrency, maxAttempts });
  running.set(type, 0);
};

/**
 * Queue a job. With an idempotencyKey the same (owner, key) pair always
 * resolves to the same job, so a double-click or a retried request never
 * does the work twice.
 */
const enqueue = async ({
  id, type, payload = {}, title = '', owner = {}, idempotencyKey, pinToThisHost = false,
  resource = {}, maxAttempts, delayMs = 0,
}) => {
  if (!handlers.has(type)) throw new Error(`No handler registered for job type "${type}"`);
  const doc = {
    // Callers may pre-generate the id so they can record it on the target
    // document before a worker could possibly pick the job up.
    ...(id ? { _id: id } : {}),
    type,
    payload,
    title,
    owner: { userId: owner.userId ? String(owner.userId) : null, role: owner.role || null },
    idempotencyKey: idempotencyKey || undefined,
    pinnedHost: pinToThisHost ? HOST : null,
    resource,
    maxAttempts: maxAttempts || handlers.get(type).maxAttempts,
    runAt: new Date(Date.now() + delayMs),
  };

  try {
    const job = await Job.create(doc);
    logger.info('Job enqueued', { jobId: job._id, type, resource, owner: doc.owner.userId });
    kick();
    return job;
  } catch (err) {
    if (err.code === 11000 && idempotencyKey) {
      const existing = await Job.findOne({ 'owner.userId': doc.owner.userId, idempotencyKey });
      if (existing) {
        logger.info('Job enqueue deduplicated by idempotency key', { jobId: existing._id, type });
        return existing;
      }
    }
    throw err;
  }
};

const publish = (job) => events.emit('job', job.toClient ? job.toClient() : job);

// ── Claiming ──────────────────────────────────────────────────────────────────
const claimNext = async (type) => {
  const now = new Date();
  return Job.findOneAndUpdate(
    {
      type,
      status: 'queued',
      runAt: { $lte: now },
      $or: [{ pinnedHost: null }, { pinnedHost: HOST }],
    },
    {
      $set: {
        status: 'running',
        lockedBy: WORKER_ID,
        lockedUntil: new Date(now.getTime() + LEASE_MS),
        startedAt: now,
        'progress.stage': 'starting',
      },
      $inc: { attempts: 1 },
    },
    { sort: { runAt: 1 }, new: true }
  );
};

/** Re-queue running jobs whose worker died (lease expired without a heartbeat). */
let lastRecovery = 0;
const recoverStaleJobs = async () => {
  if (Date.now() - lastRecovery < 30_000) return;
  lastRecovery = Date.now();
  const res = await Job.updateMany(
    { status: 'running', lockedUntil: { $lt: new Date() } },
    { $set: { status: 'queued', lockedBy: null, lockedUntil: null, runAt: new Date(), 'progress.stage': 'requeued' } }
  );
  if (res.modifiedCount) logger.warn('Recovered stale jobs', { count: res.modifiedCount });
};

// ── Execution ────────────────────────────────────────────────────────────────
const makeContext = (job, controller) => {
  let lastWrite = 0;
  let pending = null;

  const heartbeat = () => Job.updateOne(
    { _id: job._id, lockedBy: WORKER_ID },
    { $set: { lockedUntil: new Date(Date.now() + LEASE_MS) } }
  ).catch((err) => logger.warn('Heartbeat failed', { jobId: job._id, error: err.message }));

  const progress = async (percent, stage, message = '') => {
    job.progress = { percent: Math.max(0, Math.min(100, Math.round(percent))), stage: stage || job.progress.stage, message };
    const now = Date.now();
    if (now - lastWrite < PROGRESS_WRITE_INTERVAL_MS && percent < 100) {
      pending = job.progress;
      return;
    }
    lastWrite = now;
    pending = null;
    await Job.updateOne(
      { _id: job._id, lockedBy: WORKER_ID },
      { $set: { progress: job.progress, lockedUntil: new Date(now + LEASE_MS) } }
    ).catch((err) => logger.warn('Progress write failed', { jobId: job._id, error: err.message }));
    publish(job);
  };

  const flush = async () => {
    if (pending) await Job.updateOne({ _id: job._id }, { $set: { progress: pending } }).catch(() => {});
  };

  return { progress, heartbeat, flush, signal: controller.signal, log: logger.child({ jobId: String(job._id), jobType: job.type }) };
};

const runJob = async (job) => {
  const { fn } = handlers.get(job.type);
  const controller = new AbortController();
  active.set(String(job._id), controller);
  const ctx = makeContext(job, controller);
  const heartbeatTimer = setInterval(ctx.heartbeat, LEASE_MS / 3);
  heartbeatTimer.unref?.();
  const started = Date.now();

  logger.info('Job started', { jobId: job._id, type: job.type, attempt: job.attempts, of: job.maxAttempts });
  publish(job);

  try {
    const result = await fn(job, ctx);
    await ctx.flush();
    const done = await Job.findOneAndUpdate(
      { _id: job._id, lockedBy: WORKER_ID },
      {
        $set: {
          status: 'completed',
          result: result ?? null,
          progress: { percent: 100, stage: 'completed', message: '' },
          error: { message: '', code: '', retryable: false },
          lockedBy: null, lockedUntil: null,
          finishedAt: new Date(),
          expiresAt: new Date(Date.now() + RETENTION_MS),
        },
      },
      { new: true }
    );
    logger.info('Job completed', { jobId: job._id, type: job.type, durationMs: Date.now() - started });
    if (done) publish(done);
  } catch (err) {
    await ctx.flush();
    const shuttingDown = controller.signal.aborted && stopping;
    const permanent = err instanceof PermanentJobError;
    const canRetry = !permanent && (shuttingDown || job.attempts < job.maxAttempts);

    const update = canRetry
      ? {
          status: 'queued',
          // A shutdown isn't the job's fault — give the attempt back.
          ...(shuttingDown ? { attempts: Math.max(0, job.attempts - 1) } : {}),
          runAt: new Date(Date.now() + (shuttingDown ? 0 : backoffDelay(job.attempts, { baseMs: 2000, maxMs: 5 * 60 * 1000 }))),
          'progress.stage': shuttingDown ? 'requeued' : 'retrying',
          'progress.message': shuttingDown ? 'Server restarting — will resume shortly.' : `Attempt ${job.attempts} failed — retrying.`,
          error: { message: err.message, code: err.code || 'JOB_ERROR', retryable: true },
          lockedBy: null, lockedUntil: null,
        }
      : {
          status: 'failed',
          'progress.stage': 'failed',
          error: { message: err.message, code: err.code || 'JOB_FAILED', retryable: !permanent },
          lockedBy: null, lockedUntil: null,
          finishedAt: new Date(),
          expiresAt: new Date(Date.now() + RETENTION_MS),
        };

    const after = await Job.findOneAndUpdate({ _id: job._id, lockedBy: WORKER_ID }, { $set: update }, { new: true });
    const logFn = canRetry ? logger.warn.bind(logger) : logger.error.bind(logger);
    logFn(canRetry ? 'Job attempt failed — will retry' : 'Job failed permanently', {
      jobId: job._id, type: job.type, attempt: job.attempts, of: job.maxAttempts,
      error: err.message, code: err.code, status: err?.response?.status,
      stack: canRetry ? undefined : err.stack,
    });
    if (after) {
      publish(after);
      if (after.status === 'failed') events.emit('failed', after);
    }
  } finally {
    clearInterval(heartbeatTimer);
    active.delete(String(job._id));
  }
};

// ── Polling loop ────────────────────────────────────────────────────────────
const tick = async () => {
  pollTimer = null;
  if (stopping) return;
  let claimedAny = false;
  try {
    await recoverStaleJobs();
    for (const [type, { concurrency }] of handlers) {
      while (!stopping && running.get(type) < concurrency) {
        const job = await claimNext(type);
        if (!job) break;
        claimedAny = true;
        running.set(type, running.get(type) + 1);
        runJob(job).finally(() => {
          running.set(type, running.get(type) - 1);
          kick();
        });
      }
    }
  } catch (err) {
    logger.error('Job poll failed', { error: err.message });
  }
  pollDelay = claimedAny ? POLL_MIN_MS : Math.min(POLL_MAX_MS, pollDelay * 1.5);
  schedule(pollDelay);
};

const schedule = (ms) => {
  if (stopping || pollTimer) return;
  pollTimer = setTimeout(tick, ms);
  pollTimer.unref?.();
};

/** Wake the poller now (called after enqueue / job completion). */
const kick = () => {
  if (!started || stopping) return;
  pollDelay = POLL_MIN_MS;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  setImmediate(tick);
};

const start = () => {
  if (started) return;
  started = true;
  logger.info('Job worker started', { workerId: WORKER_ID, types: [...handlers.keys()] });
  schedule(POLL_MIN_MS);
};

/** Stop claiming new work, abort in-flight handlers and wait for them to hand their jobs back. */
const stop = async (timeoutMs = 10_000) => {
  stopping = true;
  if (pollTimer) clearTimeout(pollTimer);
  for (const controller of active.values()) controller.abort();
  const deadline = Date.now() + timeoutMs;
  while (active.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (active.size) {
    await Job.updateMany(
      { _id: { $in: [...active.keys()] }, lockedBy: WORKER_ID },
      { $set: { status: 'queued', lockedBy: null, lockedUntil: null, runAt: new Date(), 'progress.stage': 'requeued' } }
    ).catch(() => {});
  }
  logger.info('Job worker stopped', { workerId: WORKER_ID });
};

// ── Queries used by the jobs API ─────────────────────────────────────────────
const retryJob = async (id) => Job.findOneAndUpdate(
  { _id: id, status: 'failed' },
  {
    $set: {
      status: 'queued', runAt: new Date(), attempts: 0, finishedAt: null, expiresAt: null,
      progress: { percent: 0, stage: 'queued', message: 'Retry requested.' },
      error: { message: '', code: '', retryable: false },
    },
  },
  { new: true }
).then((job) => {
  if (job) {
    events.emit('retried', job);
    kick();
  }
  return job;
});

const cancelJob = async (id) => Job.findOneAndUpdate(
  { _id: id, status: 'queued' },
  { $set: { status: 'cancelled', 'progress.stage': 'cancelled', finishedAt: new Date(), expiresAt: new Date(Date.now() + RETENTION_MS) } },
  { new: true }
);

module.exports = {
  registerHandler, enqueue, start, stop, kick, retryJob, cancelJob, events,
  PermanentJobError, HOST, WORKER_ID,
};
