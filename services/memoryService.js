/**
 * Memory Service using Mem0 for Agent Conversation Memory
 * 
 * This service provides persistent memory for agents, allowing them to:
 * - Remember their identity (what website/document they represent)
 * - Store conversation history
 * - Recall relevant context from past interactions
 */

const { Memory } = require('mem0ai/oss');
const path = require('path');

// Memory instance (initialized lazily)
let memoryInstance = null;

/**
 * Initialize the Mem0 memory system
 * Uses OpenAI for embeddings and LLM, with in-memory vector store
 */
const initializeMemory = async () => {
    if (memoryInstance) {
        return memoryInstance;
    }

    try {
        memoryInstance = new Memory({
            version: "v1.1",
            embedder: {
                provider: "openai",
                config: {
                    apiKey: process.env.OPENAI_API_KEY,
                    model: "text-embedding-3-small"
                }
            },
            vectorStore: {
                provider: "memory",
                config: {
                    collectionName: "agent_memories",
                    dimension: 1536
                }
            },
            llm: {
                provider: "openai",
                config: {
                    apiKey: process.env.OPENAI_API_KEY,
                    model: "gpt-4o"
                }
            },
            historyDbPath: path.join(__dirname, '../data/memory.db')
        });

        console.log('✅ Mem0 memory service initialized');
        return memoryInstance;
    } catch (error) {
        console.error('❌ Failed to initialize memory service:', error);
        throw error;
    }
};

/**
 * Store agent identity in memory
 * Called when an agent is created or on first interaction
 * 
 * @param {string} agentId - The agent's unique identifier
 * @param {Object} agentInfo - Agent metadata (name, type, description, sourceUrl)
 */
const storeAgentIdentity = async (agentId, agentInfo) => {
    try {
        const memory = await initializeMemory();

        const { name, type, description, sourceUrl } = agentInfo;

        // Create identity messages that the memory system will store
        const identityMessages = [
            {
                role: "system",
                content: `I am an AI assistant named "${name}". I was created to help users with questions about ${type === 'website' ? 'the website' : 'the document'} "${name}".`
            },
            {
                role: "system",
                content: description
                    ? `My purpose is: ${description}`
                    : `I help users understand and navigate the content of ${name}.`
            }
        ];

        if (sourceUrl) {
            identityMessages.push({
                role: "system",
                content: `My knowledge source is: ${sourceUrl}`
            });
        }

        identityMessages.push({
            role: "system",
            content: `When users ask who I am, I should explain that I am the AI assistant for "${name}" and I'm here to help answer questions about its content.`
        });

        // Store identity with agent-specific metadata
        await memory.add(identityMessages, {
            agentId: agentId,
            metadata: {
                type: "identity",
                agentName: name,
                agentType: type,
                sourceUrl: sourceUrl || null
            }
        });

        console.log(`✅ Stored identity for agent: ${name} (${agentId})`);
        return true;
    } catch (error) {
        console.error('❌ Failed to store agent identity:', error);
        return false;
    }
};

/**
 * Add a conversation exchange to memory
 * 
 * @param {string} agentId - The agent's unique identifier
 * @param {string} sessionId - The conversation session ID
 * @param {string} userMessage - The user's message
 * @param {string} assistantMessage - The assistant's response
 */
const addConversationMemory = async (agentId, sessionId, userMessage, assistantMessage) => {
    try {
        const memory = await initializeMemory();

        const messages = [
            { role: "user", content: userMessage },
            { role: "assistant", content: assistantMessage }
        ];

        await memory.add(messages, {
            agentId: agentId,
            userId: sessionId,
            metadata: {
                type: "conversation",
                timestamp: new Date().toISOString()
            }
        });

        console.log(`✅ Added conversation memory for agent ${agentId}`);
        return true;
    } catch (error) {
        console.error('❌ Failed to add conversation memory:', error);
        return false;
    }
};

/**
 * Search for relevant memories based on the user's query
 * 
 * @param {string} agentId - The agent's unique identifier
 * @param {string} query - The search query
 * @param {string} sessionId - Optional session ID to prioritize recent conversations
 * @returns {Array} - Relevant memories
 */
const searchMemories = async (agentId, query, sessionId = null) => {
    try {
        const memory = await initializeMemory();

        // Search for relevant memories
        const searchOptions = {
            agentId: agentId,
            limit: 5
        };

        if (sessionId) {
            searchOptions.userId = sessionId;
        }

        const results = await memory.search(query, searchOptions);

        console.log(`🔍 Found ${results?.length || 0} relevant memories for query`);
        return results || [];
    } catch (error) {
        console.error('❌ Failed to search memories:', error);
        return [];
    }
};

/**
 * Get agent identity from memory
 * 
 * @param {string} agentId - The agent's unique identifier
 * @returns {Object|null} - Agent identity info or null
 */
const getAgentIdentity = async (agentId) => {
    try {
        const memory = await initializeMemory();

        // Search for identity memories
        const results = await memory.search("who am I and what is my purpose", {
            agentId: agentId,
            limit: 3
        });

        if (results && results.length > 0) {
            return {
                memories: results,
                hasIdentity: true
            };
        }

        return { hasIdentity: false, memories: [] };
    } catch (error) {
        console.error('❌ Failed to get agent identity:', error);
        return { hasIdentity: false, memories: [] };
    }
};

/**
 * Get all memories for an agent
 * 
 * @param {string} agentId - The agent's unique identifier
 * @returns {Array} - All memories for the agent
 */
const getAllMemories = async (agentId) => {
    try {
        const memory = await initializeMemory();

        const results = await memory.getAll({
            agentId: agentId
        });

        // mem0 returns { memories: [...] } or similar structure
        if (Array.isArray(results)) {
            return results;
        }
        if (results && Array.isArray(results.memories)) {
            return results.memories;
        }
        if (results && Array.isArray(results.results)) {
            return results.results;
        }
        return [];
    } catch (error) {
        console.error('❌ Failed to get all memories:', error);
        return [];
    }
};

/**
 * Clear all memories for an agent
 * Useful when an agent is deleted or reset
 * 
 * @param {string} agentId - The agent's unique identifier
 */
const clearAgentMemories = async (agentId) => {
    try {
        const memory = await initializeMemory();

        // Get all memories for this agent
        const allMemories = await getAllMemories(agentId);

        // Delete each memory
        for (const mem of allMemories) {
            if (mem.id) {
                await memory.delete(mem.id);
            }
        }

        console.log(`🗑️ Cleared memories for agent ${agentId}`);
        return true;
    } catch (error) {
        console.error('❌ Failed to clear agent memories:', error);
        return false;
    }
};

/**
 * Build memory context for the prompt
 * Combines identity and relevant conversation memories
 * 
 * @param {string} agentId - The agent's unique identifier  
 * @param {string} query - The user's current query
 * @param {string} sessionId - The session ID
 * @returns {string} - Memory context string to add to prompt
 */
const buildMemoryContext = async (agentId, query, sessionId) => {
    try {
        // Check if this is a personal/identity question
        const identityPatterns = [
            /who are you/i,
            /what are you/i,
            /tell me about yourself/i,
            /your name/i,
            /how are you/i,
            /what can you do/i,
            /what do you know/i,
            /introduce yourself/i,
            /what is your purpose/i,
            /why were you created/i
        ];

        const isIdentityQuestion = identityPatterns.some(pattern => pattern.test(query));

        let memoryContext = "";

        // Always search for relevant memories
        const memories = await searchMemories(agentId, query, sessionId);

        if (isIdentityQuestion) {
            // For identity questions, prioritize identity memories
            const identityInfo = await getAgentIdentity(agentId);

            if (identityInfo.hasIdentity && identityInfo.memories.length > 0) {
                memoryContext += "=== YOUR IDENTITY (FROM MEMORY) ===\n";
                identityInfo.memories.forEach(mem => {
                    if (mem.memory) {
                        memoryContext += `• ${mem.memory}\n`;
                    }
                });
                memoryContext += "\n";
            }
        }

        // Add relevant conversation memories
        if (memories.length > 0) {
            memoryContext += "=== RELEVANT PAST INTERACTIONS ===\n";
            memories.forEach(mem => {
                if (mem.memory) {
                    memoryContext += `• ${mem.memory}\n`;
                }
            });
            memoryContext += "\n";
        }

        return memoryContext;
    } catch (error) {
        console.error('❌ Failed to build memory context:', error);
        return "";
    }
};

/**
 * Check if an agent has stored identity
 * 
 * @param {string} agentId - The agent's unique identifier
 * @returns {boolean} - Whether the agent has stored identity
 */
const hasStoredIdentity = async (agentId) => {
    try {
        const identity = await getAgentIdentity(agentId);
        return identity.hasIdentity;
    } catch (error) {
        return false;
    }
};

module.exports = {
    initializeMemory,
    storeAgentIdentity,
    addConversationMemory,
    searchMemories,
    getAgentIdentity,
    getAllMemories,
    clearAgentMemories,
    buildMemoryContext,
    hasStoredIdentity
};
