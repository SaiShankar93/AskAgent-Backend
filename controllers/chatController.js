const Message = require('../models/Message');
const Agent = require('../models/Agent');
const ragService = require('../services/ragService');
const llmService = require('../services/llmService');
const vectorStore = require('../services/vectorStore');
const memoryService = require('../services/memoryService');

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

        const startTime = Date.now();

        const userMessage = await Message.create({ agentId, role: 'user', content });

        console.log(`[Chat] Processing message for agent: ${agent.name}`);

        // Generate a session ID for this user+agent combination
        const sessionId = `${userId}_${agentId}`;

        // Ensure agent identity is stored in memory (first-time setup)
        const hasIdentity = await memoryService.hasStoredIdentity(agentId);
        if (!hasIdentity) {
            console.log(`[Chat] Storing identity for agent: ${agent.name}`);
            await memoryService.storeAgentIdentity(agentId, {
                name: agent.name,
                type: agent.type,
                description: agent.description,
                sourceUrl: agent.source_url
            });
        }

        // Build memory context from past interactions and identity
        const memoryContext = await memoryService.buildMemoryContext(agentId, content, sessionId);
        if (memoryContext) {
            console.log(`[Chat] Retrieved memory context`);
        }

        const embeddingCount = await vectorStore.getEmbeddingCount(agentId).catch(() => 0);
        if (embeddingCount === 0) {
            console.log(`[Chat] No embeddings found for agent ${agent.name}`);
            const assistantMessage = await Message.create({
                agentId,
                role: 'assistant',
                content: `I don't have any knowledge loaded yet for ${agent.name}. Please wait for the agent's data to be processed, or try creating a new agent with content.`,
                metadata: { noEmbeddings: true, timestamp: new Date().toISOString() },
            });
            return res.json({ success: true, data: { userMessage, assistantMessage, metadata: { noEmbeddings: true, message: 'Agent has no knowledge base yet' } } });
        }

        const retrievedData = await ragService.retrieveContext(agentId, content, { topK: 5, threshold: 0.5, includeConversationHistory: true });

        console.log(`[Chat] Retrieved ${retrievedData.chunks.length} relevant chunks`);
        console.log(`[Chat] Average similarity: ${retrievedData.metadata.averageSimilarity.toFixed(3)}`);
        
        // For generic requests (summarize, outline), lower the bar for context relevance
        const isGenericRequest = retrievedData.isGenericRequest;
        const hasRelevantContext = isGenericRequest 
            ? retrievedData.chunks.length > 0 
            : (retrievedData.chunks.length > 0 && retrievedData.metadata.averageSimilarity > 0.3);
        
        // Build agent context information
        const agentContext = {
            name: agent.name,
            type: agent.type, // 'website' or 'document'
            description: agent.description,
            sourceUrl: agent.source_url,
            memoryContext: memoryContext, // Include memory context
        };
        
        let llmResponse;
        
        // If generic request with no/low relevant chunks, use tool calling to get all content
        if (isGenericRequest && (!hasRelevantContext || retrievedData.chunks.length < 3)) {
            console.log(`[Chat] Generic request with insufficient context - using tool calling to fetch all content`);
            
            // Define the tool for fetching all knowledge base content
            const tools = [
                {
                    type: 'function',
                    function: {
                        name: 'get_all_knowledge_base_content',
                        description: `Fetches all content from the ${agent.name} knowledge base. Use this when you need to summarize, create an outline, or provide an overview of the entire content.`,
                        parameters: {
                            type: 'object',
                            properties: {
                                max_chunks: {
                                    type: 'number',
                                    description: 'Maximum number of content chunks to retrieve (default: 30)',
                                },
                            },
                            required: [],
                        },
                    },
                },
            ];
            
            // Tool executor function
            const toolExecutor = async (functionName, args) => {
                if (functionName === 'get_all_knowledge_base_content') {
                    const maxChunks = args.max_chunks || 30;
                    const allChunks = await vectorStore.getAllChunks(agentId, maxChunks);
                    
                    if (allChunks.length === 0) {
                        return 'No content found in the knowledge base.';
                    }
                    
                    // Format chunks as content
                    let formattedContent = `Content from ${agent.name} (${allChunks.length} sections):\n\n`;
                    allChunks.forEach((chunk, index) => {
                        const source = chunk.metadata?.sourceUrl || chunk.metadata?.pageTitle || `Section ${index + 1}`;
                        formattedContent += `[${source}]\n${chunk.content}\n\n`;
                    });
                    
                    return formattedContent;
                }
                return 'Unknown tool';
            };
            
            // Build system prompt for tool-based response
            const systemPrompt = `You are an AI assistant for "${agent.name}", a ${agent.type === 'website' ? 'website' : 'document'} knowledge base.
${agent.description ? `About ${agent.name}: ${agent.description}` : ''}
${agent.source_url ? `Source: ${agent.source_url}` : ''}

The user wants to ${content.toLowerCase().includes('summarize') ? 'get a summary of' : content.toLowerCase().includes('outline') ? 'see an outline of' : 'learn about'} the knowledge base content.

Use the get_all_knowledge_base_content tool to fetch the content, then provide a comprehensive response based on what you retrieve.
Be thorough but concise. Organize your response clearly.`;

            llmResponse = await llmService.generateWithTools(systemPrompt, content, tools, toolExecutor);
            
        } else {
            // Standard RAG response
            if (isGenericRequest) {
                console.log(`[Chat] Generic request detected - using retrieved chunks for comprehensive response`);
            }
            
            const prompt = ragService.buildPrompt(content, retrievedData.context, retrievedData.conversationHistory, agentContext, hasRelevantContext, isGenericRequest);
            llmResponse = await llmService.generateResponse(prompt);
        }

        // Store conversation in memory for future reference
        memoryService.addConversationMemory(agentId, sessionId, content, llmResponse.content)
            .catch(err => console.error('[Chat] Failed to store conversation memory:', err));

        const assistantMessage = await Message.create({
            agentId,
            role: 'assistant',
            content: llmResponse.content,
            metadata: {
                model: llmResponse.model,
                tokensUsed: llmResponse.usage.totalTokens,
                chunksRetrieved: retrievedData.chunks.length,
                averageSimilarity: retrievedData.metadata.averageSimilarity,
                sources: ragService.extractSources(retrievedData.chunks),
                processingTimeMs: Date.now() - startTime,
            },
        });

        const totalTime = Date.now() - startTime;
        console.log(`[Chat] Response generated in ${totalTime}ms`);

        res.json({ success: true, data: { userMessage, assistantMessage, metadata: { processingTimeMs: totalTime, chunksRetrieved: retrievedData.chunks.length, tokensUsed: llmResponse.usage.totalTokens } } });
    } catch (error) {
        console.error('Error sending message:', error);
        try {
            const errorMessage = await Message.create({
                agentId: req.body.agentId,
                role: 'assistant',
                content: 'Sorry, I encountered an error while processing your message. Please try again.',
                metadata: { error: error.message, timestamp: new Date().toISOString() },
            });
            return res.status(500).json({ success: false, error: 'Failed to generate response', message: llmService.formatErrorMessage(error), data: { errorMessage } });
        } catch (saveError) {
            return res.status(500).json({ success: false, error: 'Failed to send message', message: error.message });
        }
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

module.exports = { getHistory, sendMessage, getContext, testLLM, widgetMessage };


