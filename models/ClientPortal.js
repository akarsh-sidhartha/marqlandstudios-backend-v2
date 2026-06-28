"use strict";
/**
 * backend/models/ClientPortal.js
 *
 * One document per order. Stores the curated items the team wants to show
 * the client, plus the two-way chat thread.
 *
 * slug    = URL-safe version of refNumber  e.g. "inq-25-26-002"
 * type    = "product" | "offsite"
 * status  = "active" | "completed"
 */

const mongoose = require("mongoose");

// ── File attachment in a message ─────────────────────────────────────────────
const msgAttachmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    url: { type: String, required: true }, // /uploads/... path
    mimeType: { type: String, default: "application/octet-stream" },
    size: { type: Number, default: 0 },
  },
  { _id: false },
);

// ── Chat message ──────────────────────────────────────────────────────────────
const messageSchema = new mongoose.Schema(
  {
    sender: { type: String, enum: ["team", "client"], required: true },
    senderName: { type: String, default: "Team" },
    text: { type: String, default: "" },
    attachments: [msgAttachmentSchema],
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

// ── Product item (gifting/merchandise) ────────────────────────────────────────
const productItemSchema = new mongoose.Schema(
  {
    productId: { type: String },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    // Additional gallery images (different angles, lifestyle shots)
    additionalImages: { type: [String], default: [] },
    // YouTube or brand video URL — embedded in client portal card
    videoUrl: { type: String, default: "" },
    price: { type: Number, default: 0 },
    category: { type: String, default: "" },
    subCategory: { type: String, default: "" },
    note: { type: String, default: "" },
    order: { type: Number, default: 0 },
  },
  { _id: true },
);

// ── Offsite item (property) ────────────────────────────────────────────────────

// Day package inside an offsite portal item
const portalDayPkgSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    activities: { type: String, default: "" },
    sellingPrice: { type: Number, default: 0 },
  },
  { _id: false },
);

// Room category carried from Property into the portal snapshot
// (selling prices only — no purchase data sent to client)
const portalRoomCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true }, // e.g. "Premium"
    singlePrice: { type: Number, default: 0 },
    doublePrice: { type: Number, default: 0 },
    triplePrice: { type: Number, default: 0 },
  },
  { _id: true },
);

// Adhoc add-on carried from Property into the portal snapshot
const portalAddonSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    sellingPrice: { type: Number, default: 0 },
    // When true, sellingPrice is per guest and is multiplied by headcount in the calculator
    perPerson: { type: Boolean, default: false },
  },
  { _id: false },
);

// Property-level attachment shown to client (itinerary PDFs, brochures)
const portalAttachmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    url: { type: String, required: true },
    mimeType: { type: String, default: "application/octet-stream" },
    size: { type: Number, default: 0 },
  },
  { _id: false },
);

const offsiteItemSchema = new mongoose.Schema(
  {
    propertyId: { type: String },
    name: { type: String, required: true },
    location: { type: String, default: "" }, // "Lonavala, Maharashtra"
    imageUrl: { type: String, default: "" },
    website: { type: String, default: "" },

    // YouTube video URL — embedded player in client portal
    youtubeUrl: { type: String, default: "" },

    details: { type: String, default: "" },
    type: { type: String, default: "Night Stay" }, // Night Stay | Day Outing

    // Night Stay room pricing (selling prices only — no purchase data sent to client)
    singlePrice: { type: Number, default: 0 },
    doublePrice: { type: Number, default: 0 },
    triplePrice: { type: Number, default: 0 },
    quadPrice: { type: Number, default: 0 }, // NEW — quad occupancy

    // Day Outing flat price
    packagePrice: { type: Number, default: 0 },

    // Standard add-ons (selling prices)
    djCost: { type: Number, default: 0 },
    licenseFeeDJ: { type: Number, default: 0 },
    cocktailSnacks: { type: Number, default: 0 },
    banquetHall: { type: Number, default: 0 },

    // Per-person flags for standard add-ons (true = multiply by guest count in calculator)
    djCostPerPerson: { type: Boolean, default: false },
    licenseFeeDJPerPerson: { type: Boolean, default: false },
    cocktailSnacksPerPerson: { type: Boolean, default: true }, // default on — cocktails/snacks are always per head
    banquetHallPerPerson: { type: Boolean, default: false },

    // Configurable room categories (e.g. "Premium", "Luxury") — each with single/double/triple
    roomCategories: [portalRoomCategorySchema],

    // Dynamic adhoc add-ons
    adhocAddons: [portalAddonSchema],

    // Property attachments visible to client
    attachments: [portalAttachmentSchema],

    dayPackages: [portalDayPkgSchema],
    note: { type: String, default: "" },
    order: { type: Number, default: 0 },
  },
  { _id: true },
);

// ── Main portal schema ────────────────────────────────────────────────────────
const clientPortalSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OrderInquiry",
      required: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    type: { type: String, enum: ["product", "offsite"], required: true },
    orderRef: { type: String },
    clientName: { type: String },
    orderPlacedBy: { type: String },
    clientEmail: { type: String },
    title: { type: String },
    teamNote: { type: String, default: "" },

    productItems: [productItemSchema],
    offsiteItems: [offsiteItemSchema],

    // ── Combo bundles ─────────────────────────────────────────────────────────
    // Each entry is a snapshot of a generated Combo, pinned at portal-creation
    // time so changes to the master Combo record don't silently alter what the
    // client already saw. comboId holds the source Combo._id for reference.
    comboItems: [{
      comboId:         { type: String },                        // source Combo._id (string ref)
      label:           { type: String, default: '' },
      totalPrice:      { type: Number, default: 0 },
      collageImageUrl: { type: String, default: '' },           // pre-generated hero image
      items: [{                                                  // snapshot of each product
        productId:        { type: String },
        name:             { type: String, required: true },
        description:      { type: String, default: '' },
        imageUrl:         { type: String, default: '' },
        additionalImages: { type: [String], default: [] },
        videoUrl:         { type: String, default: '' },
        price:            { type: Number, default: 0 },
        category:         { type: String, default: '' },
        subCategory:      { type: String, default: '' },
        order:            { type: Number, default: 0 },
      }],
      note:  { type: String, default: '' },
      order: { type: Number, default: 0 },
    }],

    messages: [messageSchema],

    status: { type: String, enum: ["active", "completed"], default: "active" },
    completedAt: { type: Date },

    lastViewedAt: { type: Date },
    viewCount: { type: Number, default: 0 },

    reviewLink: { type: String, default: "" },

    // Client's shortlisted item IDs — persisted so they survive page refresh
    shortlistedIds: { type: [String], default: [] },

    // Offsite cost calculator state — persisted so team pre-set and client edits both survive
    // Shape: { [itemId]: { pax, nights, single, double, triple, quad, addons: { [key]: bool }, disabledAddons: { [key]: bool } } }
    calculatorState: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("ClientPortal", clientPortalSchema);