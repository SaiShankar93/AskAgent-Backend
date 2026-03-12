const path = require('path');
const fs = require('fs').promises;
const Agent = require('../models/Agent');
const documentProcessor = require('../services/documentProcessor');
const TextChunker = require('../services/textChunker');
const WebsiteCrawler = require('../services/websiteCrawler');
const embeddingService = require('../services/embeddingService');
const vectorStore = require('../services/vectorStore');
const memoryService = require('../services/memoryService');

// GET /api/agents
async function getAgents(req, res) {
    try {
        const userId = req.auth.userId;
        const agents = await Agent.findByUserId(userId);

        res.json({
            success: true,
            data: agents,
            count: agents.length,
        });
    } catch (error) {
        console.error('Error fetching agents:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch agents',
            message: error.message,
        });
    }
}

// GET /api/agents/:id
async function getAgentById(req, res) {
    try {
        const userId = req.auth.userId;
        const agentId = req.params.id;

        const agent = await Agent.findById(agentId);

        if (!agent) {
            return res.status(404).json({ success: false, error: 'Agent not found' });
        }

        if (agent.user_id !== userId) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        res.json({ success: true, data: agent });
    } catch (error) {
        console.error('Error fetching agent:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch agent',
            message: error.message,
        });
    }
}

// POST /api/agents/scrape-website
async function createAgentFromWebsite(req, res) {
    try {
        const userId = req.auth.userId;
        const { url, name, description } = req.body;

        if (!url || !name) {
            return res.status(400).json({ success: false, error: 'URL and name are required' });
        }

        try {
            new URL(url);
        } catch (_) {
            return res.status(400).json({ success: false, error: 'Invalid URL format' });
        }

        res.json({ success: true, message: 'Website scraping initiated', status: 'processing' });

        (async () => {
            try {
                console.log(`[Agent Creation] Starting comprehensive crawl of: ${url}`);
                const maxPages = 50;
                const crawler = new WebsiteCrawler(url, maxPages);
                const scrapedPages = await crawler.crawl();

                const summary = crawler.getSummary();
                console.log(`[Agent Creation] Crawled ${summary.totalPages} pages, ${summary.totalWords} words`);

                if (scrapedPages.length === 0) {
                    throw new Error('No content could be extracted from the website');
                }
                console.log("scrapedPages",scrapedPages);   
                const textChunker = new TextChunker(1200, 200);
                let allChunks = [];
                for (const page of scrapedPages) {
                    if (page.content && page.content.trim().length > 0) {
                        const chunks = await textChunker.chunkText(page.content, {
                            sourceUrl: page.url,
                            pageTitle: page.title,
                            pageDescription: page.description,
                        });
                        allChunks = allChunks.concat(chunks);
                    }
                }

                console.log(`[Agent Creation] Created ${allChunks.length} chunks from ${scrapedPages.length} pages`);
                console.log("allChunks",allChunks);
                const firstPage = scrapedPages[0];
                const logoUrl = firstPage.favicon || null;
                const pageTitle = firstPage.title || name;
                const pageDescription = firstPage.description || description || `Knowledge base from ${url}`;

                console.log(`[Agent Creation] Generating embeddings for ${allChunks.length} chunks`);
                const embeddedChunks = await embeddingService.generateChunkEmbeddings(allChunks);
                console.log("embd",embeddedChunks);
                console.log(`[Agent Creation] Generated ${embeddedChunks.length} embeddings`);

                const agent = await Agent.create({
                    user_id: userId,
                    name,
                    type: 'website',
                    description: pageDescription,
                    logo_url: logoUrl,
                    source_url: url,
                    vector_store_id: `pending_${Date.now()}`,
                    metadata: {
                        totalPages: scrapedPages.length,
                        totalChunks: allChunks.length,
                        totalWords: summary.totalWords,
                        totalCharacters: summary.totalCharacters,
                        avgWordsPerPage: summary.avgWordsPerPage,
                        scrapedAt: new Date().toISOString(),
                        pages: summary.pages.slice(0, 10),
                    },
                });

                console.log(`[Agent Creation] Agent created: ${agent.id}`);

                const embeddingIds = await vectorStore.storeEmbeddings(agent.id, embeddedChunks);
                console.log(`[Agent Creation] Stored ${embeddingIds.length} embeddings in vector store`);

                // Store agent identity in memory service for website agent
                await memoryService.storeAgentIdentity(agent.id, {
                    name: agent.name,
                    type: 'website',
                    description: pageDescription,
                    sourceUrl: url
                }).catch(err => console.error('[Agent Creation] Failed to store memory identity:', err));

                // Store page-level summaries so identity/ownership questions have rich context
                await memoryService.storePageSummaries(agent.id, {
                    name: agent.name,
                    sourceUrl: url
                }, scrapedPages).catch(err => console.error('[Agent Creation] Failed to store page summaries:', err));

                await Agent.update(agent.id, {
                    vector_store_id: `agent_${agent.id}`,
                    metadata: {
                        ...agent.metadata,
                        embeddingCount: embeddingIds.length,
                        vectorStoreUpdatedAt: new Date().toISOString(),
                    },
                });

                console.log(`[Agent Creation] Agent ${agent.id} fully processed and ready`);
            } catch (error) {
                console.error('[Agent Creation] Background processing failed:', error);
            }
        })();
    } catch (error) {
        console.error('Error initiating website scraping:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to initiate website scraping',
            message: error.message,
        });
    }
}

// POST /api/agents/upload-document (multer handles file before this handler)
async function uploadDocument(req, res) {
    let filePath = null;
    try {
        const userId = req.auth.userId;
        const { name, description } = req.body;

        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }
        if (!name) {
            return res.status(400).json({ success: false, error: 'Agent name is required' });
        }

        filePath = req.file.path;
        const fileType = path.extname(req.file.originalname).toLowerCase().slice(1);

        res.json({ success: true, message: 'Document upload successful, processing started', status: 'processing' });

        (async () => {
            try {
                console.log(`[Agent Creation] Processing document: ${req.file.originalname}`);
                const validation = await documentProcessor.validateFile(filePath);
                if (!validation.valid) {
                    throw new Error(validation.error);
                }

                const { text, metadata: docMetadata } = await documentProcessor.processDocument(filePath, fileType);
                console.log(`[Agent Creation] Extracted ${text.length} characters`);

                const textChunker = new TextChunker(1500, 200);
                const chunks = await textChunker.chunkDocument(text, docMetadata);
                console.log(`[Agent Creation] Created ${chunks.length} chunks`);

                console.log(`[Agent Creation] Generating embeddings for ${chunks.length} chunks`);
                const embeddedChunks = await embeddingService.generateChunkEmbeddings(chunks);
                console.log(`[Agent Creation] Generated ${embeddedChunks.length} embeddings`);

                const agent = await Agent.create({
                    user_id: userId,
                    name,
                    type: 'document',
                    description: description || `Knowledge base from ${req.file.originalname}`,
                    source_url: req.file.originalname,
                    vector_store_id: `pending_${Date.now()}`,
                    metadata: {
                        fileName: req.file.originalname,
                        fileType,
                        fileSize: req.file.size,
                        totalChunks: chunks.length,
                        characterCount: text.length,
                        wordCount: docMetadata.wordCount,
                        processedAt: new Date().toISOString(),
                    },
                });

                console.log(`[Agent Creation] Agent created: ${agent.id}`);

                const embeddingIds = await vectorStore.storeEmbeddings(agent.id, embeddedChunks);
                console.log(`[Agent Creation] Stored ${embeddingIds.length} embeddings in vector store`);

                // Store agent identity in memory service for document agent
                await memoryService.storeAgentIdentity(agent.id, {
                    name: agent.name,
                    type: 'document',
                    description: description || `Knowledge base from ${req.file.originalname}`,
                    sourceUrl: req.file.originalname
                }).catch(err => console.error('[Agent Creation] Failed to store memory identity:', err));

                await Agent.update(agent.id, {
                    vector_store_id: `agent_${agent.id}`,
                    metadata: {
                        ...agent.metadata,
                        embeddingCount: embeddingIds.length,
                        vectorStoreUpdatedAt: new Date().toISOString(),
                    },
                });

                await fs.unlink(filePath);
                console.log(`[Agent Creation] Cleaned up temp file: ${filePath}`);
            } catch (error) {
                console.error('[Agent Creation] Background processing failed:', error);
                if (filePath) {
                    try { await fs.unlink(filePath); } catch (unlinkError) { console.error('Failed to clean up file:', unlinkError); }
                }
            }
        })();
    } catch (error) {
        console.error('Error initiating document upload:', error);
        if (filePath) {
            try { await fs.unlink(filePath); } catch (unlinkError) { console.error('Failed to clean up file:', unlinkError); }
        }
        res.status(500).json({ success: false, error: 'Failed to process document upload', message: error.message });
    }
}

// DELETE /api/agents/:id
async function deleteAgent(req, res) {
    try {
        const userId = req.auth.userId;
        const agentId = req.params.id;

        const agent = await Agent.findById(agentId);

        if (!agent) {
            return res.status(404).json({ success: false, error: 'Agent not found' });
        }
        if (agent.user_id !== userId) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        try {
            await vectorStore.deleteAgentEmbeddings(agentId);
            console.log(`[Agent Deletion] Deleted embeddings for agent ${agentId}`);
        } catch (error) {
            console.error('[Agent Deletion] Failed to delete embeddings:', error);
        }

        // Clear agent memories
        try {
            await memoryService.clearAgentMemories(agentId);
            console.log(`[Agent Deletion] Cleared memories for agent ${agentId}`);
        } catch (error) {
            console.error('[Agent Deletion] Failed to clear memories:', error);
        }

        await Agent.delete(agentId);

        res.json({ success: true, message: 'Agent deleted successfully' });
    } catch (error) {
        console.error('Error deleting agent:', error);
        res.status(500).json({ success: false, error: 'Failed to delete agent', message: error.message });
    }
}

module.exports = {
    getAgents,
    getAgentById,
    createAgentFromWebsite,
    uploadDocument,
    deleteAgent,
};


