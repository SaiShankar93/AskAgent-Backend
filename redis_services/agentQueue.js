/**
 * BullMQ queue for agent ingestion pipeline.
 *
 * Handles the full pipeline for both agent types:
 *   Website  → crawl → chunk → embed → store
 *   Document → parse → chunk → embed → store
 *
 * Clients get an IMMEDIATE HTTP 202 response with a jobId.
 * They then poll GET /api/agents/:id/progress to track processing.
 *
 * Progress is written into Redis at every stage so the poll endpoint
 * can return live stage/percentage data without hitting the DB.
 *
 * Concurrency is deliberately lower than the chat queue — ingestion
 * jobs are heavy (Puppeteer + N×embedding API calls).
 */

const { Queue, Worker, QueueEvents } = require('bullmq');
const { redisSet, redisGet, isConnected } = require('./redisClient');

// ─── Constants ────────────────────────────────────────────────────────────

const QUEUE_NAME     = 'agent-ingestion';
const PROGRESS_TTL   = 86_400;             // 24 h — keep progress for a day
const PROGRESS_KEY   = (agentId) => `agent:progress:${agentId}`;

const REDIS_CONN = {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT || 6379),
};

// Ingestion stages (used for progress reporting)
const STAGES = {
    QUEUED:    { label: 'Queued',                pct: 0   },
    CRAWLING:  { label: 'Crawling website',       pct: 10  },
    PARSING:   { label: 'Parsing document',       pct: 10  },
    CHUNKING:  { label: 'Chunking content',       pct: 35  },
    EMBEDDING: { label: 'Generating embeddings',  pct: 60  },
    STORING:   { label: 'Storing to vector DB',   pct: 85  },
    MEMORY:    { label: 'Building memory index',  pct: 90  },
    DONE:      { label: 'Ready',                  pct: 100 },
    FAILED:    { label: 'Failed',                 pct: -1  },
};

// ─── BullMQ instances ─────────────────────────────────────────────────────

let agentQueue  = null;
let queueEvents = null;
let worker      = null;

function getQueue() {
    if (!agentQueue) {
        agentQueue = new Queue(QUEUE_NAME, {
            connection: REDIS_CONN,
            defaultJobOptions: {
                attempts:         3,
                backoff:          { type: 'exponential', delay: 2000 },
                removeOnComplete: { age: 3600 },   // 1 h
                removeOnFail:     { age: 86_400 },  // 24 h
            },
        });
        agentQueue.on('error', err => console.error('[AgentQueue] Error:', err.message));
    }
    return agentQueue;
}

function getQueueEvents() {
    if (!queueEvents) {
        queueEvents = new QueueEvents(QUEUE_NAME, { connection: REDIS_CONN });
        queueEvents.on('error', err => console.error('[AgentQueue] Events error:', err.message));
    }
    return queueEvents;
}

// ─── Progress helpers ─────────────────────────────────────────────────────

/**
 * Write progress into Redis.
 * @param {string} agentId
 * @param {string} stage   - key from STAGES
 * @param {object} extra   - any extra info to merge (e.g. pageCount, chunkCount)
 */
async function setProgress(agentId, stage, extra = {}) {
    const s = STAGES[stage] || STAGES.QUEUED;
    return redisSet(PROGRESS_KEY(agentId), {
        stage,
        label:     s.label,
        pct:       s.pct,
        updatedAt: new Date().toISOString(),
        ...extra,
    }, PROGRESS_TTL);
}

/**
 * Read current progress for an agent.
 * Returns null if Redis is down or key doesn't exist.
 */
async function getProgress(agentId) {
    return redisGet(PROGRESS_KEY(agentId));
}

// ─── Worker init ──────────────────────────────────────────────────────────

function initAgentQueue() {
    if (worker) return;

    // Lazy-require the pipeline runners to avoid circular imports
    const { runWebsitePipeline, runDocumentPipeline, runAddContextPipeline } =
        require('../controllers/agentController');

    worker = new Worker(
        QUEUE_NAME,
        async (job) => {
            const { type, agentId } = job.data;
            console.log(`[AgentQueue] Job ${job.id} — type: ${type}, agentId: ${agentId || 'pending'}`);

            switch (type) {
                case 'website':
                    return runWebsitePipeline(job.data, (stage, extra) => setProgress(agentId, stage, extra));

                case 'document':
                    return runDocumentPipeline(job.data, (stage, extra) => setProgress(agentId, stage, extra));

                case 'add-context':
                    return runAddContextPipeline(job.data, (stage, extra) => setProgress(agentId, stage, extra));

                default:
                    throw new Error(`Unknown agent ingestion type: ${type}`);
            }
        },
        {
            connection:  REDIS_CONN,
            concurrency: Number(process.env.AGENT_QUEUE_CONCURRENCY || 3),
            limiter: {
                max:      Number(process.env.AGENT_QUEUE_RATE_MAX || 5),
                duration: Number(process.env.AGENT_QUEUE_RATE_MS  || 1000),
            },
        }
    );

    worker.on('completed', (job) => {
        console.log(`[AgentQueue] Job ${job.id} completed in ${Date.now() - job.timestamp}ms`);
    });

    worker.on('failed', async (job, err) => {
        console.error(`[AgentQueue] Job ${job?.id} failed:`, err.message);
        if (job?.data?.agentId) {
            await setProgress(job.data.agentId, 'FAILED', { error: err.message });
        }
    });

    worker.on('error', err => console.error('[AgentQueue] Worker error:', err.message));

    getQueueEvents(); // warm up
    console.log(`[AgentQueue] Worker ready — concurrency: ${process.env.AGENT_QUEUE_CONCURRENCY || 3}`);
}

// ─── Enqueue ──────────────────────────────────────────────────────────────

/**
 * Enqueue an agent ingestion job (fire-and-forget — caller returns 202 immediately).
 * @param {object} payload  - Job data (type, userId, agentId, ...)
 * @returns {Promise<string>} BullMQ job ID
 */
async function enqueueAgentJob(payload) {
    const queue = getQueue();

    // Mark as queued immediately so progress polling works from the start
    if (payload.agentId) {
        await setProgress(payload.agentId, 'QUEUED');
    }

    const job = await queue.add(`${payload.type}-ingestion`, payload, {
        jobId:    payload.agentId ? `${payload.type}-${payload.agentId}` : undefined,
        priority: 1,
    });

    console.log(`[AgentQueue] Enqueued job ${job.id} (type: ${payload.type})`);
    return job.id;
}

// ─── Stats ────────────────────────────────────────────────────────────────

async function getAgentQueueStats() {
    const q = getQueue();
    const [waiting, active, completed, failed, delayed] = await Promise.all([
        q.getWaitingCount(), q.getActiveCount(), q.getCompletedCount(),
        q.getFailedCount(),  q.getDelayedCount(),
    ]);
    return { waiting, active, completed, failed, delayed };
}

// ─── Shutdown ─────────────────────────────────────────────────────────────

async function shutdownAgentQueue() {
    await Promise.allSettled([worker?.close(), agentQueue?.close(), queueEvents?.close()]);
}

module.exports = {
    initAgentQueue,
    enqueueAgentJob,
    getAgentQueueStats,
    getProgress,
    setProgress,
    shutdownAgentQueue,
    STAGES,
};
