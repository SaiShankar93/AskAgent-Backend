const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const agentController = require('../controllers/agentController');
const upload = require('../services/multerService');

// Get all agents for the authenticated user
router.get('/', requireAuth, agentController.getAgents);

// Get a single agent by ID
router.get('/:id', requireAuth, agentController.getAgentById);

// Create agent from website URL
router.post('/scrape-website', requireAuth, agentController.createAgentFromWebsite);

// Create agent from document upload
router.post('/upload-document', requireAuth, upload.single('document'), agentController.uploadDocument);

// Delete an agent
router.delete('/:id', requireAuth, agentController.deleteAgent);

module.exports = router;
