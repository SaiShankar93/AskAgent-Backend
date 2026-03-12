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
  /**
   * Contextualize a vague/pronoun-based query with the agent name
   * e.g. "his blogs" + agent "Sai Shankar" → "Sai Shankar blogs"
   */
  contextualizeQuery(query, agentName) {
    if (!agentName) return query;
    const lowerQuery = query.toLowerCase().trim();

    // Pronoun / vague reference patterns that need grounding
    const pronounPatterns = [
      /\b(his|her|their|its|this person'?s?)\b/i,
      /\b(he|she|they)\b/i,
      /^(whose|who is|who are|who's)/i,
      /\b(the (owner|author|creator|developer|person|guy|individual))\b/i,
    ];

    const hasPronouns = pronounPatterns.some(p => p.test(lowerQuery));
    if (hasPronouns) {
      // Replace pronouns with agent name for a grounded query
      let grounded = query
        .replace(/\b(his|her|their|its)\b/gi, `${agentName}'s`)
        .replace(/\b(he|she|they)\b/gi, agentName)
        .replace(/^(whose)/i, `who is`);
      // Append agent name as extra context for the embedding
      return `${grounded} ${agentName}`;
    }

    return query;
  }

  expandQuery(query) {
    const lowerQuery = query.toLowerCase().trim();

    // No ^ anchors — match anywhere in the query string
    const summaryPatterns = [
      /\b(summarize|summarise|summary)\b/i,
      /\bsum up\b/i,
      /\bgive (me )?(a |an )?(summary|overview|outline)\b/i,
      /\b(outline|overview)\b/i,
      /\b(explain|describe)\b/i,
      /\bwhat is (this|the )?(website|site|page|content|document|project|blog|portfolio)?\b/i,
      /\bwhat'?s (this|the )?(website|site|page|content|document|project|blog|portfolio)?\b/i,
      /\btell me about (this|the )?(website|site|page|content|document|project|blog|portfolio)\b/i,
      /\bcan you (summarize|summarise|overview|explain|describe|outline)\b/i,
      /\bplease (summarize|summarise|overview|explain|describe|outline)\b/i,
      /\b(info|information) about (this|the )?(website|site|page|content|document)\b/i,
    ];

    const isGenericRequest = summaryPatterns.some(pattern => pattern.test(lowerQuery));

    if (isGenericRequest) {
      return query + ' introduction overview main key important content information description explanation example definition purpose';
    }

    return query;
  }

  detectIdentityQuestion(query, agentName = '') {
    const lowerQuery = query.toLowerCase().trim();

    const patterns = [
      /\bwhose (website|site|page|blog|portfolio|project)\b/i,
      /\bwho (is|are) (this|the) (person|owner|author|creator|developer|individual)\b/i,
      /\bwho (made|created|built|owns|runs|developed) (this|the)?\s*(website|site|page|blog|project)?\b/i,
      /\btell me (more )?about (him|her|the (author|owner|creator|developer|person))\b/i,
      /\bwho (is|are) (behind|responsible for) (this|the)\b/i,
      /\b(about|info about|information about) (the )?(owner|author|creator|developer|person)\b/i,
      /\bfetch (his|her|their)\b/i,
      /\b(his|her|their) (blogs?|projects?|work|skills?|experience|education|contact|portfolio)\b/i,
    ];

    if (patterns.some(p => p.test(lowerQuery))) return true;

    // "who is [agent name]" — check if query contains the agent name alongside "who is"
    if (agentName && /\bwho (is|are)\b/i.test(lowerQuery)) {
      const nameParts = agentName.toLowerCase().split(/\s+/).filter(p => p.length > 2);
      if (nameParts.some(part => lowerQuery.includes(part))) return true;
    }

    return false;
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
        agentContext = {},
      } = options;

      console.log(`[RAG] Retrieving context for query: "${userQuery.substring(0, 50)}..."`);

      // Step 0: Contextualize pronoun/vague queries with the agent name
      const agentName = agentContext.name || '';
      const contextualizedQuery = this.contextualizeQuery(userQuery, agentName);
      if (contextualizedQuery !== userQuery) {
        console.log(`[RAG] Contextualized query: "${contextualizedQuery.substring(0, 80)}"`);
      }

      // Expand query for better vector search (especially for generic requests)
      const expandedQuery = this.expandQuery(contextualizedQuery);
      const isGenericRequest = expandedQuery !== contextualizedQuery;
      const isIdentityQuestion = this.detectIdentityQuestion(userQuery, agentName);

      if (isGenericRequest) {
        console.log(`[RAG] Detected generic request, expanding query for better retrieval`);
      }
      if (isIdentityQuestion) {
        console.log(`[RAG] Detected identity/ownership question`);
      }

      // Step 1: Generate embedding for the expanded query
      const queryEmbedding = await embeddingService.generateEmbedding(expandedQuery);
      console.log(`[RAG] Generated query embedding (${queryEmbedding.length} dimensions)`);

      // Step 2: Search for similar chunks in vector store
      // For generic requests, use lower threshold and get more chunks
      const searchTopK = isGenericRequest ? topK * 2 : topK;
      const searchThreshold = isGenericRequest ? 0.3 : threshold;
      
      let similarChunks = await vectorStore.searchSimilar(
        agentId,
        queryEmbedding,
        searchTopK,
        searchThreshold
      );

      // Fallback: if nothing found, retry with a very low threshold to always surface something
      if (similarChunks.length === 0) {
        console.log(`[RAG] No chunks at threshold ${searchThreshold}, retrying with fallback threshold 0.2`);
        similarChunks = await vectorStore.searchSimilar(agentId, queryEmbedding, topK, 0.2);
        console.log(`[RAG] Fallback retrieval found ${similarChunks.length} chunks`);
      }

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
        isGenericRequest,
        isIdentityQuestion,
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
  buildPrompt(userQuery, context, conversationHistory = [], agentContext = {}, hasRelevantContext = true, isGenericRequest = false, isIdentityQuestion = false) {
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

    // Handle identity/ownership questions — use memory context + any retrieved chunks
    if (isIdentityQuestion) {
      prompt += `USER QUESTION:\n${userQuery}\n\n`;
      prompt += `HOW TO RESPOND:\n`;
      prompt += `1. The user is asking about the owner/creator/author of this ${sourceType}, or wants to know who ${agentName} is.\n`;
      prompt += `2. Use the identity and memory context above to describe who ${agentName} represents.\n`;
      prompt += `3. Include their background, skills, projects, experience, and any other personal info from the content below.\n`;
      prompt += `4. If asked "who is [name]" - describe the person whose ${sourceType} this is, using all available info.\n`;
      prompt += `5. Be warm, informative, and helpful. Do not say "I don't have that info" if memory context or chunks contain relevant info.\n\n`;
      if (context && !context.includes('No relevant information')) {
        prompt += `RELEVANT CONTENT FROM ${agentName.toUpperCase()}:\n${context}\n\n`;
      }
    }
    // Handle generic requests (summarize, outline, overview) specially
    else if (isGenericRequest && hasRelevantContext) {
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
