const OpenAI = require('openai');

class EmbeddingService {
  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    this.model = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
    this.maxBatchSize = 100;
  }

  /**
   * Generate embedding for a single text
   * @param {string} text - Text to embed
   * @returns {Promise<Array<number>>} Embedding vector
   */
  async generateEmbedding(text) {
    try {
      if (!text || text.trim().length === 0) {
        throw new Error('Text cannot be empty');
      }

      const response = await this.client.embeddings.create({
        model: this.model,
        input: text,
      });

      return response.data[0]?.embedding || [];
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw new Error(`Failed to generate embedding: ${error.message}`);
    }
  }

  /**
   * Generate embeddings for multiple texts in batches
   * @param {Array<string>} texts - Array of texts to embed
   * @returns {Promise<Array<Array<number>>>} Array of embedding vectors
   */
  async generateEmbeddings(texts) {
    try {
      if (!texts || texts.length === 0) {
        throw new Error('Texts array cannot be empty');
      }

      // Filter out empty texts
      const validTexts = texts.filter(text => text && text.trim().length > 0);
      
      if (validTexts.length === 0) {
        throw new Error('No valid texts to embed');
      }

      const embeddings = [];
      
      // Process in batches to avoid rate limits
      for (let i = 0; i < validTexts.length; i += this.maxBatchSize) {
        const batch = validTexts.slice(i, i + this.maxBatchSize);

        console.log(`[Embedding] Processing batch ${Math.floor(i / this.maxBatchSize) + 1}/${Math.ceil(validTexts.length / this.maxBatchSize)} (${batch.length} texts)`);

        const response = await this.client.embeddings.create({
          model: this.model,
          input: batch,
        });

        // Extract embeddings in order
        const batchEmbeddings = response.data
          .sort((a, b) => a.index - b.index)
          .map(item => item.embedding);
        
        embeddings.push(...batchEmbeddings);

        if (i + this.maxBatchSize < validTexts.length) {
          await this.delay(500);
        }
      }

      return embeddings;
    } catch (error) {
      console.error('Error generating embeddings:', error);
      throw new Error(`Failed to generate embeddings: ${error.message}`);
    }
  }

  /**
   * Generate embeddings for chunks with metadata
   * @param {Array<{content: string, metadata: object}>} chunks - Array of chunk objects
   * @returns {Promise<Array<{content: string, embedding: Array<number>, metadata: object}>>}
   */
  async generateChunkEmbeddings(chunks) {
    try {
      if (!chunks || chunks.length === 0) {
        throw new Error('Chunks array cannot be empty');
      }

      console.log(`[Embedding] Generating embeddings for ${chunks.length} chunks`);
      
      const texts = chunks.map(chunk => chunk.content);
      const embeddings = await this.generateEmbeddings(texts);
      
      // Combine chunks with their embeddings
      const embeddedChunks = chunks.map((chunk, index) => ({
        content: chunk.content,
        embedding: embeddings[index],
        metadata: chunk.metadata || {},
      }));

      console.log(`[Embedding] Successfully generated ${embeddedChunks.length} embeddings`);
      
      return embeddedChunks;
    } catch (error) {
      console.error('Error generating chunk embeddings:', error);
      throw new Error(`Failed to generate chunk embeddings: ${error.message}`);
    }
  }

  /**
   * Delay helper for rate limiting
   * @param {number} ms - Milliseconds to delay
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get embedding statistics
   * @param {Array<Array<number>>} embeddings - Array of embeddings
   * @returns {object} Statistics about the embeddings
   */
  getEmbeddingStats(embeddings) {
    if (!embeddings || embeddings.length === 0) {
      return { count: 0, dimensions: 0, totalSize: 0 };
    }

    const dimensions = embeddings[0].length;
    const totalSize = embeddings.length * dimensions;

    return {
      count: embeddings.length,
      dimensions,
      totalSize,
      sizeInMB: (totalSize * 4) / (1024 * 1024), // Assuming 4 bytes per float
    };
  }

  /**
   * Calculate cosine similarity between two embeddings
   * @param {Array<number>} embedding1 - First embedding vector
   * @param {Array<number>} embedding2 - Second embedding vector
   * @returns {number} Similarity score between 0 and 1
   */
  cosineSimilarity(embedding1, embedding2) {
    if (embedding1.length !== embedding2.length) {
      throw new Error('Embeddings must have the same dimensions');
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < embedding1.length; i++) {
      dotProduct += embedding1[i] * embedding2[i];
      norm1 += embedding1[i] * embedding1[i];
      norm2 += embedding2[i] * embedding2[i];
    }

    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
  }

  /**
   * Test the embedding service
   * @returns {Promise<boolean>} True if service is working
   */
  async test() {
    try {
      const testText = 'This is a test sentence for embedding generation.';
      const embedding = await this.generateEmbedding(testText);
      
      console.log('[Embedding] Service test successful');
      console.log(`[Embedding] Test embedding dimensions: ${embedding.length}`);
      
      return true;
    } catch (error) {
      console.error('[Embedding] Service test failed:', error);
      return false;
    }
  }
}

module.exports = new EmbeddingService();
