// ⚠️ dotenv MUST be first — services like embeddingService and llmService
// instantiate OpenAI clients at require-time and need env vars to be set.
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const connectToDatabase  = require('./config/mongo');
const { getRedisClient } = require('./redis_services/redisClient');
const { initChatQueue,  shutdownChatQueue  } = require('./redis_services/chatQueue');
const { initAgentQueue, shutdownAgentQueue } = require('./redis_services/agentQueue');

const agentRoutes = require('./routes/agentRoutes');
const chatRoutes  = require('./routes/chatRoutes');

const app = express();

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

// ─── Routes ────────────────────────────────────────────────────────────────
app.use('/api/agents', agentRoutes);
app.use('/api/chat', chatRoutes);

const PORT = process.env.PORT || 5000;

(async () => {
    try {
        // 1. Connect to MongoDB
        await connectToDatabase();
        console.log('[Boot] MongoDB connected ✓');

        // 2. Connect to Redis and start BullMQ workers
        try {
            await getRedisClient(); // warns gracefully if Redis is down

            initChatQueue();   // chat messages (send + widget)
            initAgentQueue();  // agent ingestion (crawl / embed / store)

            console.log('[Boot] Redis queues initialised ✓');
        } catch (redisErr) {
            console.warn('[Boot] Redis unavailable — all operations will run inline (no queue):', redisErr.message);
        }

        // 3. Start HTTP server
        const server = app.listen(PORT, () => {
            console.log(`[Boot] AskAgent server running on port ${PORT} ✓`);
        });

        // 4. Graceful shutdown on SIGTERM / SIGINT (e.g. Docker stop, Ctrl-C)
        const gracefulShutdown = async (signal) => {
            console.log(`\n[Shutdown] ${signal} received — shutting down gracefully...`);
            server.close(async () => {
                await Promise.allSettled([shutdownChatQueue(), shutdownAgentQueue()]);
                console.log('[Shutdown] All queues drained. Bye!');
                process.exit(0);
            });

            // Force-exit after 15 s if something is stuck
            setTimeout(() => {
                console.error('[Shutdown] Forced exit after timeout');
                process.exit(1);
            }, 15_000);
        };

        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    } catch (err) {
        console.error('[Boot] Fatal startup error:', err);
        process.exit(1);
    }
})();
