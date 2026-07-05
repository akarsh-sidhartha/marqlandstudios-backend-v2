const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const Invite = require('../models/Invite');
const { authenticate, authorize } = require('../middleware/authMiddleware');
const { sendInviteEmail, sendPasswordResetEmail } = require('../services/emailService');
const { validateBody } = require('../utils/inputValidation'); // NEW — security hardening
const logger = require('../utils/logger').child({ module: 'authRoutes' });

// ─── TOKEN HELPERS ────────────────────────────────────────────────────────────

const generateAccessToken = (user) => {
  return jwt.sign(
    {
      id:            user._id,
      name:          user.name,
      email:         user.email,
      role:          user.role,
      status:        user.status,
      allowedRoutes: user.allowedRoutes || [],
    },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
};

const generateRefreshToken = (user) => {
  return jwt.sign(
    { id: user._id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );
};

/**
 * Builds the cookie options for the static_token cookie.
 *
 * CROSS-ORIGIN REQUIREMENT:
 * In production, the admin app (admin.marqlandstudios.com) and the API
 * (api.marqlandstudios.com) are on different subdomains. Browsers will NOT
 * send a sameSite:'strict' or sameSite:'lax' cookie on cross-origin requests.
 * We must use sameSite:'none' + secure:true in production so the cookie is
 * sent when the browser fetches /uploads/* images from the API domain.
 *
 * In development both apps run on localhost so sameSite:'strict' is fine.
 */
const staticCookieOptions = () => {
  const IS_PRODUCTION = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure:   IS_PRODUCTION,           // HTTPS only in prod (required for sameSite:'none')
    sameSite: IS_PRODUCTION ? 'none' : 'strict',
    maxAge:   8 * 60 * 60 * 1000,     // 8 hours in ms — matches access token expiry
  };
};

// ─── PUBLIC ROUTES ────────────────────────────────────────────────────────────

/**
 * POST /api/auth/register
 * Standard self-registration (no invite). Account starts as "pending".
 */
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ message: 'Name, email, and password are required.' });
    if (password.length < 8)
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing)
      return res.status(409).json({ message: 'An account with this email already exists.' });

    const user = new User({ name, email, password, role: 'viewer', status: 'pending' });
    await user.save();

    logger.info('New user registered', { userId: user._id, email: user.email });
    res.status(201).json({
      message: 'Registration successful! Your account is pending admin approval.',
      user: { id: user._id, name: user.name, email: user.email, status: user.status }
    });
  } catch (err) {
    res.status(500).json({ message: 'Registration failed.', error: err.message });
  }
});

/**
 * GET /api/auth/invite/verify?token=xxx
 * Frontend calls this to validate the invite token before showing the form.
 * Returns the pre-filled email so the form can lock it.
 */
router.get('/invite/verify', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ message: 'Token is required.' });

    const invite = await Invite.findOne({ token, used: false });

    if (!invite)
      return res.status(404).json({ message: 'This invite link is invalid or has already been used.' });

    if (new Date() > invite.expiresAt)
      return res.status(410).json({ message: 'This invite link has expired. Please ask your admin to send a new one.' });

    res.json({ valid: true, email: invite.email });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /api/auth/invite/register
 * Register using an invite token. Email is pre-filled and locked from the token.
 */
router.post('/invite/register',
  validateBody({ name: 'name', password: 'password' }, ['token', 'name', 'password']),
  async (req, res) => {
  try {
    const { token, name, password } = req.body;

    const invite = await Invite.findOne({ token, used: false });
    if (!invite)
      return res.status(404).json({ message: 'This invite link is invalid or has already been used.' });
    if (new Date() > invite.expiresAt)
      return res.status(410).json({ message: 'This invite link has expired.' });

    const existing = await User.findOne({ email: invite.email });
    if (existing)
      return res.status(409).json({ message: 'An account with this email already exists.' });

    const user = new User({
      name,
      email:  invite.email,
      password,
      role:   'viewer',
      status: 'pending',
    });
    await user.save();

    invite.used = true;
    await invite.save();

    res.status(201).json({
      message: 'Account created! An admin will activate your account shortly.',
      user: { id: user._id, name: user.name, email: user.email, status: user.status }
    });
  } catch (err) {
    res.status(500).json({ message: 'Registration failed.', error: err.message });
  }
});

/**
 * POST /api/auth/login
 */
router.post('/login',
  validateBody({ email: 'email', password: 'password' }, ['email', 'password']),
  async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email: email.toLowerCase() }).select('+password +refreshToken');

    if (!user || !(await user.comparePassword(password))) {
      logger.warn('Login failed — invalid credentials', { email: email.toLowerCase() });
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    if (user.status === 'pending') {
      logger.warn('Login blocked — account pending', { userId: user._id, email: user.email });
      return res.status(403).json({
        message: 'Your account is pending approval. An admin will activate it shortly.',
        status: 'pending'
      });
    }

    if (user.status === 'suspended') {
      logger.warn('Login blocked — account suspended', { userId: user._id, email: user.email });
      return res.status(403).json({
        message: 'Your account has been suspended. Please contact your administrator.',
        status: 'suspended'
      });
    }

    const accessToken  = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    user.refreshToken = refreshToken;
    user.lastLogin    = new Date();
    await user.save();

    // Set httpOnly cookie for static file auth (/uploads/* images, PDFs, videos).
    // sameSite:'none' in production is required because the admin app and API
    // are on different subdomains — see staticCookieOptions() above.
    res.cookie('static_token', accessToken, staticCookieOptions());

    logger.info('User logged in', { userId: user._id, email: user.email, role: user.role });
    res.json({
      message:      'Login successful.',
      accessToken,
      refreshToken,
      user: {
        id:            user._id,
        name:          user.name,
        email:         user.email,
        role:          user.role,
        status:        user.status,
        allowedRoutes: user.allowedRoutes || [],
      }
    });
  } catch (err) {
    logger.error('Login error', { error: err.message, stack: err.stack });
    res.status(500).json({ message: 'Login failed.', error: err.message });
  }
});

/**
 * POST /api/auth/refresh
 * Issues a new access token using the stored refresh token.
 */
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ message: 'Refresh token required.' });

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user    = await User.findById(decoded.id).select('+refreshToken');

    if (!user || user.refreshToken !== refreshToken)
      return res.status(401).json({ message: 'Invalid refresh token. Please log in again.' });

    if (user.status !== 'active')
      return res.status(403).json({ message: 'Account is not active.' });

    const newAccessToken = generateAccessToken(user);
    logger.info('Token refreshed', { userId: user._id, role: user.role });

    // Re-issue the static cookie with the new access token so file serving
    // doesn't break mid-session after a token refresh.
    res.cookie('static_token', newAccessToken, staticCookieOptions());

    res.json({ accessToken: newAccessToken });
  } catch (err) {
    res.status(401).json({ message: 'Refresh token expired. Please log in again.' });
  }
});

/**
 * GET /api/auth/me
 * Returns the current user's fresh profile from DB (picks up any permission changes).
 * Intentionally returns only safe fields — never the full Mongoose document.
 */
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    res.json({
      id:            user._id,
      name:          user.name,
      email:         user.email,
      role:          user.role,
      status:        user.status,
      allowedRoutes: user.allowedRoutes || [],
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', authenticate, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user.id, { refreshToken: null });
    logger.info('User logged out', { userId: req.user.id });

    // Clear the static file auth cookie using the same options it was set with
    // (sameSite + secure must match, otherwise browsers ignore clearCookie)
    const opts = staticCookieOptions();
    res.clearCookie('static_token', {
      httpOnly: opts.httpOnly,
      secure:   opts.secure,
      sameSite: opts.sameSite,
    });

    res.json({ message: 'Logged out successfully.' });
  } catch (err) {
    res.status(500).json({ message: 'Logout failed.' });
  }
});

/**
 * POST /api/auth/change-password
 * Any logged-in user can change their own password.
 */
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword)
      return res.status(400).json({ message: 'Current password and new password are required.' });
    if (newPassword.length < 8)
      return res.status(400).json({ message: 'New password must be at least 8 characters.' });
    if (currentPassword === newPassword)
      return res.status(400).json({ message: 'New password must be different from your current password.' });

    const user = await User.findById(req.user.id).select('+password');
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const isCorrect = await user.comparePassword(currentPassword);
    if (!isCorrect)
      return res.status(401).json({ message: 'Current password is incorrect.' });

    user.password     = newPassword; // pre('save') hook hashes automatically
    user.refreshToken = null;        // invalidate all other sessions
    await user.save();

    res.json({ message: 'Password changed successfully. Please log in again on other devices.' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to change password.', error: err.message });
  }
});

/**
 * POST /api/auth/forgot-password
 * Public. Sends a reset link to the user's email.
 * Always responds 200 — never reveals if an email is registered.
 */
router.post('/forgot-password', async (req, res) => {
  const SAFE_RESPONSE = { message: 'If that email is registered, a reset link has been sent.' };

  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required.' });

    const user = await User.findOne({ email: email.toLowerCase().trim() });

    // Don't reveal whether the email exists
    if (!user) return res.json(SAFE_RESPONSE);

    const resetToken   = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    user.passwordResetToken   = resetToken;
    user.passwordResetExpires = resetExpires;
    await user.save();

    await sendPasswordResetEmail(user.email, resetToken, user.name, user.role === 'supplier');
    logger.info('Password reset email sent', { userId: user._id, email: user.email });

    res.json(SAFE_RESPONSE);
  } catch (err) {
    console.error('Forgot password error:', err);
    res.json({ message: 'If that email is registered, a reset link has been sent.' });
  }
});

/**
 * POST /api/auth/reset-password
 * Public. Validates token and sets the new password.
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword)
      return res.status(400).json({ message: 'Token and new password are required.' });
    if (newPassword.length < 8)
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });

    const user = await User.findOne({
      passwordResetToken:   token,
      passwordResetExpires: { $gt: new Date() },
    }).select('+password');

    if (!user)
      return res.status(400).json({
        message: 'This reset link is invalid or has expired. Please request a new one.'
      });

    user.password             = newPassword; // pre('save') hook hashes automatically
    user.passwordResetToken   = undefined;
    user.passwordResetExpires = undefined;
    user.refreshToken         = null;        // log out all active sessions
    await user.save();

    logger.info('Password reset complete', { userId: user._id, email: user.email });
    res.json({ message: 'Password reset successfully. You can now sign in with your new password.' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to reset password.', error: err.message });
  }
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────

/**
 * POST /api/auth/invite
 * Admin sends an invite email to a new employee.
 */
router.post('/invite', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const { email, inviteType } = req.body; // NEW — inviteType: 'employee' (default) | 'supplier'
    if (!email)
      return res.status(400).json({ message: 'Email address is required.' });

    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser)
      return res.status(409).json({
        message: `${email} already has an account (status: ${existingUser.status}).`
      });

    // Resend existing unused invite if still valid
    const existingInvite = await Invite.findOne({ email: normalizedEmail, used: false });
    if (existingInvite && new Date() < existingInvite.expiresAt) {
      await sendInviteEmail(normalizedEmail, existingInvite.token, req.user.name, inviteType);
      return res.json({ message: `Invite resent to ${email}.` });
    }

    const token  = crypto.randomBytes(32).toString('hex');
    const invite = new Invite({ email: normalizedEmail, token, invitedBy: req.user.id, inviteType: inviteType || 'employee' });
    await invite.save();

    await sendInviteEmail(normalizedEmail, token, req.user.name, inviteType);

    logger.info('Invite sent', { to: normalizedEmail, sentBy: req.user.id });
    res.status(201).json({ message: `Invite sent successfully to ${email}.` });
  } catch (err) {
    console.error('Invite Error:', err);
    if (err.code === 'EAUTH' || err.responseCode === 535) {
      return res.status(500).json({
        message: 'Email authentication failed. Check EMAIL_USER and EMAIL_PASS in your .env file.'
      });
    }
    res.status(500).json({ message: 'Failed to send invite.', error: err.message });
  }
});

/**
 * GET /api/auth/invites
 * Admin: View all pending (unused) invites.
 */
router.get('/invites', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const invites = await Invite.find({ used: false })
      .populate('invitedBy', 'name email')
      .sort({ createdAt: -1 });
    res.json(invites);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * DELETE /api/auth/invites/:id
 * Admin: Cancel / revoke a pending invite.
 */
router.delete('/invites/:id', authenticate, authorize(['admin']), async (req, res) => {
  try {
    await Invite.findByIdAndDelete(req.params.id);
    res.json({ message: 'Invite revoked.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * GET /api/auth/users
 */
router.get('/users', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * GET /api/auth/users/pending
 */
router.get('/users/pending', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const users = await User.find({ status: 'pending' }).sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * PATCH /api/auth/users/:id/approve
 */
router.patch('/users/:id/approve', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const { role } = req.body;
    const validRoles = ['admin', 'accounts', 'sales', 'inventory', 'courier', 'viewer', 'supplier'];
    if (!role || !validRoles.includes(role))
      return res.status(400).json({ message: `Role must be one of: ${validRoles.join(', ')}` });

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { status: 'active', role, approvedBy: req.user.id, approvedAt: new Date(), allowedRoutes: [] },
      { new: true }
    );
    if (!user) return res.status(404).json({ message: 'User not found.' });
    logger.info('User approved', { targetUserId: user._id, role, approvedBy: req.user.id });
    res.json({ message: `${user.name} approved as ${role}.`, user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * PATCH /api/auth/users/:id/role
 */
router.patch('/users/:id/role', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const { role } = req.body;
    const validRoles = ['admin', 'accounts', 'sales', 'inventory', 'courier', 'viewer', 'supplier'];
    if (!role || !validRoles.includes(role))
      return res.status(400).json({ message: `Role must be one of: ${validRoles.join(', ')}` });
    if (req.params.id === req.user.id && role !== 'admin')
      return res.status(400).json({ message: 'You cannot change your own admin role.' });

    const user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true });
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json({ message: `${user.name}'s role updated to ${role}.`, user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * PATCH /api/auth/users/:id/routes
 * Set the exact list of frontend routes this user can access.
 */
router.patch('/users/:id/routes', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const { allowedRoutes } = req.body;
    if (!Array.isArray(allowedRoutes))
      return res.status(400).json({ message: 'allowedRoutes must be an array of strings.' });

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { allowedRoutes },
      { new: true }
    );
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json({ message: 'Route access updated.', user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * PATCH /api/auth/users/:id/suspend
 */
router.patch('/users/:id/suspend', authenticate, authorize(['admin']), async (req, res) => {
  try {
    if (req.params.id === req.user.id)
      return res.status(400).json({ message: 'You cannot suspend your own account.' });

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { status: 'suspended', refreshToken: null },
      { new: true }
    );
    if (!user) return res.status(404).json({ message: 'User not found.' });
    logger.info('User suspended', { targetUserId: user._id, suspendedBy: req.user.id });
    res.json({ message: `${user.name} suspended.`, user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * PATCH /api/auth/users/:id/reactivate
 */
router.patch('/users/:id/reactivate', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { status: 'active' }, { new: true });
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json({ message: `${user.name} reactivated.`, user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /api/auth/users/:id/reset-password
 * Admin force-resets another user's password (e.g. locked-out employee).
 */
router.post('/users/:id/reset-password', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8)
      return res.status(400).json({ message: 'New password must be at least 8 characters.' });

    const user = await User.findById(req.params.id).select('+password');
    if (!user) return res.status(404).json({ message: 'User not found.' });

    user.password     = newPassword;
    user.refreshToken = null; // force fresh login
    await user.save();

    res.json({ message: `Password reset for ${user.name}. They must log in with the new password.` });
  } catch (err) {
    res.status(500).json({ message: 'Failed to reset password.', error: err.message });
  }
});

/**
 * DELETE /api/auth/users/:id
 */
router.delete('/users/:id', authenticate, authorize(['admin']), async (req, res) => {
  try {
    if (req.params.id === req.user.id)
      return res.status(400).json({ message: 'You cannot delete your own account.' });

    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    logger.info('User deleted', { targetUserId: user._id, deletedBy: req.user.id });
    res.json({ message: `${user.name} deleted.` });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;