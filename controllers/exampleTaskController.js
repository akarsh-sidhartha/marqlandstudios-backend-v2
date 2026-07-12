'use strict';
/**
 * controllers/exampleTaskController.js
 *
 * Thin HTTP layer — translates req -> service call -> res. No try/catch
 * (asyncHandler in routes/exampleRoutes.js forwards rejections to the
 * centralized errorHandler) and no business logic (that lives in
 * services/example/exampleTaskService.js).
 */
const taskService = require('../services/example/exampleTaskService');
const logger = require('../utils/logger').child({ module: 'exampleTaskController' });

const list = async (req, res) => {
  const result = await taskService.listTasks(req.query);
  res.status(200).json(result);
};

const getOne = async (req, res) => {
  const task = await taskService.getTaskById(req.params.id);
  res.status(200).json(task);
};

const create = async (req, res) => {
  const task = await taskService.createTask(req.body);
  logger.info('Example task created', { id: task._id });
  res.status(201).json(task);
};

const update = async (req, res) => {
  const task = await taskService.updateTask(req.params.id, req.body);
  res.status(200).json(task);
};

const remove = async (req, res) => {
  await taskService.deleteTask(req.params.id);
  res.status(204).end();
};

module.exports = { list, getOne, create, update, remove };
