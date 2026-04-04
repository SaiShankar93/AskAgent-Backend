// ⚠️ dotenv MUST be first — services read process.env at require-time.
require('dotenv').config();

// mem0ai/oss reports to PostHog unless MEM0_TELEMETRY is the string "false". On many VPS
// setups outbound HTTPS to PostHog times out (ETIMEDOUT) and logs "Telemetry event capture failed".
// Default off; set MEM0_TELEMETRY=true to opt in. Must run before any require('mem0ai/...').
if (process.env.MEM0_TELEMETRY == null || process.env.MEM0_TELEMETRY === '') {
    process.env.MEM0_TELEMETRY = 'false';
}

const http    = require('http');
const express = require('express');
const cors    = require('cors');
const connectToDatabase  = require('./config/mongo');
const socketService      = require('./services/socketService');
const { getRedisClient } = require('./redis_services/redisClient');
const { initChatQueue,  shutdownChatQueue  } = require('./redis_services/chatQueue');
const { initAgentQueue, shutdownAgentQueue } = require('./redis_services/agentQueue');

const agentRoutes = require('./routes/agentRoutes');
const chatRoutes  = require('./routes/chatRoutes');

const app    = express();
const server = http.createServer(app);   // raw http.Server so socket.io can attach

app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json());

app.use('/api/agents', agentRoutes);
app.use('/api/chat',   chatRoutes);

const PORT = process.env.PORT || 5000;

(async () => {
    try {
        // 1. MongoDB
        await connectToDatabase();
        console.log('[Boot] MongoDB connected ✓');

        // 2. Socket.io  (must come before listening so clients can connect)
        socketService.init(server);

        // 3. Redis + BullMQ workers
        try {
            await getRedisClient();
            initChatQueue();
            initAgentQueue();
            console.log('[Boot] Redis queues initialised ✓');
        } catch (redisErr) {
            console.warn('[Boot] Redis unavailable — running inline (no queue):', redisErr.message);
        }

        // 4. Start listening
        server.listen(PORT, () => {
            console.log(`[Boot] AskAgent server running on port ${PORT} ✓`);
        });

        // 5. Graceful shutdown
        const gracefulShutdown = async (signal) => {
            console.log(`\n[Shutdown] ${signal} received...`);
            server.close(async () => {
                await Promise.allSettled([shutdownChatQueue(), shutdownAgentQueue()]);
                console.log('[Shutdown] Done');
                process.exit(0);
            });
            setTimeout(() => { console.error('[Shutdown] Forced exit'); process.exit(1); }, 15_000);
        };

        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

    } catch (err) {
        console.error('[Boot] Fatal startup error:', err);
        process.exit(1);
    }
})();
