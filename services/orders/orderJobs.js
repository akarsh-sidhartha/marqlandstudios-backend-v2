'use strict';
/**
 * services/orders/orderJobs.js
 *
 * order.folder.sync   — creates the order's OneDrive folder if missing and
 *                       renames it to the current identifier (INQ → QT → INV).
 *                       Idempotent, so it is queued after every status change.
 * order.folder.delete — removes the folder of a deleted order.
 *
 * Previously both ran in a fire-and-forget setImmediate() inside the request:
 * a Graph hiccup or a server restart silently left orders without a folder.
 * As queued jobs they retry with backoff and show up in the task tray.
 */
const OrderInquiry = require('../../models/orderInquiry');
const jobQueue = require('../../lib/jobs/jobQueue');
const graph = require('../msGraphService');
const storage = require('./orderStorage');
const { JOB_FOLDER_SYNC, JOB_FOLDER_DELETE } = require('./orderService');

const { PermanentJobError } = jobQueue;

const syncFolder = async (job, ctx) => {
  const order = await OrderInquiry.findById(job.payload.orderId).lean();
  if (!order) throw new PermanentJobError('Order no longer exists.', 'TARGET_DELETED');
  await ctx.progress(30, 'syncing', 'Preparing the OneDrive folder…');
  return storage.syncFolderName(order);
};

const deleteFolder = async (job) => {
  const { folderId, folderUrl, legacySegments } = job.payload;
  const resolved = folderId || (folderUrl ? await graph.getFolderIdFromUrl(folderUrl) : null);
  await storage.deleteFolder({ folderId: resolved, legacySegments: resolved ? null : legacySegments });
  return { deleted: true };
};

const registerOrderJobs = () => {
  jobQueue.registerHandler(JOB_FOLDER_SYNC, syncFolder, { concurrency: 2, maxAttempts: 5 });
  jobQueue.registerHandler(JOB_FOLDER_DELETE, deleteFolder, { concurrency: 1, maxAttempts: 5 });
};

module.exports = { registerOrderJobs };
