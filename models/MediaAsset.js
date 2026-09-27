'use strict';
/**
 * models/MediaAsset.js
 *
 * Images uploaded ahead of a product save. The product form uploads each
 * picked image straight away (in the background, while the user keeps
 * typing), so pressing Save only sends a small JSON body and returns in
 * milliseconds. Each upload is recorded here as 'staged'; saving a product
 * flips the ones it uses to 'attached'.
 *
 * Staged assets that are never attached (form abandoned) are deleted from
 * R2 by services/media/mediaCleanupService.js once expiresAt passes.
 *
 * The record also proves ownership: a product can only be saved with image
 * keys that the same user staged, so nobody can attach someone else's files.
 */
const mongoose = require('mongoose');

const mediaAssetSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  url: { type: String, required: true },
  owner: {
    userId: { type: String, required: true, index: true },
    role: { type: String, required: true },
  },
  status: { type: String, enum: ['staged', 'attached'], default: 'staged', index: true },
  attachedTo: {
    kind: { type: String, default: '' },
    id: { type: String, default: '' },
  },
  width: { type: Number, default: null },
  height: { type: Number, default: null },
  bytes: { type: Number, default: 0 },
  expiresAt: { type: Date, default: null, index: true },
}, { timestamps: true });

module.exports = mongoose.model('MediaAsset', mediaAssetSchema);
