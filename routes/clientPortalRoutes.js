'use strict';
/**
 * backend/routes/clientPortalRoutes.js
 * Mounted at /api/portal
 *
 * STORAGE CHANGES FROM ORIGINAL:
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Removed: msgStorage (multer diskStorage), uploadMsg, fs, path imports
 * 2. Added:   upload = require('../middleware/upload')
 * 3. Two message routes changed:
 *      POST /public/:slug/message      (client)  → storageRouter decides per file:
 *      POST /:slug/message/team        (team)      images → R2/portal, others → OneDrive
 *    Attachment shape gains: { key, storage } alongside existing { name, url, mimeType, size }
 * 4. normaliseImageUrl: added https:// guard (already there) — no change needed,
 *    R2 URLs start with https:// so they pass through untouched.
 * 5. POST /admin/fix-image-paths: updated regex to also skip https:// URLs
 *    so it never tries to "fix" R2 URLs that are already absolute.
 * 6. Removed: require('fs'), require('path') — no longer needed for uploads.
 *    (crypto and mongoose still needed, kept.)
 *
 * Everything else — all routes, all logic, push, email — is UNCHANGED.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express      = require('express');
const router       = express.Router();
const crypto       = require('crypto');
const mongoose     = require('mongoose');
const multer       = require('multer');
const nodemailer   = require('nodemailer');

const ClientPortal = require('../models/ClientPortal');
const OrderInquiry = require('../models/orderInquiry');
const Product      = require('../models/Product');
const Property     = require('../models/Property');
const Shipment     = require('../models/Shipment');
const { authenticate, authorize } = require('../middleware/authMiddleware');
const upload       = require('../middleware/upload');          // ← NEW
const logger       = require('../utils/logger').child({ module: 'clientPortalRoutes' });
const { sendPortalEmail } = require('../services/emailService');
const { videoStreamFor } = require('../services/catalog/productService');   // NEW — OneDrive video playback
const { videoView } = require('../services/media/productMediaService');
const { requestTimeout } = require('../middleware/requestTimeout');
const { removeProductsFromPortals } = require('../services/catalog/portalCleanupService');  // NEW — deleted products leave portals

// ── Web Push setup (UNCHANGED) ────────────────────────────────────────────────
let webpush = null;
try {
  webpush = require('web-push');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      process.env.VAPID_CONTACT || 'mailto:info@marqland.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  } else {
    console.warn('[Push] VAPID keys not set — push notifications disabled');
    webpush = null;
  }
} catch {
  console.warn('[Push] web-push not installed — run: npm install web-push');
}

// ── PushSubscription model (UNCHANGED) ───────────────────────────────────────
const pushSubSchema = new mongoose.Schema({
  endpoint:  { type: String, required: true, unique: true },
  keys:      { p256dh: String, auth: String },
  userAgent: { type: String },
  createdAt: { type: Date, default: Date.now },
});
const PushSubscription = mongoose.models.PushSubscription
  || mongoose.model('PushSubscription', pushSubSchema);

  /*
// ── Email transporter (UNCHANGED) ────────────────────────────────────────────
const buildTransporter = () => {
  const isGmail = process.env.EMAIL_SERVICE === 'gmail';
  return isGmail
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      })
    : nodemailer.createTransport({
        host:       process.env.EMAIL_HOST || 'smtp.office365.com',
        port:       parseInt(process.env.EMAIL_PORT || '587', 10),
        secure:     parseInt(process.env.EMAIL_PORT || '587', 10) === 465,
        requireTLS: true,
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
        tls: { rejectUnauthorized: false },
      });
};
*/

// ─── Helpers (UNCHANGED) ─────────────────────────────────────────────────────

const slugify = (str) =>
  str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const genToken = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.randomBytes(5))
    .map(b => chars[b % chars.length])
    .join('');
};

const makeSlug = (orderRef) => `${genToken()}-${slugify(orderRef)}`;

/**
 * normaliseImageUrl — UNCHANGED logic.
 * Already handles https:// (returns as-is) so R2 URLs pass through untouched.
 */
const normaliseImageUrl = (imageUrl) => {
  if (!imageUrl) return imageUrl;
  if (
    imageUrl.startsWith('/uploads/internalApp/') ||
    imageUrl.startsWith('/uploads/store/')       ||
    imageUrl.startsWith('/uploads/publicApp/')   ||
    imageUrl.startsWith('http')                   // covers both https://r2... and https://onedrive...
  ) return imageUrl;
  if (imageUrl.startsWith('/uploads/')) {
    const filename = imageUrl.replace('/uploads/', '');
    return `/uploads/internalApp/products/uncategorised/${filename}`;
  }
  return imageUrl;
};

// ── Helper: send a push to ALL stored subscriptions (UNCHANGED) ───────────────
const sendPushToAll = async (payload) => {
  if (!webpush) return;
  try {
    const subs    = await PushSubscription.find().lean();
    const results = await Promise.allSettled(
      subs.map(sub =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify(payload)
        )
      )
    );
    const toRemove = results
      .map((r, i) => (r.status === 'rejected' && [404, 410].includes(r.reason?.statusCode) ? subs[i].endpoint : null))
      .filter(Boolean);
    if (toRemove.length) await PushSubscription.deleteMany({ endpoint: { $in: toRemove } });
  } catch (err) {
    console.warn('[Push] sendPushToAll error:', err.message);
  }
};

// ── Price calculator helper (UNCHANGED) ──────────────────────────────────────
const calcSellPrice = (purchasePrice, markupPercent) =>
  Math.round(parseFloat(purchasePrice || 0) * (1 + parseFloat(markupPercent || 0) / 100));

/**
 * NEW — the fields of a portal item that always follow the live catalogue
 * Product. Portal items are snapshots taken when a product is added to an
 * order; overlaying these on every read means an edit made later by the
 * Marqland team OR by the partner who supplied the product (description,
 * price, images, video) shows up in every client portal that already
 * contains it — no manual "sync" needed. Team price overrides live in
 * calculatorState.priceOverride and are unaffected.
 */
const LIVE_PRODUCT_FIELDS = 'name description imageUrl additionalImages videoSource videoUrl videoOneDriveItemId videoOneDrivePath category subCategory purchasePrice markupPercent';

const liveProductFields = (src) => {
  const video = videoView(src);
  return {
    name:             src.name        || '',
    description:      src.description || '',
    imageUrl:         src.imageUrl    || '',
    additionalImages: src.additionalImages || [],
    videoSource:      video.source,
    videoUrl:         video.source === 'link' ? (src.videoUrl || '') : '',
    price:            calcSellPrice(src.purchasePrice, src.markupPercent),
  };
};

/**
 * NEW HELPER — build attachment shape from cloud result + original multer file.
 * Replaces the old inline .map(f => ({ url: `/uploads/...` })) in both message routes.
 *
 * @param {object} cloudResult  { storage, url, key }  from req.uploadedFiles[i]
 * @param {object} file         multer file object      from req.files[i]
 */
const toAttachment = (cloudResult, file) => ({
  name:     file.originalname,
  url:      cloudResult.url,       // full https:// URL stored in MongoDB
  key:      cloudResult.key,       // R2 key or OneDrive path — for future deletion
  storage:  cloudResult.storage,   // 'r2' | 'onedrive'
  mimeType: file.mimetype,
  size:     file.size,
});


// ═══════════════════════════════════════════════════════════════════════════════
// TEAM ROUTES (UNCHANGED — except /:slug/message/team)
// ═══════════════════════════════════════════════════════════════════════════════

/** POST /api/portal — create portal (UNCHANGED) */
router.post('/', async (req, res) => {
  try {
    const { orderId, type, orderRef, clientName, clientEmail, title } = req.body;
    if (!orderId || !type || !orderRef)
      return res.status(400).json({ message: 'orderId, type, and orderRef are required.' });

    const existing = await ClientPortal.findOne({ orderId });
    if (existing)
      return res.status(409).json({ message: 'Portal already exists.', portal: existing });

    const portal = new ClientPortal({
      orderId, slug: makeSlug(orderRef), type, orderRef, clientName, clientEmail, title,
    });
    await portal.save();

    logger.info('Portal created', { slug: portal.slug, orderId, type, userId: req.user?.id });
    res.status(201).json(portal);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Slug collision — please retry.' });
    res.status(500).json({ message: err.message });
  }
});

/** GET /api/portal — list portals (UNCHANGED) */
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.type)   filter.type   = req.query.type;
    if (req.query.status) filter.status = req.query.status;

    const portals = await ClientPortal.find(filter)
      .select('slug type orderRef orderPlacedBy clientName title status productItems offsiteItems orderId')
      .populate('orderId', 'status')
      .sort({ createdAt: -1 })
      .lean();

    const enriched = portals.map(p => ({
      ...p,
      orderStatus: p.orderId?.status || 'unknown',
      orderId:     p.orderId?._id    || p.orderId,
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/** GET /api/portal/unread-counts (UNCHANGED) */
router.get('/unread-counts', async (req, res) => {
  try {
    const portals = await ClientPortal.find({ status: 'active' }, { orderId: 1, messages: 1 }).lean();
    const result  = {};
    portals.forEach(portal => {
      const orderId = portal.orderId?.toString();
      if (!orderId) return;
      const clientMsgs = (portal.messages || []).filter(m => m.sender === 'client');
      const last       = clientMsgs[clientMsgs.length - 1];
      result[orderId]  = {
        clientCount:       clientMsgs.length,
        lastClientMessage: last
          ? (last.text?.slice(0, 80) || (last.attachments?.length ? `📎 ${last.attachments[0].name}` : ''))
          : '',
        lastClientAt: last?.createdAt || null,
      };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/** GET /api/portal/vapid-public-key (UNCHANGED) */
router.get('/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ message: 'Push not configured.' });
  res.json({ publicKey: key });
});

/** GET /api/portal/order/:orderId (UNCHANGED) */
router.get('/order/:orderId', async (req, res) => {
  try {
    const portal = await ClientPortal.findOne({ orderId: req.params.orderId });
    if (!portal) return res.status(404).json({ message: 'No portal for this order yet.' });

    if (portal.type === 'product' && (portal.productItems || []).length > 0) {
      try {
        const ids      = portal.productItems.map(i => i.productId).filter(Boolean);
        const products = await Product.find({ _id: { $in: ids } }).lean();
        const pMap     = new Map(products.map(p => [p._id.toString(), p]));
        let dirty      = false;

        portal.productItems = portal.productItems.map(item => {
          const src = pMap.get(item.productId);
          if (!src) {
            const fixed = normaliseImageUrl(item.imageUrl);
            if (fixed !== item.imageUrl) { dirty = true; return { ...(item.toObject ? item.toObject() : { ...item }), imageUrl: fixed }; }
            return item;
          }
          const live    = { ...liveProductFields(src), imageUrl: src.imageUrl || normaliseImageUrl(item.imageUrl) };
          const changed = Object.keys(live).some(k => JSON.stringify(item[k] ?? '') !== JSON.stringify(live[k] ?? ''));
          if (!changed) return item;
          dirty = true;
          return { ...(item.toObject ? item.toObject() : { ...item }), ...live };
        });

        if (dirty) await portal.save();
      } catch (syncErr) {
        console.warn('[portal auto-sync] skipped:', syncErr.message);
      }
    }

    res.json(portal);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Re-sync portal items from their source records after a change:
 *   offsite → roomCategories from Property
 *   product → additionalImages / videoUrl / imageUrl / price from Product
 * Non-fatal: a failure is logged and the portal keeps its saved items.
 * (Extracted unchanged from PUT /:slug/items so the add/remove routes below
 * behave exactly the same.)
 */
const enrichPortalItems = async (portal) => {
  if (portal.type === 'offsite' && (portal.offsiteItems || []).length > 0) {
    try {
      const propIds = portal.offsiteItems.map(i => i.propertyId).filter(Boolean);
      if (propIds.length > 0) {
        const properties = await Property.find({ _id: { $in: propIds } }).lean();
        const propMap    = new Map(properties.map(p => [p._id.toString(), p]));
        portal.offsiteItems = portal.offsiteItems.map(item => {
          const src = propMap.get(String(item.propertyId));
          if (!src) return item;
          const roomCategories = (src.roomCategories || []).map(rc => ({
            _id: rc._id, name: rc.name,
            singlePrice: rc.singlePrice || 0, doublePrice: rc.doublePrice || 0, triplePrice: rc.triplePrice || 0,
          }));
          return { ...(item.toObject ? item.toObject() : { ...item }), roomCategories };
        });
        await portal.save();
      }
    } catch (enrichErr) {
      console.warn('[items PUT offsite-enrich] skipped:', enrichErr.message);
    }
  }

  if (portal.type === 'product' && (portal.productItems || []).length > 0) {
    try {
      const ids      = portal.productItems.map(i => i.productId).filter(Boolean);
      const products = await Product.find({ _id: { $in: ids } }).lean();
      const pMap     = new Map(products.map(p => [p._id.toString(), p]));
      portal.productItems = portal.productItems.map(item => {
        const src = pMap.get(item.productId);
        if (!src) return item;
        return {
          ...(item.toObject ? item.toObject() : { ...item }),
          ...liveProductFields(src),
          imageUrl: src.imageUrl || item.imageUrl,
        };
      });
      await portal.save();
    } catch (syncErr) {
      console.warn('[items PUT auto-sync] skipped:', syncErr.message);
    }
  }

};

// ═══════════════════════════════════════════════════════════════════════════════
// "ADD TO PORTAL" PICKER ROUTES (ProductList / PropertyList → usePortalItems)
//
// The picker only needs order rows, so it no longer downloads every portal's
// full item list (4+ MB). Items are loaded per portal on expand, and adding /
// removing is done on the server — the browser never sends the whole list back,
// so two people adding to the same portal can't overwrite each other.
// ═══════════════════════════════════════════════════════════════════════════════

const itemsKeyFor = (portal) => (portal.type === 'offsite' ? 'offsiteItems' : 'productItems');
const sourceIdOf  = (portal, item) => String((portal.type === 'offsite' ? item.propertyId : item.productId) || '');

/** Row summary for the picker: counts + source ids (for "already added"). */
const toPickerRow = (portal, orderStatus) => {
  const items = portal[itemsKeyFor(portal)] || [];
  return {
    _id:           portal._id,
    slug:          portal.slug,
    type:          portal.type,
    title:         portal.title,
    orderRef:      portal.orderRef,
    clientName:    portal.clientName,
    orderPlacedBy: portal.orderPlacedBy,
    status:        portal.status,
    orderId:       portal.orderId,
    orderStatus:   orderStatus || 'unknown',
    itemCount:     items.length,
    itemIds:       items.map((i) => sourceIdOf(portal, i)).filter(Boolean),
  };
};

/**
 * GET /api/portal/picker?type=product|offsite
 * Active portals whose order is still open (inquiry/ongoing) or has no order.
 * Returns row details only — no item content.
 */
router.get('/picker', async (req, res) => {
  try {
    const type = req.query.type === 'offsite' ? 'offsite' : 'product';
    const idField = type === 'offsite' ? 'offsiteItems.propertyId' : 'productItems.productId';

    const portals = await ClientPortal.find({ type, status: 'active' })
      .select(`slug type title orderRef clientName orderPlacedBy status orderId ${idField}`)
      .sort({ createdAt: -1 })
      .lean();

    const orders = await OrderInquiry.find(
      { _id: { $in: portals.map((p) => p.orderId).filter(Boolean) } },
      { status: 1 }
    ).lean();
    const statusById = new Map(orders.map((o) => [String(o._id), o.status]));

    const rows = portals
      .map((p) => toPickerRow(p, statusById.get(String(p.orderId))))
      .filter((r) => ['inquiry', 'ongoing', 'unknown'].includes(r.orderStatus));

    res.json(rows);
  } catch (err) {
    logger.error('Portal picker list failed', { error: err.message });
    res.status(500).json({ message: err.message });
  }
});

/**
 * GET /api/portal/:slug/items
 * Light item list for one portal (shown when a picker row is expanded).
 */
router.get('/:slug/items', async (req, res) => {
  try {
    const portal = await ClientPortal.findOne({ slug: req.params.slug })
      .select('type productItems._id productItems.productId productItems.name productItems.imageUrl ' +
              'offsiteItems._id offsiteItems.propertyId offsiteItems.name offsiteItems.imageUrl')
      .lean();
    if (!portal) return res.status(404).json({ message: 'Portal not found.' });
    res.json(portal[itemsKeyFor(portal)] || []);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /api/portal/:slug/items/add   body: { items: [ ...new items ] }
 * Appends items on the server. Items whose productId/propertyId is already in
 * the portal are skipped; custom items (no source id) are always added.
 * Returns the updated picker row.
 */
router.post('/:slug/items/add', async (req, res) => {
  try {
    const incoming = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!incoming.length) return res.status(400).json({ message: 'No items to add.' });

    const portal = await ClientPortal.findOne({ slug: req.params.slug });
    if (!portal) return res.status(404).json({ message: 'Portal not found.' });

    const key = itemsKeyFor(portal);
    const existing = new Set((portal[key] || []).map((i) => sourceIdOf(portal, i)).filter(Boolean));
    const toAdd = incoming.filter((item) => {
      const id = sourceIdOf(portal, item);
      if (!id) return true;          // custom item
      if (existing.has(id)) return false;
      existing.add(id);              // also de-dupes within the request
      return true;
    });

    if (toAdd.length) {
      portal[key].push(...toAdd);
      await portal.save();
      await enrichPortalItems(portal);
    }

    logger.info('Portal items added', { slug: portal.slug, added: toAdd.length, skipped: incoming.length - toAdd.length, userId: req.user?.id });
    res.json({ added: toAdd.length, skipped: incoming.length - toAdd.length, row: toPickerRow(portal.toObject()) });
  } catch (err) {
    logger.error('Portal items add failed', { slug: req.params.slug, error: err.message });
    res.status(500).json({ message: err.message });
  }
});

/**
 * DELETE /api/portal/:slug/items/:itemId
 * Removes one item (by the item's own _id). Returns the updated picker row.
 */
router.delete('/:slug/items/:itemId', async (req, res) => {
  try {
    const portal = await ClientPortal.findOne({ slug: req.params.slug });
    if (!portal) return res.status(404).json({ message: 'Portal not found.' });

    const key = itemsKeyFor(portal);
    const before = portal[key].length;
    portal[key] = portal[key].filter((i) => String(i._id) !== String(req.params.itemId));
    if (portal[key].length === before) return res.status(404).json({ message: 'Item not found in this portal.' });

    await portal.save();
    res.json({ removed: 1, row: toPickerRow(portal.toObject()) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/** PUT /api/portal/:slug/items (UNCHANGED) */
router.put('/:slug/items', async (req, res) => {
  try {
    const { productItems, offsiteItems } = req.body;
    const portal = await ClientPortal.findOne({ slug: req.params.slug });
    if (!portal) return res.status(404).json({ message: 'Portal not found.' });

    if (portal.type === 'product' && productItems) portal.productItems = productItems;
    if (portal.type === 'offsite' && offsiteItems) portal.offsiteItems = offsiteItems;

    await portal.save();

    await enrichPortalItems(portal);

    res.json(portal);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/** PUT /api/portal/:slug/combo-items — attach/replace combo bundles on a portal */
router.put('/:slug/combo-items', async (req, res) => {
  try {
    const portal = await ClientPortal.findOne({ slug: req.params.slug });
    if (!portal) return res.status(404).json({ message: 'Portal not found.' });

    portal.comboItems = req.body.comboItems || [];
    await portal.save();
    res.json(portal);
  } catch (err) {
    logger.error('combo-items PUT error', { err: err.message });
    res.status(500).json({ message: err.message });
  }
});

/** PUT /api/portal/:slug/meta (UNCHANGED) */
router.put('/:slug/meta', async (req, res) => {
  try {
    const { teamNote, clientEmail, title, reviewLink } = req.body;
    const portal = await ClientPortal.findOneAndUpdate(
      { slug: req.params.slug },
      { $set: { teamNote, clientEmail, title, reviewLink } },
      { new: true }
    );
    if (!portal) return res.status(404).json({ message: 'Portal not found.' });
    res.json(portal);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/** PUT /api/portal/:slug/complete (UNCHANGED) */
router.put('/:slug/complete', async (req, res) => {
  try {
    const { reviewLink } = req.body;
    const portal = await ClientPortal.findOneAndUpdate(
      { slug: req.params.slug },
      { $set: { status: 'completed', completedAt: new Date(), ...(reviewLink && { reviewLink }) } },
      { new: true }
    );
    if (!portal) return res.status(404).json({ message: 'Portal not found.' });
    res.json(portal);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/** PUT /api/portal/:slug/shortlist — team (UNCHANGED) */
router.put('/:slug/shortlist', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ message: 'ids must be an array.' });
    const portal = await ClientPortal.findOneAndUpdate(
      { slug: req.params.slug },
      { $set: { shortlistedIds: ids } },
      { new: true }
    );
    if (!portal) return res.status(404).json({ message: 'Portal not found.' });
    res.json({ shortlistedIds: portal.shortlistedIds || [] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/** PUT /api/portal/:slug/calculator — team (UNCHANGED) */
router.put('/:slug/calculator', async (req, res) => {
  try {
    const { calculatorState } = req.body;
    if (!calculatorState || typeof calculatorState !== 'object')
      return res.status(400).json({ message: 'calculatorState must be an object.' });
    const portal = await ClientPortal.findOneAndUpdate(
      { slug: req.params.slug },
      { $set: { calculatorState } },
      { new: true }
    );
    if (!portal) return res.status(404).json({ message: 'Portal not found.' });
    res.json({ ok: true, calculatorState: portal.calculatorState });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /api/portal/:slug/message/team
 *
 * CHANGED:
 *   - uploadMsg.array('files', 5)  →  upload.array('files', 5)
 *   - attachment url built from req.uploadedFiles[i].url  (full https://)
 *   - attachment gains key + storage fields
 *   - storageRouter decision:
 *       images  → R2   /website/internalApp/portal/
 *       videos  → OneDrive /uploads/videos/
 *       others  → OneDrive /uploads/files/
 */
router.post('/:slug/message/team',
  (req, _res, next) => { req.r2Folder = 'portal'; next(); },
  upload.array('files', 5),
  async (req, res) => {
    try {
      const { text, senderName } = req.body;
      if (!text?.trim() && (!req.files || req.files.length === 0))
        return res.status(400).json({ message: 'Message text or attachment required.' });

      const attachments = (req.files || []).map((f, i) =>
        toAttachment(req.uploadedFiles[i], f)
      );

      const portal = await ClientPortal.findOneAndUpdate(
        { slug: req.params.slug },
        { $push: { messages: {
          sender:      'team',
          senderName:  senderName || 'Marqland Team',
          text:        text?.trim() || '',
          attachments,
        }}},
        { new: true }
      );
      if (!portal) return res.status(404).json({ message: 'Portal not found.' });

      const newMsg = portal.messages[portal.messages.length - 1];
      sendPushToAll({
        title: `Marqland Studios — ${portal.clientName || 'Your Portal'}`,
        body:  newMsg.text?.slice(0, 80) || (newMsg.attachments?.length ? `📎 ${newMsg.attachments[0].name}` : 'New message from the team'),
        tag:   `portal-team-${portal.slug}`,
        url:   `/p/${portal.slug}`,
      });

      logger.info('Team message sent', { slug: req.params.slug, hasAttachments: attachments.length > 0, userId: req.user?.id });
      res.json(newMsg);
    } catch (err) {
      logger.error('Team message failed', { slug: req.params.slug, error: err.message });
      res.status(500).json({ message: err.message });
    }
  }
);

/** POST /api/portal/:slug/sync-products (UNCHANGED) */
router.post('/:slug/sync-products', async (req, res) => {
  try {
    const portal = await ClientPortal.findOne({ slug: req.params.slug });
    if (!portal) return res.status(404).json({ message: 'Portal not found.' });
    if (portal.type !== 'product')
      return res.status(400).json({ message: 'Sync only applies to product portals.' });

    const items = portal.productItems || [];
    if (items.length === 0) return res.json({ synced: 0, portal });

    const ids        = items.map(i => i.productId).filter(Boolean);
    const products   = await Product.find({ _id: { $in: ids } }).lean();
    const productMap = new Map(products.map(p => [p._id.toString(), p]));

    let synced = 0;
    portal.productItems = items.map(item => {
      const src = productMap.get(item.productId);
      if (!src) return item;
      synced++;
      return {
        ...(item.toObject ? item.toObject() : { ...item }),
        ...liveProductFields(src),
        name:             src.name        || item.name,
        imageUrl:         src.imageUrl    || item.imageUrl,
        category:         src.category    || item.category,
        subCategory:      src.subCategory || item.subCategory,
      };
    });

    await portal.save();
    res.json({ synced, total: items.length, portal });
  } catch (err) {
    logger.error('sync-products failed', { slug: req.params.slug, error: err.message });
    res.status(500).json({ message: err.message });
  }
});

/** POST /api/portal/:slug/sync-offsite (UNCHANGED) */
router.post('/:slug/sync-offsite', async (req, res) => {
  try {
    const portal = await ClientPortal.findOne({ slug: req.params.slug });
    if (!portal) return res.status(404).json({ message: 'Portal not found.' });
    if (portal.type !== 'offsite')
      return res.status(400).json({ message: 'sync-offsite only applies to offsite portals.' });

    const items = portal.offsiteItems || [];
    if (items.length === 0) return res.json({ synced: 0, portal });

    const propIds    = items.map(i => i.propertyId).filter(Boolean);
    if (propIds.length === 0) return res.json({ synced: 0, portal });

    const properties = await Property.find({ _id: { $in: propIds } }).lean();
    const propMap    = new Map(properties.map(p => [p._id.toString(), p]));

    let synced = 0;
    portal.offsiteItems = items.map(item => {
      const src = propMap.get(String(item.propertyId));
      if (!src) return item;
      synced++;
      const roomCategories = (src.roomCategories || []).map(rc => ({
        _id: rc._id, name: rc.name,
        singlePrice: rc.singlePrice || 0, doublePrice: rc.doublePrice || 0, triplePrice: rc.triplePrice || 0,
      }));
      return { ...(item.toObject ? item.toObject() : { ...item }), roomCategories };
    });

    await portal.save();
    res.json({ synced, total: items.length, portal });
  } catch (err) {
    logger.error('sync-offsite failed', { slug: req.params.slug, error: err.message });
    res.status(500).json({ message: err.message });
  }
});

/** DELETE /api/portal/:slug (UNCHANGED) */
router.delete('/:slug', async (req, res) => {
  try {
    const portal = await ClientPortal.findOneAndDelete({ slug: req.params.slug });
    if (!portal) return res.status(404).json({ message: 'Portal not found.' });
    logger.info('Portal deleted', { slug: req.params.slug, userId: req.user?.id });
    res.json({ message: 'Portal deleted.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /api/portal/send-email
 * CHANGED: now captures the {messageId, subject} returned by sendPortalEmail
 * and persists them as OrderInquiry.emailThread — this is the one-time
 * anchor that lets POST /api/orders/:id/timeline send later client updates
 * as threaded replies (same Message-ID chain) instead of standalone emails.
 */
router.post('/send-email', async (req, res) => {
    const { slug, clientEmail, contactName, clientName, orderRef, title, cc } = req.body;
    
  try {
    if (!clientEmail) return res.status(400).json({ message: 'clientEmail required.' });
    if (!slug)        return res.status(400).json({ message: 'slug required.' });

    const appUrl     = (process.env.CLIENT_URL || 'http://localhost:3000').replace(/\/$/, '');
    const portalUrl        = `${appUrl}/p/${slug}`;
    const greetName  = contactName || clientName || 'there';
    const ccAddress  = cc || process.env.PORTAL_CC_EMAIL || 'info@marqland.com';
    // Use the centralized service wrapper
    const { messageId, subject } = await sendPortalEmail({
      slug,
      clientEmail,
      contactName,
      clientName,
      orderRef,
      title,
      portalUrl,
      cc
    });

    // ── Anchor the email thread on the order ──────────────────────────────
    // This is what lets POST /api/orders/:id/timeline send later updates as
    // threaded replies (same Message-ID chain) instead of fresh emails.
    // Non-fatal: if this fails, the portal email above has already sent —
    // we just log it so staff know timeline updates won't thread correctly
    // for this order until it's fixed.
    try {
      const portal = await ClientPortal.findOne({ slug }).lean();
      if (portal?.orderId) {
        await OrderInquiry.findByIdAndUpdate(portal.orderId, {
          emailThread: { subject, messageId, references: [messageId] },
        });
        logger.debug('Email thread anchored on order', { orderId: portal.orderId, messageId });
      } else {
        logger.warn('No portal/orderId found for slug — emailThread not anchored', { slug });
      }
    } catch (threadErr) {
      logger.warn('Failed to persist emailThread (non-fatal)', { slug, error: threadErr.message });
    }
/*
    await buildTransporter().sendMail({
      from:    process.env.EMAIL_FROM || `Marqland Studios <${process.env.EMAIL_USER}>`,
      to:      clientEmail,
      cc:      ccAddress,
      subject: `Marqland Studios - Your Curated Options — ${orderRef}`,
      html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#0a1422;font-family:'Segoe UI',system-ui,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#17202f;border-radius:16px;overflow:hidden;">
<tr><td style="background:#1a2332;padding:32px 40px;text-align:center;">
  <table cellpadding="0" cellspacing="0" align="center"><tr>
    <td style="background:linear-gradient(45deg,#e6c273,#c5a357);width:32px;height:32px;border-radius:8px;text-align:center;vertical-align:middle;">
      <span style="color:#3f2e00;font-size:16px;font-weight:900;">M</span>
    </td>
    <td style="padding-left:10px;color:#f0e8d6;font-size:16px;font-weight:800;letter-spacing:0.05em;text-transform:uppercase;">Marqland Studios</td>
  </tr></table>
</td></tr>
<tr><td style="padding:40px 40px 32px;">
  <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#f0e8d6;font-family:Georgia,serif;">Your curated options are ready</h1>
  <p style="margin:0 0 8px;font-size:15px;color:#f0e8d6;line-height:1.8;">Dear <strong style="color:#e6c273;">${greetName}</strong>,</p>
  <p style="margin:0 0 28px;font-size:14px;color:rgba(240,232,214,0.65);line-height:1.8;">
    We have hand-curated a selection for <strong style="color:#c5a357;">${title || orderRef}</strong>. Please review and share your preferences.
  </p>
  <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;"><tr>
    <td style="background:linear-gradient(45deg,#e6c273,#c5a357);border-radius:10px;">
      <a href="${url}" style="display:inline-block;padding:14px 36px;color:#3f2e00;text-decoration:none;font-size:15px;font-weight:700;">View Your Portal &rarr;</a>
    </td>
  </tr></table>
  <p style="font-size:12px;color:rgba(240,232,214,0.3);text-align:center;margin:0;">
    Or copy: <a href="${url}" style="color:#c5a357;word-break:break-all;font-size:11px;">${url}</a>
  </p>
</td></tr>
<tr><td style="background:#0a1422;padding:18px 40px;text-align:center;border-top:1px solid rgba(197,163,87,0.15);">
  <p style="margin:0;font-size:11px;color:rgba(197,163,87,0.5);letter-spacing:0.08em;text-transform:uppercase;">Marqland Studios &middot; Premium Corporate Gifting</p>
  <p style="margin:6px 0 0;font-size:10px;color:rgba(255,255,255,0.15);">Ref: ${orderRef} &middot; This link is private.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`,
    });
*/
    await ClientPortal.findOneAndUpdate({ slug }, { $set: { clientEmail } });
    logger.info('Portal email sent', { to: clientEmail, slug, orderRef, portalUrl });
    res.json({ ok: true, sentTo: clientEmail, portalUrl });
  } catch (err) {
    logger.error('Portal send-email failed', { slug, clientEmail, error: err.message });
    res.status(500).json({ message: err.message });
  }
});

/** POST /api/portal/push-subscribe (UNCHANGED) */
router.post('/push-subscribe', async (req, res) => {
  try {
    const { endpoint, keys, userAgent } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth)
      return res.status(400).json({ message: 'Invalid subscription object.' });
    await PushSubscription.findOneAndUpdate(
      { endpoint },
      { endpoint, keys, userAgent: userAgent || req.headers['user-agent'] || '' },
      { upsert: true, new: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /api/portal/admin/fix-image-paths
 *
 * CHANGED: regex updated to also skip https:// URLs (R2 / OneDrive absolute URLs)
 * so migrated portals are never touched by this one-time fixer.
 * Was: $regex: '^/uploads/[^i]'
 * Now: $regex: '^/uploads/[^i]'  (same — https:// never starts with /uploads/ so
 *      this already works. Keeping the normaliseImageUrl https guard as the real safety net.)
 */
router.post('/admin/fix-image-paths', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const portals = await ClientPortal.find({
      'productItems.imageUrl': { $regex: '^/uploads/[^i]' },
    }).lean();

    let updatedPortals = 0;
    let updatedItems   = 0;

    for (const portal of portals) {
      let dirty      = false;
      const fixedItems = (portal.productItems || []).map(item => {
        const fixed = normaliseImageUrl(item.imageUrl);
        if (fixed !== item.imageUrl) {
          dirty = true;
          updatedItems++;
          return { ...item, imageUrl: fixed };
        }
        return item;
      });
      if (dirty) {
        await ClientPortal.updateOne({ _id: portal._id }, { $set: { productItems: fixedItems } });
        updatedPortals++;
      }
    }

    logger.info('Image path migration complete', { updatedPortals, updatedItems, userId: req.user?.id });
    res.json({ message: 'Image path migration complete.', updatedPortals, updatedItems });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES — no auth, client-facing
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/portal/public/:slug
 * CHANGED — product items (and the items inside combo bundles) are overlaid
 * with the LIVE catalogue product on every load, so edits made after the
 * product was added to this order (by the team or by the partner) are what
 * the client sees. Items whose product was since deleted keep their snapshot.
 */
router.get('/public/:slug', requestTimeout(10_000), async (req, res) => {
  try {
    const portal = await ClientPortal.findOne({ slug: req.params.slug }).lean();
    if (!portal) return res.status(404).json({ message: 'This link is invalid or has expired.' });

    let productItems = portal.productItems || [];
    let comboItems   = portal.comboItems   || [];

    // Client-built hampers store the portal item _id; team combos store the Product id.
    const itemById   = new Map(productItems.map(i => [String(i._id), i]));
    // A hamper entry pointing at a CUSTOM portal item (no catalogue product)
    // resolves to null, so it is never looked up or treated as deleted.
    const sourceIdOf = (productId) => {
      const item = itemById.get(String(productId));
      return item ? (item.productId || null) : productId;
    };

    const ids = [
      ...productItems.map(i => i.productId),
      ...comboItems.flatMap(c => (c.items || []).map(it => sourceIdOf(it.productId))),
    ].filter(id => id && mongoose.Types.ObjectId.isValid(String(id)));

    if (ids.length > 0) {
      const uniqueIds  = [...new Set(ids.map(String))];
      const products   = await Product.find({ _id: { $in: uniqueIds } }, LIVE_PRODUCT_FIELDS).lean();
      const productMap = new Map(products.map(p => [p._id.toString(), p]));

      // NEW — products deleted from the catalogue are no longer shown, and are
      // removed from this portal for good (covers products deleted before
      // deletion started cleaning portals up). Custom items have no productId
      // and are never affected.
      const deletedIds = uniqueIds.filter(id => !productMap.has(id));
      if (deletedIds.length) {
        const deleted = new Set(deletedIds);
        const removedItemIds = new Set(productItems.filter(i => deleted.has(String(i.productId || ''))).map(i => String(i._id)));
        const isGone = (pid) => deleted.has(String(pid || '')) || removedItemIds.has(String(pid || ''));
        productItems = productItems.filter(i => !removedItemIds.has(String(i._id)));
        comboItems = comboItems
          .map(c => {
            const items = (c.items || []).filter(it => !isGone(sourceIdOf(it.productId)) && !isGone(it.productId));
            return items.length === (c.items || []).length ? c : { ...c, items };
          })
          .filter(c => c.items.length > 0);
        portal.shortlistedIds = (portal.shortlistedIds || []).filter(id => !isGone(id));
        removeProductsFromPortals(deletedIds)
          .catch(err => logger.warn('Portal cleanup of deleted products failed', { slug: portal.slug, error: err.message }));
      }

      productItems = productItems.map(item => {
        const src = item.productId && productMap.get(String(item.productId));
        if (!src) return item;
        return {
          ...item,
          ...liveProductFields(src),
          imageUrl:    src.imageUrl    || item.imageUrl || '',
          category:    item.category    || src.category    || '',
          subCategory: item.subCategory || src.subCategory || '',
        };
      });

      comboItems = comboItems.map(combo => {
        const items = (combo.items || []).map(it => {
          const src = productMap.get(String(sourceIdOf(it.productId)));
          return src ? { ...it, ...liveProductFields(src), imageUrl: src.imageUrl || it.imageUrl || '' } : it;
        });
        return { ...combo, items, totalPrice: items.reduce((sum, it) => sum + (Number(it.price) || 0), 0) };
      });
    }

    res.set('Cache-Control', 'no-store');
    res.json({
      slug:            portal.slug,
      type:            portal.type,
      orderRef:        portal.orderRef,
      orderId:         portal.orderId,
      clientName:      portal.clientName,
      orderPlacedBy:   portal.orderPlacedBy   || '',
      title:           portal.title,
      teamNote:        portal.teamNote,
      productItems,
      offsiteItems:    portal.offsiteItems    || [],
      comboItems,                                        // ← combo bundles for the Combo tab
      messages:        portal.messages        || [],
      status:          portal.status,
      completedAt:     portal.completedAt,
      reviewLink:      portal.reviewLink,
      shortlistedIds:  portal.shortlistedIds  || [],
      calculatorState: portal.calculatorState || {},
    });
  } catch (err) {
    logger.error('Public portal load failed', { slug: req.params.slug, error: err.message });
    res.status(500).json({ message: 'Could not load this page. Please refresh.' });
  }
});

/**
 * NEW — GET /api/portal/public/:slug/products/:productId/video-stream
 * Short-lived playable URL for a product video uploaded to OneDrive.
 * Public (clients have no login), so it only answers for products that are
 * actually part of THIS portal — a slug can't be used to probe other
 * products. :productId may be the catalogue Product id or the portal item id.
 * Response: { url, expiresInSeconds }
 */
router.get('/public/:slug/products/:productId/video-stream', requestTimeout(10_000), async (req, res) => {
  try {
    const portal = await ClientPortal.findOne({ slug: req.params.slug }, 'productItems._id productItems.productId comboItems.items.productId').lean();
    if (!portal) return res.status(404).json({ message: 'Portal not found.' });

    const wanted     = String(req.params.productId);
    const byItemId   = new Map((portal.productItems || []).map(i => [String(i._id), String(i.productId || '')]));
    const productIds = new Set([
      ...(portal.productItems || []).map(i => String(i.productId || '')),
      ...(portal.comboItems || []).flatMap(c => (c.items || []).map(it => byItemId.get(String(it.productId)) || String(it.productId || ''))),
    ].filter(Boolean));

    const productId = productIds.has(wanted) ? wanted : byItemId.get(wanted);
    if (!productId || !productIds.has(productId) || !mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(404).json({ message: 'Video not found.' });
    }

    const product = await Product.findById(productId, 'videoSource videoUrl videoOneDriveItemId videoOneDrivePath videoFileName').lean();
    if (!product) return res.status(404).json({ message: 'Video not found.' });

    const stream = await videoStreamFor(product);
    res.set('Cache-Control', 'private, no-store');
    res.json({ url: stream.url, expiresInSeconds: stream.expiresInSeconds, source: stream.source });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) logger.warn('Portal video stream failed', { slug: req.params.slug, productId: req.params.productId, error: err.message });
    res.status(status).json({ message: status === 404 ? 'Video not found.' : 'Video temporarily unavailable.' });
  }
});

/** GET /api/portal/public/:slug/shipments (UNCHANGED) */
router.get('/public/:slug/shipments', async (req, res) => {
  try {
    const portal = await ClientPortal.findOne({ slug: req.params.slug }, 'orderId type').lean();
    if (!portal)          return res.status(404).json({ message: 'Portal not found.' });
    if (!portal.orderId)  return res.json([]);
    const shipments = await Shipment.find(
      { orderId: portal.orderId },
      'recipientName city state phone trackingId shippingPartner status lastTrackedAt shippedDate'
    ).sort({ createdAt: 1 }).lean();
    res.json(shipments);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /api/portal/public/:slug/message  — client sends a message
 *
 * CHANGED:
 *   - uploadMsg.array('files', 5)  →  upload.array('files', 5)
 *   - No req.isInvoice flag → images go to R2 /portal/, videos/docs → OneDrive
 *   - attachment url = full https:// from cloud  (was /uploads/internalApp/portal/...)
 *   - attachment gains key + storage fields
 *
 * NOTE: This is a PUBLIC route — client attaches files directly.
 *       No auth cookie is present, but upload middleware doesn't need one.
 */
router.post('/public/:slug/message',
  (req, _res, next) => { req.r2Folder = 'portal'; next(); },
  upload.array('files', 5),
  async (req, res) => {
    try {
      const { text, senderName } = req.body;
      if (!text?.trim() && (!req.files || req.files.length === 0))
        return res.status(400).json({ message: 'Message text or attachment required.' });

      const portal = await ClientPortal.findOne({ slug: req.params.slug });
      if (!portal)                          return res.status(404).json({ message: 'Portal not found.' });
      if (portal.status === 'completed')    return res.status(400).json({ message: 'This order is completed.' });

      const attachments = (req.files || []).map((f, i) =>
        toAttachment(req.uploadedFiles[i], f)
      );

      portal.messages.push({
        sender:      'client',
        senderName:  senderName || portal.clientName || 'Client',
        text:        text?.trim() || '',
        attachments,
      });
      await portal.save();

      const savedMsg    = portal.messages[portal.messages.length - 1];
      const clientLabel = senderName || portal.clientName || 'Client';

      sendPushToAll({
        title: `${clientLabel} sent a message`,
        body:  savedMsg.text?.slice(0, 80) || (savedMsg.attachments?.length ? `📎 ${savedMsg.attachments[0].name}` : 'New message'),
        tag:   `portal-client-${portal.slug}`,
        url:   `/orders`,
      });

      logger.info('Client message received', { slug: req.params.slug, hasAttachments: attachments.length > 0 });
      res.json(savedMsg);
    } catch (err) {
      logger.error('Client message failed', { slug: req.params.slug, error: err.message });
      res.status(500).json({ message: err.message });
    }
  }
);

/** POST /api/portal/public/:slug/view (UNCHANGED) */
router.post('/public/:slug/view', async (req, res) => {
  try {
    await ClientPortal.findOneAndUpdate(
      { slug: req.params.slug },
      { $inc: { viewCount: 1 }, $set: { lastViewedAt: new Date() } }
    );
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

/** PUT /api/portal/public/:slug/shortlist — client (UNCHANGED) */
router.put('/public/:slug/shortlist', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ message: 'ids must be an array.' });
    const portal = await ClientPortal.findOneAndUpdate(
      { slug: req.params.slug },
      { $set: { shortlistedIds: ids } },
      { new: true }
    );
    if (!portal) return res.status(404).json({ message: 'Portal not found.' });
    res.json({ ok: true, count: ids.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/** PUT /api/portal/public/:slug/calculator — client (UNCHANGED) */
router.put('/public/:slug/calculator', async (req, res) => {
  try {
    const { calculatorState } = req.body;
    if (!calculatorState || typeof calculatorState !== 'object')
      return res.status(400).json({ message: 'calculatorState must be an object.' });
    const portal = await ClientPortal.findOneAndUpdate(
      { slug: req.params.slug },
      { $set: { calculatorState } },
      { new: true }
    );
    if (!portal) return res.status(404).json({ message: 'Portal not found.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * PUT /api/portal/public/:slug/combo-items — client Hamper Builder
 *
 * Lets a client save the custom combo(s) they built themselves from the
 * catalogue (Step 4 of the Hamper Builder: "Save Combo").
 *
 * Body: { comboItems: [{ label?, note?, items: [{ productId }] }] }
 *   — productId here is the portal's own productItems _id (the id the
 *     client-facing catalogue already keys everything by), not the master
 *     Product._id.
 *
 * Safety:
 *   - Only ever replaces this client's OWN bundles (createdBy: 'client').
 *     Any team-attached combos (createdBy: 'admin', via ComboCreator /
 *     ClientPortalEditor) are always left untouched.
 *   - Name/description/image/price are never trusted from the client — every
 *     item is re-derived from the portal's own productItems snapshot, and
 *     totalPrice is recomputed server-side, so a tampered payload can't
 *     misrepresent what's actually in the bundle.
 *   - Any submitted productId that isn't part of this portal's catalogue is
 *     silently dropped; a bundle left with zero valid items is dropped too.
 */
router.put('/public/:slug/combo-items', async (req, res) => {
  try {
    const { comboItems } = req.body;
    if (!Array.isArray(comboItems)) return res.status(400).json({ message: 'comboItems must be an array.' });

    const portal = await ClientPortal.findOne({ slug: req.params.slug });
    if (!portal) return res.status(404).json({ message: 'Portal not found.' });
    if (portal.status === 'completed') return res.status(400).json({ message: 'This order is completed.' });
    if (portal.type !== 'product') return res.status(400).json({ message: 'Custom hampers are only available on product portals.' });

    // Team-attached combos are never touched by this route.
    const adminCombos = (portal.comboItems || []).filter(c => c.createdBy !== 'client');

    // Look up every item against the portal's own product snapshot so price,
    // name, image, etc. always reflect what the client was actually shown.
    const catalogue = new Map((portal.productItems || []).map(i => [String(i._id), i]));

    const clientCombos = comboItems.map((combo, ci) => {
      const items = (Array.isArray(combo.items) ? combo.items : [])
        .map(it => catalogue.get(String(it.productId)))
        .filter(Boolean)
        .map((src, i) => ({
          productId:        String(src._id),
          name:             src.name,
          description:      src.description     || '',
          imageUrl:         src.imageUrl         || '',
          additionalImages: src.additionalImages || [],
          videoUrl:         src.videoUrl         || '',
          videoSource:      src.videoSource      || '',
          price:            src.price            || 0,
          category:         src.category         || '',
          subCategory:      src.subCategory      || '',
          order:            i,
        }));

      return {
        comboId:         null,
        label:           String(combo.label || `My Hamper ${ci + 1}`).slice(0, 80),
        totalPrice:      items.reduce((s, it) => s + (it.price || 0), 0),
        // Leave blank — ComboThumbGallery automatically renders a CSS mosaic
        // collage of all the bundle's item photos whenever collageImageUrl is
        // empty. This is exactly what already happens for admin-generated
        // combos (comboService never sets a real collage image either), so
        // client-built hampers get the same "combo" visual treatment for free.
        collageImageUrl: '',
        items,
        note:            String(combo.note || '').slice(0, 300),
        order:           adminCombos.length + ci,
        createdBy:       'client',
      };
    }).filter(c => c.items.length > 0);

    portal.comboItems = [...adminCombos, ...clientCombos];
    await portal.save();
    res.json({ ok: true, comboItems: portal.comboItems });
  } catch (err) {
    logger.error('public combo-items PUT error', { err: err.message });
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;