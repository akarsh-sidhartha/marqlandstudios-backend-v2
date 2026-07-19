const dotenv = require('dotenv');
//dotenv.config({ override: false });
// ⚠ MUST call before any require that reads process.env
dotenv.config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const cron = require('node-cron');
const sanitizeBody = require('./middleware/sanitizeBody'); // NEW — NoSQL injection hardening (body-only, avoids express-mongo-sanitize's req.query crash)
const sanitizeRequest = require('./middleware/security/sanitizeRequest'); // XSS/HTML stripping for body+query+params
const { createRateLimiter } = require('./middleware/security/rateLimiter');
const { corsOptions, helmetOptions, rateLimits } = require('./config/security');
const errorHandler = require('./middleware/errorHandler');
const notFoundHandler = require('./middleware/notFoundHandler');

const app = express();

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const legacyPortalRedirect = require('./middleware/legacyPortalRedirect');// delete this over a period of time.
app.use(legacyPortalRedirect); // must be before all other app.use() calls // delete this over a period of time.
const logger = require('./utils/logger').child({ module: 'server' });
const { attachRequestId, requestLogger } = require('./middleware/requestLogger');
const whatsappService = require('./services/whatsappService');
const { startScheduler } = require('./services/trendingProductService');
const { startTrackingScheduler } = require('./services/shipmentTrackingService');
const { runActivityLogMaintenance } = require('./services/activityLogArchiveService');


// ─── Security Headers ─────────────────────────────────────────────────────────
app.use(helmet(helmetOptions));

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors(corsOptions));

// ─── Global Rate Limiting (Token Bucket) ─────────────────────────────────────
// Applies to every request, ahead of body parsing so abusive clients are
// rejected as cheaply as possible. Per-route limiters (e.g. /api/auth,
// routes/exampleRoutes.js) layer a stricter bucket on top of this one.
app.use(createRateLimiter(rateLimits.global));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(cookieParser());

// NEW — strips any req.body keys containing `$` or `.` (NoSQL injection
// hardening). Only touches req.body (safe to reassign); does NOT touch
// req.query/req.params, which express-mongo-sanitize crashes on in this
// Express/Node version (getter-only accessors).
app.use(sanitizeBody);

// XSS/HTML-injection hardening — strips markup from every string in
// body, query, AND params (mutated in place, see middleware comment for
// why that matters on Express 5).
app.use(sanitizeRequest);

// ─── Request Logging ─────────────────────────────────────────────────────────
// attachRequestId stamps req.requestId on every request — used by all downstream logs.
app.use(attachRequestId);
app.use(requestLogger);

// ─── Route Imports ────────────────────────────────────────────────────────────

// marqlandstudios-client routes
const publicSiteRoutes = require('./routes/public-site/publicSiteRoutes');
// marqlandstudios-admin routes
const authRoutes = require('./routes/authRoutes');

const productRoutes = require('./routes/productRoutes');
const vendorRoutes = require('./routes/vendorRoutes');
const clientRoutes = require('./routes/clientRoutes');
const catalogueRoutes = require('./routes/catalogueRoutes');
const propertyRoutes = require('./routes/propertyRoutes');
const offsiteCatalogueRoutes = require('./routes/offsiteCatalogueRoutes');
const orderInquiry = require('./routes/orderInquiryRoute');
const SamplesProvided = require('./routes/samplesProvided');
const SourcingHub = require('./routes/inquiryRoutes');
const { router: paymentTracker, syncOutlookInvoices } = require('./routes/paymentTrackerRoutes');
const activityLogger = require('./middleware/activityLogger');
const { authenticateStatic, routeGuard } = require('./middleware/authMiddleware');
const logRoutes = require('./routes/logRoutes');
const imageProcessing = require('./routes/imageProcessingRoutes');
const trendingProductRoutes = require('./routes/trendingProductRoutes');
const shipmentRoutes = require('./routes/shipmentRoutes');
const shippingPartnerRoutes = require('./routes/shippingPartnerRoutes');
const leadScoutRoutes = require('./routes/leadScoutRoutes');
const clientPortalRoutes = require('./routes/clientPortalRoutes');
const comboRoutes = require('./routes/comboRoutes');
// NEW — Supplier Portal
const supplierRoutes = require('./routes/supplierRoutes');
const adminSupplierRoutes = require('./routes/adminSupplierRoutes');
const messageTemplateRoutes = require('./routes/messageTemplateRoutes');
// Reference implementation — see routes/exampleRoutes.js
const exampleRoutes = require('./routes/exampleRoutes');
const jobWorkVendorRoutes = require('./routes/job-work/jobWorkVendorRoutes');
const jobWorkAdminRoutes  = require('./routes/job-work/jobWorkAdminRoutes');
// ─── Static File Serving (Uploads Only) ──────────────────────────────────────
app.use('/public', express.static(path.join(__dirname, 'public')));

// Public — no auth
app.use('/uploads/store', express.static(path.join(__dirname, 'public', 'uploads', 'store')));
app.use('/uploads/publicApp', express.static(path.join(__dirname, 'public', 'uploads', 'publicApp')));
app.use('/uploads/internalApp/products', express.static(path.join(__dirname, 'public', 'uploads', 'internalApp', 'products')));
app.use('/uploads/internalApp/portal', express.static(path.join(__dirname, 'public', 'uploads', 'internalApp', 'portal')));

// Protected — httpOnly cookie required
app.use('/uploads/internalApp', authenticateStatic, express.static(path.join(__dirname, 'public', 'uploads', 'internalApp')));

// Fallback — bare /uploads/<file> paths (legacy upload-temp-image)
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// ─── Database ─────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => {
    const dbName = MONGO_URI.split('/').pop().split('?')[0];
    logger.info('MongoDB connected', { database: dbName });
  })
  .catch(err => {
    logger.error('MongoDB connection failed', { error: err.message, stack: err.stack });
    process.exit(1);
  });

mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
mongoose.connection.on('error', err => logger.error('MongoDB runtime error', { error: err.message }));

// ─── App Middleware ───────────────────────────────────────────────────────────
app.use(activityLogger);

// Global route guard — token + role enforcement for all /api/* routes.
// Public client-portal paths are explicitly exempted so unauthenticated
// clients can load their portal, record views, send messages, etc.
app.use('/api', (req, res, next) => {
  const PUBLIC_PATHS = [
    '/portal/public/',      // GET portal data, POST view, POST message, PUT shortlist/calculator, GET shipments
    '/portal/push-subscribe',  // register browser push subscription (no auth needed)
    '/portal/vapid-public-key', // fetch VAPID key for push setup (no auth needed)
  ];
  if (PUBLIC_PATHS.some(p => req.path.startsWith(p) || req.path === p)) {
    return next(); // bypass auth for public client-facing routes
  }
  return routeGuard(req, res, next);
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/products', productRoutes);
app.use('/api/vendors', vendorRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/catalogues', catalogueRoutes);
app.use('/api/properties', propertyRoutes);
app.use('/api/offsitecatalogues', offsiteCatalogueRoutes);
app.use('/api/orders', orderInquiry);
app.use('/api/challans', SamplesProvided);
app.use('/api/inquiries', SourcingHub);
// CHANGED — the tighter auth token bucket now applies per-route INSIDE
// authRoutes.js (only to the actual brute-forceable public endpoints:
// /login, /forgot-password, /reset-password, /invite/register,
// /invite/verify) instead of blanket-covering the whole /api/auth/* prefix.
// The blanket mount was penalizing normal authenticated admin traffic
// (/me, /users, /invites, /users/:id/role, /users/:id/approve, ...) with
// the same ~1-request-per-30s bucket meant for login attempts — a single
// page refresh could exhaust it. Those routes now rely on the global
// limiter above (120 burst, ~2/sec sustained) plus their own
// authenticate/authorize(['admin']) check, matching this comment's
// original intent of brute-force resistance "without penalizing normal
// API traffic."
app.use('/api/auth', authRoutes);
app.use('/api/payment-tracker', paymentTracker);
app.use('/api/image-processing', imageProcessing);
app.use('/api/trending-products', trendingProductRoutes);
app.use('/api/shipments', shipmentRoutes);
app.use('/api/shipping-partners', shippingPartnerRoutes);
app.use('/api/lead-scout', leadScoutRoutes);
app.use('/api/public-site', publicSiteRoutes);
app.use('/api/portal', clientPortalRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/combos', comboRoutes);
app.use('/api/message-templates', messageTemplateRoutes);
// NEW — Supplier Portal
app.use('/api/suppliers', supplierRoutes);
app.use('/api/admin/supplier-products', adminSupplierRoutes);
// Reference implementation — see routes/exampleRoutes.js
app.use('/api/examples/tasks', exampleRoutes);

app.use('/api/job-work', jobWorkVendorRoutes);
app.use('/api/admin/job-work', jobWorkAdminRoutes);

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use(notFoundHandler);

// ─── Global Error Handler ─────────────────────────────────────────────────────
// Must be the LAST app.use() — Express recognizes it as an error handler
// by its 4-argument signature (see middleware/errorHandler.js).
app.use(errorHandler);

// ─── Background Schedulers ────────────────────────────────────────────────────
startScheduler();         // Trending products — 02:00 IST daily
startTrackingScheduler(); // Shipment tracking — every 2 hours
require('./services/job-work/jobWorkLifecycleService').startScheduler();

// ─── CRON: Daily Outlook + WhatsApp Sync ─────────────────────────────────────
const cronLogger = logger.child({ module: 'cron' });
cron.schedule('0 10 * * *', async () => {
  cronLogger.info('Daily sync task started');
  let stats = { outlookStatus: 'Pending', invoicesCount: 0 };

  try {
    if (syncOutlookInvoices) {
      cronLogger.info('Scanning Outlook for new invoices');
      const syncResult = await syncOutlookInvoices();
      stats.outlookStatus = syncResult.success ? 'Success' : 'Failed';
      stats.invoicesCount = syncResult.processed || 0;
      cronLogger.info('Outlook sync complete', { status: stats.outlookStatus, invoices: stats.invoicesCount });
    } else {
      stats.outlookStatus = 'Sync function missing';
      cronLogger.warn('syncOutlookInvoices not available — skipping');
    }

    cronLogger.info('Syncing WhatsApp invoices');
    await whatsappService.syncWhatsAppInvoices();

    cronLogger.info('Sending daily WhatsApp status report');
    await whatsappService.sendDailyStatus(stats);

    cronLogger.info('Daily sync task finished', stats);
  } catch (err) {
    cronLogger.error('Daily sync task failed', { error: err.message, stack: err.stack });
    await whatsappService.sendDailyStatus({
      outlookStatus: `Error: ${err.message}`,
      invoicesCount: 0,
    }).catch(e => cronLogger.error('WhatsApp fallback status report also failed', { error: e.message }));
  }
}, {
  scheduled: true,
  timezone: 'Asia/Kolkata',
});

// ─── CRON: Weekly Activity Log Archival ──────────────────────────────────────
// Every Sunday at 02:00 IST — well clear of the 10:00 daily Outlook/WhatsApp
// sync above, and before Monday's business traffic starts.
//
//   1. Any ActivityLog rows older than 7 days get grouped by calendar week
//      (Mon–Sun), written to a weekly .xlsx, and uploaded to OneDrive under
//      development/website → "activity logs folder" → "weekly excel saved".
//      Rows are only deleted from MongoDB after their file uploads successfully.
//   2. Archived .xlsx files on OneDrive older than 5 months are then deleted,
//      so the OneDrive folder doesn't grow forever either.
//
// This keeps MongoDB's ActivityLog collection capped at ~7 days of data while
// preserving the full history on OneDrive for up to 5 months.
cron.schedule('0 2 * * 0', async () => {
  cronLogger.info('Activity log maintenance started');
  try {
    await runActivityLogMaintenance();
    cronLogger.info('Activity log maintenance finished');
  } catch (err) {
    cronLogger.error('Activity log maintenance failed', { error: err.message, stack: err.stack });
  }
}, {
  scheduled: true,
  timezone: 'Asia/Kolkata',
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
const shutdown = async (signal) => {
  logger.info(`${signal} received — shutting down gracefully`);
  try {
    await mongoose.disconnect();
    logger.info('MongoDB disconnected cleanly');
  } catch (err) {
    logger.error('Error during shutdown', { error: err.message });
  }
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Catch any unhandled rejections/exceptions so they always appear in logs
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — process will exit', { error: err.message, stack: err.stack });
  process.exit(1);
});

// ─── Server Startup ───────────────────────────────────────────────────────────
//const HOST = '0.0.0.0';
const PORT = process.env.PORT || 3000;
app.listen(PORT,() => {
  console.log('SERVER STARTED ON PORT', PORT); // raw console, not logger
  logger.info('API server started', {
    env: IS_PRODUCTION ? 'production' : 'development',
    port: PORT,
    apiBase: IS_PRODUCTION ? 'https://api.marqlandstudios.com' : `http://localhost:${PORT}`,
  });
});
