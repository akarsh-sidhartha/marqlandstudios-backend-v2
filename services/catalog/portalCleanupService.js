'use strict';
/**
 * services/catalog/portalCleanupService.js
 *
 * When a catalogue product is deleted, it must disappear from every client
 * portal it was added to. Portal items are snapshots (name, description,
 * price, video link…) taken when the product was added to an order, so
 * without this the portal kept showing the deleted product's details and
 * video — only its image broke, because the image file itself was deleted.
 *
 * removeProductsFromPortals(productIds) removes, in every portal:
 *   - product items whose productId is one of the deleted products
 *   - those products inside combo bundles (team combos store the Product id,
 *     client-built hampers store the portal item _id); a combo's total is
 *     recalculated and a combo left with no items is removed
 *   - the removed items from the client's shortlist and from the saved
 *     calculator state (team price overrides)
 *
 * Custom portal items (no productId) are never touched.
 */
const mongoose = require('mongoose');
const ClientPortal = require('../../models/ClientPortal');
const logger = require('../../utils/logger').child({ module: 'portalCleanupService' });

const removeProductsFromPortals = async (productIds) => {
  const ids = [...new Set((productIds || []).map(String).filter(Boolean))];
  if (!ids.length) return { portals: 0, items: 0 };
  const deleted = new Set(ids);

  const portals = await ClientPortal.find({
    $or: [{ 'productItems.productId': { $in: ids } }, { 'comboItems.items.productId': { $in: ids } }],
  });

  let itemCount = 0;
  for (const portal of portals) {
    const removedItemIds = new Set(
      (portal.productItems || []).filter((i) => deleted.has(String(i.productId || ''))).map((i) => String(i._id))
    );
    const isGone = (id) => deleted.has(String(id || '')) || removedItemIds.has(String(id || ''));

    portal.productItems = (portal.productItems || []).filter((i) => !removedItemIds.has(String(i._id)));

    portal.comboItems = (portal.comboItems || [])
      .map((combo) => {
        const items = (combo.items || []).filter((it) => !isGone(it.productId));
        if (items.length === (combo.items || []).length) return combo;
        itemCount += (combo.items || []).length - items.length;
        const plain = combo.toObject ? combo.toObject() : { ...combo };
        return { ...plain, items, totalPrice: items.reduce((sum, it) => sum + (Number(it.price) || 0), 0) };
      })
      .filter((combo) => (combo.items || []).length > 0);

    portal.shortlistedIds = (portal.shortlistedIds || []).filter((id) => !isGone(id));

    if (portal.calculatorState && typeof portal.calculatorState === 'object' && removedItemIds.size) {
      const next = { ...portal.calculatorState };
      removedItemIds.forEach((id) => { delete next[id]; });
      portal.calculatorState = next;
      portal.markModified('calculatorState');
    }

    itemCount += removedItemIds.size;
    // eslint-disable-next-line no-await-in-loop
    await portal.save();
  }

  if (portals.length) logger.info('Deleted products removed from client portals', { productIds: ids, portals: portals.length, items: itemCount });
  return { portals: portals.length, items: itemCount };
};

const isObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id || '')) && /^[0-9a-fA-F]{24}$/.test(String(id));

module.exports = { removeProductsFromPortals, isObjectId };
