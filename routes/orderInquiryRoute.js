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
 * ONEDRIVE_ORDER_ROOT controls this — defaults to 'website/orders'.
 * Old root was 'Orders' (single segment, capital O).
 *
 * Two call sites updated:
 *   1. POST  / → buildOrderFolderHierarchy receives { ...req.body, folderRoot }
 *              so msGraphService uses the new root when building the hierarchy.
 *   2. DELETE /:id → deleteFolderByPath path array now starts with the two
 *              segments ['website', 'orders'] instead of ['Orders'].
 *
 * NOTE: If you have NOT yet updated msGraphService.buildOrderFolderHierarchy
 * to accept a `folderRoot` override, see the comment on the POST route below
 * for the fallback approach.
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
// Root segments for order folders in OneDrive.
// Old value: 'Orders'  (single segment, capital O)
// New value: 'website/orders'  → resolves to ['website', 'orders'] in path arrays
//
// Override via env var if needed:  ONEDRIVE_ORDER_ROOT=website/orders
const ONEDRIVE_ORDER_ROOT = (process.env.ONEDRIVE_ORDER_ROOT || 'website/orders').replace(/^\/|\/$/g, '');
// Split into segments for deleteFolderByPath (which takes an array):
//   'website/orders'  →  ['website', 'orders']
const ORDER_ROOT_SEGMENTS = ONEDRIVE_ORDER_ROOT.split('/');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const slugify = (str) =>
  str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Cryptographically secure 5-char alphanumeric token — same pattern as clientPortalRoutes
const genToken = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.randomBytes(5)).map(b => chars[b % chars.length]).join('');
};

const makePortalSlug = (refOrId) => `${genToken()}-${slugify(String(refOrId))}`;


// ─── GET / — list all orders ──────────────────────────────────────────────────
// FAST path: returns MongoDB data immediately — no OneDrive calls.
// Attachment metadata (name, type, size, webUrl) is stored on the DB record.
// The live OneDrive folder is fetched only when an order is opened (see /:id/attachments).
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

    // Create OneDrive folder — non-blocking on failure (order still saves)
    // folderRoot overrides the hardcoded 'Orders' root inside msGraphService so
    // new folders land at  website/orders/<client>/...  instead of  Orders/<client>/...
    const folderLink = await (async () => {
      try {
        const { folderId, folderUrl } = await buildOrderFolderHierarchy({
          ...req.body,
          folderRoot: ONEDRIVE_ORDER_ROOT,   // ← NEW: passes 'website/orders' to the service
        });
        await uploadFiles(folderId, attachments);
        return folderUrl;
      } catch (err) {
        logger.warn('OneDrive folder creation failed — order will save without folder link', {
          clientName, refNumber, error: err.message,
        });
        return null;
      }
    })();

    // Strip base64 from attachment records before saving to MongoDB
    const cleanedAttachments = (attachments || []).map(({ name, type, size, lastModified }) => ({
      name, type, size, lastModified,
    }));

    const order = new OrderInquiry({
      title, clientName, orderPlacedBy, description, refNumber,
      orderType:         orderType || 'product',
      status:            'inquiry',
      oneDriveFolderUrl: folderLink,
      attachments:       cleanedAttachments,
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

    // Auto-create ClientPortal — non-fatal
    try {
      const slug = makePortalSlug(order.refNumber || order._id);
      await ClientPortal.create({
        orderId:       order._id,
        slug,
        type:          order.orderType || 'product',
        orderRef:      order.refNumber || '',
        clientName:    order.clientName,
        orderPlacedBy: order.orderPlacedBy || '',
        title:         order.title || '',
      });
      logger.debug('ClientPortal auto-created', { orderId: order._id, slug });
    } catch (portalErr) {
      logger.warn('ClientPortal auto-create skipped', { orderId: order._id, error: portalErr.message });
    }

    res.status(201).json(order);
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

        // Sync attachments: delete removed files, upload new ones
        if (attachments) {
          const currentFiles = await listFolderContents(folderId).catch(() => []);
          const toDelete     = currentFiles.filter(f => !attachments.some(a => a.name === f.name));
          for (const f of toDelete) {
            await deleteFile(f.id).catch(e => logger.warn('OneDrive file delete failed', { file: f.name, error: e.message }));
          }
          const newUploads = attachments.filter(a => a.base64);
          if (newUploads.length) await uploadFiles(folderId, newUploads);
        }
      }
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

    // Delete OneDrive folder — non-fatal
    if (order.clientName && order.refNumber) {
      const orderDate = new Date(order.createdAt || order.updatedAt || new Date());
      const mo  = orderDate.getMonth() + 1;
      const y   = orderDate.getFullYear();
      const sh  = n => String(n).slice(-2).padStart(2, '0');
      const fy  = mo >= 4 ? `${sh(y)}-${sh(y + 1)}` : `${sh(y - 1)}-${sh(y)}`;

      await deleteFolderByPath([
        ...ORDER_ROOT_SEGMENTS,                          // ['website', 'orders']  (was ['Orders'])
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