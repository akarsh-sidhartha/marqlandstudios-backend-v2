'use strict';
/**
 * routes/jobWorkAdminRoutes.js
 * Mounted at /api/admin/job-work — protected globally by routeGuard(['admin'])
 * via authMiddleware.js ROUTE_PERMISSIONS['/admin/job-work'] (see JOB_WORK_WIRING.md).
 *
 * Admin review queue for Job Work rows submitted by 'jobWork'-role vendors,
 * plus a dedicated invite endpoint for onboarding new vendors (kept separate
 * from the generic POST /api/auth/invite so services/emailService.js and
 * models/Invite.js's inviteType enum branch don't need touching for the
 * 'employee'/'supplier' cases — see jobWorkEmailService.js).
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const JobWorkRow = require('../../models/job-work/JobWorkRow');
const User = require('../../models/User');
const Invite = require('../../models/Invite');
const { sendJobWorkInviteEmail } = require('../../services/job-work/jobWorkEmailService');
const { isValidEmail, isValidMessage } = require('../../utils/inputValidation');
const { createRateLimiter } = require('../../middleware/security/rateLimiter');
const logger = require('../../utils/logger').child({ module: 'jobWorkAdminRoutes' });

const jobWorkWriteLimiter = createRateLimiter({ capacity: 30, refillPerSec: 0.5 });

const buildDateFilter = (from, to) => {
  const filter = {};
  if (from) filter.$gte = new Date(from);
  if (to) {
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    filter.$lte = end;
  }
  return Object.keys(filter).length ? filter : null;
};

// ─── GET /api/admin/job-work/rows ─────────────────────────────────────────────
// Query: tab=ongoing|completed|archive, search=, vendor=<userId>, from=, to=
router.get('/rows', async (req, res) => {
  try {
    const { tab, search, vendor, from, to } = req.query;
    const filter = {};
    if (tab && ['ongoing', 'completed', 'archive'].includes(tab)) filter.status = tab;
    if (vendor) filter.vendor = vendor;
    if (search && String(search).trim()) {
      filter.$or = [
        { description: { $regex: String(search).trim().slice(0, 200), $options: 'i' } },
        { serialId: { $regex: String(search).trim().slice(0, 200), $options: 'i' } },
      ];
    }
    const dateFilter = buildDateFilter(from, to);
    if (dateFilter) filter.createdAt = dateFilter;

    const rows = await JobWorkRow.find(filter)
      .populate('vendor', 'name email')
      .populate('approvedBy', 'name email')
      .sort({ createdAt: -1 })
      .lean();
    res.json(rows);
  } catch (err) {
    logger.error('Failed to list job work rows (admin)', { error: err.message });
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/job-work/vendors ──────────────────────────────────────────
// Distinct vendor list, for the admin's vendor-filter dropdown/search box.
router.get('/vendors', async (req, res) => {
  try {
    const vendors = await User.find({ role: 'jobWork' }, 'name email status').sort({ name: 1 }).lean();
    res.json(vendors);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/job-work/rows/:id ─────────────────────────────────────────
router.get('/rows/:id', async (req, res) => {
  try {
    const row = await JobWorkRow.findById(req.params.id).populate('vendor', 'name email').lean();
    if (!row) return res.status(404).json({ message: 'Row not found.' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── PUT /api/admin/job-work/rows/:id/approve ─────────────────────────────────
// ongoing -> completed. Auto-archived 2 months later by jobWorkLifecycleService.
router.put('/rows/:id/approve', jobWorkWriteLimiter, async (req, res) => {
  try {
    const row = await JobWorkRow.findById(req.params.id);
    if (!row) return res.status(404).json({ message: 'Row not found.' });
    if (row.status !== 'ongoing')
      return res.status(400).json({ message: 'Only rows in Ongoing can be approved.' });

    row.status = 'completed';
    row.completedAt = new Date();
    row.approvedBy = req.user.id;
    row.approvedAt = new Date();
    await row.save();

    logger.info('Job work row approved', { rowId: row._id, approvedBy: req.user.id });
    res.json({ message: 'Row approved and moved to Completed.', row });
  } catch (err) {
    logger.error('Failed to approve job work row', { error: err.message, rowId: req.params.id });
    res.status(500).json({ message: err.message });
  }
});

// ─── PUT /api/admin/job-work/rows/:id/comment ─────────────────────────────────
// Body: { text } — row stays 'ongoing', comment is visible to the vendor.
router.put('/rows/:id/comment', jobWorkWriteLimiter, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim())
      return res.status(400).json({ message: 'Comment text is required.' });
    if (!isValidMessage(text))
      return res.status(400).json({ message: 'Comment can only contain letters, numbers, spaces, and line breaks.' });

    const row = await JobWorkRow.findById(req.params.id);
    if (!row) return res.status(404).json({ message: 'Row not found.' });

    row.adminComment = text.trim();
    row.commentHistory.push({ text: text.trim(), byUser: req.user.id, byName: req.user.name || '' });
    await row.save();

    logger.info('Job work comment added', { rowId: row._id, byUser: req.user.id });
    res.json({ message: 'Comment saved.', row });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/admin/job-work/invite ──────────────────────────────────────────
// Body: { email } — invites a new Job Work vendor. Reuses the existing generic
// GET /api/auth/invite/verify and POST /api/auth/invite/register endpoints
// (they don't branch on inviteType), and the existing PATCH
// /api/auth/users/:id/approve flow for granting portal access + assigning
// the 'jobWork' role (see JOB_WORK_WIRING.md for the one-line enum additions
// those shared files need).
router.post('/invite', jobWorkWriteLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !isValidEmail(email))
      return res.status(400).json({ message: 'A valid email address is required.' });

    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser)
      return res.status(409).json({ message: `${email} already has an account (status: ${existingUser.status}).` });

    const existingInvite = await Invite.findOne({ email: normalizedEmail, used: false });
    if (existingInvite && new Date() < existingInvite.expiresAt) {
      await sendJobWorkInviteEmail(normalizedEmail, existingInvite.token, req.user.name);
      return res.json({ message: `Invite resent to ${email}.` });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const invite = new Invite({ email: normalizedEmail, token, invitedBy: req.user.id, inviteType: 'jobWork' });
    await invite.save();

    await sendJobWorkInviteEmail(normalizedEmail, token, req.user.name);

    logger.info('Job work invite sent', { to: normalizedEmail, sentBy: req.user.id });
    res.status(201).json({ message: `Invite sent successfully to ${email}.` });
  } catch (err) {
    logger.error('Failed to send job work invite', { error: err.message });
    res.status(500).json({ message: 'Failed to send invite.', error: err.message });
  }
});

// Note: there's no dedicated GET /invites here — the existing, generic
// GET /api/auth/invites (used by UserManagement.js's InvitePanel) already
// returns pending jobWork invites too, since they're stored in the same
// Invite collection, just with inviteType: 'jobWork'.

// ─── GET /api/admin/job-work/pending-vendors ──────────────────────────────────
// Users who registered via a jobWork invite but haven't been approved yet —
// used by the admin UI's "Pending Vendor Approvals" panel, which then calls
// the existing PATCH /api/auth/users/:id/approve with { role: 'jobWork' }.
router.get('/pending-vendors', async (req, res) => {
  try {
    const pendingUsers = await User.find({ status: 'pending' }, 'name email createdAt').sort({ createdAt: -1 }).lean();
    if (!pendingUsers.length) return res.json([]);

    const emails = pendingUsers.map(u => u.email);
    const jobWorkInvites = await Invite.find({ email: { $in: emails }, inviteType: 'jobWork' }, 'email').lean();
    const jobWorkEmails = new Set(jobWorkInvites.map(i => i.email));

    res.json(pendingUsers.filter(u => jobWorkEmails.has(u.email)));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
