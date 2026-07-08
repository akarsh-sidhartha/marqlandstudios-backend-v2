'use strict';
/**
 * backend/routes/orderInquiryRoute.js
 * Mounted at /api/orders
 *
 *   GET    /                  — list all orders (fast, DB only — no OneDrive calls)
 *   GET    /shipment-counts   — orderId → linked shipment count  ← NEW
 *   GET    /:id/attachments   — live OneDrive listing for one order (lazy, on open)
 *   POST   /                  — create order + OneDrive folder + auto-create ClientPortal
 *   PATCH  /:id               — update order + sync OneDrive (rename folder, add/remove files)
 *   POST   /:id/timeline      — post a staff update + send threaded client email  ← NEW
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
const Client       = require('../models/Client'); // adjust path/name if your client model differs
const Shipment     = require('../models/Shipment');
const logger       = require('../utils/logger').child({ module: 'orderInquiryRoute' });

const { sendTimelineUpdateEmail } = require('../services/emailService');

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

// ─── GET /shipment-counts — orderId → linked shipment count ───────────────────
// Backs the row-level "Linked Shipments" icon in OrderTracker.js — the icon is
// only shown when an order actually has shipments, without needing to open the
// (self-fetching) LinkedShipmentsPanel just to find out.
router.get('/shipment-counts', async (req, res) => {
  try {
    const counts = await Shipment.aggregate([
      { $match: { orderId: { $ne: null } } },
      { $group: { _id: '$orderId', count: { $sum: 1 } } },
    ]);
    const result = {};
    counts.forEach(c => { result[c._id.toString()] = c.count; });
    res.json(result);
  } catch (err) {
    logger.error('Shipment counts failed', { error: err.message });
    res.status(500).json({});
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
      itemId:      f.id,          // OneDrive item ID — used by /proxy-attachment
      mimeType:    f.file?.mimeType || '',
      isOneDrive:  true,
    })));
  } catch (err) {
    logger.error('Attachment fetch failed — returning empty', { orderId: req.params.id, error: err.message });
    res.json([]); // non-fatal — never 500 for attachment listing
  }
});

// ─── GET /proxy-attachment — authenticated OneDrive stream ───────────────────
/**
 * Streams a single OneDrive file through the backend so the browser never
 * needs a SharePoint/Microsoft session. Identical pattern to the vendor
 * media proxy (/api/vendors/media/:vendorId/:mediaId).
 *
 * Query params:
 *   ?itemId=<OneDrive item ID>   (required)
 *   ?download=1                  (optional — forces Content-Disposition: attachment)
 *
 * This route is whitelisted as public in authMiddleware (ROUTE_PERMISSIONS),
 * matching '/orders/proxy-attachment'. The Graph bearer token (client
 * credentials) is the actual auth layer for the file content.
 */
router.get('/proxy-attachment', async (req, res) => {
  const { itemId, download } = req.query;
  if (!itemId) return res.status(400).json({ error: 'itemId query param is required.' });

  try {
    const { getAccessToken } = require('../services/msGraphService');
    const MICROSOFT_USER_ID  = process.env.MICROSOFT_USER_ID;
    const token = await getAccessToken();

    // Fetch item metadata from Graph — includes @microsoft.graph.downloadUrl
    // which is a short-lived (~1h) pre-authenticated direct download URL.
    const metaRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${MICROSOFT_USER_ID}/drive/items/${itemId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!metaRes.ok) {
      const text = await metaRes.text();
      logger.error('Graph item metadata failed', { itemId, status: metaRes.status, text });
      return res.status(metaRes.status).json({ error: 'Could not resolve file from OneDrive.' });
    }

    const meta        = await metaRes.json();
    const dlUrl       = meta['@microsoft.graph.downloadUrl'];
    const mimeType    = meta.file?.mimeType || 'application/octet-stream';
    const filename    = meta.name || 'file';

    if (!dlUrl) return res.status(502).json({ error: 'OneDrive did not return a download URL.' });

    // Stream the file back through our server
    const fileRes = await fetch(dlUrl);
    if (!fileRes.ok) return res.status(fileRes.status).json({ error: 'Failed to stream file from OneDrive.' });

    res.setHeader('Content-Type', mimeType);
    if (fileRes.headers.get('content-length')) {
      res.setHeader('Content-Length', fileRes.headers.get('content-length'));
    }
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader(
      'Content-Disposition',
      `${download === '1' ? 'attachment' : 'inline'}; filename="${encodeURIComponent(filename)}"`
    );

    const { Readable } = require('stream');
    Readable.fromWeb(fileRes.body).pipe(res);

  } catch (err) {
    logger.error('Order attachment proxy failed', { itemId, error: err.message });
    res.status(500).json({ error: 'Proxy error: ' + err.message });
  }
});

// ─── POST / — create order ────────────────────────────────────────────────────
/**
 * STRATEGY: respond immediately after DB save, do OneDrive work in the background.
 *
 * The original flow was fully sequential:
 *   buildOrderFolderHierarchy (4-5 Graph calls) → uploadFiles → save → respond
 *
 * That caused 30 s timeouts when the Graph API was slow or the token was being
 * refreshed. Now:
 *   1. Save to MongoDB with cleaned attachment metadata (no webUrls yet)
 *   2. Auto-create ClientPortal
 *   3. Respond 201 immediately — frontend unblocks
 *   4. Background: create OneDrive folder, upload files, patch the order record
 *
 * The order appears in the list instantly. Attachment webUrls become available
 * a few seconds later (visible after the user next opens the order or refreshes).
 */
router.post('/', async (req, res) => {
  try {
    const { title, clientName, orderPlacedBy, description, refNumber, attachments, orderType } = req.body;

    if (!clientName || !orderPlacedBy)
      return res.status(400).json({ error: 'Client Name and Contact Person are required.' });

    // Strip base64 from attachment metadata — we never store raw base64 in MongoDB.
    // webUrl/downloadUrl will be backfilled by the background OneDrive job below.
    const cleanedAttachments = (attachments || []).map(({ name, type, size, lastModified }) => ({
      name, type, size, lastModified,
    }));

    // ── 1. Save to DB immediately ─────────────────────────────────────────────
    const order = new OrderInquiry({
      title, clientName, orderPlacedBy, description, refNumber,
      orderType:   orderType || 'product',
      status:      'inquiry',
      attachments: cleanedAttachments,   // no webUrls yet — backfilled in background
    });
    await order.save();

    logger.info('Order created (fast path)', {
      orderId: order._id, refNumber, clientName,
      orderType: order.orderType, userId: req.user?.id,
    });

    // ── 2. Auto-create ClientPortal (fast — MongoDB only) ─────────────────────
    let createdSlug = null;
    try {
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
      createdSlug = slug;
      logger.debug('ClientPortal auto-created', { orderId: order._id, slug });
    } catch (portalErr) {
      logger.warn('ClientPortal auto-create skipped', { orderId: order._id, error: portalErr.message });
    }

    // ── 3. Respond immediately ────────────────────────────────────────────────
    res.status(201).json({
      ...order.toObject(),
      ...(createdSlug && { slug: createdSlug }),
    });

    // ── 4. Background: OneDrive folder + file uploads ─────────────────────────
    // Runs after the response is sent — never blocks the client.
    // Any failure is logged and non-fatal; the order is already saved.
    setImmediate(async () => {
      try {
        const { folderId, folderUrl } = await buildOrderFolderHierarchy({
          ...req.body,
          folderRoot: ORDER_FOLDER_ROOT,
        });

        // Patch the order with the folder URL first so the edit modal can
        // resolve the folder even before attachments finish uploading.
        await OrderInquiry.findByIdAndUpdate(order._id, { oneDriveFolderUrl: folderUrl });
        logger.debug('OneDrive folder created (background)', { orderId: order._id, folderUrl });

        // Upload attachments that have base64 data
        const toUpload = (attachments || []).filter(a => a.base64 || a.data);
        if (toUpload.length) {
          const uploadedMeta = await uploadFiles(folderId, toUpload);

          if (uploadedMeta?.length) {
            const byName = Object.fromEntries(
              toUpload.map(a => [a.name, { type: a.type, lastModified: a.lastModified }])
            );
            const enrichedAttachments = uploadedMeta.map(u => ({
              name:         u.name,
              size:         u.size,
              webUrl:       u.webUrl      || null,
              downloadUrl:  u.downloadUrl || null,
              type:         byName[u.name]?.type         || null,
              lastModified: byName[u.name]?.lastModified || null,
            }));

            await OrderInquiry.findByIdAndUpdate(order._id, { attachments: enrichedAttachments });
            logger.info('OneDrive attachments uploaded (background)', {
              orderId: order._id, count: enrichedAttachments.length,
            });
          }
        }
      } catch (bgErr) {
        // Non-fatal — order exists in DB; OneDrive sync can be retried manually
        logger.error('OneDrive background sync failed (order still saved)', {
          orderId: order._id, error: bgErr.message,
        });
      }
    });

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

        // Rename OneDrive folder to quote number when a quote is first assigned
        // (Start Project). Ref number itself is left untouched now — it stays
        // the permanent INQ identifier. e.g. INQ-26-27-099 → QT-26-27-0095
        if (
          updateData.quoteNumber &&
          updateData.quoteNumber !== existing.quoteNumber
        ) {
          const quoteFolderName = updateData.quoteNumber.replace(/\//g, '-').trim();
          const newUrl = await renameItem(folderId, quoteFolderName).catch((e) => {
            logger.warn('OneDrive folder rename (quote) failed', { orderId: req.params.id, error: e.message });
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

// ─── POST /:id/timeline — post a timeline update + threaded client email ─────
/**
 * Appends a staff-posted update to order.timeline and, if the order has a
 * known client email and an established emailThread (set when the initial
 * portal email was sent — see /api/portal/send-email), fires a threaded
 * reply email so the update lands in the SAME inbox conversation as the
 * original message.
 *
 * The email send is best-effort and non-fatal: if it fails (or there's no
 * client email / no thread anchor yet), the timeline entry is still saved
 * with emailSent:false and emailError set, so staff can see it needs
 * attention without the whole request failing.
 */
router.post('/:id/timeline', async (req, res) => {
  try {
    const { status, message, postedBy } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Update message is required.' });
    }

    const order = await OrderInquiry.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    const event = {
      status:    status || 'update',
      message:   message.trim(),
      postedBy:  postedBy || req.user?.email || req.user?.name || 'Staff',
      createdAt: new Date(),
    };

    // Resolve the client contact's email (same lookup pattern as the
    // frontend's /clients/lookup flow used at order-creation time).
    let clientEmail = null;
    try {
      const client = await Client.findOne({ companyName: order.clientName }).lean();
      const contact = client?.contacts?.find(
        c => c.name?.toLowerCase() === (order.orderPlacedBy || '').toLowerCase()
      );
      clientEmail = contact?.email || null;
    } catch (lookupErr) {
      logger.warn('Client lookup failed for timeline email', { orderId: order._id, error: lookupErr.message });
    }

    if (clientEmail && order.emailThread?.messageId) {
      try {
        const portal = await ClientPortal.findOne({ orderId: order._id }).lean();
        const portalUrl = portal?.slug
          ? `${process.env.CLIENT_URL || 'https://www.marqlandstudios.com'}/p/${portal.slug}`
          : null;

        const priorRefs = order.emailThread.references || [];
        const lastMessageId = priorRefs.length ? priorRefs[priorRefs.length - 1] : order.emailThread.messageId;

        const { messageId } = await sendTimelineUpdateEmail({
          clientEmail,
          subject:     order.emailThread.subject,
          inReplyTo:   lastMessageId,
          references:  priorRefs.join(' '),
          contactName: order.orderPlacedBy,
          clientName:  order.clientName,
          orderRef:    order.refNumber,
          title:       order.title,
          status:      event.status,
          message:     event.message,
          portalUrl,
        });

        event.emailSent = true;
        order.emailThread.references = [...priorRefs, messageId];
        logger.info('Timeline update email sent', { orderId: order._id, messageId });
      } catch (emailErr) {
        event.emailSent  = false;
        event.emailError = emailErr.message;
        logger.warn('Timeline update email failed (non-fatal)', { orderId: order._id, error: emailErr.message });
      }
    } else {
      event.emailSent  = false;
      event.emailError = !clientEmail
        ? 'No client email on file for this contact.'
        : 'No email thread linked to this order yet — the initial portal email may not have been sent.';
    }

    order.timeline = order.timeline || [];
    order.timeline.push(event);
    await order.save();

    logger.info('Timeline update posted', {
      orderId: order._id, status: event.status, emailSent: event.emailSent, userId: req.user?.id,
    });
    res.status(201).json(order.timeline[order.timeline.length - 1]);
  } catch (err) {
    logger.error('Timeline update failed', { orderId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
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