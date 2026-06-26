'use strict';
/**
 * backend/routes/vendorRoutes.js
 * Mounted at /api/vendors
 *
 * FEATURE ADDITIONS:
 *   F1 — isPreferred  : Boolean field accepted in POST / PUT payloads.
 *   F2 — websiteUrl   : String field accepted in POST / PUT payloads.
 *         POST /api/vendors/extract-menu  — scrape nav categories from a URL
 *         using Cheerio (no headless browser, no AI).
 *   F3 — OneDrive vendor folders:
 *         Every vendor gets its own OneDrive folder at
 *           dev  →  development/vendors/<companyName>/
 *           prod →  website/vendors/<companyName>/
 *         All media is uploaded to that folder (buffer upload via Graph).
 *         When a vendor is deleted its folder is also deleted.
 */

const express  = require('express');
const router   = express.Router();
const cheerio  = require('cheerio');          // npm i cheerio
const Vendor   = require('../models/Vendor');
const upload   = require('../middleware/upload');
const { deleteFromR2 }          = require('../services/storageRouter');
const { extractFromBusinessCard } = require('../services/aiService');
const {
  getOrCreateFolder,
  uploadSingleFileBuffer,
  deleteFolderByPath,
  deleteFile: deleteOneDriveFile,
} = require('../services/msGraphService');
const { odvPath } = require('../utils/oneDrivePaths');
const logger   = require('../utils/logger').child({ module: 'vendorRoutes' });

// ─── OneDrive vendor folder path ─────────────────────────────────────────────
// dev  → ['development', 'vendors', <companyName>]
// prod → ['website',     'vendors', <companyName>]
const vendorFolderPath = (companyName) => odvPath('vendors', companyName);

// ─── Ensure (or reuse) the OneDrive folder for a vendor ──────────────────────
// Returns { folderId, folderUrl } — both are persisted on the vendor document.
// If the vendor document already has a folderId we just return it (idempotent).
const ensureVendorFolder = async (vendor) => {
  if (vendor.onedriveFolderId) {
    return { folderId: vendor.onedriveFolderId, folderUrl: vendor.onedriveFolderUrl };
  }
  const segments = vendorFolderPath(vendor.companyName);
  let parentId = 'root';
  for (const segment of segments) {
    parentId = await getOrCreateFolder(parentId, segment);
  }
  return { folderId: parentId, folderUrl: '' };   // webUrl populated after first upload
};

// ─── Upload a single multer buffer to the vendor's OneDrive folder ────────────
// ALL file types — images, PDFs, Excel, video, docs — go here.
// We deliberately do NOT call storageRouter so nothing gets scattered to R2
// or generic OneDrive paths. Every vendor attachment lives in one place.
const uploadToVendorFolder = async (folderId, file) => {
  const { v4: uuidv4 } = require('uuid');
  const pathMod = require('path');
  const ext      = pathMod.extname(file.originalname).toLowerCase() || '.bin';
  const filename = `${uuidv4()}${ext}`;

  // Upload directly by folder ID — no path walk needed (folderId already resolved)
  const result = await uploadSingleFileBuffer(
    [],          // folderPath unused when folderId is supplied
    filename,
    file.buffer,
    file.mimetype,
    folderId,    // ← direct ID upload (patched msGraphService)
  );

  return {
    name:     file.originalname,
    url:      result.webUrl,
    key:      result.fileId,   // OneDrive item ID — used for single-file deletion
    storage:  'onedrive',
    mimeType: file.mimetype,
    size:     file.size,
    label:    '',
  };
};

// ─── Helper: delete a cloud file, non-fatal ───────────────────────────────────
const deleteCloudFile = async (mediaItem) => {
  if (!mediaItem?.key) return;
  try {
    if (mediaItem.storage === 'r2') {
      await deleteFromR2(mediaItem.key);
    } else if (mediaItem.storage === 'onedrive') {
      // key is the OneDrive item ID for vendor media
      await deleteOneDriveFile(mediaItem.key);
    }
  } catch (err) {
    logger.warn('deleteCloudFile non-fatal', { key: mediaItem.key, error: err.message });
  }
};

// ─── GET / ────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const vendors = await Vendor.find().sort({ companyName: 1 }).lean();
    res.json(vendors);
  } catch (err) {
    logger.error('Failed to list vendors', { error: err.message });
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /media/:vendorId/:mediaId — authenticated OneDrive proxy ─────────────
/**
 * Streams a vendor media file from OneDrive through the backend so the browser
 * never needs a SharePoint session. The frontend uses this URL as the src for
 * <img>, <video>, <iframe> and download links instead of the raw webUrl.
 *
 * The OneDrive item ID is stored in media[].key on the vendor document.
 * We fetch a short-lived direct download URL from Graph and pipe it back.
 *
 * Query param ?download=1 adds Content-Disposition: attachment so the browser
 * downloads instead of previewing.
 */
router.get('/media/:vendorId/:mediaId', async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.vendorId).lean();
    if (!vendor) return res.status(404).json({ message: 'Vendor not found.' });

    const media = vendor.media.find(m => m._id.toString() === req.params.mediaId);
    if (!media) return res.status(404).json({ message: 'Media item not found.' });

    // Only OneDrive items need proxying. R2 URLs are public — redirect directly.
    if (media.storage === 'r2') {
      return res.redirect(302, media.url);
    }

    // media.key is the OneDrive item ID (fileId returned by uploadSingleFileBuffer)
    const itemId = media.key;
    if (!itemId) {
      return res.status(404).json({ message: 'No OneDrive item ID stored for this file.' });
    }

    const { getAccessToken } = require('../services/msGraphService');
    const MICROSOFT_USER_ID  = process.env.MICROSOFT_USER_ID;
    const token = await getAccessToken();

    // Ask Graph for the item metadata — the @microsoft.graph.downloadUrl field
    // is a short-lived (≈1h) pre-authenticated URL we can fetch without extra auth.
    const metaRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${MICROSOFT_USER_ID}/drive/items/${itemId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!metaRes.ok) {
      const err = await metaRes.text();
      logger.error('Graph item metadata failed', { itemId, status: metaRes.status, err });
      return res.status(metaRes.status).json({ message: 'Could not resolve file from OneDrive.' });
    }
    const meta        = await metaRes.json();
    const downloadUrl = meta['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) {
      return res.status(502).json({ message: 'OneDrive did not return a download URL.' });
    }

    // Stream the file back through our backend
    const fileRes = await fetch(downloadUrl);
    if (!fileRes.ok) {
      return res.status(fileRes.status).json({ message: 'Failed to stream file from OneDrive.' });
    }

    // Forward content type and length
    const ct = fileRes.headers.get('content-type') || media.mimeType || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    if (fileRes.headers.get('content-length')) {
      res.setHeader('Content-Length', fileRes.headers.get('content-length'));
    }
    // Cache for 1 hour in the browser (download URL is valid for ~1h from Graph)
    res.setHeader('Cache-Control', 'private, max-age=3600');

    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(media.name)}"`);
    } else {
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(media.name)}"`);
    }

    // Pipe the stream
    const { Readable } = require('stream');
    Readable.fromWeb(fileRes.body).pipe(res);

  } catch (err) {
    logger.error('Vendor media proxy failed', { error: err.message, ...req.params });
    res.status(500).json({ message: 'Media proxy error.', error: err.message });
  }
});

// ─── POST /extract-menu ───────────────────────────────────────────────────────
/**
 * Feature 2 — Website menu/category extraction using Cheerio.
 * Scrapes the <nav> and dropdown links of a vendor's website and returns
 * a structured list of top-level categories and their sub-items.
 *
 * Strategy (no AI, no headless browser):
 *   1. fetch() the URL with a real browser UA (follows redirects).
 *   2. Load into Cheerio and walk common nav selectors.
 *   3. De-duplicate, filter noise (login/cart/social), and return.
 *
 * Body: { url: string }
 * Response: { categories: [{ label, href, children: [{ label, href }] }] }
 */
router.post('/extract-menu', async (req, res) => {
  const { url } = req.body;
  if (!url?.trim()) {
    return res.status(400).json({ message: 'url is required.' });
  }

  // Normalise — prepend https:// if scheme is missing
  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = `https://${targetUrl}`;

  try {
    // ── 1. Fetch the page ────────────────────────────────────────────────────
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timer);

    if (!response.ok) {
      return res.status(502).json({ message: `Remote server returned ${response.status}` });
    }

    const html = await response.text();

    // ── 2. Parse with Cheerio ─────────────────────────────────────────────────
    const $ = cheerio.load(html);

    // Words that indicate utility links, not service categories
    const NOISE = new Set([
      'login', 'sign in', 'sign up', 'register', 'logout', 'cart', 'bag',
      'wishlist', 'account', 'profile', 'contact us', 'contact', 'home',
      'search', 'menu', 'facebook', 'instagram', 'twitter', 'linkedin',
      'youtube', 'tiktok', 'pinterest', 'whatsapp', 'privacy', 'terms',
      'cookie', 'sitemap', 'rss', 'help', 'faq',
    ]);
    const isNoise = (text) => NOISE.has(text.trim().toLowerCase());

    const cleanText = (el) => $(el).text().replace(/\s+/g, ' ').trim();

    // Resolve href relative to origin
    const origin = new URL(targetUrl).origin;
    const resolveHref = (href) => {
      if (!href || href === '#' || href.startsWith('javascript:')) return null;
      if (/^https?:\/\//i.test(href)) return href;
      return `${origin}${href.startsWith('/') ? '' : '/'}${href}`;
    };

    const categories = [];
    const seenLabels = new Set();

    /**
     * Common nav selectors in order of specificity.
     * We walk the first match that contains at least one <a> tag.
     */
    const NAV_SELECTORS = [
      'nav',
      '[role="navigation"]',
      'header ul',
      '.navbar',
      '.nav-menu',
      '.navigation',
      '.main-menu',
      '.primary-menu',
      '.site-navigation',
      '#main-nav',
      '#primary-nav',
      '#site-navigation',
      '.header-nav',
      '.top-nav',
    ];

    let $nav = null;
    for (const sel of NAV_SELECTORS) {
      const found = $(sel);
      if (found.length && found.find('a').length > 0) {
        $nav = found.first();
        break;
      }
    }

    if (!$nav) {
      // Fallback: use the whole page header or body if nothing nav-like found
      $nav = $('header').length ? $('header') : $('body');
    }

    // Walk top-level <li> items (or direct <a> tags) within the nav
    const processNavItem = ($li) => {
      // The direct anchor of this list item (skip sub-items)
      const $directA = $li.children('a').first();
      const label    = $directA.length ? cleanText($directA) : cleanText($li.find('a').first());
      const href     = resolveHref($directA.attr('href') || $li.find('a').first().attr('href') || '');

      if (!label || label.length < 2 || isNoise(label)) return;
      if (seenLabels.has(label.toLowerCase())) return;
      seenLabels.add(label.toLowerCase());

      // Collect children: sub-menus, dropdowns, nested <li>
      const children = [];
      const seenChildren = new Set();

      const $subItems = $li.find('ul li, .dropdown-menu li, .sub-menu li, [class*="dropdown"] li');
      $subItems.each((_, subEl) => {
        const $a      = $(subEl).find('a').first();
        const subLabel = cleanText($a);
        const subHref  = resolveHref($a.attr('href') || '');
        if (!subLabel || subLabel.length < 2 || isNoise(subLabel)) return;
        if (seenChildren.has(subLabel.toLowerCase())) return;
        seenChildren.add(subLabel.toLowerCase());
        children.push({ label: subLabel, href: subHref });
      });

      categories.push({ label, href, children });
    };

    // Try list-item based nav first
    const $topItems = $nav.find('> ul > li, > ul > li, ul:first-of-type > li');
    if ($topItems.length > 0) {
      $topItems.each((_, li) => processNavItem($(li)));
    } else {
      // Flat anchor-based nav (no ul/li structure)
      $nav.find('a').each((_, a) => {
        const label = cleanText(a);
        const href  = resolveHref($(a).attr('href') || '');
        if (!label || label.length < 2 || isNoise(label)) return;
        if (seenLabels.has(label.toLowerCase())) return;
        seenLabels.add(label.toLowerCase());
        categories.push({ label, href, children: [] });
      });
    }

    // ── 3. Build human-readable text for the textarea ─────────────────────────
    const lines = [];
    for (const cat of categories) {
      lines.push(cat.label);
      for (const child of cat.children) {
        lines.push(`  • ${child.label}`);
      }
    }
    const text = lines.join('\n');

    logger.info('Menu extracted', { url: targetUrl, categoryCount: categories.length });
    return res.json({ categories, text });

  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ message: 'Request to vendor website timed out.' });
    }
    logger.error('extract-menu failed', { url: targetUrl, error: err.message });
    return res.status(500).json({ message: 'Failed to extract menu.', error: err.message });
  }
});

/**
 * POST / — create vendor
 * F1: accepts isPreferred in body
 * F2: accepts websiteUrl in body
 * F3: creates a vendor-specific OneDrive folder and uploads all media there
 */
router.post('/',
  (req, _res, next) => { req.r2Folder = 'vendors'; req.skipStorageRouter = true; next(); },
  upload.array('mediaFiles', 20),
  async (req, res) => {
    try {
      const {
        companyName, state, city, category, subCategory,
        suppliedProducts, description, gstNumber,
        isPreferred, websiteUrl,
      } = req.body;

      if (!companyName?.trim())
        return res.status(400).json({ message: 'Company name is required.' });

      let contacts = [];
      if (req.body.contacts) {
        try { contacts = JSON.parse(req.body.contacts); }
        catch (e) { logger.warn('Vendor contacts JSON parse failed', { error: e.message }); }
      }

      // ── F3: ensure OneDrive folder ────────────────────────────────────────
      // Create a stub vendor object so ensureVendorFolder can read companyName
      const stubVendor = { companyName: companyName.trim(), onedriveFolderId: '' };
      const { folderId } = await ensureVendorFolder(stubVendor).catch(err => {
        logger.warn('Could not create OneDrive vendor folder', { error: err.message });
        return { folderId: null };
      });

      // ── Upload all media to vendor's OneDrive folder ──────────────────────
      // Images, PDFs, Excel, video, docs — ALL go into the vendor folder.
      // storageRouter is NOT used here; it would scatter files across R2/generic OneDrive paths.
      const mediaFiles = req.files || [];
      let media = [];
      if (folderId) {
        media = await Promise.all(mediaFiles.map(f => uploadToVendorFolder(folderId, f)));
      } else {
        // OneDrive folder creation failed — log and skip attachments; don't scatter to other paths
        if (mediaFiles.length > 0) {
          logger.error('Vendor OneDrive folder unavailable — attachments NOT saved', {
            name: companyName.trim(), fileCount: mediaFiles.length,
          });
        }
        media = [];
      }

      const vendor = await Vendor.create({
        companyName:       companyName.trim(),
        state, city, category, subCategory, suppliedProducts, description, gstNumber,
        isPreferred:       isPreferred === 'true' || isPreferred === true,
        websiteUrl:        websiteUrl || '',
        onedriveFolderId:  folderId || '',
        contacts,
        media,
      });

      logger.info('Vendor created', { vendorId: vendor._id, name: vendor.companyName });
      res.status(201).json(vendor);
    } catch (err) {
      logger.error('Vendor creation failed', { error: err.message });
      res.status(400).json({ message: err.message });
    }
  }
);

/**
 * PUT /:id — update vendor
 * F1: accepts isPreferred in body
 * F2: accepts websiteUrl in body
 * F3: reuses the existing OneDrive folder (or creates one if missing); uploads new media there
 */
router.put('/:id',
  (req, _res, next) => { req.r2Folder = 'vendors'; req.skipStorageRouter = true; next(); },
  upload.array('mediaFiles', 20),
  async (req, res) => {
    try {
      const vendor = await Vendor.findById(req.params.id);
      if (!vendor) return res.status(404).json({ message: 'Vendor not found.' });

      const {
        companyName, state, city, category, subCategory,
        suppliedProducts, description, gstNumber, keepMediaIds,
        isPreferred, websiteUrl,
      } = req.body;

      const keepIds = keepMediaIds
        ? keepMediaIds.split(',').map(s => s.trim()).filter(Boolean)
        : vendor.media.map(m => m._id.toString());

      // Delete removed media from cloud
      for (const m of vendor.media) {
        if (!keepIds.includes(m._id.toString())) {
          await deleteCloudFile(m);
        }
      }

      let contacts = vendor.contacts;
      if (req.body.contacts) {
        try { contacts = JSON.parse(req.body.contacts); }
        catch (e) { logger.warn('Vendor contacts JSON parse failed on update', { error: e.message }); }
      }

      // ── F3: ensure OneDrive folder (reuse existing if already created) ─────
      // If companyName changes, we still use the existing folder ID — rename is optional.
      const { folderId } = await ensureVendorFolder(vendor).catch(err => {
        logger.warn('Could not resolve OneDrive vendor folder on update', { error: err.message });
        return { folderId: null };
      });

      const retainedMedia = vendor.media.filter(m => keepIds.includes(m._id.toString()));
      const mediaFiles    = req.files || [];
      let newMedia        = [];

      if (folderId) {
        newMedia = await Promise.all(mediaFiles.map(f => uploadToVendorFolder(folderId, f)));
      } else {
        if (mediaFiles.length > 0) {
          logger.error('Vendor OneDrive folder unavailable on update — new attachments NOT saved', {
            vendorId: req.params.id, fileCount: mediaFiles.length,
          });
        }
        newMedia = [];
      }

      const updated = await Vendor.findByIdAndUpdate(
        req.params.id,
        {
          companyName:       companyName?.trim()     ?? vendor.companyName,
          state:             state                   ?? vendor.state,
          city:              city                    ?? vendor.city,
          category:          category                ?? vendor.category,
          subCategory:       subCategory             ?? vendor.subCategory,
          suppliedProducts:  suppliedProducts         ?? vendor.suppliedProducts,
          description:       description              ?? vendor.description,
          gstNumber:         gstNumber                ?? vendor.gstNumber,
          isPreferred:       isPreferred !== undefined
                               ? (isPreferred === 'true' || isPreferred === true)
                               : vendor.isPreferred,
          websiteUrl:        websiteUrl !== undefined ? websiteUrl : vendor.websiteUrl,
          onedriveFolderId:  folderId || vendor.onedriveFolderId,
          contacts,
          media: [...retainedMedia, ...newMedia],
        },
        { new: true }
      );

      logger.info('Vendor updated', {
        vendorId: req.params.id,
        newFiles: newMedia.length,
        removedFiles: vendor.media.length - retainedMedia.length,
      });
      res.json(updated);
    } catch (err) {
      logger.error('Vendor update failed', { vendorId: req.params.id, error: err.message });
      res.status(400).json({ message: err.message });
    }
  }
);

/**
 * DELETE /:id/media/:mediaId — remove one media file
 */
router.delete('/:id/media/:mediaId', async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found.' });

    const media = vendor.media.id(req.params.mediaId);
    if (!media) return res.status(404).json({ message: 'Media not found.' });

    await deleteCloudFile(media);
    media.deleteOne();
    await vendor.save();

    logger.info('Vendor media deleted', { vendorId: req.params.id, mediaId: req.params.mediaId });
    res.json({ message: 'Media deleted.' });
  } catch (err) {
    logger.error('Vendor media delete failed', { vendorId: req.params.id, error: err.message });
    res.status(500).json({ message: err.message });
  }
});

/**
 * DELETE /:id — delete vendor + all media + OneDrive vendor folder (F3)
 */
router.delete('/:id', async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found.' });

    // ── F3: Delete the entire vendor OneDrive folder ──────────────────────────
    // We prefer deleting by folder path (more resilient than ID after renames).
    // deleteFolderByPath silently skips 404 — safe to call even if folder never existed.
    const folderSegments = vendorFolderPath(vendor.companyName);
    await deleteFolderByPath(folderSegments).catch(err =>
      logger.warn('OneDrive vendor folder deletion failed (non-fatal)', { error: err.message })
    );

    // Also delete any R2 files that may exist from before the OneDrive migration
    for (const m of vendor.media || []) {
      if (m.storage === 'r2') await deleteCloudFile(m);
    }

    await Vendor.findByIdAndDelete(req.params.id);

    logger.info('Vendor deleted', { vendorId: req.params.id, name: vendor.companyName });
    res.json({ message: 'Vendor deleted.' });
  } catch (err) {
    logger.error('Vendor delete failed', { vendorId: req.params.id, error: err.message });
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /scan-card — AI business card scan ──────────────────────────────────
router.post('/scan-card', async (req, res) => {
  try {
    const { image, backImage, mimeType } = req.body;
    if (!image) return res.status(400).json({ message: 'Image is required.' });
    const result = await extractFromBusinessCard(image, backImage);
    res.json(result);
  } catch (err) {
    logger.error('Business card scan failed', { error: err.message });
    res.status(500).json({ message: 'Card scan failed.', error: err.message });
  }
});

module.exports = router;