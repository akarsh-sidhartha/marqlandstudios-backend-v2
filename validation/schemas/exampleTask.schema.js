'use strict';
/**
 * validation/schemas/exampleTask.schema.js
 *
 * zod schemas for the reference /api/examples/tasks endpoint. Field
 * primitives (title, description, ...) are defined once and composed
 * into the create/update/list schemas so a length limit or format rule
 * only ever needs to change in one place.
 */
const { z } = require('zod');

const title = z.string().trim().min(1, 'Title is required.').max(200, 'Title must be under 200 characters.');
const description = z.string().trim().max(2000, 'Description must be under 2000 characters.').optional().default('');
const status = z.enum(['pending', 'in_progress', 'done']).default('pending');
const mongoId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id.');

const createTaskSchema = z.object({ title, description, status }).strict();

const updateTaskSchema = z
  .object({ title: title.optional(), description, status: status.optional() })
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field must be provided.' });

const idParamSchema = z.object({ id: mongoId });

const listQuerySchema = z.object({
  status: status.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

module.exports = { createTaskSchema, updateTaskSchema, idParamSchema, listQuerySchema };
