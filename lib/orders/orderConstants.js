'use strict';
/**
 * lib/orders/orderConstants.js
 *
 * Single source of truth for order vocabularies. The model enums, the zod
 * schemas and the admin UI (via GET /api/v2/orders/meta) all read from
 * here, so adding a procurement stage is a one-line change.
 */

const ORDER_STATUSES = ['inquiry', 'ongoing', 'completed'];
const ORDER_TYPES = ['product', 'offsite'];
const FILE_CATEGORIES = ['attachment', 'screenshot', 'quote'];

// In the order goods physically move through, so the UI can show progress.
const PROCUREMENT_STATUSES = [
  { value: 'pending',          label: 'Yet to source',        tone: 'slate'   },
  { value: 'enquired',         label: 'Enquired with vendor', tone: 'blue'    },
  { value: 'blocked',          label: 'Stock blocked',        tone: 'indigo'  },
  { value: 'payment_made',     label: 'Payment made',         tone: 'violet'  },
  { value: 'vendor_shipped',   label: 'Shipped by vendor',    tone: 'amber'   },
  { value: 'in_branding',      label: 'In branding',          tone: 'orange'  },
  { value: 'ready_at_office',  label: 'Ready at office',      tone: 'teal'    },
  { value: 'dispatched',       label: 'Dispatched to client', tone: 'emerald' },
];
const PROCUREMENT_STATUS_VALUES = PROCUREMENT_STATUSES.map((s) => s.value);

// Stages at which an item counts as "ready" in the row-level progress badge.
const PROCUREMENT_READY = new Set(['ready_at_office', 'dispatched']);

module.exports = {
  ORDER_STATUSES,
  ORDER_TYPES,
  FILE_CATEGORIES,
  PROCUREMENT_STATUSES,
  PROCUREMENT_STATUS_VALUES,
  PROCUREMENT_READY,
};
