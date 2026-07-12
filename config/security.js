'use strict';
/**
 * config/security.js
 *
 * Single source of truth for CORS, security headers, and rate-limit
 * tuning. Change limits/origins here — middleware reads from this file
 * rather than hardcoding values, so there's one place to audit for a
 * security review.
 */

const allowedOrigins = [
  ...(process.env.ADMIN_URL ? process.env.ADMIN_URL.split(',').map(o => o.trim()) : []),
  ...(process.env.CLIENT_URL ? process.env.CLIENT_URL.split(',').map(o => o.trim()) : []),
  'https://marqlandstudios.com',
  'https://www.marqlandstudios.com',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5000',
];

const corsOptions = {
  origin: (origin, callback) => {
    const normalised = origin?.replace(/\/$/, '');
    if (!normalised || allowedOrigins.includes(normalised)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS policy: origin '${origin}' not allowed`));
    }
  },
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

// This is a JSON API consumed by separate admin/client front-ends, not a
// server rendering HTML, so a strict CSP has nothing to protect here and
// would just get in the way of Helmet's other (genuinely useful) headers.
// crossOriginResourcePolicy is relaxed because /uploads/* assets are
// fetched cross-origin by those front-ends.
const helmetOptions = {
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
};

// Token-bucket tuning: `capacity` is the burst size, `refillPerSec` is the
// sustained rate once the burst is spent. Keyed per route-group below so
// a slow brute-force-prone endpoint (auth) can be tightened independently
// of general API traffic.
const rateLimits = {
  global: { capacity: 120, refillPerSec: 2 },        // ~2 req/sec sustained per client, 120 burst
  auth: { capacity: 10, refillPerSec: 10 / 300 },    // 10 attempts per 5 min sustained — brute-force resistant
  write: { capacity: 30, refillPerSec: 0.5 },        // stricter bucket for mutating example endpoints
};

module.exports = { allowedOrigins, corsOptions, helmetOptions, rateLimits };
