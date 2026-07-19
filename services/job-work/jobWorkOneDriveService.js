'use strict';
/**
 * services/jobWorkOneDriveService.js
 *
 * Thin job-work-specific wrapper around services/msGraphService.js.
 * Folder convention (per spec):
 *   development env -> OneDrive / development / job work / job work folder <serialId>
 *   production  env -> OneDrive / website     / job work / job work folder <serialId>
 * Built with utils/oneDrivePaths.js's odvPath(), the same dev/prod root
 * switch already used for invoices/PI-attachments/payments.
 */
const { odvPath } = require('../../utils/oneDrivePaths');
const { uploadSingleFileBuffer, deleteFile, getOrCreateFolder } = require('../msGraphService');
const logger = require('../../utils/logger').child({ module: 'jobWorkOneDriveService' });

/** ['development'|'website', 'job work', 'job work folder <serialId>'] */
const buildJobWorkFolderPath = (serialId) =>
  odvPath('job work', `job work folder ${serialId.replace(/\//g, '-')}`);

/**
 * Uploads one or more multer memoryStorage files into the row's OneDrive
 * folder, creating the folder on first upload and reusing its id afterwards.
 *
 * @param {string}   serialId
 * @param {Array}    files          multer file objects ({ originalname, buffer, mimetype, size })
 * @param {string}   [existingFolderId]  reuse when adding more images to an existing row
 * @returns {Promise<{ folderId: string, folderPath: string[], images: Array }>}
 */
const uploadJobWorkImages = async (serialId, files, existingFolderId) => {
  if (!files?.length) {
    return { folderId: existingFolderId || '', folderPath: buildJobWorkFolderPath(serialId), images: [] };
  }

  const folderPath = buildJobWorkFolderPath(serialId);
  let folderId = existingFolderId || '';
  if (!folderId) {
    let parentId = 'root';
    for (const segment of folderPath) {
      parentId = await getOrCreateFolder(parentId, segment);
    }
    folderId = parentId;
  }

  const images = [];
  for (const file of files) {
    const ext = (file.originalname.match(/\.[a-zA-Z0-9]+$/) || ['.jpg'])[0];
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const result = await uploadSingleFileBuffer(folderPath, filename, file.buffer, file.mimetype, folderId);
    images.push({
      filename,
      url: result.webUrl,
      oneDriveItemId: result.fileId,
      mimeType: file.mimetype,
      size: file.size,
    });
  }

  logger.info('Job work images uploaded', { serialId, count: images.length, folder: folderPath.join('/') });
  return { folderId, folderPath, images };
};

/** Deletes the whole OneDrive folder for a row (best-effort, logs failures). */
const deleteJobWorkFolder = async (folderId) => {
  if (!folderId) return;
  try {
    await deleteFile(folderId);
  } catch (err) {
    logger.error('Failed to delete job work OneDrive folder', { folderId, error: err.message });
  }
};

module.exports = { buildJobWorkFolderPath, uploadJobWorkImages, deleteJobWorkFolder };
