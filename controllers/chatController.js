const Message     = require('../models/Message');
const Agent       = require('../models/Agent');
const ragService  = require('../services/ragService');
const llmService  = require('../services/llmService');
const vectorStore = require('../services/vectorStore');
const memoryService = require('../services/memoryService');
const { enqueueChatJob } = require('../redis_services/chatQueue');
const { checkRateLimit }  = require('../redis_services/rateLimiter');
const { isConnected }     = require('../redis_services/redisClient');

// ─── Rate-limit config ────────────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX       = Number(process.env.RATE_LIMIT_MAX       || 30);

// ─── GET /api/chat/:agentId/history ──────────────────────────────────────
async function getHistory(req, res) {
    try {
        const userId  = req.auth.userId;
        const agentId = req.params.agentId;
        const limit   = parseInt(req.query.limit) || 50;

        const agent = await Agent.findById(agentId);
        if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });
        if (agent.user_id !== userId) return res.status(403).json({ success: false, error: 'Access denied' });

        const messages = await Message.findByAgentId(agentId, { limit });
        res.json({ success: true, data: messages, count: messages.length });
    } catch (error) {
        console.error('Error fetching chat history:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch chat history', message: error.message });
    }
}

// ─── Core pipeline (runs inside the queue worker OR inline) ───────────────
/**
 * Execute the full RAG pipeline for a chat message.
 * This function is queue-safe: it only uses plain-serialisable inputs and
 * returns a plain-serialisable result so BullMQ can store it in Redis.
 */
async function runChatPipeline({ agentId, userId, content, isWidget }) {
    const startTime = Date.now();
    const sessionId = `${userId}_${agentId}`;

    const agent = await Agent.findById(agentId);
    if (!agent) throw new Error('Agent not found');

    // ── Save user message ──────────────────────────────────────────────────
    const userMessage = await Message.create({ agentId, role: 'user', content });

    console.log(`[Pipeline] Processing for agent: ${agent.name} | session: ${sessionId}`);

    // ── Identity bootstrap ─────────────────────────────────────────────────
    if (!isWidget) {
        const hasIdentity = await memoryService.hasStoredIdentity(agentId);
        if (!hasIdentity) {
            console.log(`[Pipeline] Storing identity for agent: ${agent.name}`);
            await memoryService.storeAgentIdentity(agentId, {
                name: agent.name, type: agent.type,
                description: agent.description, sourceUrl: agent.source_url,
            });
        }
    }

    // ── Memory + embeddings in parallel ───────────────────────────────────
    const [memoryContext, embeddingCount] = await Promise.all([
        isWidget
            ? Promise.resolve(null)
            : memoryService.buildMemoryContext(agentId, content, sessionId).catch(() => null),
        vectorStore.getEmbeddingCount(agentId).catch(() => 0),
    ]);

    if (memoryContext) console.log(`[Pipeline] Retrieved memory context`);

    if (embeddingCount === 0) {
        console.log(`[Pipeline] No embeddings for agent ${agent.name}`);
        const assistantMessage = await Message.create({
            agentId, role: 'assistant',
            content: `I don't have any knowledge loaded yet for ${agent.name}. Please wait for the agent's data to be processed, or try creating a new agent with content.`,
            metadata: { noEmbeddings: true, timestamp: new Date().toISOString() },
        });
        return {
            userMessage,
            assistantMessage,
            metadata: { noEmbeddings: true, processingTimeMs: Date.now() - startTime },
        };
    }

    // ── RAG retrieval ─────────────────────────────────────────────────────
    const retrievedData = await ragService.retrieveContext(agentId, content, {
        topK: 5, threshold: 0.5,
        includeConversationHistory: !isWidget,
        agentContext: { name: agent.name, type: agent.type, description: agent.description, sourceUrl: agent.source_url },
    });

    console.log(`[Pipeline] Retrieved ${retrievedData.chunks.length} chunks | avg sim: ${retrievedData.metadata.averageSimilarity.toFixed(3)}`);

    const isGenericRequest   = retrievedData.isGenericRequest;
    const isIdentityQuestion = retrievedData.isIdentityQuestion;
    const hasRelevantContext = isIdentityQuestion
        ? true
        : isGenericRequest
            ? retrievedData.chunks.length > 0
            : (retrievedData.chunks.length > 0 && retrievedData.metadata.averageSimilarity > 0.3);
    const shouldUseGeneralFallback = !hasRelevantContext && !isGenericRequest && !isIdentityQuestion;

    const agentContext = {
        name: agent.name, type: agent.type,
        description: agent.description, sourceUrl: agent.source_url,
        memoryContext,
    };

    // ── LLM call ──────────────────────────────────────────────────────────
    let llmResponse;

    if (isGenericRequest && (!hasRelevantContext || retrievedData.chunks.length < 3)) {
        // Tool-calling path: fetch all KB content then summarise
        console.log(`[Pipeline] Generic request — using tool calling`);

        const tools = [{
            type: 'function',
            function: {
                name: 'get_all_knowledge_base_content',
                description: `Fetches all content from the ${agent.name} knowledge base.`,
                parameters: {
                    type: 'object',
                    properties: { max_chunks: { type: 'number', description: 'Max chunks to retrieve (default 30)' } },
                    required: [],
                },
            },
        }];

        const toolExecutor = async (functionName, args) => {
            if (functionName === 'get_all_knowledge_base_content') {
                const allChunks = await vectorStore.getAllChunks(agentId, args.max_chunks || 30);
                if (allChunks.length === 0) return 'No content found in the knowledge base.';
                let out = `Content from ${agent.name} (${allChunks.length} sections):\n\n`;
                allChunks.forEach((chunk, i) => {
                    const src = chunk.metadata?.sourceUrl || chunk.metadata?.pageTitle || `Section ${i + 1}`;
                    out += `[${src}]\n${chunk.content}\n\n`;
                });
                return out;
            }
            return 'Unknown tool';
        };

        const systemPrompt = `You are an AI assistant for "${agent.name}", a ${agent.type === 'website' ? 'website' : 'document'} knowledge base.
${agent.description ? `About ${agent.name}: ${agent.description}` : ''}
${agent.source_url ? `Source: ${agent.source_url}` : ''}

Use the get_all_knowledge_base_content tool to fetch the content, then provide a comprehensive response. Be thorough but concise.`;

        llmResponse = await llmService.generateWithTools(systemPrompt, content, tools, toolExecutor);

    } else if (shouldUseGeneralFallback) {
        // Direct LLM fallback — no KB context found, send raw question
        console.log(`[Pipeline] No relevant KB context — direct LLM fallback`);
        llmResponse = await llmService.generateChatResponse(
            [{ role: 'user', content }],
            { model: 'gpt-4o-mini' }
        );

    } else {
        // Standard RAG path
        if (isGenericRequest) console.log(`[Pipeline] Generic request with chunks — standard RAG`);
        const conversationHistory = isWidget ? [] : retrievedData.conversationHistory;
        const prompt = ragService.buildPrompt(content, retrievedData.context, conversationHistory, agentContext, hasRelevantContext, isGenericRequest, isIdentityQuestion);
        llmResponse = await llmService.generateResponse(prompt);
    }

    // ── Persist + return ──────────────────────────────────────────────────
    if (!isWidget) {
        memoryService.addConversationMemory(agentId, sessionId, content, llmResponse.content)
            .catch(err => console.error('[Pipeline] Failed to store memory:', err));
    }

    const assistantMessage = await Message.create({
        agentId, role: 'assistant',
        content: llmResponse.content,
        metadata: {
            model:             llmResponse.model,
            tokensUsed:        llmResponse.usage?.totalTokens,
            chunksRetrieved:   shouldUseGeneralFallback ? 0 : retrievedData.chunks.length,
            averageSimilarity: shouldUseGeneralFallback ? 0 : retrievedData.metadata.averageSimilarity,
            sources:           shouldUseGeneralFallback ? [] : ragService.extractSources(retrievedData.chunks),
            processingTimeMs:  Date.now() - startTime,
        },
    });

    const totalTime = Date.now() - startTime;
    console.log(`[Pipeline] Done in ${totalTime}ms`);

    return {
        userMessage,
        assistantMessage,
        metadata: {
            processingTimeMs: totalTime,
            chunksRetrieved:  shouldUseGeneralFallback ? 0 : retrievedData.chunks.length,
            tokensUsed:       llmResponse.usage?.totalTokens,
            queued:           isConnected(),
        },
    };
}

// ─── POST /api/chat/send ──────────────────────────────────────────────────
async function sendMessage(req, res) {
    try {
        const userId  = req.auth.userId;
        const { agentId, content } = req.body;

        if (!agentId || !content) {
            return res.status(400).json({ success: false, error: 'Agent ID and content are required' });
        }

        // ── Auth check (must happen before queueing) ───────────────────────
        const agent = await Agent.findById(agentId);
        if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });
        if (agent.user_id !== userId) return res.status(403).json({ success: false, error: 'Access denied' });

        // ── Per-user rate limit ────────────────────────────────────────────
        const rl = await checkRateLimit(`chat:${userId}`, {
            windowMs: RATE_LIMIT_WINDOW_MS,
            max:      RATE_LIMIT_MAX,
        });

        res.setHeader('X-RateLimit-Limit',     RATE_LIMIT_MAX);
        res.setHeader('X-RateLimit-Remaining', rl.remaining);
        res.setHeader('X-RateLimit-Reset',     Math.ceil(rl.resetMs / 1000));

        if (!rl.allowed) {
            return res.status(429).json({
                success: false,
                error:   'Too many requests — please slow down.',
                retryAfterMs: rl.resetMs - Date.now(),
            });
        }

        // ── Route through Redis queue or run inline ────────────────────────
        let result;
        if (isConnected()) {
            result = await enqueueChatJob({ agentId, userId, content, isWidget: false });
        } else {
            console.warn('[Chat] Redis unavailable — running pipeline inline');
            result = await runChatPipeline({ agentId, userId, content, isWidget: false });
        }

        return res.json({ success: true, data: result });

    } catch (error) {
        console.error('Error sending message:', error);
        try {
            const errorMessage = await Message.create({
                agentId: req.body.agentId, role: 'assistant',
                content: 'Sorry, I encountered an error while processing your message. Please try again.',
                metadata: { error: error.message, timestamp: new Date().toISOString() },
            });
            return res.status(500).json({
                success: false, error: 'Failed to generate response',
                message: llmService.formatErrorMessage(error),
                data: { errorMessage },
            });
        } catch (_) {
            return res.status(500).json({ success: false, error: 'Failed to send message', message: error.message });
        }
    }
}

// ─── POST /api/chat/widget ────────────────────────────────────────────────
async function widgetMessage(req, res) {
    try {
        const { agentId, content } = req.body;

        if (!agentId || !content) {
            return res.status(400).json({ success: false, error: 'Agent ID and content are required' });
        }

        const agent = await Agent.findById(agentId);
        if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });

        // ── Per-agent widget rate limit (IP-based, more lenient) ───────────
        const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
        const rl = await checkRateLimit(`widget:${agentId}:${ip}`, {
            windowMs: 60_000,
            max:      20,
        });

        if (!rl.allowed) {
            return res.status(429).json({
                success: false,
                error: 'Too many requests — please wait a moment.',
                retryAfterMs: rl.resetMs - Date.now(),
            });
        }

        // ── Route through Redis queue or run inline ────────────────────────
        let result;
        if (isConnected()) {
            result = await enqueueChatJob({ agentId, userId: `widget_${agentId}`, content, isWidget: true });
        } else {
            result = await runChatPipeline({ agentId, userId: `widget_${agentId}`, content, isWidget: true });
        }

        return res.json({
            success: true,
            data: { content: result.assistantMessage.content, processingTimeMs: result.metadata.processingTimeMs },
        });

    } catch (error) {
        console.error('Error in widget message:', error);
        res.status(500).json({
            success: false, error: 'Failed to generate response',
            data: { content: 'Sorry, I encountered an error. Please try again.' },
        });
    }
}

// ─── POST /api/chat/context ───────────────────────────────────────────────
async function getContext(req, res) {
    try {
        const userId  = req.auth.userId;
        const { agentId, query } = req.body;

        if (!agentId || !query) return res.status(400).json({ success: false, error: 'Agent ID and query are required' });

        const agent = await Agent.findById(agentId);
        if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });
        if (agent.user_id !== userId) return res.status(403).json({ success: false, error: 'Access denied' });

        const retrievedData = await ragService.retrieveContext(agentId, query, { topK: 5, threshold: 0.7 });
        const stats = ragService.getContextStats(retrievedData);

        res.json({ success: true, data: { query, chunks: retrievedData.chunks, formattedContext: retrievedData.context, stats } });
    } catch (error) {
        console.error('Error retrieving context:', error);
        res.status(500).json({ success: false, error: 'Failed to retrieve context', message: error.message });
    }
}

// ─── GET /api/chat/test-llm ───────────────────────────────────────────────
async function testLLM(req, res) {
    try {
        const isWorking = await llmService.test();
        res.json({ success: true, llmWorking: isWorking, models: llmService.getAvailableModels() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// ─── GET /api/chat/queue-stats ────────────────────────────────────────────
async function queueStats(req, res) {
    try {
        const { getChatQueueStats } = require('../redis_services/chatQueue');
        const stats = await getChatQueueStats();
        res.json({ success: true, data: { redisConnected: isConnected(), queue: stats } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

module.exports = {
    getHistory, sendMessage, getContext, testLLM, widgetMessage, queueStats,
    runChatPipeline, // exported so the queue worker can import it
};
