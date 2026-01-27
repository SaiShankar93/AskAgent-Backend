const Message = require('../models/Message');
const Agent = require('../models/Agent');
const ragService = require('../services/ragService');
const llmService = require('../services/llmService');
const vectorStore = require('../services/vectorStore');
const memoryService = require('../services/memoryService');
const messageQueueService = require('../services/messageQueue');

// GET /api/chat/:agentId/history
async function getHistory(req, res) {
    try {
        const userId = req.auth.userId;
        const agentId = req.params.agentId;
        const limit = parseInt(req.query.limit) || 50;

        const agent = await Agent.findById(agentId);
        if (!agent) {
            return res.status(404).json({ success: false, error: 'Agent not found' });
        }
        if (agent.user_id !== userId) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const messages = await Message.findByAgentId(agentId, { limit });

        res.json({ success: true, data: messages, count: messages.length });
    } catch (error) {
        console.error('Error fetching chat history:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch chat history', message: error.message });
    }
}

// POST /api/chat/send
async function sendMessage(req, res) {
    try {
        const userId = req.auth.userId;
        const { agentId, content } = req.body;

        if (!agentId || !content) {
            return res.status(400).json({ success: false, error: 'Agent ID and content are required' });
        }

        const agent = await Agent.findById(agentId);
        if (!agent) {
            return res.status(404).json({ success: false, error: 'Agent not found' });
        }
        if (agent.user_id !== userId) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        console.log(`[Chat] Enqueueing message for agent: ${agent.name}`);

        // Enqueue the message for asynchronous processing
        const messageId = await messageQueueService.enqueue({
            userId,
            agentId,
            content,
        });

        // Return immediately with message ID
        res.json({ 
            success: true, 
            data: { 
                messageId,
                status: 'queued',
                message: 'Your message has been queued for processing'
            } 
        });
    } catch (error) {
        console.error('Error enqueueing message:', error);
        return res.status(500).json({ success: false, error: 'Failed to queue message', message: error.message });
    }
}

// POST /api/chat/context
async function getContext(req, res) {
    try {
        const userId = req.auth.userId;
        const { agentId, query } = req.body;

        if (!agentId || !query) {
            return res.status(400).json({ success: false, error: 'Agent ID and query are required' });
        }

        const agent = await Agent.findById(agentId);
        if (!agent) {
            return res.status(404).json({ success: false, error: 'Agent not found' });
        }
        if (agent.user_id !== userId) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const retrievedData = await ragService.retrieveContext(agentId, query, { topK: 5, threshold: 0.7 });
        const stats = ragService.getContextStats(retrievedData);

        res.json({ success: true, data: { query, chunks: retrievedData.chunks, formattedContext: retrievedData.context, stats } });
    } catch (error) {
        console.error('Error retrieving context:', error);
        res.status(500).json({ success: false, error: 'Failed to retrieve context', message: error.message });
    }
}

// GET /api/chat/test-llm
async function testLLM(req, res) {
    try {
        const isWorking = await llmService.test();
        res.json({ success: true, llmWorking: isWorking, models: llmService.getAvailableModels() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// POST /api/chat/widget - Public endpoint for embedded widget
async function widgetMessage(req, res) {
    try {
        const { agentId, content } = req.body;

        if (!agentId || !content) {
            return res.status(400).json({ success: false, error: 'Agent ID and content are required' });
        }

        const agent = await Agent.findById(agentId);
        if (!agent) {
            return res.status(404).json({ success: false, error: 'Agent not found' });
        }

        const startTime = Date.now();

        console.log(`[Widget] Processing message for agent: ${agent.name}`);

        const embeddingCount = await vectorStore.getEmbeddingCount(agentId).catch(() => 0);
        if (embeddingCount === 0) {
            return res.json({ 
                success: true, 
                data: { 
                    content: `I don't have any knowledge loaded yet. Please check back later.` 
                } 
            });
        }

        const retrievedData = await ragService.retrieveContext(agentId, content, { topK: 5, threshold: 0.5, includeConversationHistory: false });

        const isGenericRequest = retrievedData.isGenericRequest;
        const hasRelevantContext = isGenericRequest 
            ? retrievedData.chunks.length > 0 
            : (retrievedData.chunks.length > 0 && retrievedData.metadata.averageSimilarity > 0.3);

        const agentContext = {
            name: agent.name,
            type: agent.type,
            description: agent.description,
            sourceUrl: agent.source_url,
        };

        let llmResponse;

        if (isGenericRequest && (!hasRelevantContext || retrievedData.chunks.length < 3)) {
            const tools = [
                {
                    type: 'function',
                    function: {
                        name: 'get_all_knowledge_base_content',
                        description: `Fetches all content from the ${agent.name} knowledge base.`,
                        parameters: {
                            type: 'object',
                            properties: {
                                max_chunks: { type: 'number', description: 'Maximum chunks to retrieve' },
                            },
                            required: [],
                        },
                    },
                },
            ];

            const toolExecutor = async (functionName, args) => {
                if (functionName === 'get_all_knowledge_base_content') {
                    const allChunks = await vectorStore.getAllChunks(agentId, args.max_chunks || 30);
                    if (allChunks.length === 0) return 'No content found.';
                    let formattedContent = `Content from ${agent.name}:\n\n`;
                    allChunks.forEach((chunk, index) => {
                        formattedContent += `${chunk.content}\n\n`;
                    });
                    return formattedContent;
                }
                return 'Unknown tool';
            };

            const systemPrompt = `You are an AI assistant for "${agent.name}". Be helpful and concise.`;
            llmResponse = await llmService.generateWithTools(systemPrompt, content, tools, toolExecutor);
        } else {
            const prompt = ragService.buildPrompt(content, retrievedData.context, [], agentContext, hasRelevantContext, isGenericRequest);
            llmResponse = await llmService.generateResponse(prompt);
        }

        const totalTime = Date.now() - startTime;
        console.log(`[Widget] Response generated in ${totalTime}ms`);

        res.json({ 
            success: true, 
            data: { 
                content: llmResponse.content,
                processingTimeMs: totalTime 
            } 
        });
    } catch (error) {
        console.error('Error in widget message:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to generate response',
            data: { content: 'Sorry, I encountered an error. Please try again.' }
        });
    }
}

// GET /api/chat/status/:messageId - Check status of a queued message
async function getMessageStatus(req, res) {
    try {
        const messageId = req.params.messageId;

        if (!messageId) {
            return res.status(400).json({ success: false, error: 'Message ID is required' });
        }

        // Check if result is available
        const result = await messageQueueService.getResult(messageId);

        if (result) {
            // Message has been processed
            return res.json({
                success: true,
                data: {
                    messageId,
                    status: result.status,
                    result: result.result,
                    completedAt: result.completedAt
                }
            });
        }

        // Check queue statistics to determine if message is still in queue
        const stats = await messageQueueService.getStats();

        return res.json({
            success: true,
            data: {
                messageId,
                status: 'processing',
                queueStats: stats,
                message: 'Message is being processed'
            }
        });
    } catch (error) {
        console.error('Error checking message status:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to check message status', 
            message: error.message 
        });
    }
}

// GET /api/chat/queue/stats - Get queue statistics
async function getQueueStats(req, res) {
    try {
        const stats = await messageQueueService.getStats();
        res.json({ success: true, data: stats });
    } catch (error) {
        console.error('Error getting queue stats:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to get queue stats', 
            message: error.message 
        });
    }
}

module.exports = { getHistory, sendMessage, getContext, testLLM, widgetMessage, getMessageStatus, getQueueStats };


