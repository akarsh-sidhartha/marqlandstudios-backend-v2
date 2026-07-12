'use strict';
/**
 * validation/validate.js
 *
 * Generic, reusable request-validation middleware factory. Pass zod
 * schemas for whichever parts of the request a route cares about
 * (body/query/params); this is the one place that turns a failed schema
 * into a 400 response, so no route hand-rolls its own "if (!field)
 * return res.status(400)..." checks (DRY — see utils/inputValidation.js
 * for the older, narrower version of this idea that this generalizes).
 *
 * Usage:
 *   router.post('/', validate({ body: createTaskSchema }), controller.create);
 *   router.get('/:id', validate({ params: idParamSchema }), controller.getOne);
 */
const AppError = require('../lib/errors/AppError');

const validate = (schemas = {}) => (req, res, next) => {
  for (const key of ['params', 'query', 'body']) {
    const schema = schemas[key];
    if (!schema) continue;

    const result = schema.safeParse(req[key]);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || key,
        message: issue.message,
      }));
      return next(AppError.badRequest('Invalid request data.', details));
    }

    // req.query/req.params are getter-only in Express 5 (reassigning them
    // throws), so validated/coerced values are copied back onto the
    // existing object instead of replacing req[key] wholesale.
    Object.assign(req[key], result.data);
  }
  next();
};

module.exports = validate;
