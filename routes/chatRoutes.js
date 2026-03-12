const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const chatController = require('../controllers/chatController');

// Get chat history for an agent
router.get('/:agentId/history', requireAuth, chatController.getHistory);

// Send a message with RAG response (queue-backed)
router.post('/send', requireAuth, chatController.sendMessage);

// Widget endpoint (no auth required for public embedding)
router.post('/widget', chatController.widgetMessage);

// Get RAG context for a query (for debugging/testing)
router.post('/context', requireAuth, chatController.getContext);

// Test LLM service
router.get('/test-llm', requireAuth, chatController.testLLM);

// Queue + Redis health stats
router.get('/queue-stats', requireAuth, chatController.queueStats);

module.exports = router;

