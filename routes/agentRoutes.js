const express  = require('express');
const router   = express.Router();
const { requireAuth } = require('../middleware/auth');
const agentController = require('../controllers/agentController');
const upload   = require('../services/multerService');

// ─── Read ──────────────────────────────────────────────────────────────────
router.get('/',    requireAuth, agentController.getAgents);
router.get('/:id', requireAuth, agentController.getAgentById);

// ─── Ingestion progress polling ────────────────────────────────────────────
// Poll this after creating an agent to track pipeline progress.
router.get('/:id/progress', requireAuth, agentController.getIngestionProgress);

// ─── Create ────────────────────────────────────────────────────────────────
// Returns 202 immediately; processing is handled by the BullMQ agent queue.
router.post('/scrape-website',  requireAuth, agentController.createAgentFromWebsite);
router.post('/upload-document', requireAuth, upload.single('document'), agentController.uploadDocument);

// ─── Update ────────────────────────────────────────────────────────────────
router.post('/:id/add-context', requireAuth, upload.single('document'), agentController.addContext);

// ─── Delete ────────────────────────────────────────────────────────────────
router.delete('/:id', requireAuth, agentController.deleteAgent);

// ─── Ops / observability ──────────────────────────────────────────────────
router.get('/ops/queue-stats', requireAuth, agentController.agentQueueStats);

module.exports = router;
