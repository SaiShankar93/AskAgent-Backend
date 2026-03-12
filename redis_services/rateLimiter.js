/**
 * Redis-backed sliding-window rate limiter.
 * Falls back to an in-memory implementation when Redis is unavailable.
 */

const { getRedisClient, isConnected } = require('./redisClient');

// In-memory fallback store: { key -> [timestamps] }
const memoryStore = new Map();

const DEFAULTS = {
    windowMs: 60_000,
    max:      30,
};

/**
 * Check whether a key is within its rate limit.
 * @param {string} key
 * @param {{ windowMs?: number, max?: number }} options
 * @returns {Promise<{ allowed: boolean, remaining: number, resetMs: number }>}
 */
async function checkRateLimit(key, options = {}) {
    const windowMs = options.windowMs ?? DEFAULTS.windowMs;
    const max      = options.max      ?? DEFAULTS.max;
    const now      = Date.now();

    if (isConnected()) {
        return _redisRateLimit(key, windowMs, max, now);
    }
    return _memoryRateLimit(key, windowMs, max, now);
}

// ─── Redis sliding window (sorted set) ───────────────────────────────────

async function _redisRateLimit(key, windowMs, max, now) {
    const redisKey  = `rl:${key}`;
    const windowSec = Math.ceil(windowMs / 1000);
    const cutoff    = now - windowMs;

    try {
        const client = await getRedisClient();
        const multi  = client.multi();
        multi.zRemRangeByScore(redisKey, '-inf', cutoff.toString());
        multi.zAdd(redisKey, [{ score: now, value: `${now}-${Math.random()}` }]);
        multi.zCard(redisKey);
        multi.expire(redisKey, windowSec + 1);
        const results = await multi.exec();

        const count     = results[2];
        const allowed   = count <= max;
        const remaining = Math.max(0, max - count);

        return { allowed, remaining, resetMs: now + windowMs };
    } catch {
        return _memoryRateLimit(key, windowMs, max, now);
    }
}

// ─── In-memory fallback ───────────────────────────────────────────────────

function _memoryRateLimit(key, windowMs, max, now) {
    const cutoff = now - windowMs;

    if (!memoryStore.has(key)) memoryStore.set(key, []);
    const timestamps = memoryStore.get(key).filter(t => t > cutoff);
    timestamps.push(now);
    memoryStore.set(key, timestamps);

    // Prune ghost keys periodically
    if (memoryStore.size > 1000) {
        for (const [k, ts] of memoryStore) {
            if (!ts.length || ts[ts.length - 1] < cutoff) memoryStore.delete(k);
        }
    }

    const count     = timestamps.length;
    const allowed   = count <= max;
    const remaining = Math.max(0, max - count);

    return { allowed, remaining, resetMs: now + windowMs };
}

module.exports = { checkRateLimit };
