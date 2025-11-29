const embeddingService = require('./embeddingService');
const vectorStore = require('./vectorStore');
const Message = require('../models/Message');

class RAGService {
  constructor() {
    this.defaultTopK = 5; // Number of similar chunks to retrieve
    this.defaultThreshold = 0.5; // Minimum similarity score (lowered for better retrieval)
    this.maxContextLength = 4000; // Maximum characters for context
  }

  /**
   * Detect if query is a generic request and expand it
   * @param {string} query - User query
   * @returns {string} Expanded query for better vector search
   */
  expandQuery(query) {
    const lowerQuery = query.toLowerCase().trim();
    
    // Patterns for summary/outline requests
    const summaryPatterns = [
      /^(summarize|summary|summarise|sum up|give me a summary)/i,
      /^(outline|give me an outline|show me an outline)/i,
      /^(overview|give me an overview|show me an overview)/i,
      /^(explain|explain this|explain it|what is this|what's this)/i,
      /^(describe|describe this|describe it)/i,
      /^(tell me about|what about|info about)/i,
    ];
    
    // Check if it's a generic request
    const isGenericRequest = summaryPatterns.some(pattern => pattern.test(lowerQuery));
    
    if (isGenericRequest) {
      // For generic requests, search broadly by returning common content words
      // This will help retrieve the most central/important chunks
      return query + " introduction overview main key important content information description explanation example definition purpose";
    }
    
    // For specific questions, return as-is
    return query;
  }

  /**
   * Retrieve relevant context for a user query
   * @param {string} agentId - Agent ID
   * @param {string} userQuery - User's question
   * @param {object} options - Optional parameters
   * @returns {Promise<object>} Retrieved context and sources
   */
  async retrieveContext(agentId, userQuery, options = {}) {
    try {
      const {
        topK = this.defaultTopK,
        threshold = this.defaultThreshold,
        includeConversationHistory = true,
      } = options;

      console.log(`[RAG] Retrieving context for query: "${userQuery.substring(0, 50)}..."`);

      // Expand query for better vector search (especially for generic requests)
      const expandedQuery = this.expandQuery(userQuery);
      const isGenericRequest = expandedQuery !== userQuery;
      
      if (isGenericRequest) {
        console.log(`[RAG] Detected generic request, expanding query for better retrieval`);
      }

      // Step 1: Generate embedding for the expanded query
      const queryEmbedding = await embeddingService.generateEmbedding(expandedQuery);
      console.log(`[RAG] Generated query embedding (${queryEmbedding.length} dimensions)`);

      // Step 2: Search for similar chunks in vector store
      // For generic requests, use lower threshold and get more chunks
      const searchTopK = isGenericRequest ? topK * 2 : topK;
      const searchThreshold = isGenericRequest ? 0.3 : threshold;
      
      const similarChunks = await vectorStore.searchSimilar(
        agentId,
        queryEmbedding,
        searchTopK,
        searchThreshold
      );

      console.log(`[RAG] Found ${similarChunks.length} relevant chunks`);

      // Step 3: Format retrieved chunks as context
      const context = this.formatContext(similarChunks);

      // Step 4: Get recent conversation history (optional)
      let conversationHistory = [];
      if (includeConversationHistory) {
        conversationHistory = await Message.getConversationContext(agentId, 5);
      }

      return {
        context,
        chunks: similarChunks,
        conversationHistory,
        isGenericRequest, // Flag for prompt building
        metadata: {
          chunksRetrieved: similarChunks.length,
          averageSimilarity: this.calculateAverageSimilarity(similarChunks),
          contextLength: context.length,
        },
      };
    } catch (error) {
      console.error('[RAG] Error retrieving context:', error);
      throw new Error(`Failed to retrieve context: ${error.message}`);
    }
  }

  /**
   * Format retrieved chunks into a context string
   * @param {Array} chunks - Retrieved chunks with content and metadata
   * @returns {string} Formatted context
   */
  formatContext(chunks) {
    if (!chunks || chunks.length === 0) {
      return 'No relevant information found in the knowledge base.';
    }

    let context = '';
    let currentLength = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkText = this.formatChunk(chunk, i + 1);
      
      // Check if adding this chunk would exceed max context length
      if (currentLength + chunkText.length > this.maxContextLength) {
        console.log(`[RAG] Reached max context length at chunk ${i + 1}`);
        break;
      }

      context += chunkText + '\n\n';
      currentLength += chunkText.length;
    }

    return context.trim();
  }

  /**
   * Format a single chunk with metadata
   * @param {object} chunk - Chunk with content, metadata, and similarity
   * @param {number} index - Chunk index
   * @returns {string} Formatted chunk
   */
  formatChunk(chunk, index) {
    const { content, metadata, similarity } = chunk;
    
    let formattedChunk = `[Source ${index}`;
    
    // Add source information if available
    if (metadata.sourceUrl) {
      formattedChunk += ` - ${metadata.sourceUrl}`;
    } else if (metadata.pageTitle) {
      formattedChunk += ` - ${metadata.pageTitle}`;
    }
    
    formattedChunk += `]\n${content}`;
    
    return formattedChunk;
  }

  /**
   * Calculate average similarity score
   * @param {Array} chunks - Retrieved chunks
   * @returns {number} Average similarity
   */
  calculateAverageSimilarity(chunks) {
    if (!chunks || chunks.length === 0) return 0;
    
    const sum = chunks.reduce((acc, chunk) => acc + chunk.similarity, 0);
    return sum / chunks.length;
  }

  /**
   * Build a complete prompt for the LLM
   * @param {string} userQuery - User's question
   * @param {string} context - Retrieved context
   * @param {Array} conversationHistory - Previous messages
   * @param {object} agentContext - Agent information (name, type, description, sourceUrl)
   * @param {boolean} hasRelevantContext - Whether retrieved context is relevant
   * @param {boolean} isGenericRequest - Whether this is a summary/outline request
   * @returns {string} Complete prompt
   */
  buildPrompt(userQuery, context, conversationHistory = [], agentContext = {}, hasRelevantContext = true, isGenericRequest = false) {
    const agentName = agentContext.name || 'Assistant';
    const agentType = agentContext.type || 'knowledge base';
    const sourceUrl = agentContext.sourceUrl || '';
    const description = agentContext.description || '';
    const memoryContext = agentContext.memoryContext || '';
    
    let sourceType = agentType === 'website' ? 'website' : 'document';
    let sourceInfo = sourceUrl ? ` (Source: ${sourceUrl})` : '';
    
    let prompt = `You are an AI assistant for "${agentName}", which is a knowledge base created from a ${sourceType}${sourceInfo}.\n\n`;
    
    prompt += `CRITICAL INSTRUCTIONS - IDENTITY AND SCOPE:\n`;
    prompt += `- You represent ONLY the content from ${agentName}\n`;
    prompt += `- When users say "this ${sourceType}", "this project", "this content", "it", "here" - they mean ${agentName}\n`;
    prompt += `- ${description ? `About ${agentName}: ${description}\n` : ''}`;
    prompt += `- Phrases like "generate outline", "summarize this", "explain it" refer specifically to ${agentName}'s content\n`;
    prompt += `- You are NOT a general AI - you can ONLY discuss information from ${agentName}\n`;
    prompt += `- NEVER invent or hallucinate information not present in the knowledge base\n`;
    prompt += `- If information isn't in your knowledge base, clearly say: "That information is not available in ${agentName}"\n\n`;

    // Add memory context if available (agent identity and past interactions)
    if (memoryContext && memoryContext.trim().length > 0) {
      prompt += `${memoryContext}\n`;
    }

    // Add conversation history if available
    if (conversationHistory && conversationHistory.length > 0) {
      prompt += `PREVIOUS CONVERSATION:\n`;
      conversationHistory.forEach(msg => {
        const role = msg.role === 'user' ? 'User' : 'You';
        prompt += `${role}: ${msg.content}\n`;
      });
      prompt += `\n`;
    }

    // Handle generic requests (summarize, outline, overview) specially
    if (isGenericRequest && hasRelevantContext) {
      prompt += `CONTENT FROM ${agentName.toUpperCase()}:\n`;
      prompt += `${context}\n\n`;
      prompt += `USER REQUEST:\n${userQuery}\n\n`;
      prompt += `SPECIAL INSTRUCTIONS FOR SUMMARY/OUTLINE REQUEST:\n`;
      prompt += `1. The user wants a summary or outline of ${agentName}\n`;
      prompt += `2. Synthesize the content above into a clear, organized response\n`;
      prompt += `3. For "outline" - create a structured bullet-point outline of main topics\n`;
      prompt += `4. For "summarize" - provide a concise paragraph summary of key points\n`;
      prompt += `5. For "explain" - give a clear explanation of what ${agentName} contains\n`;
      prompt += `6. Use the content provided above - organize and present it comprehensively\n`;
      prompt += `7. If you see multiple topics/sections, organize them logically\n`;
      prompt += `8. Be thorough but concise - cover all major points from the content\n\n`;
    }
    // Add context if relevant
    else if (hasRelevantContext && context && !context.includes('No relevant information')) {
      prompt += `RELEVANT CONTENT FROM ${agentName.toUpperCase()}:\n`;
      prompt += `${context}\n\n`;
      prompt += `CURRENT USER QUESTION:\n${userQuery}\n\n`;
      prompt += `HOW TO RESPOND:\n`;
      prompt += `1. Answer using ONLY the content provided above from ${agentName}\n`;
      prompt += `2. If asked about "this ${sourceType}" or "it" - you're discussing ${agentName}\n`;
      prompt += `3. For "outline" or "summary" requests - organize ${agentName}'s content clearly\n`;
      prompt += `4. For "what is this" or "explain it" - describe ${agentName} based on the content above\n`;
      prompt += `5. Be specific and reference the actual content from the knowledge base\n`;
      prompt += `6. If greeting (hi/hello), respond: "Hello! I'm the assistant for ${agentName}. I can help answer questions about this ${sourceType}. What would you like to know?"\n`;
      prompt += `7. Stay factual - only state what's in the content above\n`;
      prompt += `8. If asked about something not covered above, say: "I don't see that information in ${agentName}"\n\n`;
    } else {
      prompt += `NOTE: The question doesn't match content in ${agentName} strongly.\n\n`;
      prompt += `CURRENT USER QUESTION:\n${userQuery}\n\n`;
      prompt += `HOW TO RESPOND:\n`;
      prompt += `1. For greetings (hi/hello/hey): "Hello! I'm the assistant for ${agentName}, a ${sourceType} knowledge base. I can answer questions about its content. What would you like to know?"\n`;
      prompt += `2. For "what is this" or "what can you do": "I'm an AI assistant for ${agentName}. I can help you understand and navigate the content from this ${sourceType}. Ask me anything about it!"\n`;
      prompt += `3. For specific questions not in the knowledge base: "I don't have information about that in ${agentName}. Could you ask something else about this ${sourceType}?"\n`;
      prompt += `4. DO NOT make up information or provide general knowledge\n`;
      prompt += `5. Always stay within the scope of ${agentName}\n\n`;
    }

    prompt += `YOUR RESPONSE (be natural and helpful):`;

    return prompt;
  }

  /**
   * Evaluate if retrieved context is relevant to the query
   * @param {Array} chunks - Retrieved chunks
   * @param {number} minSimilarity - Minimum acceptable similarity
   * @returns {boolean} Whether context is relevant
   */
  isContextRelevant(chunks, minSimilarity = 0.7) {
    if (!chunks || chunks.length === 0) return false;
    
    // Check if at least one chunk meets the minimum similarity
    return chunks.some(chunk => chunk.similarity >= minSimilarity);
  }

  /**
   * Get summary statistics about retrieved context
   * @param {object} retrievedData - Data from retrieveContext
   * @returns {object} Statistics
   */
  getContextStats(retrievedData) {
    const { chunks, metadata } = retrievedData;
    
    return {
      totalChunks: chunks.length,
      averageSimilarity: metadata.averageSimilarity.toFixed(3),
      contextLength: metadata.contextLength,
      sources: this.extractSources(chunks),
      isRelevant: this.isContextRelevant(chunks),
    };
  }

  /**
   * Extract unique sources from chunks
   * @param {Array} chunks - Retrieved chunks
   * @returns {Array} Unique source URLs or titles
   */
  extractSources(chunks) {
    const sources = new Set();
    
    chunks.forEach(chunk => {
      if (chunk.metadata.sourceUrl) {
        sources.add(chunk.metadata.sourceUrl);
      } else if (chunk.metadata.pageTitle) {
        sources.add(chunk.metadata.pageTitle);
      }
    });
    
    return Array.from(sources);
  }
}

module.exports = new RAGService();
