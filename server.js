const dotenv = require('dotenv');
//dotenv.config({ override: false });
// ⚠ MUST call before any require that reads process.env
dotenv.config();


const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const cron = require('node-cron');

const app = express();

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const legacyPortalRedirect = require('./middleware/legacyPortalRedirect');// delete this over a period of time.
app.use(legacyPortalRedirect); // must be before all other app.use() calls // delete this over a period of time.
const logger = require('./utils/logger').child({ module: 'server' });
const { attachRequestId, requestLogger } = require('./middleware/requestLogger');
const whatsappService = require('./services/whatsappService');
const { startScheduler } = require('./services/trendingProductService');
const { startTrackingScheduler } = require('./services/shipmentTrackingService');

/**
 * ─── CORS CONFIGURATION ───────────────────────────────────────────────────────
 * DEV:  Allows localhost:3000 (admin portal) and localhost:3001 (public site)
 * PROD: Allows only the two live domains
 * Override by setting ALLOWED_ORIGINS as a comma-separated list in .env.
 */
const defaultOrigins = IS_PRODUCTION
  ? [
    'https://admin.marqlandstudios.com',
    'https://www.marqlandstudios.com',
    'https://marqlandstudios.com',
    // Legacy — keep during DNS transition; remove after cutover
    'https://internalportal.marqland.com',
    'https://www.marqland.com',
    'https://marqland.com',
  ]
  : [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5000',
  ];

/*
const allowedOrigins = process.env.ALLOWED_ORIGINS
? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
: defaultOrigins;
*/
const allowedOrigins = [
  ...process.env.ADMIN_URL.split(',').map(o => o.trim()),
  ...process.env.CLIENT_URL.split(',').map(o => o.trim()),
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5000',
];
app.use(cors({
  origin: (origin, callback) => {
    const normalised = origin?.replace(/\/$/, '');
    if (!normalised || allowedOrigins.includes(normalised)) {
      callback(null, true);
    } else {
      logger.warn('CORS rejected request', { origin });
      callback(new Error(`CORS policy: origin '${origin}' not allowed`));
    }
  },
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(cookieParser());

// ─── Request Logging ─────────────────────────────────────────────────────────
// attachRequestId stamps req.requestId on every request — used by all downstream logs.
app.use(attachRequestId);
app.use(requestLogger);

// ─── Route Imports ────────────────────────────────────────────────────────────

// marqlandstudios-client routes
const publicSiteRoutes = require('./routes/public-site/publicSiteRoutes');
console.log('publicSiteRoutes loaded OK');
// marqlandstudios-admin routes
const authRoutes = require('./routes/authRoutes');

const productRoutes = require('./routes/productRoutes');
console.log('productRoutes loaded OK');
const vendorRoutes = require('./routes/vendorRoutes');
console.log('vendorRoutes loaded OK');
const clientRoutes = require('./routes/clientRoutes');
console.log('clientRoutes loaded OK');
const catalogueRoutes = require('./routes/catalogueRoutes');
console.log('catalogueRoutes loaded OK');
const propertyRoutes = require('./routes/propertyRoutes');
console.log('propertyRoutes loaded OK');
const offsiteCatalogueRoutes = require('./routes/offsiteCatalogueRoutes');
console.log('offsiteCatalogueRoutes loaded OK');
const orderInquiry = require('./routes/orderInquiryRoute');
console.log('orderInquiry loaded OK');
const SamplesProvided = require('./routes/samplesProvided');
console.log('SamplesProvided loaded OK');
const SourcingHub = require('./routes/inquiryRoutes');
console.log('SourcingHub loaded OK');
const { router: paymentTracker, syncOutlookInvoices } = require('./routes/paymentTrackerRoutes');
console.log('paymentTracker loaded OK');
const activityLogger = require('./middleware/activityLogger');
console.log('activityLogger loaded OK');
const { authenticateStatic, routeGuard } = require('./middleware/authMiddleware');
console.log('authenticateStatic loaded OK');
const logRoutes = require('./routes/logRoutes');
console.log('logRoutes loaded OK');
const imageProcessing = require('./routes/imageProcessingRoutes');
console.log('imageProcessing loaded OK');
const trendingProductRoutes = require('./routes/trendingProductRoutes');
console.log('trendingProductRoutes loaded OK');
const shipmentRoutes = require('./routes/shipmentRoutes');
console.log('shipmentRoutes loaded OK');
const shippingPartnerRoutes = require('./routes/shippingPartnerRoutes');
console.log('shippingPartnerRoutes loaded OK');
const leadScoutRoutes = require('./routes/leadScoutRoutes');
console.log('leadScoutRoutes loaded OK');
const clientPortalRoutes = require('./routes/clientPortalRoutes');
console.log('clientPortalRoutes loaded OK');

// ─── Static File Serving (Uploads Only) ──────────────────────────────────────
app.use('/public', express.static(path.join(__dirname, 'public')));
console.log('Log 1 file');

// Public — no auth
app.use('/uploads/store', express.static(path.join(__dirname, 'public', 'uploads', 'store')));
console.log('Log 2 file');
app.use('/uploads/publicApp', express.static(path.join(__dirname, 'public', 'uploads', 'publicApp')));
console.log('Log 3 file');
app.use('/uploads/internalApp/products', express.static(path.join(__dirname, 'public', 'uploads', 'internalApp', 'products')));
console.log('Log 4 file');
app.use('/uploads/internalApp/portal', express.static(path.join(__dirname, 'public', 'uploads', 'internalApp', 'portal')));
console.log('Log 5 file');

// Protected — httpOnly cookie required
app.use('/uploads/internalApp', authenticateStatic, express.static(path.join(__dirname, 'public', 'uploads', 'internalApp')));
console.log('Log 6 file');

// Fallback — bare /uploads/<file> paths (legacy upload-temp-image)
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));
console.log('Log 7 file');

// ─── Database ─────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
console.log('Log 8 file');

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
console.log('Log 9 file');
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
console.log('Log 10 file');
// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/products', productRoutes);
console.log('Log 11 file');
app.use('/api/vendors', vendorRoutes);
console.log('Log 12 file');
app.use('/api/clients', clientRoutes);
console.log('Log 13 file');
app.use('/api/catalogues', catalogueRoutes);
console.log('Log 14 file');
app.use('/api/properties', propertyRoutes);
console.log('Log 15 file');
app.use('/api/offsitecatalogues', offsiteCatalogueRoutes);
console.log('Log 16 file');
app.use('/api/orders', orderInquiry);
console.log('Log 17 file');
app.use('/api/challans', SamplesProvided);
console.log('Log 18 file');
app.use('/api/inquiries', SourcingHub);
console.log('Log 19 file');
app.use('/api/auth', authRoutes);
console.log('Log 20 file');
app.use('/api/payment-tracker', paymentTracker);
console.log('Log 21 file');
app.use('/api/image-processing', imageProcessing);
console.log('Log 22 file');
app.use('/api/trending-products', trendingProductRoutes);
console.log('Log 23 file');
app.use('/api/shipments', shipmentRoutes);
console.log('Log 24 file');
app.use('/api/shipping-partners', shippingPartnerRoutes);
console.log('Log 25 file');
app.use('/api/lead-scout', leadScoutRoutes);
console.log('Log 26 file');
app.use('/api/public-site', publicSiteRoutes);
console.log('Log 27 file');
app.use('/api/portal', clientPortalRoutes);
console.log('Log 28 file');
app.use('/api/logs', logRoutes);
console.log('Log 29 file');

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (
    req.url.startsWith('/api') ||
    req.url.startsWith('/public') ||
    req.url.startsWith('/uploads')
  ) return next();

  logger.warn('404 — unmatched route', {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
  });
  res.status(404).json({ error: 'Not found. This is an API server.' });
});
console.log('Log 30 file');
// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error reached global handler', {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    error: err.message,
    stack: err.stack,
    userId: req.user?.id,
  });
  res.status(err.status || 500).json({
    error: IS_PRODUCTION ? 'Internal Server Error' : err.message,
  });
});
console.log('Log 31 file');
// ─── Background Schedulers ────────────────────────────────────────────────────
startScheduler();         // Trending products — 02:00 IST daily
startTrackingScheduler(); // Shipment tracking — every 2 hours
console.log('Log 32 file');
// ─── CRON: Daily Outlook + WhatsApp Sync ─────────────────────────────────────
const cronLogger = logger.child({ module: 'cron' });
console.log('Log 33 file');
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
console.log('Log 34 file');
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
console.log('Log 35 file');
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
console.log('Log 36 file');
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
console.log('Log 37 file');
// ─── Server Startup ───────────────────────────────────────────────────────────
//const HOST = '0.0.0.0';
const PORT = process.env.PORT || 5000;
console.log('Log 38 file');
logger.info("after setting the port");
console.log('PORT value is:', JSON.stringify(process.env.PORT));
console.log('PORT resolved:', PORT);
app.listen(PORT,() => {
  logger.info('API server started', {
    env: IS_PRODUCTION ? 'production' : 'development',
    port: PORT,
    apiBase: IS_PRODUCTION ? 'https://api.marqlandstudios.com' : `http://localhost:${PORT}`,
  });
});

