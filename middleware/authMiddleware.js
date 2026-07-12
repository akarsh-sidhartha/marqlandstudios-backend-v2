const jwt = require('jsonwebtoken');
const logger = require('../utils/logger').child({ module: 'authMiddleware' });

/**
 * ─── ROUTE PERMISSION MAP ─────────────────────────────────────────────────────
 *
 * Paths are matched against req.path INSIDE app.use('/api', ...)
 * Express strips the '/api' prefix, so req.path = '/auth/login' not '/api/auth/login'
 *
 * null  = fully public (no token needed)
 * array = token required AND role must be in the list
 */
const ROUTE_PERMISSIONS = {
  '/auth':                    null,   // ALL /api/auth/* routes are public
  '/examples':                null,   // reference/demo endpoint — see routes/exampleRoutes.js
  '/public-site':             null,   // public-facing site routes
  '/vendors/media':           null,   // OneDrive media proxy — auth handled by Graph bearer token
  '/orders/proxy-attachment': null,   // OneDrive order attachment proxy — same pattern
  // NEW: Supplier Portal — suppliers can only ever hit /api/suppliers/*.
  // They deliberately do NOT get access to '/products' (that stays
  // internal-roles-only below) so a supplier account can never read/write
  // the live catalogue directly, only their own staging rows.
  '/suppliers':                ['supplier'],
  '/products':                ['inventory', 'sales', 'accounts', 'admin'],
  // NEW: admin review queue for supplier submissions — admin only.
  '/admin/supplier-products':  ['admin'],
  '/vendors':                 ['accounts', 'admin'],
  '/clients':              ['sales', 'accounts', 'admin'],
  '/catalogues':           ['inventory', 'sales', 'accounts', 'admin'],
  '/properties':           ['inventory', 'sales', 'accounts', 'admin'],
  '/offsitecatalogues':    ['inventory', 'sales', 'accounts', 'admin'],
  '/orders':               ['sales', 'accounts', 'admin'],
  '/challans':             ['inventory', 'sales', 'accounts', 'admin'],
  '/inquiries':            ['sales', 'accounts', 'admin'],
  '/payment-tracker':      ['accounts', 'admin'],
  '/shipments':            ['courier', 'inventory', 'sales', 'accounts', 'admin'],
  '/shipping-partners':    ['courier', 'admin'],
  '/lead-scout':           ['sales', 'accounts', 'admin'],
  '/image-processing':     ['inventory', 'sales', 'accounts', 'admin'],
  '/trending-products':    ['inventory', 'sales', 'accounts', 'admin'],
  '/logs':                 ['admin'],
  '/portal/public':        null,                                          // client-facing, no auth
  '/portal':               ['sales', 'accounts', 'admin'],
};

// ─── MIDDLEWARE: authenticate ─────────────────────────────────────────────────
/**
 * Verifies JWT from the Authorization: Bearer <token> header.
 * Attaches decoded payload to req.user.
 * Use this on individual protected routes.
 */
const authenticate = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    logger.warn('Auth failed — no token', { path: req.path, ip: req.ip });
    return res.status(401).json({ message: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    logger.warn('Auth failed — invalid token', { path: req.path, ip: req.ip, error: err.message });
    return res.status(401).json({ message: 'Invalid or expired token. Please log in again.' });
  }
};

// ─── MIDDLEWARE: authorize ────────────────────────────────────────────────────
/**
 * Use after authenticate to restrict a route to specific roles.
 * Usage: router.get('/', authenticate, authorize(['admin']), handler)
 */
const authorize = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authenticated.' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      logger.warn('Authorisation denied', { path: req.path, userId: req.user.id, role: req.user.role });
      return res.status(403).json({
        message: `Access denied. Your role (${req.user.role}) does not have permission.`
      });
    }
    next();
  };
};

// ─── MIDDLEWARE: routeGuard ───────────────────────────────────────────────────
/**
 * Global guard applied via app.use('/api', routeGuard) in server.js.
 * Automatically protects all /api/* routes using ROUTE_PERMISSIONS above.
 * Eliminates the need to manually add authenticate + authorize on every router.
 *
 * Routes NOT in the map default to ['admin'] for safety — this prevents a
 * newly added route from accidentally being publicly accessible.
 */
const routeGuard = (req, res, next) => {
  const matchedPrefix = Object.keys(ROUTE_PERMISSIONS).find(prefix =>
    req.path.startsWith(prefix)
  );

  // Route not in map → default to admin-only for safety
  const allowedRoles = matchedPrefix !== undefined
    ? ROUTE_PERMISSIONS[matchedPrefix]
    : ['admin'];

  // null = public route, skip all auth checks
  if (allowedRoles === null) {
    return next();
  }

  // Verify token from Authorization header
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    logger.warn('Auth failed — no token', { path: req.path, ip: req.ip });
    logger.warn('routeGuard — no token', { path: req.path, ip: req.ip });
    return res.status(401).json({ message: 'Access denied. No token provided.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token. Please log in again.' });
  }

  req.user = decoded;

  if (!allowedRoles.includes(decoded.role)) {
    logger.warn('routeGuard — role denied', { path: req.path, userId: decoded.id, role: decoded.role });
    return res.status(403).json({
      message: `Your role (${decoded.role}) cannot access this resource.`
    });
  }

  next();
};

// ─── MIDDLEWARE: authenticateStatic ──────────────────────────────────────────
/**
 * Protects express.static routes using the httpOnly cookie set on login.
 *
 * WHY A COOKIE AND NOT A HEADER:
 * Browsers don't send Authorization headers when loading <img src="...">,
 * PDFs, or video files directly. The cookie is sent automatically.
 *
 * CROSS-ORIGIN NOTE:
 * In production the admin app (admin.marqlandstudios.com) and the API
 * (api.marqlandstudios.com) are on different subdomains. The cookie must be
 * set with sameSite: 'none' + secure: true for the browser to send it
 * cross-origin. This is handled in authRoutes /login.
 */
const authenticateStatic = (req, res, next) => {
  const token = req.cookies?.static_token;

  if (!token) {
    return res.status(401).json({ message: 'Access denied. Please log in to view this resource.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Reject suspended/pending users even if their cookie is still valid
    if (decoded.status && decoded.status !== 'active') {
      return res.status(403).json({ message: 'Account is not active.' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Session expired. Please log in again.' });
  }
};

module.exports = { authenticate, authorize, routeGuard, authenticateStatic };