/**
 * Shared Redis client used by all queue and rate-limit services.
 * Gracefully degrades: if Redis is unavailable the app continues
 * to run without queueing (all queues fall back to inline execution).
 */

const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let client = null;
let connected = false;

async function getRedisClient() {
    if (client && connected) return client;

    client = createClient({
        url: REDIS_URL,
        socket: {
            reconnectStrategy: (retries) => {
                if (retries >= 3) {
                    console.warn('[Redis] Max reconnect attempts reached — running without Redis');
                    return false;
                }
                return Math.min(retries * 500, 2000);
            },
        },
    });

    client.on('connect', () => { connected = true; console.log('[Redis] Connected ✓'); });
    client.on('error', (err) => { connected = false; console.warn('[Redis] Error:', err.message); });
    client.on('end', () => { connected = false; console.warn('[Redis] Connection closed'); });

    try {
        await client.connect();
    } catch (err) {
        console.warn('[Redis] Failed to connect — queue/rate-limit features disabled:', err.message);
        client = null;
        connected = false;
    }

    return client;
}

function isConnected() {
    return connected && client !== null;
}

/**
 * Store a value in Redis with optional TTL.
 * Safe to call even when Redis is down (returns false).
 */
async function redisSet(key, value, ttlSeconds = null) {
    if (!isConnected()) return false;
    try {
        const c = await getRedisClient();
        const opts = ttlSeconds ? { EX: ttlSeconds } : {};
        await c.set(key, JSON.stringify(value), opts);
        return true;
    } catch { return false; }
}

/**
 * Get a JSON value from Redis.
 * Returns null if key missing or Redis is down.
 */
async function redisGet(key) {
    if (!isConnected()) return null;
    try {
        const c = await getRedisClient();
        const raw = await c.get(key);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

module.exports = { getRedisClient, isConnected, redisSet, redisGet };
