'use strict';
/**
 * backend/services/activityLogArchiveService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Keeps MongoDB's ActivityLog collection capped at the last 7 days by:
 *
 *   1. Archiving anything older than 7 days into weekly Excel files, one file
 *      per calendar week (Mon–Sun), uploaded to OneDrive at:
 *        development env → OneDrive / development / activity logs folder / weekly excel saved
 *        production  env → OneDrive / website     / activity logs folder / weekly excel saved
 *      (root segment resolved automatically by odvPath(), same helper
 *      supplierRoutes.js already uses for its own env-aware paths).
 *   2. Deleting a batch from MongoDB ONLY after its file has uploaded
 *      successfully — if the OneDrive upload throws, that week's rows are
 *      left alone and get picked up again on the next run.
 *   3. Separately, purging archived Excel files from OneDrive once they are
 *      older than 5 months, so the OneDrive folder itself doesn't grow
 *      forever either.
 *
 * Entry point: runActivityLogMaintenance() — call this from a cron job
 * (see server.js). Safe to call repeatedly; every step is idempotent enough
 * that a partial failure just gets retried on the next run.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const XLSX        = require('xlsx');
const ActivityLog = require('../models/ActivityLog');
const {
  getOrCreateFolder,
  uploadSingleFileBuffer,
  listFolderContents,
  deleteFile,
} = require('./msGraphService');
const { odvPath }  = require('../utils/oneDrivePaths');
const logger       = require('../utils/logger').child({ module: 'activityLogArchiveService' });

const MONGO_RETENTION_DAYS   = 7;
const ONEDRIVE_RETENTION_MONTHS = 5;
const ARCHIVE_FOLDER_SEGMENTS = () => odvPath('activity logs folder', 'weekly excel saved');

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Monday 00:00:00.000 → Sunday 23:59:59.999 for the week containing `date` */
const getWeekBounds = (date) => {
  const d = new Date(date);
  const dayIdx = (d.getDay() + 6) % 7; // Mon=0 ... Sun=6
  const monday = new Date(d);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - dayIdx);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { start: monday, end: sunday };
};

const ymd = (d) => new Date(d).toISOString().slice(0, 10); // 2026-06-29

// ── Excel building ────────────────────────────────────────────────────────────

const buildWorkbookBuffer = (rows) => {
  const data = rows.map(r => ({
    'Date/Time':      new Date(r.createdAt).toLocaleString('en-IN', { hour12: true }),
    'User':           r.userName || 'Anonymous',
    'Email':          r.userEmail || '',
    'Role':           r.userRole || '',
    'Action':         r.action,
    'Category':       r.category,
    'Method':         r.method,
    'Path':           r.path,
    'Summary':        r.summary,
    'Status Code':    r.status,
    'Success':        r.success ? 'Yes' : 'No',
    'IP':             r.ip || '',
    'Duration (ms)':  r.duration || 0,
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [
    { wch: 20 }, { wch: 20 }, { wch: 26 }, { wch: 10 }, { wch: 22 },
    { wch: 12 }, { wch: 8 }, { wch: 30 }, { wch: 40 }, { wch: 12 },
    { wch: 9 }, { wch: 16 }, { wch: 12 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Activity Log');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

// ── Archive one week's worth of rows, then delete them from Mongo ────────────

const archiveWeek = async (rows, weekStart, weekEnd) => {
  const filename = `Activity-Log_${ymd(weekStart)}_to_${ymd(weekEnd)}.xlsx`;
  const buffer   = buildWorkbookBuffer(rows);
  const folderSegments = ARCHIVE_FOLDER_SEGMENTS();

  await uploadSingleFileBuffer(
    folderSegments,
    filename,
    buffer,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );

  // Only delete AFTER a confirmed successful upload.
  const ids = rows.map(r => r._id);
  const result = await ActivityLog.deleteMany({ _id: { $in: ids } });

  logger.info('Archived activity log week to OneDrive and purged from MongoDB', {
    filename,
    rows: rows.length,
    deleted: result.deletedCount,
    folder: folderSegments.join('/'),
  });
};

/**
 * Walk week-by-week from the oldest un-archived log up to the 7-day
 * retention cutoff, archiving + purging each week that has rows.
 * Weeks are processed independently — one failure doesn't block the rest.
 */
const archiveAndPurgeOldLogs = async () => {
  const retentionCutoff = new Date(Date.now() - MONGO_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const oldest = await ActivityLog.findOne({ createdAt: { $lt: retentionCutoff } })
    .sort({ createdAt: 1 })
    .lean();

  if (!oldest) {
    logger.debug('No activity logs older than 7 days — nothing to archive');
    return;
  }

  let cursor = getWeekBounds(oldest.createdAt).start;

  while (cursor < retentionCutoff) {
    const { start, end } = getWeekBounds(cursor);

    try {
      const rows = await ActivityLog.find({
        createdAt: { $gte: start, $lte: end, $lt: retentionCutoff },
      }).sort({ createdAt: 1 }).lean();

      if (rows.length) {
        await archiveWeek(rows, start, end);
      }
    } catch (err) {
      // Leave this week's rows in Mongo — they'll be retried on the next run.
      logger.error('Failed to archive activity log week — will retry next run', {
        weekStart: ymd(start), weekEnd: ymd(end), error: err.message,
      });
    }

    cursor = new Date(end.getTime() + 1); // advance to next week
  }
};

// ── Purge OneDrive archive files older than 5 months ─────────────────────────

const purgeOldOneDriveArchives = async () => {
  const folderSegments = ARCHIVE_FOLDER_SEGMENTS();

  let parentId = 'root';
  for (const segment of folderSegments) {
    parentId = await getOrCreateFolder(parentId, segment);
  }

  const files = await listFolderContents(parentId);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - ONEDRIVE_RETENTION_MONTHS);

  for (const file of files) {
    if (file.folder) continue; // safety — never recurse into subfolders here
    const created = new Date(file.createdDateTime || file.fileSystemInfo?.createdDateTime || 0);
    if (created < cutoff) {
      try {
        await deleteFile(file.id);
        logger.info('Purged OneDrive activity log archive older than 5 months', {
          name: file.name, created: created.toISOString(),
        });
      } catch (err) {
        logger.error('Failed to purge OneDrive archive file', { name: file.name, error: err.message });
      }
    }
  }
};

// ── Entry point ────────────────────────────────────────────────────────────

const runActivityLogMaintenance = async () => {
  await archiveAndPurgeOldLogs();
  await purgeOldOneDriveArchives();
};

module.exports = {
  runActivityLogMaintenance,
  archiveAndPurgeOldLogs,
  purgeOldOneDriveArchives,
};