const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const connectToDatabase  = require('./config/mongo');
const { connectToRedis, disconnectRedis } = require('./config/redis');
const messageWorker = require('./services/messageWorker');

dotenv.config();

const app = express();

app.use(cors({
    origin: "*",
    credentials: true,
}));

app.use(express.json());

// Load routes
const agentRoutes = require('./routes/agentRoutes');
const chatRoutes = require('./routes/chatRoutes');

app.use('/api/agents', agentRoutes);
app.use('/api/chat', chatRoutes);

const PORT = process.env.PORT || 5000;

// Initialize MongoDB and Redis, then start server and worker
(async () => {
    try {
        // Connect to MongoDB
        await connectToDatabase();
        
        // Connect to Redis
        await connectToRedis();
        
        // Start the message worker
        messageWorker.start();
        console.log('Message worker started successfully');
        
        app.listen(PORT, () => {
            console.log(`AskAgent backend running on port ${PORT}`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
})();

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM signal received: closing HTTP server');
    messageWorker.stop();
    await disconnectRedis();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT signal received: closing HTTP server');
    messageWorker.stop();
    await disconnectRedis();
    process.exit(0);
});
