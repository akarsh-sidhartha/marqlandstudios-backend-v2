'use strict';
/**
 * backend/routes/clientRoutes.js
 * Mounted at /api/clients
 *
 *   GET    /               — list all clients
 *   POST   /               — create client
 *   GET    /lookup?name=X  — find client by company name (MUST be before /:id)
 *   PUT    /:id            — full update
 *   PATCH  /:id/add-contact — append a contact without replacing all contacts
 *   DELETE /:id            — delete client
 */

const express = require('express');
const router  = express.Router();
const Client  = require('../models/Client');
const logger  = require('../utils/logger').child({ module: 'clientRoutes' });

// ─── GET all clients ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const clients = await Client.find().sort({ companyName: 1 }).lean();
    logger.debug('Clients listed', { count: clients.length, userId: req.user?.id });
    res.json(clients);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Lookup by company name ───────────────────────────────────────────────────
// IMPORTANT: Must be registered BEFORE /:id — otherwise Express matches
// the literal string "lookup" as an :id param and hits the wrong handler.
router.get('/lookup', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) return res.status(400).json({ message: 'name query param required' });

    // Escape regex special chars, then match full company name case-insensitively
    const escaped = name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    const client  = await Client.findOne({
      companyName: { $regex: new RegExp(`^${escaped}$`, 'i') },
    }).lean();

    res.json({ found: !!client, client: client || null });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Create client ────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const client = new Client(req.body);
    await client.save();
    logger.info('Client created', { clientId: client._id, name: client.companyName, userId: req.user?.id });
    res.status(201).json(client);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ─── Full update ──────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const client = await Client.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!client) return res.status(404).json({ message: 'Client not found.' });
    logger.info('Client updated', { clientId: client._id, userId: req.user?.id });
    res.json(client);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ─── Add a single contact ─────────────────────────────────────────────────────
router.patch('/:id/add-contact', async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Contact name is required.' });

    const client = await Client.findById(req.params.id);
    if (!client) return res.status(404).json({ message: 'Client not found.' });

    // Avoid duplicate — check by name (case-insensitive)
    const alreadyExists = client.contacts.some(
      c => c.name?.toLowerCase() === name.trim().toLowerCase()
    );
    if (!alreadyExists) {
      client.contacts.push({
        name:  name.trim(),
        phone: phone?.trim()  || '',
        email: email?.trim()  || '',
      });
      await client.save();
    }

    res.json(client);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Move contact from one client to another ──────────────────────────────────
// Body: { fromClientId, contactName, toClientId, newEmail? }
// Removes the contact from the source client and upserts into the destination.
router.patch('/move-contact', async (req, res) => {
  try {
    const { fromClientId, contactName, toClientId, newEmail } = req.body;
    if (!fromClientId || !contactName || !toClientId) {
      return res.status(400).json({ message: 'fromClientId, contactName, and toClientId are required.' });
    }
    if (fromClientId === toClientId) {
      return res.status(400).json({ message: 'Source and destination clients must be different.' });
    }

    const [fromClient, toClient] = await Promise.all([
      Client.findById(fromClientId),
      Client.findById(toClientId),
    ]);
    if (!fromClient) return res.status(404).json({ message: 'Source client not found.' });
    if (!toClient)   return res.status(404).json({ message: 'Destination client not found.' });

    // Find contact in source
    const contactIndex = fromClient.contacts.findIndex(
      c => c.name?.toLowerCase() === contactName.trim().toLowerCase()
    );
    if (contactIndex === -1) {
      return res.status(404).json({ message: 'Contact not found in source client.' });
    }

    // Pull the contact out and optionally update email
    const [contact] = fromClient.contacts.splice(contactIndex, 1);
    if (newEmail !== undefined && newEmail !== null) {
      contact.email = newEmail.trim();
    }

    // Avoid duplicates in destination (match by name, case-insensitive)
    const alreadyInDest = toClient.contacts.some(
      c => c.name?.toLowerCase() === contact.name?.toLowerCase()
    );
    if (!alreadyInDest) {
      toClient.contacts.push({ name: contact.name, phone: contact.phone, email: contact.email });
    }

    await Promise.all([fromClient.save(), toClient.save()]);

    logger.info('Contact moved', {
      contact: contact.name,
      from: fromClient.companyName,
      to: toClient.companyName,
      userId: req.user?.id,
    });

    res.json({ fromClient, toClient });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Delete client ────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const client = await Client.findByIdAndDelete(req.params.id);
    if (!client) return res.status(404).json({ message: 'Client not found.' });
    logger.info('Client deleted', { clientId: req.params.id, name: client.companyName, userId: req.user?.id });
    res.json({ message: 'Client deleted.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;