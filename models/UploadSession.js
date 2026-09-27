'use strict';
/**
 * models/UploadSession.js
 *
 * A resumable, chunked browser → API upload for large files (product
 * videos, up to 500 MB). The browser sends the file in small chunks, each
 * a short request that fits comfortably inside the API's timeouts, so a
 * slow connection never produces one multi-minute request that can hang or
 * be killed half-way. A dropped chunk is simply re-sent; the browser can
 * ask the server how many bytes it already holds (receivedBytes) and
 * resume from there.
 *
 * When the last chunk arrives the client calls /complete, which hands the
 * assembled file to a background job (OneDrive upload) and answers 202.
 * See services/media/uploadSessionService.js and routes/v2/uploadRoutes.js.
 */
const mongoose = require('mongoose');

const uploadSessionSchema = new mongoose.Schema({
  owner: {
    userId: { type: String, required: true, index: true },
    role: { type: String, required: true },
  },
  // What the finished file is for — decides which job runs on /complete.
  purpose: { type: String, enum: ['product-video', 'supplier-product-video'], required: true },
  targetId: { type: String, required: true },

  fileName: { type: String, required: true },
  mimeType: { type: String, required: true },
  totalBytes: { type: Number, required: true },
  receivedBytes: { type: Number, default: 0 },
  chunkSize: { type: Number, required: true },

  tmpPath: { type: String, default: '' },  // cleared once the temp file is removed
  host: { type: String, required: true },

  status: {
    type: String,
    enum: ['uploading', 'completed', 'aborted'],
    default: 'uploading',
    index: true,
  },
  jobId: { type: String, default: null },

  // Abandoned sessions are cleaned up (temp file removed) after this.
  expiresAt: { type: Date, required: true, index: true },
}, { timestamps: true });

uploadSessionSchema.methods.toClient = function toClient() {
  return {
    uploadId: String(this._id),
    purpose: this.purpose,
    targetId: this.targetId,
    fileName: this.fileName,
    totalBytes: this.totalBytes,
    receivedBytes: this.receivedBytes,
    chunkSize: this.chunkSize,
    status: this.status,
    jobId: this.jobId,
    expiresAt: this.expiresAt,
  };
};

module.exports = mongoose.model('UploadSession', uploadSessionSchema);
