const { createClient } = require('redis');

let redisClient = null;

async function connectToRedis() {
    if (redisClient) {
        return redisClient;
    }

    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    
    try {
        redisClient = createClient({
            url: redisUrl,
        });

        redisClient.on('error', (err) => {
            console.error('Redis Client Error:', err);
        });

        redisClient.on('connect', () => {
            console.log('Redis client connected');
        });

        redisClient.on('ready', () => {
            console.log('Redis client ready');
        });

        redisClient.on('reconnecting', () => {
            console.log('Redis client reconnecting');
        });

        await redisClient.connect();
        console.log('Connected to Redis successfully');
        return redisClient;
    } catch (error) {
        console.error('Failed to connect to Redis:', error);
        throw error;
    }
}

function getRedisClient() {
    if (!redisClient) {
        throw new Error('Redis client not initialized. Call connectToRedis() first.');
    }
    return redisClient;
}

async function disconnectRedis() {
    if (redisClient) {
        await redisClient.quit();
        redisClient = null;
        console.log('Disconnected from Redis');
    }
}

module.exports = {
    connectToRedis,
    getRedisClient,
    disconnectRedis,
};
