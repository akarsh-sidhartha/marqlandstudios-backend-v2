const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Full name is required'],
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email address'],
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [8, 'Password must be at least 8 characters'],
    select: false, // Never returned in queries by default
  },
  passwordResetToken: { type: String, default: undefined },
  passwordResetExpires: { type: Date, default: undefined },
  role: {
    // CHANGED: added 'supplier' — used by the Partner Portal. Suppliers are
    // intentionally NOT given any of the internal app's default route access;
    // see authMiddleware.js ROUTE_PERMISSIONS and authRoutes.js approve logic.
    type: String,
    enum: ['admin', 'accounts', 'sales', 'inventory', 'courier', 'viewer', 'supplier'],
    default: 'viewer', // Admin assigns the actual role on approval
  },
  status: {
    type: String,
    enum: ['pending', 'active', 'suspended'],
    default: 'pending', // All new registrations start as pending
  },
  // NEW — only meaningful when role === 'supplier'. Lets suppliers see a
  // branded portal ("Welcome, Acme Fittings") and lets the OneDrive video
  // path resolver build "supplier folder -> <supplierCompanyName>".
  supplierCompanyName: {
    type: String,
    default: '',
    trim: true,
  },
  // Tracks which admin approved this user
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  approvedAt: {
    type: Date,
    default: null,
  },
  lastLogin: {
    type: Date,
    default: null,
  },
  // Refresh token stored server-side for invalidation support
  refreshToken: {
    type: String,
    default: null,
    select: false,
  },
  // Per-user route access overrides. If empty, role-based defaults apply.
  allowedRoutes: {
    type: [String],
    default: [],
  },
}, {
  timestamps: true, // createdAt, updatedAt
});

// Hash password before saving
userSchema.pre('save', async function () {
  // Only hash if the password field was modified
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

// Instance method to compare password
userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Never expose password or refreshToken in JSON output
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshToken;
  return obj;
};

module.exports = mongoose.model('User', userSchema);