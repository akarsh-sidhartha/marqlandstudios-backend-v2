'use strict';
/**
 * services/example/exampleTaskService.js
 *
 * Business logic / data access for the reference example endpoint,
 * deliberately decoupled from Express (no req/res here) so it's testable
 * in isolation and reusable from anywhere — a controller, a script, a
 * cron job — without dragging HTTP concerns along with it.
 */
const ExampleTask = require('../../models/ExampleTask');
const AppError = require('../../lib/errors/AppError');

const listTasks = async ({ status, page, limit }) => {
  const filter = status ? { status } : {};
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    ExampleTask.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ExampleTask.countDocuments(filter),
  ]);

  return { items, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
};

const getTaskById = async (id) => {
  const task = await ExampleTask.findById(id).lean();
  if (!task) throw AppError.notFound('Task not found.');
  return task;
};

const createTask = (data) => ExampleTask.create(data);

const updateTask = async (id, data) => {
  const task = await ExampleTask.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true });
  if (!task) throw AppError.notFound('Task not found.');
  return task;
};

const deleteTask = async (id) => {
  const task = await ExampleTask.findByIdAndDelete(id);
  if (!task) throw AppError.notFound('Task not found.');
};

module.exports = { listTasks, getTaskById, createTask, updateTask, deleteTask };
