'use strict';
/**
 * backend/routes/orderInquiryRoute.js
 * Mounted at /api/orders
 *
 *   GET    /                  — list all orders (fast, DB only — no OneDrive calls)
 *   GET    /:id/attachments   — live OneDrive listing for one order (lazy, on open)
 *   POST   /                  — create order + OneDrive folder + auto-create ClientPortal
 *   PATCH  /:id               — update order + sync OneDrive (rename folder, add/remove files)
 *   DELETE /:id               — delete order + OneDrive folder
 *
 * STORAGE PATH CHANGE (2025):
 * ─────────────────────────────────────────────────────────────────────────────
 * OneDrive folder root changed from:
 *   Orders/<client>/<fy>/<contact>/<ref>
 * to:
 *   website/orders/<client>/<fy>/<contact>/<ref>
 *
 * DEV / PROD ISOLATION:
 * ─────────────────────────────────────────────────────────────────────────────
 * When NODE_ENV !== 'production', all OneDrive paths are re-rooted under
 * 'development' instead of 'website':
 *   production  →  website/orders/<client>/...
 *   development →  development/orders/<client>/...
 *
 * This is handled centrally by utils/oneDrivePaths.js — no duplication here.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * CHANGE (attachment URLs):
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /  — uploadFiles() now returns { name, size, webUrl, downloadUrl } for
 *           each file. These are persisted to MongoDB so the Files column in
 *           OrderTracker renders live links immediately on list load, without
 *           requiring the user to click into the order detail popup.
 *
 * PATCH /:id — after uploading new files, their webUrl/downloadUrl are merged
 *              back into the attachments array saved to MongoDB. Previously
 *              only the name/size from the client payload was kept, so links
 *              were lost on edit.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express      = require('express');
const router       = express.Router();
const crypto       = require('crypto');
const OrderInquiry = require('../models/orderInquiry');
const ClientPortal = require('../models/ClientPortal');
const logger       = require('../utils/logger').child({ module: 'orderInquiryRoute' });

const {
  buildOrderFolderHierarchy,
  uploadFiles,
  listFolderContents,
  deleteFile,
  deleteFolderByPath,
  renameItem,
  getFolderIdFromUrl,
} = require('../services/msGraphService');

// ─── OneDrive path config ─────────────────────────────────────────────────────
// Central helper: returns ['website', ...] in production, ['development', ...] in dev.
const { odvPath, odvSegments } = require('../utils/oneDrivePaths');

// Root segments for deleteFolderByPath (which takes an array).
// prod  → ['website', 'orders']
// dev   → ['development', 'orders']
const ORDER_ROOT_SEGMENTS = odvSegments('orders');

// String form for buildOrderFolderHierarchy's folderRoot param.
// prod  → 'website/orders'
// dev   → 'development/orders'
const ORDER_FOLDER_ROOT = ORDER_ROOT_SEGMENTS.join('/');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const slugify = (str) =>
  str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Cryptographically secure 5-char alphanumeric token — same pattern as clientPortalRoutes
const genToken = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.randomBytes(5)).map(b => chars[b % chars.length]).join('');
};

//const makePortalSlug = (refOrId) => `${genToken()}-${slugify(String(refOrId))}`;
const makePortalSlug = () =>
  Array.from({length: 10}, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');

// ─── GET / — list all orders ──────────────────────────────────────────────────
// FAST path: returns MongoDB data immediately — no OneDrive calls.
// Attachment metadata (name, type, size, webUrl, downloadUrl) is stored on the
// DB record and populated at creation / edit time. The live OneDrive folder is
// only re-fetched when an order is opened (see /:id/attachments).
router.get('/', async (req, res) => {
  try {
    const orders = await OrderInquiry.find().sort({ updatedAt: -1 }).lean();
    logger.debug('Orders listed', { count: orders.length, userId: req.user?.id });
    res.json(orders.map(o => ({ ...o, attachments: o.attachments || [] })));
  } catch (err) {
    logger.error('Orders list failed', { error: err.message, stack: err.stack });
    res.status(500).json([]);
  }
});

// ─── GET /:id/attachments — live OneDrive listing ────────────────────────────
// Lazy: called only when a specific order is opened in the edit modal.
// Non-fatal: returns stored metadata on OneDrive failure rather than 500.
router.get('/:id/attachments', async (req, res) => {
  try {
    const order = await OrderInquiry.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (!order.oneDriveFolderUrl) return res.json([]);

    const folderId = await getFolderIdFromUrl(order.oneDriveFolderUrl).catch(() => null);
    if (!folderId) {
      logger.warn('OneDrive folder ID not resolved — returning stored metadata', {
        orderId:  req.params.id,
        folderUrl: order.oneDriveFolderUrl,
      });
      return res.json(order.attachments || []);
    }

    const files = await listFolderContents(folderId);
    res.json(files.map(f => ({
      name:        f.name,
      size:        f.size,
      webUrl:      f.webUrl,
      downloadUrl: f['@microsoft.graph.downloadUrl'],
      isOneDrive:  true,
    })));
  } catch (err) {
    logger.error('Attachment fetch failed — returning empty', { orderId: req.params.id, error: err.message });
    res.json([]); // non-fatal — never 500 for attachment listing
  }
});

// ─── POST / — create order ────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { title, clientName, orderPlacedBy, description, refNumber, attachments, orderType } = req.body;

    if (!clientName || !orderPlacedBy)
      return res.status(400).json({ error: 'Client Name and Contact Person are required.' });

    // Base fallback: strip base64 but keep name/type/size/lastModified.
    // This is used only when OneDrive upload fails — webUrl will be absent
    // and the row chip will render without a link (graceful degradation).
    const cleanedAttachments = (attachments || []).map(({ name, type, size, lastModified }) => ({
      name, type, size, lastModified,
    }));

    // Will be replaced with richer metadata if OneDrive upload succeeds.
    let savedAttachmentMeta = cleanedAttachments;

    // Create OneDrive folder — non-blocking on failure (order still saves).
    // ORDER_FOLDER_ROOT switches automatically between 'website/orders' (prod)
    // and 'development/orders' (dev) via utils/oneDrivePaths.
    const folderLink = await (async () => {
      try {
        const { folderId, folderUrl } = await buildOrderFolderHierarchy({
          ...req.body,
          folderRoot: ORDER_FOLDER_ROOT,   // ← env-aware: 'website/orders' or 'development/orders'
        });

        // uploadFiles now returns [{ name, size, webUrl, downloadUrl }, ...]
        // Use this to persist live URLs to MongoDB — no separate listFolderContents needed.
        const uploadedMeta = await uploadFiles(folderId, attachments);

        if (uploadedMeta?.length) {
          // Merge: keep original type/lastModified from the client payload,
          // enrich with webUrl/downloadUrl/size from the Graph response.
          const byName = Object.fromEntries(
            (attachments || []).map(a => [a.name, { type: a.type, lastModified: a.lastModified }])
          );
          savedAttachmentMeta = uploadedMeta.map(u => ({
            name:         u.name,
            size:         u.size,
            webUrl:       u.webUrl       || null,
            downloadUrl:  u.downloadUrl  || null,
            type:         byName[u.name]?.type         || null,
            lastModified: byName[u.name]?.lastModified || null,
          }));
        }

        return folderUrl;
      } catch (err) {
        logger.warn('OneDrive folder creation failed — order will save without folder link', {
          clientName, refNumber, error: err.message,
        });
        return null;
      }
    })();

    const order = new OrderInquiry({
      title, clientName, orderPlacedBy, description, refNumber,
      orderType:         orderType || 'product',
      status:            'inquiry',
      oneDriveFolderUrl: folderLink,
      attachments:       savedAttachmentMeta,  // ← includes webUrl/downloadUrl when OneDrive succeeds
    });
    await order.save();

    logger.info('Order created', {
      orderId:    order._id,
      refNumber,
      clientName,
      orderType:  order.orderType,
      hasFolder:  !!folderLink,
      userId:     req.user?.id,
    });

    // 1. Declare the slug variable in the upper scope
    let createdSlug = null;

    // Auto-create ClientPortal — non-fatal
    try {
      //const slug = makePortalSlug(order.refNumber || order._id);
      const slug = makePortalSlug();
      await ClientPortal.create({
        orderId:       order._id,
        slug,
        type:          order.orderType || 'product',
        orderRef:      order.refNumber || '',
        clientName:    order.clientName,
        orderPlacedBy: order.orderPlacedBy || '',
        title:         order.title || '',
      });

      // 2. Assign the slug to the outer variable if creation succeeds
      createdSlug = slug;
      logger.debug('ClientPortal auto-created', { orderId: order._id, slug });
    } catch (portalErr) {
      logger.warn('ClientPortal auto-create skipped', { orderId: order._id, error: portalErr.message });
    }

    // 3. Return a combined response payload
    const responsePayload = {
      ...order.toObject(), // Converts Mongoose document to plain object
      ...(createdSlug && { slug: createdSlug }) // Conditionally includes slug if it exists
    };
    res.status(201).json(responsePayload);
    //res.status(201).json(order);
  } catch (err) {
    if (err.code === 11000) {
      logger.warn('Order creation blocked — duplicate ref number', { refNumber: req.body.refNumber });
      return res.status(400).json({ error: 'Reference number already exists.' });
    }
    logger.error('Order creation failed', { error: err.message, stack: err.stack, userId: req.user?.id });
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /:id — update order ────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const { attachments, ...updateData } = req.body;
    const existing = await OrderInquiry.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Order not found.' });

    if (existing.oneDriveFolderUrl) {
      const folderId = await getFolderIdFromUrl(existing.oneDriveFolderUrl).catch(() => null);

      if (folderId) {
        // Rename OneDrive folder if ref number changed
        if (updateData.refNumber && updateData.refNumber !== existing.refNumber) {
          const newFolderName = updateData.refNumber.replace(/\//g, '-').trim();
          const newUrl = await renameItem(folderId, newFolderName).catch((e) => {
            logger.warn('OneDrive folder rename failed', { orderId: req.params.id, error: e.message });
            return null;
          });
          if (newUrl) updateData.oneDriveFolderUrl = newUrl;
        }

        // Rename OneDrive folder to invoice number when order is marked completed.
        // e.g. QT-26-27-0072 → INV-26-27-008
        if (
          updateData.status === 'completed' &&
          updateData.invoiceNumber &&
          updateData.invoiceNumber !== existing.invoiceNumber
        ) {
          const invoiceFolderName = updateData.invoiceNumber.replace(/\//g, '-').trim();
          const newUrl = await renameItem(folderId, invoiceFolderName).catch((e) => {
            logger.warn('OneDrive folder rename (invoice) failed', { orderId: req.params.id, error: e.message });
            return null;
          });
          if (newUrl) updateData.oneDriveFolderUrl = newUrl;
        }

        // Sync attachments: delete removed files, upload new ones
        if (attachments) {
          const currentFiles = await listFolderContents(folderId).catch(() => []);
          const toDelete     = currentFiles.filter(f => !attachments.some(a => a.name === f.name));
          for (const f of toDelete) {
            await deleteFile(f.id).catch(e => logger.warn('OneDrive file delete failed', { file: f.name, error: e.message }));
          }

          // Upload new files (those with base64 data) and capture their URLs.
          const newUploads = attachments.filter(a => a.base64);
          let uploadedMeta = [];
          if (newUploads.length) {
            uploadedMeta = await uploadFiles(folderId, newUploads);
          }

          // Rebuild the attachments array for MongoDB:
          //   - existing files (no base64): keep whatever webUrl/downloadUrl they already have
          //   - newly uploaded files: enrich with fresh webUrl/downloadUrl from Graph response
          const uploadedByName = Object.fromEntries(uploadedMeta.map(u => [u.name, u]));
          updateData.attachments = attachments.map(a => {
            if (a.base64) {
              // Newly uploaded — use Graph metadata if available, fall back to client payload
              const u = uploadedByName[a.name];
              return {
                name:         a.name,
                size:         u?.size         || a.size         || null,
                webUrl:       u?.webUrl       || null,
                downloadUrl:  u?.downloadUrl  || null,
                type:         a.type          || null,
                lastModified: a.lastModified  || null,
              };
            }
            // Existing file — preserve all stored fields (including webUrl)
            return {
              name:         a.name,
              size:         a.size         || null,
              webUrl:       a.webUrl       || null,
              downloadUrl:  a.downloadUrl  || null,
              type:         a.type         || null,
              lastModified: a.lastModified || null,
            };
          });
        }
      }
    } else if (attachments) {
      // No OneDrive folder — still persist the attachment list as-is
      // (preserves any webUrl already on existing records, strips base64)
      updateData.attachments = attachments.map(({ name, type, size, lastModified, webUrl, downloadUrl }) => ({
        name, type, size, lastModified,
        ...(webUrl      && { webUrl }),
        ...(downloadUrl && { downloadUrl }),
      }));
    }

    const updated = await OrderInquiry.findByIdAndUpdate(
      req.params.id,
      { ...updateData, updatedAt: Date.now() },
      { new: true }
    );

    logger.info('Order updated', { orderId: req.params.id, userId: req.user?.id });
    res.json(updated);
  } catch (err) {
    logger.error('Order update failed', { orderId: req.params.id, error: err.message, stack: err.stack });
    res.status(400).json({ error: err.message });
  }
});

// ─── DELETE /:id — delete order + OneDrive folder ────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const order = await OrderInquiry.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    // Delete OneDrive folder — non-fatal.
    // ORDER_ROOT_SEGMENTS is ['website','orders'] in prod, ['development','orders'] in dev.
    if (order.clientName && order.refNumber) {
      const orderDate = new Date(order.createdAt || order.updatedAt || new Date());
      const mo  = orderDate.getMonth() + 1;
      const y   = orderDate.getFullYear();
      const sh  = n => String(n).slice(-2).padStart(2, '0');
      const fy  = mo >= 4 ? `${sh(y)}-${sh(y + 1)}` : `${sh(y - 1)}-${sh(y)}`;

      await deleteFolderByPath([
        ...ORDER_ROOT_SEGMENTS,                          // ['website','orders'] or ['development','orders']
        (order.clientName    || 'Unknown Client').trim(),
        fy,
        (order.orderPlacedBy || 'General').trim(),
        order.refNumber.replace(/\//g, '-').trim(),
      ]).catch(e => logger.warn('OneDrive folder delete failed — order still deleted', {
        orderId:   req.params.id,
        refNumber: order.refNumber,
        error:     e.message,
      }));
    }

    await OrderInquiry.findByIdAndDelete(req.params.id);
    logger.info('Order deleted', { orderId: req.params.id, refNumber: order.refNumber, userId: req.user?.id });
    res.json({ message: 'Order deleted.' });
  } catch (err) {
    logger.error('Order delete failed', { orderId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;