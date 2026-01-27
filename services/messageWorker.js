const messageQueueService = require('../services/messageQueue');
const Message = require('../models/Message');
const Agent = require('../models/Agent');
const ragService = require('../services/ragService');
const llmService = require('../services/llmService');
const vectorStore = require('../services/vectorStore');
const memoryService = require('../services/memoryService');

class MessageWorker {
    constructor() {
        this.isRunning = false;
        this.processingInterval = null;
        this.pollInterval = 1000; // Poll every 1 second
    }

    /**
     * Start the worker to process messages from the queue
     */
    start() {
        if (this.isRunning) {
            console.log('[Worker] Worker is already running');
            return;
        }

        this.isRunning = true;
        console.log('[Worker] Starting message worker...');

        // Start processing loop
        this.processingInterval = setInterval(async () => {
            await this.processNext();
        }, this.pollInterval);

        console.log('[Worker] Message worker started');
    }

    /**
     * Stop the worker
     */
    stop() {
        if (!this.isRunning) {
            console.log('[Worker] Worker is not running');
            return;
        }

        this.isRunning = false;
        
        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }

        console.log('[Worker] Message worker stopped');
    }

    /**
     * Process the next message in the queue
     */
    async processNext() {
        try {
            // Dequeue a message
            const message = await messageQueueService.dequeue();

            if (!message) {
                // Queue is empty, nothing to process
                return;
            }

            console.log(`[Worker] Processing message ${message.id}`);

            try {
                // Process the message
                const result = await this.processMessage(message.data);

                // Mark as complete and store result
                await messageQueueService.markComplete(message.id, result);

                console.log(`[Worker] Message ${message.id} processed successfully`);
            } catch (error) {
                console.error(`[Worker] Error processing message ${message.id}:`, error);
                
                // Mark as failed (will retry or move to failed queue)
                await messageQueueService.markFailed(message.id, error);
            }
        } catch (error) {
            console.error('[Worker] Error in processNext:', error);
        }
    }

    /**
     * Process a chat message
     * @param {Object} messageData - The message data
     * @returns {Promise<Object>} - The processing result
     */
    async processMessage(messageData) {
        const { userId, agentId, content } = messageData;

        // Validate input
        if (!agentId || !content) {
            throw new Error('Agent ID and content are required');
        }

        // Find the agent
        const agent = await Agent.findById(agentId);
        if (!agent) {
            throw new Error('Agent not found');
        }

        // Check access permissions
        if (agent.user_id !== userId) {
            throw new Error('Access denied');
        }

        const startTime = Date.now();

        // Create user message
        const userMessage = await Message.create({ agentId, role: 'user', content });

        console.log(`[Worker] Processing message for agent: ${agent.name}`);

        // Generate a session ID for this user+agent combination
        const sessionId = `${userId}_${agentId}`;

        // Ensure agent identity is stored in memory (first-time setup)
        const hasIdentity = await memoryService.hasStoredIdentity(agentId);
        if (!hasIdentity) {
            console.log(`[Worker] Storing identity for agent: ${agent.name}`);
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
            console.log(`[Worker] Retrieved memory context`);
        }

        // Check if agent has embeddings
        const embeddingCount = await vectorStore.getEmbeddingCount(agentId).catch(() => 0);
        if (embeddingCount === 0) {
            console.log(`[Worker] No embeddings found for agent ${agent.name}`);
            const assistantMessage = await Message.create({
                agentId,
                role: 'assistant',
                content: `I don't have any knowledge loaded yet for ${agent.name}. Please wait for the agent's data to be processed, or try creating a new agent with content.`,
                metadata: { noEmbeddings: true, timestamp: new Date().toISOString() },
            });
            
            return {
                userMessage,
                assistantMessage,
                metadata: { noEmbeddings: true, message: 'Agent has no knowledge base yet' }
            };
        }

        // Retrieve relevant context using RAG
        const retrievedData = await ragService.retrieveContext(agentId, content, { 
            topK: 5, 
            threshold: 0.5, 
            includeConversationHistory: true 
        });

        console.log(`[Worker] Retrieved ${retrievedData.chunks.length} relevant chunks`);
        console.log(`[Worker] Average similarity: ${retrievedData.metadata.averageSimilarity.toFixed(3)}`);
        
        // For generic requests (summarize, outline), lower the bar for context relevance
        const isGenericRequest = retrievedData.isGenericRequest;
        const hasRelevantContext = isGenericRequest 
            ? retrievedData.chunks.length > 0 
            : (retrievedData.chunks.length > 0 && retrievedData.metadata.averageSimilarity > 0.3);
        
        // Build agent context information
        const agentContext = {
            name: agent.name,
            type: agent.type,
            description: agent.description,
            sourceUrl: agent.source_url,
            memoryContext: memoryContext,
        };
        
        let llmResponse;
        
        // If generic request with no/low relevant chunks, use tool calling to get all content
        if (isGenericRequest && (!hasRelevantContext || retrievedData.chunks.length < 3)) {
            console.log(`[Worker] Generic request with insufficient context - using tool calling to fetch all content`);
            
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
                console.log(`[Worker] Generic request detected - using retrieved chunks for comprehensive response`);
            }
            
            const prompt = ragService.buildPrompt(content, retrievedData.context, retrievedData.conversationHistory, agentContext, hasRelevantContext, isGenericRequest);
            llmResponse = await llmService.generateResponse(prompt);
        }

        // Store conversation in memory for future reference
        memoryService.addConversationMemory(agentId, sessionId, content, llmResponse.content)
            .catch(err => console.error('[Worker] Failed to store conversation memory:', err));

        // Create assistant message
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
        console.log(`[Worker] Response generated in ${totalTime}ms`);

        return {
            userMessage,
            assistantMessage,
            metadata: {
                processingTimeMs: totalTime,
                chunksRetrieved: retrievedData.chunks.length,
                tokensUsed: llmResponse.usage.totalTokens
            }
        };
    }
}

// Export singleton instance
const messageWorker = new MessageWorker();

module.exports = messageWorker;
