const mongoose = require('mongoose');

/**
 * Stores pending email invites.
 * Once used (registered), the token is deleted.
 * Expired tokens are cleaned up by TTL index automatically.
 */
const inviteSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
  },
  token: {
    type: String,
    required: true,
    unique: true,
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  inviteType: {
    type: String,
    enum: ['employee', 'supplier'],
    default: 'employee',
  },
  // MongoDB TTL index: automatically deletes this document after 48 hours
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 48 * 60 * 60 * 1000), // 48 hours
    index: { expires: 0 }, // TTL index — expires at the value of this field
  },
  used: {
    type: Boolean,
    default: false,
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('Invite', inviteSchema);