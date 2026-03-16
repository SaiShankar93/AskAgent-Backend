/**
 * Daily token budget limiter.
 *
 * Tracks how many LLM tokens a user (or IP) has consumed today and
 * blocks requests once they exceed the configured daily limit.
 *
 * Storage strategy:
 *   Redis key:  `tkn:<key>:<YYYY-MM-DD>`   (e.g. tkn:user:abc123:2026-03-16)
 *   Value:      integer — tokens used so far today
 *   TTL:        seconds remaining until UTC midnight  (auto-expire daily)
 *
 * Falls back to an in-memory map when Redis is unavailable so the app
 * never crashes — the limit is just enforced less durably.
 */

const { getRedisClient, isConnected } = require('./redisClient');

// ─── In-memory fallback ───────────────────────────────────────────────────
// { redisKey -> { count, date } }
const memStore = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────

/** UTC date string "YYYY-MM-DD" — used as part of the Redis key. */
function todayUTC() {
    return new Date().toISOString().slice(0, 10);
}

/** Seconds remaining until next UTC midnight. */
function secondsUntilMidnight() {
    const now       = new Date();
    const midnight  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return Math.ceil((midnight - now) / 1000);
}

function redisKey(key) {
    return `tkn:${key}:${todayUTC()}`;
}

// ─── Core API ─────────────────────────────────────────────────────────────

/**
 * Check whether `key` is still within its daily token budget.
 *
 * @param {string} key          - Unique identifier (e.g. `user:${userId}` or `ip:${ip}`)
 * @param {number} dailyLimit   - Max tokens allowed per day
 * @returns {Promise<{
 *   allowed:         boolean,
 *   used:            number,   // tokens used today so far
 *   limit:           number,
 *   remaining:       number,   // tokens left before hitting the ceiling
 *   resetAtMs:       number,   // epoch ms of next reset (UTC midnight)
 *   resetInSeconds:  number,
 * }>}
 */
async function checkTokenBudget(key, dailyLimit) {
    const used       = await _getUsed(key);
    const ttl        = secondsUntilMidnight();
    const resetAtMs  = Date.now() + ttl * 1000;

    return {
        allowed:        used < dailyLimit,
        used,
        limit:          dailyLimit,
        remaining:      Math.max(0, dailyLimit - used),
        resetAtMs,
        resetInSeconds: ttl,
    };
}

/**
 * Record token usage AFTER a successful LLM call.
 * Safe to call fire-and-forget (.catch(() => {})).
 *
 * @param {string} key
 * @param {number} tokens  - Tokens consumed by this request
 */
async function recordTokenUsage(key, tokens) {
    if (!tokens || tokens <= 0) return;

    if (isConnected()) {
        return _redisIncr(key, tokens);
    }
    return _memIncr(key, tokens);
}

// ─── Redis implementation ─────────────────────────────────────────────────

async function _getUsed(key) {
    if (isConnected()) {
        try {
            const client = await getRedisClient();
            const raw    = await client.get(redisKey(key));
            return raw ? parseInt(raw, 10) : 0;
        } catch {
            return _memGetUsed(key);
        }
    }
    return _memGetUsed(key);
}

async function _redisIncr(key, tokens) {
    try {
        const client = await getRedisClient();
        const rk     = redisKey(key);
        const multi  = client.multi();
        multi.incrBy(rk, tokens);
        multi.expire(rk, secondsUntilMidnight() + 60); // tiny buffer past midnight
        await multi.exec();
    } catch (err) {
        console.warn('[TokenLimiter] Redis incr failed:', err.message);
        _memIncr(key, tokens);
    }
}

// ─── In-memory fallback ───────────────────────────────────────────────────

function _memGetUsed(key) {
    const entry = memStore.get(key);
    if (!entry || entry.date !== todayUTC()) return 0;
    return entry.count;
}

function _memIncr(key, tokens) {
    const today = todayUTC();
    const entry = memStore.get(key);
    if (!entry || entry.date !== today) {
        memStore.set(key, { count: tokens, date: today });
    } else {
        entry.count += tokens;
    }

    // Prune stale keys (different date) to avoid unbounded growth
    if (memStore.size > 5000) {
        for (const [k, v] of memStore) {
            if (v.date !== today) memStore.delete(k);
        }
    }
}

module.exports = { checkTokenBudget, recordTokenUsage };
