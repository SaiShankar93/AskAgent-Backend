/**
 * BullMQ queue for chat message processing.
 *
 * Both /chat/send (authenticated) and /chat/widget (public) route through
 * this queue when Redis is available.  If Redis is down, the controller
 * falls back to running the pipeline inline — no crash, no downtime.
 *
 * Circular-dependency note:
 *   runChatPipeline lives in chatController, which imports this module.
 *   The worker therefore lazy-requires it on first job execution.
 */

const { Queue, Worker, QueueEvents } = require('bullmq');

const QUEUE_NAME = 'chat-processing';
const REDIS_CONN = {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT || 6379),
};

let chatQueue   = null;
let queueEvents = null;
let worker      = null;

// ─── Instances ────────────────────────────────────────────────────────────

function getQueue() {
    if (!chatQueue) {
        chatQueue = new Queue(QUEUE_NAME, {
            connection: REDIS_CONN,
            defaultJobOptions: {
                attempts:         2,
                backoff:          { type: 'exponential', delay: 1000 },
                removeOnComplete: { age: 300 },   // 5 min — enough for long-poll
                removeOnFail:     { age: 3600 },
            },
        });
        chatQueue.on('error', err => console.error('[ChatQueue] Error:', err.message));
    }
    return chatQueue;
}

function getQueueEvents() {
    if (!queueEvents) {
        queueEvents = new QueueEvents(QUEUE_NAME, { connection: REDIS_CONN });
        queueEvents.on('error', err => console.error('[ChatQueue] Events error:', err.message));
    }
    return queueEvents;
}

// ─── Init worker (called from index.js after Redis is confirmed up) ────────

function initChatQueue() {
    if (worker) return;

    const { runChatPipeline } = require('../controllers/chatController'); // lazy

    worker = new Worker(
        QUEUE_NAME,
        async (job) => {
            console.log(`[ChatQueue] Processing job ${job.id} (attempt ${job.attemptsMade + 1})`);
            return runChatPipeline(job.data);
        },
        {
            connection:  REDIS_CONN,
            concurrency: Number(process.env.CHAT_QUEUE_CONCURRENCY || 10),
            limiter: {
                max:      Number(process.env.CHAT_QUEUE_RATE_MAX || 50),
                duration: Number(process.env.CHAT_QUEUE_RATE_MS  || 1000),
            },
        }
    );

    worker.on('completed', job => console.log(`[ChatQueue] Job ${job.id} done in ${Date.now() - job.timestamp}ms`));
    worker.on('failed',   (job, err) => console.error(`[ChatQueue] Job ${job?.id} failed:`, err.message));
    worker.on('error',    err => console.error('[ChatQueue] Worker error:', err.message));

    getQueueEvents(); // warm up listener
    console.log(`[ChatQueue] Worker ready — concurrency: ${process.env.CHAT_QUEUE_CONCURRENCY || 10}`);
}

// ─── Enqueue + long-poll ──────────────────────────────────────────────────

/**
 * Enqueue a chat job and wait for its result (transparent to the HTTP client).
 * @param {object} payload   - JSON-serialisable job data
 * @param {number} timeoutMs - Max wait time before timeout error (default 60 s)
 */
async function enqueueChatJob(payload, timeoutMs = 60_000) {
    const queue  = getQueue();
    const events = getQueueEvents();

    const job = await queue.add('send-message', payload, {
        priority: payload.isWidget ? 2 : 1, // authenticated users get higher priority
    });

    console.log(`[ChatQueue] Enqueued job ${job.id} (agent: ${payload.agentId})`);
    return job.waitUntilFinished(events, timeoutMs);
}

// ─── Stats ────────────────────────────────────────────────────────────────

async function getChatQueueStats() {
    const q = getQueue();
    const [waiting, active, completed, failed, delayed] = await Promise.all([
        q.getWaitingCount(), q.getActiveCount(), q.getCompletedCount(),
        q.getFailedCount(),  q.getDelayedCount(),
    ]);
    return { waiting, active, completed, failed, delayed };
}

// ─── Shutdown ─────────────────────────────────────────────────────────────

async function shutdownChatQueue() {
    await Promise.allSettled([worker?.close(), chatQueue?.close(), queueEvents?.close()]);
}

module.exports = { initChatQueue, enqueueChatJob, getChatQueueStats, shutdownChatQueue };
