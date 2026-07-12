'use strict';
/**
 * routes/exampleRoutes.js
 *
 * Reference implementation of the request pipeline new endpoints in this
 * codebase should follow:
 *
 *   rate limit -> validate (zod) -> controller (asyncHandler-wrapped)
 *     -> service -> centralized errorHandler
 *
 * Mounted at /api/examples/tasks (see server.js) and marked public in
 * middleware/authMiddleware.js's ROUTE_PERMISSIONS ('/examples': null) so
 * it's directly testable without a login. The global helmet/CORS/XSS-
 * sanitize/rate-limit middleware in server.js already applies to this
 * route like every other one; the writeLimiter below shows how to layer
 * a *stricter* bucket on top of the global one for a specific route group.
 */
const express = require('express');
const router = express.Router();

const validate = require('../validation/validate');
const asyncHandler = require('../middleware/asyncHandler');
const { createRateLimiter } = require('../middleware/security/rateLimiter');
const { rateLimits } = require('../config/security');
const controller = require('../controllers/exampleTaskController');
const {
  createTaskSchema,
  updateTaskSchema,
  idParamSchema,
  listQuerySchema,
} = require('../validation/schemas/exampleTask.schema');

const writeLimiter = createRateLimiter(rateLimits.write);

router.get('/', validate({ query: listQuerySchema }), asyncHandler(controller.list));
router.get('/:id', validate({ params: idParamSchema }), asyncHandler(controller.getOne));
router.post('/', writeLimiter, validate({ body: createTaskSchema }), asyncHandler(controller.create));
router.patch('/:id', writeLimiter, validate({ params: idParamSchema, body: updateTaskSchema }), asyncHandler(controller.update));
router.delete('/:id', writeLimiter, validate({ params: idParamSchema }), asyncHandler(controller.remove));

module.exports = router;
