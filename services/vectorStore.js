const { qdrant, COLLECTION_NAME } = require('../config/qdrant');
const { v4: uuidv4 } = require('uuid');

class VectorStore {
  /**
   * Store embeddings in Qdrant vector database
   * @param {string} agentId - Agent ID
   * @param {Array<{content: string, embedding: Array<number>, metadata: object}>} embeddedChunks
   * @returns {Promise<Array<string>>} Array of inserted embedding IDs
   */
  async storeEmbeddings(agentId, embeddedChunks) {
    try {
      if (!agentId || !embeddedChunks || embeddedChunks.length === 0) {
        throw new Error('Agent ID and embedded chunks are required');
      }

      console.log(`[VectorStore] Storing ${embeddedChunks.length} embeddings for agent ${agentId} in Qdrant`);

      // Prepare points for Qdrant
      const points = embeddedChunks.map((chunk, index) => ({
        id: uuidv4(), // Generate unique ID
        vector: chunk.embedding,
        payload: {
          agentId: agentId,
          content: chunk.content,
          metadata: chunk.metadata || {},
          createdAt: new Date().toISOString(),
        },
      }));

      // Insert into Qdrant in batches of 100
      const batchSize = 100;
      const insertedIds = [];

      for (let i = 0; i < points.length; i += batchSize) {
        const batch = points.slice(i, i + batchSize);
        
        await qdrant.upsert(COLLECTION_NAME, {
          wait: true,
          points: batch,
        });
        
        insertedIds.push(...batch.map(p => p.id));
        
        console.log(`[VectorStore] Inserted batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(points.length / batchSize)}`);
      }

      console.log(`[VectorStore] Successfully stored ${insertedIds.length} embeddings in Qdrant`);
      return insertedIds;
    } catch (error) {
      console.error('[VectorStore] Error storing embeddings:', error);
      
      // Check if it's a Qdrant connection error
      if (error.message.includes('ECONNREFUSED') || error.message.includes('fetch failed')) {
        throw new Error('Qdrant is not running. Please start Qdrant: docker run -p 6333:6333 qdrant/qdrant');
      }
      
      throw new Error(`Failed to store embeddings: ${error.message}`);
    }
  }

  /**
   * Search for similar embeddings using Qdrant vector similarity
   * @param {string} agentId - Agent ID to search within
   * @param {Array<number>} queryEmbedding - Query embedding vector
   * @param {number} limit - Maximum number of results (default: 5)
   * @param {number} threshold - Minimum similarity threshold (default: 0.7)
   * @returns {Promise<Array<{content: string, metadata: object, similarity: number}>>}
   */
  async searchSimilar(agentId, queryEmbedding, limit = 5, threshold = 0.7) {
    try {
      if (!agentId || !queryEmbedding) {
        throw new Error('Agent ID and query embedding are required');
      }

      console.log(`[VectorStore] Searching in Qdrant for similar content (limit: ${limit}, threshold: ${threshold})`);

      // Search in Qdrant with filter for agentId
      const searchResult = await qdrant.search(COLLECTION_NAME, {
        vector: queryEmbedding,
        limit: limit * 2, // Get more results to filter by threshold
        filter: {
          must: [
            {
              key: 'agentId',
              match: { value: agentId },
            },
          ],
        },
        with_payload: true,
      });

      // Filter by similarity threshold and format results
      const results = searchResult
        .filter(result => result.score >= threshold)
        .slice(0, limit)
        .map(result => ({
          id: result.id,
          content: result.payload.content,
          metadata: result.payload.metadata || {},
          similarity: result.score,
        }));

      console.log(`[VectorStore] Found ${results.length} similar chunks in Qdrant`);

      return results;
    } catch (error) {
      console.error('[VectorStore] Error searching embeddings:', error);
      
      // Check if it's a Qdrant connection error
      if (error.message.includes('ECONNREFUSED') || error.message.includes('fetch failed')) {
        throw new Error('Qdrant is not running. Please start Qdrant: docker run -p 6333:6333 qdrant/qdrant');
      }
      
      throw new Error(`Failed to search embeddings: ${error.message}`);
    }
  }

  /**
   * Delete all embeddings for an agent from Qdrant
   * @param {string} agentId - Agent ID
   * @returns {Promise<number>} Number of deleted embeddings
   */
  async deleteAgentEmbeddings(agentId) {
    try {
      if (!agentId) {
        throw new Error('Agent ID is required');
      }

      console.log(`[VectorStore] Deleting embeddings for agent ${agentId} from Qdrant`);

      // Delete points from Qdrant using filter
      await qdrant.delete(COLLECTION_NAME, {
        wait: true,
        filter: {
          must: [
            {
              key: 'agentId',
              match: { value: agentId },
            },
          ],
        },
      });

      console.log(`[VectorStore] Deleted embeddings for agent ${agentId} from Qdrant`);

      return true; // Qdrant doesn't return count, so return success
    } catch (error) {
      console.error('[VectorStore] Error deleting embeddings:', error);
      throw new Error(`Failed to delete embeddings: ${error.message}`);
    }
  }

  /**
   * Get embedding count for an agent from Qdrant
   * @param {string} agentId - Agent ID
   * @returns {Promise<number>} Number of embeddings
   */
  async getEmbeddingCount(agentId) {
    try {
      if (!agentId) {
        throw new Error('Agent ID is required');
      }

      // Count points in Qdrant with agentId filter
      const result = await qdrant.count(COLLECTION_NAME, {
        filter: {
          must: [
            {
              key: 'agentId',
              match: { value: agentId },
            },
          ],
        },
      });

      const count = result.count || 0;

      return count;
    } catch (error) {
      console.error('[VectorStore] Error getting embedding count:', error);
      
      // Check if it's a Qdrant connection error
      if (error.message.includes('ECONNREFUSED') || error.message.includes('fetch failed')) {
        console.warn('[VectorStore] Qdrant is not running, returning count 0');
        return 0; // Return 0 instead of throwing error for count
      }
      
      throw new Error(`Failed to get embedding count: ${error.message}`);
    }
  }

  /**
   * Get sample embeddings for an agent from Qdrant (for debugging)
   * @param {string} agentId - Agent ID
   * @param {number} limit - Number of samples (default: 5)
   * @returns {Promise<Array>}
   */
  async getSampleEmbeddings(agentId, limit = 5) {
    try {
      if (!agentId) {
        throw new Error('Agent ID is required');
      }

      // Scroll through points in Qdrant with agentId filter
      const result = await qdrant.scroll(COLLECTION_NAME, {
        filter: {
          must: [
            {
              key: 'agentId',
              match: { value: agentId },
            },
          ],
        },
        limit: limit,
        with_payload: true,
        with_vector: false, // Don't return vectors for sample
      });

      return result.points.map(point => ({
        id: point.id,
        content: point.payload.content,
        metadata: point.payload.metadata,
        created_at: point.payload.createdAt,
      }));
    } catch (error) {
      console.error('[VectorStore] Error getting sample embeddings:', error);
      throw new Error(`Failed to get sample embeddings: ${error.message}`);
    }
  }

  /**
   * Get ALL chunks for an agent from Qdrant (for summarization/tools)
   * @param {string} agentId - Agent ID
   * @param {number} maxChunks - Maximum number of chunks to retrieve (default: 50)
   * @returns {Promise<Array<{content: string, metadata: object}>>}
   */
  async getAllChunks(agentId, maxChunks = 50) {
    try {
      if (!agentId) {
        throw new Error('Agent ID is required');
      }

      console.log(`[VectorStore] Getting all chunks for agent ${agentId} (max: ${maxChunks})`);

      // Scroll through all points in Qdrant with agentId filter
      const result = await qdrant.scroll(COLLECTION_NAME, {
        filter: {
          must: [
            {
              key: 'agentId',
              match: { value: agentId },
            },
          ],
        },
        limit: maxChunks,
        with_payload: true,
        with_vector: false, // Don't return vectors
      });

      const chunks = result.points.map(point => ({
        id: point.id,
        content: point.payload.content,
        metadata: point.payload.metadata || {},
      }));

      console.log(`[VectorStore] Retrieved ${chunks.length} total chunks for agent`);

      return chunks;
    } catch (error) {
      console.error('[VectorStore] Error getting all chunks:', error);
      throw new Error(`Failed to get all chunks: ${error.message}`);
    }
  }

  /**
   * Test vector store connection and functionality
   * @returns {Promise<boolean>}
   */
  async test() {
    try {
      // Test basic Qdrant connectivity by listing collections and counting points (if collection exists)
      const collections = await qdrant.getCollections();
      const hasCollection = collections.collections.some(c => c.name === COLLECTION_NAME);
      if (!hasCollection) {
        await qdrant.createCollection(COLLECTION_NAME, {
          vectors: { size: 768, distance: 'Cosine' },
        });
      }
      const countRes = await qdrant.count(COLLECTION_NAME, {});
      const count = countRes.count || 0;
      console.log('[VectorStore] Qdrant test successful');
      console.log(`[VectorStore] Total points in collection: ${count}`);
      return true;
    } catch (error) {
      console.error('[VectorStore] Connection test failed:', error);
      return false;
    }
  }
}

module.exports = new VectorStore();
