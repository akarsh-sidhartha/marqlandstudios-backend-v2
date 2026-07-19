'use strict';
/**
 * services/jobWorkLifecycleService.js
 *
 * Two scheduled state transitions for job-work rows:
 *   1. completed -> archive   once completedAt is 2+ months old
 *   2. archive   -> deleted   once archivedAt is 1+ year old (also deletes
 *                              the row's OneDrive image folder)
 *
 * Self-registering cron, same shape as services/trendingProductService.js's
 * startScheduler()/stopScheduler() — call startScheduler() once from
 * server.js (see JOB_WORK_WIRING.md) rather than wiring node-cron by hand
 * into the existing cron block.
 */
const cron = require('node-cron');
const JobWorkRow = require('../../models/job-work/JobWorkRow');
const { deleteJobWorkFolder } = require('../job-work/jobWorkOneDriveService');
const logger = require('../../utils/logger').child({ module: 'jobWorkLifecycleService' });

const ARCHIVE_AFTER_MONTHS = 2;
const DELETE_AFTER_MONTHS  = 12; // 1 year

const monthsAgo = (n) => {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
};

/** Move completed rows whose completedAt is 2+ months old into 'archive'. */
const archiveCompletedRows = async () => {
  const cutoff = monthsAgo(ARCHIVE_AFTER_MONTHS);
  const result = await JobWorkRow.updateMany(
    { status: 'completed', completedAt: { $ne: null, $lte: cutoff } },
    { $set: { status: 'archive', archivedAt: new Date() } }
  );
  if (result.modifiedCount) {
    logger.info('Job work rows auto-archived', { count: result.modifiedCount, cutoff: cutoff.toISOString() });
  }
  return result.modifiedCount || 0;
};

/** Permanently delete archived rows whose archivedAt is 1+ year old. */
const purgeArchivedRows = async () => {
  const cutoff = monthsAgo(DELETE_AFTER_MONTHS);
  const rows = await JobWorkRow.find({ status: 'archive', archivedAt: { $ne: null, $lte: cutoff } }).lean();

  let deleted = 0;
  for (const row of rows) {
    try {
      await deleteJobWorkFolder(row.oneDriveFolderId);
      await JobWorkRow.deleteOne({ _id: row._id });
      deleted++;
      logger.info('Job work row auto-deleted (1yr archive retention)', {
        rowId: row._id, serialId: row.serialId, archivedAt: row.archivedAt,
      });
    } catch (err) {
      logger.error('Failed to auto-delete archived job work row — will retry next run', {
        rowId: row._id, error: err.message,
      });
    }
  }
  return deleted;
};

const runJobWorkLifecycleMaintenance = async () => {
  await archiveCompletedRows();
  await purgeArchivedRows();
};

let cronJob = null;

/** Runs daily at 03:00 IST — safe to call multiple times (idempotent no-op after first). */
function startScheduler() {
  if (cronJob) return;
  cronJob = cron.schedule('0 3 * * *', async () => {
    logger.info('Job work lifecycle cron triggered');
    try { await runJobWorkLifecycleMaintenance(); }
    catch (err) { logger.error('Job work lifecycle cron run failed', { error: err.message, stack: err.stack }); }
  }, { timezone: 'Asia/Kolkata' });
  logger.info('Job work lifecycle scheduler started', { schedule: '03:00 IST' });
}

function stopScheduler() { cronJob?.stop(); cronJob = null; }

module.exports = {
  startScheduler,
  stopScheduler,
  runJobWorkLifecycleMaintenance,
  archiveCompletedRows,
  purgeArchivedRows,
};
