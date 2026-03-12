const path    = require('path');
const fs      = require('fs').promises;
const Agent   = require('../models/Agent');
const documentProcessor = require('../services/documentProcessor');
const TextChunker       = require('../services/textChunker');
const WebsiteCrawler    = require('../services/websiteCrawler');
const embeddingService  = require('../services/embeddingService');
const vectorStore       = require('../services/vectorStore');
const memoryService     = require('../services/memoryService');
const { enqueueAgentJob, getProgress, getAgentQueueStats } = require('../redis_services/agentQueue');
const { isConnected }   = require('../redis_services/redisClient');

// ─── GET /api/agents ──────────────────────────────────────────────────────
async function getAgents(req, res) {
    try {
        const agents = await Agent.findByUserId(req.auth.userId);
        res.json({ success: true, data: agents, count: agents.length });
    } catch (error) {
        console.error('Error fetching agents:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch agents', message: error.message });
    }
}

// ─── GET /api/agents/:id ──────────────────────────────────────────────────
async function getAgentById(req, res) {
    try {
        const userId  = req.auth.userId;
        const agentId = req.params.id;

        const agent = await Agent.findById(agentId);
        if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });
        if (agent.user_id !== userId) return res.status(403).json({ success: false, error: 'Access denied' });

        res.json({ success: true, data: agent });
    } catch (error) {
        console.error('Error fetching agent:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch agent', message: error.message });
    }
}

// ─── GET /api/agents/:id/progress ─────────────────────────────────────────
async function getIngestionProgress(req, res) {
    try {
        const userId  = req.auth.userId;
        const agentId = req.params.id;

        // Basic auth check (agent may not exist yet if still queued before DB write)
        const agent = await Agent.findById(agentId).catch(() => null);
        if (agent && agent.user_id !== userId) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const progress = await getProgress(agentId);

        if (!progress) {
            // No progress in Redis — check if agent exists and is already ready
            if (agent) {
                return res.json({ success: true, data: { stage: 'DONE', label: 'Ready', pct: 100 } });
            }
            return res.status(404).json({ success: false, error: 'No progress data found for this agent' });
        }

        res.json({ success: true, data: progress });
    } catch (error) {
        console.error('Error fetching progress:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch progress', message: error.message });
    }
}

// ─── GET /api/agents/queue-stats ──────────────────────────────────────────
async function agentQueueStats(req, res) {
    try {
        const stats = await getAgentQueueStats();
        res.json({ success: true, data: { redisConnected: isConnected(), queue: stats } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE FUNCTIONS
// These are exported so the BullMQ worker can call them.
// They must be self-contained and use only the job payload they receive.
// The `onProgress` callback writes stage updates to Redis.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Website ingestion pipeline.
 * Crawl → chunk → embed → create agent → store embeddings → memory
 */
async function runWebsitePipeline(payload, onProgress) {
    const { userId, url, name, description, agentId: preCreatedAgentId } = payload;
    const report  = onProgress || (() => Promise.resolve());

    try {
        // ── 1. Crawl ─────────────────────────────────────────────────────
        await report('CRAWLING');
        console.log(`[WebsitePipeline] Crawling: ${url}`);
        const maxPages   = 50;
        const crawler    = new WebsiteCrawler(url, maxPages);
        const pages      = await crawler.crawl();
        const summary    = crawler.getSummary();

        console.log(`[WebsitePipeline] Crawled ${summary.totalPages} pages, ${summary.totalWords} words`);

        if (pages.length === 0) throw new Error('No content could be extracted from the website');

        // ── 2. Chunk ─────────────────────────────────────────────────────
        await report('CHUNKING', { pageCount: pages.length });
        const textChunker = new TextChunker(1200, 200);
        let allChunks = [];

        for (const page of pages) {
            if (page.content?.trim().length > 0) {
                const chunks = await textChunker.chunkText(page.content, {
                    sourceUrl:       page.url,
                    pageTitle:       page.title,
                    pageDescription: page.description,
                });
                allChunks = allChunks.concat(chunks);
            }
        }

        console.log(`[WebsitePipeline] Created ${allChunks.length} chunks`);

        // ── 3. Embed ─────────────────────────────────────────────────────
        await report('EMBEDDING', { chunkCount: allChunks.length });
        const embeddedChunks = await embeddingService.generateChunkEmbeddings(allChunks);
        console.log(`[WebsitePipeline] Generated ${embeddedChunks.length} embeddings`);

        // ── 4. Create Agent record ────────────────────────────────────────
        const firstPage     = pages[0];
        const agent = await Agent.create({
            user_id:         userId,
            name,
            type:            'website',
            description:     firstPage.description || description || `Knowledge base from ${url}`,
            logo_url:        firstPage.favicon || null,
            source_url:      url,
            vector_store_id: `pending_${Date.now()}`,
            metadata: {
                totalPages:       pages.length,
                totalChunks:      allChunks.length,
                totalWords:       summary.totalWords,
                totalCharacters:  summary.totalCharacters,
                avgWordsPerPage:  summary.avgWordsPerPage,
                scrapedAt:        new Date().toISOString(),
                pages:            summary.pages.slice(0, 10),
            },
        });

        console.log(`[WebsitePipeline] Agent created: ${agent.id}`);

        // ── 5. Store embeddings ───────────────────────────────────────────
        await report('STORING', { agentId: agent.id });
        const embeddingIds = await vectorStore.storeEmbeddings(agent.id, embeddedChunks);
        console.log(`[WebsitePipeline] Stored ${embeddingIds.length} embeddings`);

        // ── 6. Memory ─────────────────────────────────────────────────────
        await report('MEMORY', { agentId: agent.id });
        await Promise.allSettled([
            memoryService.storeAgentIdentity(agent.id, {
                name: agent.name, type: 'website', description: agent.description, sourceUrl: url,
            }),
            memoryService.storePageSummaries(agent.id, { name: agent.name, sourceUrl: url }, pages),
        ]);

        // ── 7. Finalise ───────────────────────────────────────────────────
        await Agent.update(agent.id, {
            vector_store_id: `agent_${agent.id}`,
            metadata: {
                ...agent.metadata,
                embeddingCount:        embeddingIds.length,
                vectorStoreUpdatedAt:  new Date().toISOString(),
            },
        });

        await report('DONE', { agentId: agent.id, embeddingCount: embeddingIds.length });
        console.log(`[WebsitePipeline] Agent ${agent.id} fully processed ✓`);

        return { agentId: agent.id, embeddingCount: embeddingIds.length };

    } catch (error) {
        console.error('[WebsitePipeline] Failed:', error.message);
        throw error; // BullMQ will mark job as failed and call setProgress(FAILED)
    }
}

/**
 * Document ingestion pipeline.
 * Parse → chunk → embed → create agent → store embeddings → memory
 */
async function runDocumentPipeline(payload, onProgress) {
    const { userId, filePath, fileType, fileName, fileSize, name, description } = payload;
    const report = onProgress || (() => Promise.resolve());

    try {
        // ── 1. Parse ─────────────────────────────────────────────────────
        await report('PARSING');
        const validation = await documentProcessor.validateFile(filePath);
        if (!validation.valid) throw new Error(validation.error);

        const { text, metadata: docMetadata } = await documentProcessor.processDocument(filePath, fileType);
        console.log(`[DocumentPipeline] Extracted ${text.length} chars from ${fileName}`);

        // ── 2. Chunk ─────────────────────────────────────────────────────
        await report('CHUNKING');
        const textChunker = new TextChunker(1500, 200);
        const chunks      = await textChunker.chunkDocument(text, docMetadata);
        console.log(`[DocumentPipeline] Created ${chunks.length} chunks`);

        // ── 3. Embed ─────────────────────────────────────────────────────
        await report('EMBEDDING', { chunkCount: chunks.length });
        const embeddedChunks = await embeddingService.generateChunkEmbeddings(chunks);
        console.log(`[DocumentPipeline] Generated ${embeddedChunks.length} embeddings`);

        // ── 4. Create Agent record ─────────────────────────────────────────
        const agent = await Agent.create({
            user_id:         userId,
            name,
            type:            'document',
            description:     description || `Knowledge base from ${fileName}`,
            source_url:      fileName,
            vector_store_id: `pending_${Date.now()}`,
            metadata: {
                fileName,
                fileType,
                fileSize,
                totalChunks:     chunks.length,
                characterCount:  text.length,
                wordCount:       docMetadata.wordCount,
                processedAt:     new Date().toISOString(),
            },
        });

        console.log(`[DocumentPipeline] Agent created: ${agent.id}`);

        // ── 5. Store embeddings ────────────────────────────────────────────
        await report('STORING', { agentId: agent.id });
        const embeddingIds = await vectorStore.storeEmbeddings(agent.id, embeddedChunks);
        console.log(`[DocumentPipeline] Stored ${embeddingIds.length} embeddings`);

        // ── 6. Memory ─────────────────────────────────────────────────────
        await report('MEMORY', { agentId: agent.id });
        await memoryService.storeAgentIdentity(agent.id, {
            name: agent.name, type: 'document',
            description: agent.description, sourceUrl: fileName,
        }).catch(err => console.error('[DocumentPipeline] Memory identity error:', err));

        // ── 7. Finalise ───────────────────────────────────────────────────
        await Agent.update(agent.id, {
            vector_store_id: `agent_${agent.id}`,
            metadata: { ...agent.metadata, embeddingCount: embeddingIds.length, vectorStoreUpdatedAt: new Date().toISOString() },
        });

        // Clean up temp file
        await fs.unlink(filePath).catch(() => {});
        console.log(`[DocumentPipeline] Cleaned up temp file: ${filePath}`);

        await report('DONE', { agentId: agent.id, embeddingCount: embeddingIds.length });
        console.log(`[DocumentPipeline] Agent ${agent.id} fully processed ✓`);

        return { agentId: agent.id, embeddingCount: embeddingIds.length };

    } catch (error) {
        console.error('[DocumentPipeline] Failed:', error.message);
        // Try to clean up the file even on error
        await fs.unlink(filePath).catch(() => {});
        throw error;
    }
}

/**
 * Add-context pipeline (adds a document to an existing agent).
 * Parse → chunk → embed → store embeddings (no new Agent record created)
 */
async function runAddContextPipeline(payload, onProgress) {
    const { agentId, filePath, fileType, fileName, agentMetadata } = payload;
    const report = onProgress || (() => Promise.resolve());

    try {
        // ── 1. Parse ─────────────────────────────────────────────────────
        await report('PARSING', { agentId });
        const validation = await documentProcessor.validateFile(filePath);
        if (!validation.valid) throw new Error(validation.error);

        const { text, metadata: docMetadata } = await documentProcessor.processDocument(filePath, fileType);
        console.log(`[AddContextPipeline] Extracted ${text.length} chars from ${fileName}`);

        // ── 2. Chunk ─────────────────────────────────────────────────────
        await report('CHUNKING', { agentId });
        const textChunker = new TextChunker(1500, 200);
        const chunks      = await textChunker.chunkDocument(text, { ...docMetadata, sourceUrl: fileName, pageTitle: fileName });
        console.log(`[AddContextPipeline] Created ${chunks.length} chunks`);

        // ── 3. Embed ─────────────────────────────────────────────────────
        await report('EMBEDDING', { agentId, chunkCount: chunks.length });
        const embeddedChunks = await embeddingService.generateChunkEmbeddings(chunks);

        // ── 4. Store ──────────────────────────────────────────────────────
        await report('STORING', { agentId });
        const embeddingIds = await vectorStore.storeEmbeddings(agentId, embeddedChunks);
        console.log(`[AddContextPipeline] Stored ${embeddingIds.length} embeddings for agent ${agentId}`);

        // Update agent metadata
        const currentCount = await vectorStore.getEmbeddingCount(agentId).catch(() => 0);
        await Agent.update(agentId, {
            metadata: {
                ...(agentMetadata || {}),
                embeddingCount:   currentCount,
                lastContextUpdate: new Date().toISOString(),
            },
        });

        // Clean up
        await fs.unlink(filePath).catch(() => {});

        await report('DONE', { agentId, embeddingCount: embeddingIds.length });
        console.log(`[AddContextPipeline] Agent ${agentId} now has ${currentCount} embeddings ✓`);

        return { agentId, embeddingCount: embeddingIds.length };

    } catch (error) {
        console.error('[AddContextPipeline] Failed:', error.message);
        await fs.unlink(filePath).catch(() => {});
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

// ─── POST /api/agents/scrape-website ─────────────────────────────────────
async function createAgentFromWebsite(req, res) {
    try {
        const userId = req.auth.userId;
        const { url, name, description } = req.body;

        if (!url || !name) {
            return res.status(400).json({ success: false, error: 'URL and name are required' });
        }
        try { new URL(url); } catch {
            return res.status(400).json({ success: false, error: 'Invalid URL format' });
        }

        const jobPayload = { type: 'website', userId, url, name, description };

        if (isConnected()) {
            // Enqueue — client polls GET /api/agents/:id/progress
            const jobId = await enqueueAgentJob(jobPayload);
            return res.status(202).json({
                success: true,
                message: 'Website scraping queued',
                status:  'queued',
                jobId,
                note:    'Poll GET /api/agents/:id/progress for live status updates. The agentId will be in the progress response once the DB record is created.',
            });
        } else {
            // Redis down — run inline with fire-and-forget (legacy behaviour)
            console.warn('[Agent] Redis unavailable — running pipeline inline (no queue)');
            res.status(202).json({ success: true, message: 'Website scraping initiated', status: 'processing' });
            runWebsitePipeline(jobPayload).catch(err =>
                console.error('[Agent] Inline website pipeline failed:', err.message)
            );
        }
    } catch (error) {
        console.error('Error initiating website scraping:', error);
        res.status(500).json({ success: false, error: 'Failed to initiate website scraping', message: error.message });
    }
}

// ─── POST /api/agents/upload-document ────────────────────────────────────
async function uploadDocument(req, res) {
    let filePath = null;
    try {
        const userId = req.auth.userId;
        const { name, description } = req.body;

        if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
        if (!name)     return res.status(400).json({ success: false, error: 'Agent name is required' });

        filePath = req.file.path;
        const fileType = path.extname(req.file.originalname).toLowerCase().slice(1);

        const jobPayload = {
            type:        'document',
            userId,
            filePath,
            fileType,
            fileName:    req.file.originalname,
            fileSize:    req.file.size,
            name,
            description,
        };

        if (isConnected()) {
            const jobId = await enqueueAgentJob(jobPayload);
            return res.status(202).json({
                success: true,
                message: 'Document upload queued for processing',
                status:  'queued',
                jobId,
                note:    'Poll GET /api/agents/:id/progress for live status. agentId will appear in progress once created.',
            });
        } else {
            console.warn('[Agent] Redis unavailable — running pipeline inline');
            res.status(202).json({ success: true, message: 'Document processing started', status: 'processing' });
            runDocumentPipeline(jobPayload).catch(err =>
                console.error('[Agent] Inline document pipeline failed:', err.message)
            );
        }
    } catch (error) {
        console.error('Error initiating document upload:', error);
        if (filePath) fs.unlink(filePath).catch(() => {});
        res.status(500).json({ success: false, error: 'Failed to process document upload', message: error.message });
    }
}

// ─── POST /api/agents/:id/add-context ────────────────────────────────────
async function addContext(req, res) {
    let filePath = null;
    try {
        const userId  = req.auth.userId;
        const agentId = req.params.id;

        const agent = await Agent.findById(agentId);
        if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });
        if (agent.user_id !== userId) return res.status(403).json({ success: false, error: 'Access denied' });
        if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

        filePath = req.file.path;
        const fileType = path.extname(req.file.originalname).toLowerCase().slice(1);

        const jobPayload = {
            type:          'add-context',
            agentId,
            filePath,
            fileType,
            fileName:      req.file.originalname,
            agentMetadata: agent.metadata,
        };

        if (isConnected()) {
            const jobId = await enqueueAgentJob(jobPayload);
            return res.status(202).json({
                success: true,
                message: 'Context document queued for ingestion',
                status:  'queued',
                jobId,
                note:    'Poll GET /api/agents/:id/progress for live status.',
            });
        } else {
            console.warn('[Agent] Redis unavailable — running pipeline inline');
            res.status(202).json({ success: true, message: 'Context processing started', status: 'processing' });
            runAddContextPipeline(jobPayload).catch(err =>
                console.error('[Agent] Inline add-context pipeline failed:', err.message)
            );
        }
    } catch (error) {
        console.error('Error adding context:', error);
        if (filePath) fs.unlink(filePath).catch(() => {});
        res.status(500).json({ success: false, error: 'Failed to add context', message: error.message });
    }
}

// ─── DELETE /api/agents/:id ───────────────────────────────────────────────
async function deleteAgent(req, res) {
    try {
        const userId  = req.auth.userId;
        const agentId = req.params.id;

        const agent = await Agent.findById(agentId);
        if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });
        if (agent.user_id !== userId) return res.status(403).json({ success: false, error: 'Access denied' });

        // Best-effort cleanup
        await Promise.allSettled([
            vectorStore.deleteAgentEmbeddings(agentId),
            memoryService.clearAgentMemories(agentId),
        ]);

        await Agent.delete(agentId);
        res.json({ success: true, message: 'Agent deleted successfully' });
    } catch (error) {
        console.error('Error deleting agent:', error);
        res.status(500).json({ success: false, error: 'Failed to delete agent', message: error.message });
    }
}

module.exports = {
    // HTTP handlers
    getAgents, getAgentById, createAgentFromWebsite, uploadDocument,
    addContext, deleteAgent, getIngestionProgress, agentQueueStats,
    // Pipeline runners (called by BullMQ worker — must be exported)
    runWebsitePipeline, runDocumentPipeline, runAddContextPipeline,
};
