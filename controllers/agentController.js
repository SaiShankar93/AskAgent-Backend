const path    = require('path');
const fs      = require('fs').promises;
const Agent   = require('../models/Agent');
const documentProcessor = require('../services/documentProcessor');
const TextChunker       = require('../services/textChunker');
const WebsiteCrawler    = require('../services/websiteCrawler');
const embeddingService  = require('../services/embeddingService');
const vectorStore       = require('../services/vectorStore');
const memoryService     = require('../services/memoryService');
const socketService     = require('../services/socketService');
const { enqueueAgentJob, getProgress, getAgentQueueStats } = require('../redis_services/agentQueue');
const { isConnected }   = require('../redis_services/redisClient');

// ─── Socket emit helper ───────────────────────────────────────────────────
/**
 * Emit a progress event to all clients watching this agent.
 * @param {string} agentId
 * @param {object} payload  - { stage, label, pct, ...extra }
 */
function emitProgress(agentId, payload) {
    socketService.emitToAgent(agentId, 'agent:progress', {
        ...payload,
        timestamp: new Date().toISOString(),
    });
}

function emitPageScraped(agentId, payload) {
    socketService.emitToAgent(agentId, 'agent:page-scraped', {
        ...payload,
        timestamp: new Date().toISOString(),
    });
}

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
        const agent   = await Agent.findById(agentId);
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
        const agent   = await Agent.findById(agentId).catch(() => null);
        if (agent && agent.user_id !== userId) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }
        const progress = await getProgress(agentId);
        if (!progress) {
            if (agent) return res.json({ success: true, data: { stage: 'DONE', label: 'Ready', pct: 100 } });
            return res.status(404).json({ success: false, error: 'No progress data found' });
        }
        res.json({ success: true, data: progress });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// ─── GET /api/agents/ops/queue-stats ──────────────────────────────────────
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
// Exported so the BullMQ worker can call them.
// Each accepts an `onProgress` callback + emits socket events directly.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Website ingestion pipeline.
 * NOTE: agent DB record is created BEFORE this runs (in the HTTP handler),
 * so agentId is always available for socket emissions.
 */
async function runWebsitePipeline(payload, onProgress) {
    const { userId, url, name, description, agentId } = payload;
    const report = onProgress || (() => Promise.resolve());

    try {
        // ── 1. Crawl ────────────────────────────────────────────────────
        await report('CRAWLING');
        emitProgress(agentId, { stage: 'CRAWLING', label: 'Crawling website...', pct: 5 });

        await Agent.update(agentId, { status: 'processing' });

        console.log(`[WebsitePipeline] Crawling: ${url}`);
        const maxPages = 10;
        const crawler  = new WebsiteCrawler(url, maxPages);

        // Hook into the crawler to get per-page events
        const originalScrapePage = crawler.scrapePage.bind(crawler);
        let pageCount = 0;
        crawler.scrapePage = async (pageUrl) => {
            const result = await originalScrapePage(pageUrl);
            if (result) {
                pageCount++;
                emitPageScraped(agentId, {
                    url:       result.url,
                    title:     result.title || pageUrl,
                    wordCount: result.wordCount || 0,
                    pageIndex: pageCount,
                });
                emitProgress(agentId, {
                    stage: 'CRAWLING',
                    label: `Crawling page ${pageCount}...`,
                    pct:   Math.min(5 + pageCount, 30),
                    currentUrl: result.url,
                    pageCount,
                });
            }
            return result;
        };

        const pages   = await crawler.crawl();
        const summary = crawler.getSummary();

        if (pages.length === 0) throw new Error('No content could be extracted from the website');

        emitProgress(agentId, {
            stage: 'CRAWLING', label: `Crawled ${pages.length} pages`, pct: 30,
            totalPages: pages.length, totalWords: summary.totalWords,
        });

        // ── 2. Chunk ─────────────────────────────────────────────────────
        await report('CHUNKING', { pageCount: pages.length });
        emitProgress(agentId, { stage: 'CHUNKING', label: 'Chunking content...', pct: 35 });

        const textChunker = new TextChunker(1200, 200);
        let allChunks = [];
        for (const page of pages) {
            if (page.content?.trim().length > 0) {
                const chunks = await textChunker.chunkText(page.content, {
                    sourceUrl: page.url, pageTitle: page.title, pageDescription: page.description,
                });
                allChunks = allChunks.concat(chunks);
            }
        }
        emitProgress(agentId, { stage: 'CHUNKING', label: `Created ${allChunks.length} chunks`, pct: 45, chunkCount: allChunks.length });

        // ── 3. Embed ─────────────────────────────────────────────────────
        await report('EMBEDDING', { chunkCount: allChunks.length });
        emitProgress(agentId, { stage: 'EMBEDDING', label: `Generating embeddings for ${allChunks.length} chunks...`, pct: 50 });

        const embeddedChunks = await embeddingService.generateChunkEmbeddings(allChunks);
        emitProgress(agentId, { stage: 'EMBEDDING', label: 'Embeddings generated', pct: 75 });

        // ── 4. Store embeddings ───────────────────────────────────────────
        await report('STORING', { agentId });
        emitProgress(agentId, { stage: 'STORING', label: 'Storing to vector database...', pct: 80 });

        const embeddingIds = await vectorStore.storeEmbeddings(agentId, embeddedChunks);
        emitProgress(agentId, { stage: 'STORING', label: `Stored ${embeddingIds.length} vectors`, pct: 88 });

        // ── 5. Memory ─────────────────────────────────────────────────────
        await report('MEMORY', { agentId });
        emitProgress(agentId, { stage: 'MEMORY', label: 'Building memory index...', pct: 90 });

        const firstPage = pages[0];
        await Promise.allSettled([
            memoryService.storeAgentIdentity(agentId, {
                name, type: 'website',
                description: firstPage.description || description || `Knowledge base from ${url}`,
                sourceUrl: url,
            }),
            memoryService.storePageSummaries(agentId, { name, sourceUrl: url }, pages),
        ]);

        // ── 6. Finalise ───────────────────────────────────────────────────
        await Agent.update(agentId, {
            status:          'ready',
            description:     firstPage.description || description || `Knowledge base from ${url}`,
            logo_url:        firstPage.favicon || null,
            vector_store_id: `agent_${agentId}`,
            metadata: {
                totalPages:      pages.length,
                totalChunks:     allChunks.length,
                totalWords:      summary.totalWords,
                embeddingCount:  embeddingIds.length,
                scrapedAt:       new Date().toISOString(),
                pages:           summary.pages.slice(0, 10),
            },
        });

        await report('DONE', { agentId, embeddingCount: embeddingIds.length });
        emitProgress(agentId, {
            stage: 'DONE', label: 'Agent is ready!', pct: 100,
            embeddingCount: embeddingIds.length, totalPages: pages.length,
        });

        console.log(`[WebsitePipeline] Agent ${agentId} fully processed ✓`);
        return { agentId, embeddingCount: embeddingIds.length };

    } catch (error) {
        console.error('[WebsitePipeline] Failed:', error.message);
        await Agent.update(agentId, { status: 'failed' }).catch(() => {});
        emitProgress(agentId, { stage: 'FAILED', label: `Failed: ${error.message}`, pct: -1, error: error.message });
        throw error;
    }
}

/**
 * Document ingestion pipeline.
 */
async function runDocumentPipeline(payload, onProgress) {
    const { userId, filePath, fileType, fileName, fileSize, name, description, agentId } = payload;
    const report = onProgress || (() => Promise.resolve());

    try {
        await Agent.update(agentId, { status: 'processing' });

        // ── 1. Parse ─────────────────────────────────────────────────────
        await report('PARSING');
        emitProgress(agentId, { stage: 'PARSING', label: `Parsing ${fileName}...`, pct: 10 });

        const validation = await documentProcessor.validateFile(filePath);
        if (!validation.valid) throw new Error(validation.error);

        const { text, metadata: docMetadata } = await documentProcessor.processDocument(filePath, fileType);
        emitProgress(agentId, { stage: 'PARSING', label: `Extracted ${text.length.toLocaleString()} characters`, pct: 20 });

        // ── 2. Chunk ─────────────────────────────────────────────────────
        await report('CHUNKING');
        emitProgress(agentId, { stage: 'CHUNKING', label: 'Splitting into chunks...', pct: 30 });

        const textChunker = new TextChunker(1500, 200);
        const chunks      = await textChunker.chunkDocument(text, docMetadata);
        emitProgress(agentId, { stage: 'CHUNKING', label: `Created ${chunks.length} chunks`, pct: 45 });

        // ── 3. Embed ─────────────────────────────────────────────────────
        await report('EMBEDDING', { chunkCount: chunks.length });
        emitProgress(agentId, { stage: 'EMBEDDING', label: `Generating embeddings for ${chunks.length} chunks...`, pct: 50 });

        const embeddedChunks = await embeddingService.generateChunkEmbeddings(chunks);
        emitProgress(agentId, { stage: 'EMBEDDING', label: 'Embeddings generated', pct: 75 });

        // ── 4. Store ──────────────────────────────────────────────────────
        await report('STORING', { agentId });
        emitProgress(agentId, { stage: 'STORING', label: 'Storing to vector database...', pct: 80 });

        const embeddingIds = await vectorStore.storeEmbeddings(agentId, embeddedChunks);
        emitProgress(agentId, { stage: 'STORING', label: `Stored ${embeddingIds.length} vectors`, pct: 88 });

        // ── 5. Memory ─────────────────────────────────────────────────────
        await report('MEMORY', { agentId });
        emitProgress(agentId, { stage: 'MEMORY', label: 'Building memory index...', pct: 90 });

        await memoryService.storeAgentIdentity(agentId, {
            name, type: 'document',
            description: description || `Knowledge base from ${fileName}`,
            sourceUrl: fileName,
        }).catch(() => {});

        // ── 6. Finalise ───────────────────────────────────────────────────
        await Agent.update(agentId, {
            status:          'ready',
            vector_store_id: `agent_${agentId}`,
            metadata: {
                fileName, fileType, fileSize,
                totalChunks:    chunks.length,
                characterCount: text.length,
                wordCount:      docMetadata.wordCount,
                embeddingCount: embeddingIds.length,
                processedAt:    new Date().toISOString(),
            },
        });

        await fs.unlink(filePath).catch(() => {});

        await report('DONE', { agentId, embeddingCount: embeddingIds.length });
        emitProgress(agentId, { stage: 'DONE', label: 'Agent is ready!', pct: 100, embeddingCount: embeddingIds.length });

        console.log(`[DocumentPipeline] Agent ${agentId} fully processed ✓`);
        return { agentId, embeddingCount: embeddingIds.length };

    } catch (error) {
        console.error('[DocumentPipeline] Failed:', error.message);
        await Agent.update(agentId, { status: 'failed' }).catch(() => {});
        emitProgress(agentId, { stage: 'FAILED', label: `Failed: ${error.message}`, pct: -1, error: error.message });
        await fs.unlink(filePath).catch(() => {});
        throw error;
    }
}

/**
 * Add-context pipeline.
 */
async function runAddContextPipeline(payload, onProgress) {
    const { agentId, filePath, fileType, fileName, agentMetadata } = payload;
    const report = onProgress || (() => Promise.resolve());

    try {
        emitProgress(agentId, { stage: 'PARSING', label: `Parsing ${fileName}...`, pct: 10 });
        await report('PARSING', { agentId });

        const validation = await documentProcessor.validateFile(filePath);
        if (!validation.valid) throw new Error(validation.error);

        const { text, metadata: docMetadata } = await documentProcessor.processDocument(filePath, fileType);
        emitProgress(agentId, { stage: 'CHUNKING', label: 'Splitting into chunks...', pct: 30 });

        await report('CHUNKING', { agentId });
        const textChunker = new TextChunker(1500, 200);
        const chunks      = await textChunker.chunkDocument(text, { ...docMetadata, sourceUrl: fileName, pageTitle: fileName });

        emitProgress(agentId, { stage: 'EMBEDDING', label: `Generating embeddings...`, pct: 50 });
        await report('EMBEDDING', { agentId, chunkCount: chunks.length });
        const embeddedChunks = await embeddingService.generateChunkEmbeddings(chunks);

        emitProgress(agentId, { stage: 'STORING', label: 'Storing to vector database...', pct: 80 });
        await report('STORING', { agentId });
        const embeddingIds = await vectorStore.storeEmbeddings(agentId, embeddedChunks);

        const currentCount = await vectorStore.getEmbeddingCount(agentId).catch(() => 0);
        await Agent.update(agentId, {
            metadata: { ...(agentMetadata || {}), embeddingCount: currentCount, lastContextUpdate: new Date().toISOString() },
        });

        await fs.unlink(filePath).catch(() => {});

        await report('DONE', { agentId, embeddingCount: embeddingIds.length });
        emitProgress(agentId, { stage: 'DONE', label: 'Context added!', pct: 100, embeddingCount: embeddingIds.length });

        return { agentId, embeddingCount: embeddingIds.length };

    } catch (error) {
        console.error('[AddContextPipeline] Failed:', error.message);
        emitProgress(agentId, { stage: 'FAILED', label: `Failed: ${error.message}`, pct: -1, error: error.message });
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

        // Create the agent record IMMEDIATELY so we have an ID for socket rooms
        const agent = await Agent.create({
            user_id:         userId,
            name,
            type:            'website',
            status:          'pending',
            description:     description || `Knowledge base from ${url}`,
            source_url:      url,
            vector_store_id: `pending_${Date.now()}`,
        });

        const jobPayload = { type: 'website', userId, url, name, description, agentId: agent.id };

        if (isConnected()) {
            await enqueueAgentJob(jobPayload);
        } else {
            console.warn('[Agent] Redis unavailable — running pipeline inline');
            runWebsitePipeline(jobPayload).catch(err =>
                console.error('[Agent] Inline website pipeline failed:', err.message)
            );
        }

        // Return the agent immediately — frontend opens chat and connects socket
        return res.status(202).json({
            success: true,
            message: 'Agent created, processing started',
            status:  'pending',
            data:    agent,   // includes agent.id for socket room joining
        });

    } catch (error) {
        console.error('Error initiating website scraping:', error);
        res.status(500).json({ success: false, error: 'Failed to create agent', message: error.message });
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

        // Create agent record immediately
        const agent = await Agent.create({
            user_id:         userId,
            name,
            type:            'document',
            status:          'pending',
            description:     description || `Knowledge base from ${req.file.originalname}`,
            source_url:      req.file.originalname,
            vector_store_id: `pending_${Date.now()}`,
        });

        const jobPayload = {
            type:        'document',
            userId,
            agentId:     agent.id,
            filePath,
            fileType,
            fileName:    req.file.originalname,
            fileSize:    req.file.size,
            name,
            description,
        };

        if (isConnected()) {
            await enqueueAgentJob(jobPayload);
        } else {
            console.warn('[Agent] Redis unavailable — running pipeline inline');
            runDocumentPipeline(jobPayload).catch(err =>
                console.error('[Agent] Inline document pipeline failed:', err.message)
            );
        }

        return res.status(202).json({
            success: true,
            message: 'Agent created, processing started',
            status:  'pending',
            data:    agent,
        });

    } catch (error) {
        console.error('Error initiating document upload:', error);
        if (filePath) fs.unlink(filePath).catch(() => {});
        res.status(500).json({ success: false, error: 'Failed to create agent', message: error.message });
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
            await enqueueAgentJob(jobPayload);
        } else {
            console.warn('[Agent] Redis unavailable — running pipeline inline');
            runAddContextPipeline(jobPayload).catch(err =>
                console.error('[Agent] Inline add-context pipeline failed:', err.message)
            );
        }

        return res.status(202).json({
            success: true, message: 'Context queued for ingestion', status: 'queued',
        });

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
        const agent   = await Agent.findById(agentId);
        if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });
        if (agent.user_id !== userId) return res.status(403).json({ success: false, error: 'Access denied' });
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
    getAgents, getAgentById, createAgentFromWebsite, uploadDocument,
    addContext, deleteAgent, getIngestionProgress, agentQueueStats,
    runWebsitePipeline, runDocumentPipeline, runAddContextPipeline,
};
