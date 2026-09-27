'use strict';
/**
 * services/media/uploadSessionService.js
 *
 * Resumable chunked uploads (browser → API disk), used for product videos.
 * See models/UploadSession.js for why large files are chunked.
 *
 *   create()        validate type/size/permission, pre-allocate a temp file
 *   writeChunk()    idempotent, offset-checked append (re-sending a chunk is safe)
 *   complete()      verify the file, then hand it to the purpose's completion
 *                   handler, which enqueues the background OneDrive job
 *   abort()         user cancelled — remove temp file
 *   cleanupExpired() periodic sweep of abandoned sessions / leftover files
 *
 * Purposes register their permission check and completion handler with
 * registerPurpose(), which keeps this module free of product/supplier logic.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const UploadSession = require('../../models/UploadSession');
const AppError = require('../../lib/errors/AppError');
const { HOST } = require('../../lib/jobs/jobQueue');
const logger = require('../../utils/logger').child({ module: 'uploadSessionService' });

const TMP_DIR = process.env.UPLOAD_TMP_DIR || path.join(os.tmpdir(), 'marqland-uploads');
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const CHUNK_SIZE = 4 * 1024 * 1024;          // what the browser is told to send
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;     // what the server will accept per request
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const COMPLETED_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

const VIDEO_TYPES = new Map([
  ['video/mp4', '.mp4'], ['video/quicktime', '.mov'], ['video/webm', '.webm'],
  ['video/x-m4v', '.m4v'], ['video/mpeg', '.mpeg'], ['video/3gpp', '.3gp'],
]);

const purposes = new Map(); // purpose -> { authorize(user, targetId), onComplete(session, user) }

const registerPurpose = (purpose, { authorize, onComplete }) => purposes.set(purpose, { authorize, onComplete });

const ensureTmpDir = async () => fs.promises.mkdir(TMP_DIR, { recursive: true });

// Magic-number sniff — the browser's declared MIME type is not trusted.
const looksLikeVideo = async (filePath) => {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const head = Buffer.alloc(12);
    await fd.read(head, 0, 12, 0);
    const ftyp = head.subarray(4, 8).toString('ascii') === 'ftyp';            // mp4 / mov / m4v / 3gp
    const ebml = head.readUInt32BE(0) === 0x1a45dfa3;                          // webm / mkv
    const mpeg = head.readUInt32BE(0) === 0x000001ba || head.readUInt32BE(0) === 0x000001b3;
    return ftyp || ebml || mpeg;
  } finally {
    await fd.close();
  }
};

const findOwned = async (uploadId, user) => {
  if (!/^[0-9a-fA-F]{24}$/.test(String(uploadId))) throw AppError.notFound('Upload not found.');
  const session = await UploadSession.findById(uploadId);
  if (!session || session.owner.userId !== String(user.id)) throw AppError.notFound('Upload not found.');
  return session;
};

const create = async (user, { purpose, targetId, fileName, mimeType, totalBytes }) => {
  const config = purposes.get(purpose);
  if (!config) throw AppError.badRequest('Unknown upload purpose.');
  const ext = VIDEO_TYPES.get(String(mimeType).toLowerCase());
  if (!ext) throw AppError.badRequest('Only MP4, MOV, WEBM, M4V, MPEG or 3GP videos can be uploaded.');
  const size = Number(totalBytes);
  if (!Number.isInteger(size) || size <= 0) throw AppError.badRequest('File size is required.');
  if (size > MAX_VIDEO_BYTES) throw AppError.payloadTooLarge('Videos can be at most 500 MB.');

  await config.authorize(user, targetId);
  await ensureTmpDir();

  const session = new UploadSession({
    owner: { userId: String(user.id), role: user.role },
    purpose,
    targetId: String(targetId),
    fileName: String(fileName || `video${ext}`).slice(0, 200),
    mimeType: String(mimeType).toLowerCase(),
    totalBytes: size,
    chunkSize: CHUNK_SIZE,
    tmpPath: '',
    host: HOST,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  session.tmpPath = path.join(TMP_DIR, `${session._id}${ext}`);
  await fs.promises.writeFile(session.tmpPath, Buffer.alloc(0));
  await session.save();

  logger.info('Upload session created', { uploadId: session._id, purpose, targetId, totalBytes: size, userId: user.id });
  return session;
};

const writeChunk = async (user, uploadId, offset, chunk) => {
  const session = await findOwned(uploadId, user);
  if (session.status !== 'uploading') throw AppError.conflict('This upload is already finished.', { receivedBytes: session.receivedBytes });
  if (session.host !== HOST) throw AppError.gone('This upload can no longer be resumed. Please start again.');
  if (session.expiresAt < new Date()) throw AppError.gone('This upload expired. Please start again.');

  const start = Number(offset);
  if (!Number.isInteger(start) || start < 0) throw AppError.badRequest('offset must be a non-negative integer.');
  if (!Buffer.isBuffer(chunk) || chunk.length === 0) throw AppError.badRequest('Chunk body is empty.');
  if (chunk.length > MAX_CHUNK_BYTES) throw AppError.payloadTooLarge('Chunk too large.');
  if (start + chunk.length > session.totalBytes) throw AppError.badRequest('Chunk runs past the end of the file.');

  // Already have these bytes (a retried chunk) — acknowledge without rewriting.
  if (start + chunk.length <= session.receivedBytes) return session;
  if (start !== session.receivedBytes) {
    throw AppError.conflict('Chunk offset does not match the bytes received so far.', { receivedBytes: session.receivedBytes });
  }

  const fd = await fs.promises.open(session.tmpPath, 'r+');
  try {
    await fd.write(chunk, 0, chunk.length, start);
  } finally {
    await fd.close();
  }

  const updated = await UploadSession.findOneAndUpdate(
    { _id: session._id, receivedBytes: start, status: 'uploading' },
    { $set: { receivedBytes: start + chunk.length, expiresAt: new Date(Date.now() + SESSION_TTL_MS) } },
    { new: true }
  );
  if (!updated) {
    const current = await UploadSession.findById(session._id).lean();
    throw AppError.conflict('Another request updated this upload. Resync and continue.', { receivedBytes: current?.receivedBytes ?? 0 });
  }
  return updated;
};

const complete = async (user, uploadId, { idempotencyKey } = {}) => {
  const session = await findOwned(uploadId, user);
  if (session.status === 'completed' && session.jobId) return { session, jobId: session.jobId, replay: true };
  if (session.status !== 'uploading') throw AppError.conflict('This upload was cancelled.');
  if (session.receivedBytes !== session.totalBytes) {
    throw AppError.conflict('Upload is not complete yet.', { receivedBytes: session.receivedBytes, totalBytes: session.totalBytes });
  }

  const { size } = await fs.promises.stat(session.tmpPath).catch(() => ({ size: -1 }));
  if (size !== session.totalBytes) {
    throw AppError.gone('The uploaded file is no longer available on the server. Please upload it again.');
  }
  if (!(await looksLikeVideo(session.tmpPath))) {
    await abort(user, uploadId).catch(() => {});
    throw AppError.badRequest('That file does not look like a video.');
  }

  // Claim completion atomically so two /complete calls can't enqueue twice.
  const claimed = await UploadSession.findOneAndUpdate(
    { _id: session._id, status: 'uploading' },
    { $set: { status: 'completed', expiresAt: new Date(Date.now() + COMPLETED_RETENTION_MS) } },
    { new: true }
  );
  if (!claimed) {
    const current = await UploadSession.findById(session._id);
    if (current?.jobId) return { session: current, jobId: current.jobId, replay: true };
    throw AppError.conflict('Upload completion already in progress.');
  }

  try {
    const job = await purposes.get(claimed.purpose).onComplete(claimed, user, { idempotencyKey });
    claimed.jobId = String(job._id);
    await claimed.save();
    logger.info('Upload completed — handed to background job', { uploadId: claimed._id, jobId: claimed.jobId });
    return { session: claimed, job };
  } catch (err) {
    // Let the client call /complete again.
    await UploadSession.updateOne({ _id: claimed._id }, { $set: { status: 'uploading' } });
    throw err;
  }
};

const abort = async (user, uploadId) => {
  const session = await findOwned(uploadId, user);
  if (session.status === 'completed') throw AppError.conflict('This upload has already been handed off for processing.');
  session.status = 'aborted';
  await session.save();
  await fs.promises.rm(session.tmpPath, { force: true });
  return session;
};

/** Used by job handlers once the file is safely on OneDrive. */
const releaseFile = async (uploadId) => {
  const session = await UploadSession.findById(uploadId);
  if (!session) return;
  await fs.promises.rm(session.tmpPath, { force: true });
};

const cleanupExpired = async () => {
  const stale = await UploadSession.find({ host: HOST, expiresAt: { $lt: new Date() }, tmpPath: { $ne: '' } }).limit(200);
  for (const session of stale) {
    // eslint-disable-next-line no-await-in-loop
    await fs.promises.rm(session.tmpPath, { force: true }).catch(() => {});
    if (session.status === 'uploading') session.status = 'aborted';
    session.tmpPath = '';
    // eslint-disable-next-line no-await-in-loop
    await session.save().catch(() => {});
  }
  const purged = await UploadSession.deleteMany({
    updatedAt: { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, tmpPath: '',
  });
  if (stale.length || purged.deletedCount) {
    logger.info('Upload session cleanup', { expired: stale.length, purged: purged.deletedCount });
  }
};

module.exports = {
  registerPurpose, create, writeChunk, complete, abort, releaseFile, cleanupExpired, findOwned,
  VIDEO_TYPES, MAX_VIDEO_BYTES, MAX_CHUNK_BYTES, CHUNK_SIZE, TMP_DIR,
};
