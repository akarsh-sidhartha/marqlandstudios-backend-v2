'use strict';
/**
 * services/orders/orderService.js
 *
 * Business logic for orders (inquiry → ongoing → completed), their files,
 * and their procurement line items. No req/res here — controllers pass in
 * validated data plus the calling user, and every failure is an AppError.
 *
 * Slow OneDrive housekeeping (creating/renaming/deleting the order folder)
 * runs as durable background jobs (services/orders/orderJobs.js), so a slow
 * Graph API never blocks or fails an order save. File uploads stay
 * synchronous — the user is waiting to see the file appear.
 */
const crypto = require('crypto');
const OrderInquiry = require('../../models/orderInquiry');
const ClientPortal = require('../../models/ClientPortal');
const Client = require('../../models/Client');
const Shipment = require('../../models/Shipment');
const Vendor = require('../../models/Vendor');
const Counter = require('../../models/Counter');
const AppError = require('../../lib/errors/AppError');
const jobQueue = require('../../lib/jobs/jobQueue');
const storage = require('./orderStorage');
const { extractQuote } = require('../documentExtraction');
const { sendTimelineUpdateEmail } = require('../emailService');
const { PROCUREMENT_STATUSES, PROCUREMENT_READY } = require('../../lib/orders/orderConstants');
const logger = require('../../utils/logger').child({ module: 'orderService' });

const JOB_FOLDER_SYNC = 'order.folder.sync';
const JOB_FOLDER_DELETE = 'order.folder.delete';

// Portal links are public URLs — the slug is their only secret, so it comes
// from the CSPRNG (the old code used Math.random).
const SLUG_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const newPortalSlug = () => Array.from(crypto.randomBytes(12)).slice(0, 12).map((b) => SLUG_CHARS[b % SLUG_CHARS.length]).join('');

const actorOf = (user) => user?.name || user?.email || (user?.id ? String(user.id) : 'staff');
const owner = (user) => ({ userId: user?.id, role: user?.role });

// Old descriptions may still hold pasted base64 screenshots; never ship them.
const IMG_TAG = /<img\b[^>]*>/gi;
const cleanDescription = (d) => (typeof d === 'string' ? d.replace(IMG_TAG, '') : d);

// Fields a list row needs. Timeline bodies, the e-mail thread and the full
// item list are loaded only when an order is opened (getOrder).
const LIST_PROJECTION = {
  title: 1, clientName: 1, orderPlacedBy: 1, description: 1, refNumber: 1, quoteNumber: 1,
  invoiceNumber: 1, status: 1, orderType: 1, attachments: 1, completedAt: 1, createdAt: 1, updatedAt: 1,
  timelineCount: { $size: { $ifNull: ['$timeline', []] } },
  procurement: {
    total: { $size: { $ifNull: ['$procurementItems', []] } },
    ready: {
      $size: {
        $filter: {
          input: { $ifNull: ['$procurementItems', []] },
          cond: { $in: ['$$this.status', [...PROCUREMENT_READY]] },
        },
      },
    },
  },
};

const findOrThrow = async (id, { lean = false } = {}) => {
  const query = OrderInquiry.findById(id);
  const order = lean ? await query.lean() : await query;
  if (!order) throw AppError.notFound('Order not found.');
  return order;
};

const portalSlugFor = async (orderId) => (await ClientPortal.findOne({ orderId }, { slug: 1 }).lean())?.slug || null;

const toClient = (order, extra = {}) => {
  const o = typeof order.toObject === 'function' ? order.toObject() : order;
  const { emailThread, ...rest } = o; // internal e-mail threading headers stay server-side
  // Full documents carry the arrays; list rows already have these from LIST_PROJECTION.
  const summary = Array.isArray(rest.procurementItems) ? {
    procurement: {
      total: rest.procurementItems.length,
      ready: rest.procurementItems.filter((i) => PROCUREMENT_READY.has(i.status)).length,
    },
    timelineCount: (rest.timeline || []).length,
  } : {};
  return { ...rest, ...summary, description: cleanDescription(rest.description), attachments: rest.attachments || [], ...extra };
};

const queueFolderSync = (order, user) =>
  jobQueue.enqueue({
    type: JOB_FOLDER_SYNC,
    title: `Sync OneDrive folder for ${order.refNumber || order._id}`,
    payload: { orderId: String(order._id) },
    owner: owner(user),
    resource: { kind: 'order', id: String(order._id) },
  }).catch((err) => logger.error('Folder sync job could not be queued', { orderId: order._id, error: err.message }));

// ── Reference numbers ─────────────────────────────────────────────────────────
// INQ-26-27-001, minted server-side with an atomic counter per financial year.
// (The browser used to compute max+1 from its own list — two people saving at
// once got the same number and the second save failed on the unique index.)
const seeded = new Map();
const nextRefNumber = async (date = new Date()) => {
  const fy = storage.financialYear(date);
  const prefix = `INQ-${fy}-`;
  const scope = `orders:ref:${fy}`;
  if (!seeded.has(scope)) {
    const seed = (async () => {
      const existing = await OrderInquiry.find({ refNumber: { $regex: `^${prefix}\\d+$` } }, { refNumber: 1 }).lean();
      const max = existing.reduce((m, o) => Math.max(m, parseInt(o.refNumber.slice(prefix.length), 10) || 0), 0);
      await Counter.updateOne({ scope }, { $max: { seq: max } }, { upsert: true });
    })();
    seeded.set(scope, seed.catch((err) => { seeded.delete(scope); throw err; }));
  }
  await seeded.get(scope);
  const { seq } = await Counter.findOneAndUpdate({ scope }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return `${prefix}${String(seq).padStart(3, '0')}`;
};

// ── Queries ───────────────────────────────────────────────────────────────────
/**
 * Every order for the tracker, with the portal slug and linked-shipment count
 * joined in — one round trip instead of the three the page used to make.
 */
const listOrders = async ({ status } = {}) => {
  const match = status ? { status } : {};
  const [orders, portals, shipments] = await Promise.all([
    OrderInquiry.aggregate([{ $match: match }, { $sort: { updatedAt: -1 } }, { $project: LIST_PROJECTION }]),
    ClientPortal.find({ orderId: { $ne: null } }, { orderId: 1, slug: 1 }).lean(),
    Shipment.aggregate([{ $match: { orderId: { $ne: null } } }, { $group: { _id: '$orderId', count: { $sum: 1 } } }]),
  ]);
  const slugs = new Map(portals.map((p) => [String(p.orderId), p.slug]));
  const counts = new Map(shipments.map((s) => [String(s._id), s.count]));
  return orders.map((o) => toClient(o, {
    portalSlug: slugs.get(String(o._id)) || null,
    shipmentCount: counts.get(String(o._id)) || 0,
  }));
};

const getOrder = async (id) => {
  const [order, portalSlug] = await Promise.all([findOrThrow(id, { lean: true }), portalSlugFor(id)]);
  return toClient(order, { portalSlug });
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────
const createOrder = async (data, user) => {
  let order;
  for (let attempt = 1; ; attempt += 1) {
    try {
      order = await OrderInquiry.create({
        ...data,
        refNumber: await nextRefNumber(),
        status: 'inquiry',
        createdBy: actorOf(user),
      });
      break;
    } catch (err) {
      // A ref minted by the legacy screen can still collide once; take the next.
      if (err.code === 11000 && attempt < 3) continue;
      throw err;
    }
  }

  let portalSlug = null;
  try {
    const portal = await ClientPortal.create({
      orderId: order._id,
      slug: newPortalSlug(),
      type: order.orderType,
      orderRef: order.refNumber,
      clientName: order.clientName,
      orderPlacedBy: order.orderPlacedBy,
      title: order.title || '',
    });
    portalSlug = portal.slug;
  } catch (err) {
    logger.warn('Client portal auto-create failed (order still saved)', { orderId: order._id, error: err.message });
  }

  queueFolderSync(order, user);
  logger.info('Order created', { orderId: order._id, refNumber: order.refNumber, userId: user?.id });
  return toClient(order, { portalSlug });
};

const updateOrder = async (id, patch, user) => {
  const order = await OrderInquiry.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true }).lean();
  if (!order) throw AppError.notFound('Order not found.');
  logger.info('Order updated', { orderId: id, fields: Object.keys(patch), userId: user?.id });
  return toClient(order, { portalSlug: await portalSlugFor(id) });
};

/** Moves only when the order is still in `from` — two clicks can't both apply. */
const transition = async (id, from, set, extraUpdate = {}) => {
  const order = await OrderInquiry.findOneAndUpdate(
    { _id: id, status: from },
    { $set: set, ...extraUpdate },
    { new: true, runValidators: true },
  ).lean();
  if (order) return order;
  const current = await findOrThrow(id, { lean: true });
  throw AppError.conflict(`This order is already ${current.status}.`, { status: current.status });
};

/** A $push update with the empty entries dropped (MongoDB rejects `$push: {}`). */
const pushes = (fields) => {
  const $push = Object.fromEntries(Object.entries(fields).filter(([, v]) => v));
  return Object.keys($push).length ? { $push } : {};
};

const toItem = (item, source, user) => ({
  ...item,
  source,
  status: item.status || PROCUREMENT_STATUSES[0].value,
  statusHistory: [{ status: item.status || PROCUREMENT_STATUSES[0].value, by: actorOf(user), at: new Date() }],
});

/**
 * Inquiry → ongoing. The quote number is required; the quote document is
 * optional — when given it is stored in the order folder, and the line items
 * the user confirmed (read from it by parseQuoteFile) become procurement rows.
 */
const startProject = async (id, { quoteNumber, items = [], quoteDocument }, file, user) => {
  const existing = await findOrThrow(id, { lean: true });
  if (existing.status !== 'inquiry') throw AppError.conflict(`This order is already ${existing.status}.`, { status: existing.status });

  let quoteFile = null;
  if (file) {
    const folderId = await storage.ensureFolder(existing);
    const ext = (file.originalname.split('.').pop() || 'pdf').toLowerCase();
    quoteFile = await storage.uploadFile(folderId, {
      buffer: file.buffer,
      name: `${quoteNumber.replace(/\//g, '-')}.${ext}`,
      mimeType: file.mimetype,
    });
  }

  const order = await transition(id, 'inquiry', {
    status: 'ongoing',
    quoteNumber,
    ...(quoteFile || quoteDocument ? {
      quoteDocument: {
        ...(quoteDocument || {}),
        ...(quoteFile && { fileItemId: quoteFile.itemId, fileName: quoteFile.name }),
        parsedAt: new Date(),
      },
    } : {}),
  }, pushes({
    procurementItems: items.length ? { $each: items.map((it) => toItem(it, 'quote', user)) } : null,
    attachments: quoteFile ? { ...quoteFile, category: 'quote', uploadedBy: actorOf(user), uploadedAt: new Date() } : null,
  }));

  queueFolderSync(order, user);
  logger.info('Project started', { orderId: id, quoteNumber, items: items.length, quoteFile: !!quoteFile, userId: user?.id });
  return toClient(order, { portalSlug: await portalSlugFor(id) });
};

const completeOrder = async (id, { invoiceNumber }, user) => {
  const order = await transition(id, 'ongoing', { status: 'completed', invoiceNumber, completedAt: new Date() });
  queueFolderSync(order, user);
  logger.info('Order completed', { orderId: id, invoiceNumber, userId: user?.id });
  return toClient(order, { portalSlug: await portalSlugFor(id) });
};

/** Deletes the order and its client portal; the OneDrive folder goes in the background. */
const deleteOrder = async (id, user) => {
  const order = await OrderInquiry.findByIdAndDelete(id).lean();
  if (!order) throw AppError.notFound('Order not found.');
  await ClientPortal.deleteMany({ orderId: order._id });

  const legacySegments = order.refNumber ? [...storage.parentSegments(order), storage.folderNameFor({ refNumber: order.refNumber })] : null;
  if (order.oneDriveFolderId || order.oneDriveFolderUrl || legacySegments) {
    await jobQueue.enqueue({
      type: JOB_FOLDER_DELETE,
      title: `Delete OneDrive folder for ${order.refNumber || id}`,
      payload: { orderId: String(id), folderId: order.oneDriveFolderId || null, folderUrl: order.oneDriveFolderUrl || null, legacySegments },
      owner: owner(user),
      resource: { kind: 'order', id: String(id) },
    }).catch((err) => logger.error('Folder delete job could not be queued', { orderId: id, error: err.message }));
  }
  logger.info('Order deleted', { orderId: id, refNumber: order.refNumber, userId: user?.id });
  return { id, deleted: true };
};

// ── Quote parsing ─────────────────────────────────────────────────────────────
/** Reads a quote document for the Start Project preview. Stores nothing. */
const parseQuoteFile = async (file) => {
  const { _meta, ...quote } = await extractQuote(file.buffer);
  return { ...quote, source: _meta.source };
};

// ── Procurement items ─────────────────────────────────────────────────────────
const addItems = async (id, items, user) => {
  const order = await OrderInquiry.findByIdAndUpdate(
    id,
    { $push: { procurementItems: { $each: items.map((it) => toItem(it, 'manual', user)) } } },
    { new: true, runValidators: true, projection: { procurementItems: 1 } },
  ).lean();
  if (!order) throw AppError.notFound('Order not found.');
  return order.procurementItems;
};

/**
 * Updates one item in place with the positional operator — two people editing
 * different items of the same order never overwrite each other. A status
 * change is appended to the item's history for book-keeping.
 */
const VENDOR_FIELDS = ['productSupplier', 'brandingPartner'];

/** { vendorId } → { vendorId, name } from the vendors table; null stays null (clears the field). */
const resolveVendor = async (ref) => {
  if (!ref) return null;
  const vendor = await Vendor.findById(ref.vendorId, { companyName: 1 }).lean();
  if (!vendor) throw AppError.notFound('That vendor no longer exists.');
  return { vendorId: vendor._id, name: vendor.companyName };
};

/** Lightweight vendor list for the Product Supplier / Branding Partner pickers. */
const vendorOptions = async () => {
  const vendors = await Vendor.find({}, { companyName: 1, category: 1, city: 1, isPreferred: 1 }).sort({ companyName: 1 }).lean();
  return vendors.map((v) => ({
    id: String(v._id), name: v.companyName, category: v.category || '', city: v.city || '', preferred: Boolean(v.isPreferred),
  }));
};

const updateItem = async (id, itemId, patch, user) => {
  for (const key of VENDOR_FIELDS) {
    if (key in patch) patch = { ...patch, [key]: await resolveVendor(patch[key]) };
  }
  const current = await OrderInquiry.findOne({ _id: id, 'procurementItems._id': itemId }, { 'procurementItems.$': 1 }).lean();
  if (!current) throw AppError.notFound('Item not found on this order.');
  const before = current.procurementItems[0];

  const $set = Object.fromEntries(Object.entries(patch).map(([k, v]) => [`procurementItems.$.${k}`, v]));
  $set['procurementItems.$.updatedAt'] = new Date();
  const update = { $set };
  if (patch.status && patch.status !== before.status) {
    update.$push = { 'procurementItems.$.statusHistory': { status: patch.status, by: actorOf(user), at: new Date() } };
  }

  const order = await OrderInquiry.findOneAndUpdate(
    { _id: id, 'procurementItems._id': itemId },
    update,
    { new: true, runValidators: true, projection: { procurementItems: { $elemMatch: { _id: itemId } } } },
  ).lean();
  if (!order) throw AppError.notFound('Item not found on this order.');
  return order.procurementItems[0];
};

const removeItem = async (id, itemId) => {
  const res = await OrderInquiry.updateOne({ _id: id, 'procurementItems._id': itemId }, { $pull: { procurementItems: { _id: itemId } } });
  if (!res.matchedCount) throw AppError.notFound('Item not found on this order.');
  return { id: itemId, deleted: true };
};

// ── Files ─────────────────────────────────────────────────────────────────────
const GENERIC_NAME = /^(image|blob|screenshot|clipboard|untitled)(\s*\(\d+\))?\.(png|jpe?g|webp|heic)$/i;
const stamp = () => new Date().toISOString().replace('T', ' ').replace(/:/g, '.').slice(0, 19);

const uploadName = (file, category, index) => {
  if (category === 'screenshot' && (GENERIC_NAME.test(file.originalname) || !file.originalname)) {
    const ext = (file.mimetype.split('/')[1] || 'png').replace('jpeg', 'jpg');
    return `Screenshot ${stamp()}${index ? ` (${index + 1})` : ''}.${ext}`;
  }
  return file.originalname;
};

/**
 * Live listing of the order folder, tagged with the category recorded at
 * upload time. Falls back to the stored metadata if OneDrive is unreachable,
 * so the popup still renders (the response says which one it is).
 */
const listFiles = async (id) => {
  const order = await findOrThrow(id, { lean: true });
  const stored = order.attachments || [];
  if (!order.oneDriveFolderId && !order.oneDriveFolderUrl) return { files: stored, live: false };
  try {
    const folderId = await storage.ensureFolder(order);
    const byId = new Map(stored.filter((a) => a.itemId).map((a) => [a.itemId, a]));
    const byName = new Map(stored.map((a) => [a.name, a]));
    const files = (await storage.listFiles(folderId)).map((f) => {
      const known = byId.get(f.itemId) || byName.get(f.name);
      return { ...f, category: known?.category || 'attachment', uploadedBy: known?.uploadedBy, uploadedAt: known?.uploadedAt };
    });
    return { files, live: true };
  } catch (err) {
    logger.warn('Live file listing failed — returning stored metadata', { orderId: id, error: err.message });
    return { files: stored, live: false };
  }
};

const MAX_PARALLEL_UPLOADS = 3;

const uploadFiles = async (id, files, category, user) => {
  const order = await findOrThrow(id, { lean: true });
  const folderId = await storage.ensureFolder(order);

  const uploaded = new Array(files.length);
  const failed = [];
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      try {
        const f = await storage.uploadFile(folderId, { buffer: files[i].buffer, name: uploadName(files[i], category, i), mimeType: files[i].mimetype });
        uploaded[i] = { ...f, category, uploadedBy: actorOf(user), uploadedAt: new Date() };
      } catch (err) {
        failed.push({ name: files[i].originalname, message: err.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_UPLOADS, files.length) }, worker));

  const saved = uploaded.filter(Boolean);
  if (saved.length) await OrderInquiry.updateOne({ _id: id }, { $push: { attachments: { $each: saved } } });
  if (!saved.length) throw AppError.upstream('None of the files could be uploaded. Please try again.', { failed });
  logger.info('Order files uploaded', { orderId: id, category, uploaded: saved.length, failed: failed.length, userId: user?.id });
  return { files: saved, failed };
};

const folderOf = async (id) => storage.ensureFolder(await findOrThrow(id, { lean: true }));

const deleteFile = async (id, itemId, user) => {
  await storage.deleteFile(await folderOf(id), itemId);
  await OrderInquiry.updateOne({ _id: id }, { $pull: { attachments: { itemId } } });
  logger.info('Order file deleted', { orderId: id, itemId, userId: user?.id });
  return { itemId, deleted: true };
};

const openFile = async (id, itemId) => storage.openFileStream(await folderOf(id), itemId);

// ── Timeline ──────────────────────────────────────────────────────────────────
const resolveClientEmail = async (order) => {
  try {
    const client = await Client.findOne({ companyName: order.clientName }, { contacts: 1 }).lean();
    const contact = client?.contacts?.find((c) => c.name?.toLowerCase() === (order.orderPlacedBy || '').toLowerCase());
    return contact?.email || null;
  } catch (err) {
    logger.warn('Client lookup failed for timeline email', { orderId: order._id, error: err.message });
    return null;
  }
};

/**
 * Appends a staff update to the timeline and, when the order has a client
 * e-mail and an e-mail thread, sends it as a threaded reply. The e-mail is
 * best-effort: a failure is recorded on the event, never fails the post.
 */
const postTimeline = async (id, { status, message }, user) => {
  const order = await findOrThrow(id);
  const event = { status: status || 'update', message, postedBy: actorOf(user), createdAt: new Date() };

  const clientEmail = await resolveClientEmail(order);
  if (clientEmail && order.emailThread?.messageId) {
    try {
      const portalSlug = await portalSlugFor(order._id);
      const priorRefs = order.emailThread.references || [];
      const { messageId } = await sendTimelineUpdateEmail({
        clientEmail,
        subject: order.emailThread.subject,
        inReplyTo: priorRefs.length ? priorRefs[priorRefs.length - 1] : order.emailThread.messageId,
        references: priorRefs.join(' '),
        contactName: order.orderPlacedBy,
        clientName: order.clientName,
        orderRef: order.refNumber,
        title: order.title,
        status: event.status,
        message: event.message,
        portalUrl: portalSlug ? `${process.env.CLIENT_URL || 'https://www.marqlandstudios.com'}/p/${portalSlug}` : null,
      });
      event.emailSent = true;
      order.emailThread.references = [...priorRefs, messageId];
    } catch (err) {
      event.emailSent = false;
      event.emailError = err.message;
      logger.warn('Timeline update email failed (non-fatal)', { orderId: order._id, error: err.message });
    }
  } else {
    event.emailSent = false;
    event.emailError = !clientEmail
      ? 'No client email on file for this contact.'
      : 'No email thread linked to this order yet — the initial portal email may not have been sent.';
  }

  order.timeline.push(event);
  await order.save();
  logger.info('Timeline update posted', { orderId: order._id, status: event.status, emailSent: event.emailSent, userId: user?.id });
  return order.timeline[order.timeline.length - 1].toObject();
};

const meta = () => ({ procurementStatuses: PROCUREMENT_STATUSES, readyStatuses: [...PROCUREMENT_READY] });

module.exports = {
  JOB_FOLDER_SYNC,
  JOB_FOLDER_DELETE,
  meta,
  vendorOptions,
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  startProject,
  completeOrder,
  deleteOrder,
  parseQuoteFile,
  addItems,
  updateItem,
  removeItem,
  listFiles,
  uploadFiles,
  deleteFile,
  openFile,
  postTimeline,
  nextRefNumber,
};
