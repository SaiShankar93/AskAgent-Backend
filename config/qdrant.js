const { QdrantClient } = require('@qdrant/js-client-rest');

// Initialize Qdrant client
const qdrant = new QdrantClient({
    url: process.env.QDRANT_PROD_URL,
    apiKey: process.env.QDRANT_API_KEY,
});

// Collection name for storing embeddings
const COLLECTION_NAME = 'askagent_embeddings';

// Test Qdrant connection
(async () => {
  try {
    const collections = await qdrant.getCollections();
    console.log('✅ Qdrant connected successfully');
    console.log(`Found ${collections.collections.length} collections`);
    
    // Create collection if it doesn't exist
    const collectionExists = collections.collections.some(
      col => col.name === COLLECTION_NAME
    );
    
    if (!collectionExists) {
      await qdrant.createCollection(COLLECTION_NAME, {
        vectors: {
          size: 1536, // OpenAI text-embedding-3-small dimension
          distance: 'Cosine',
        },
      });
      console.log(`✅ Created collection: ${COLLECTION_NAME}`);
    }
  } catch (err) {
    console.error('❌ Qdrant connection error:', err.message);
    console.error('   Make sure Qdrant is running on http://localhost:6333');
    console.error('   Start with Docker: docker run -p 6333:6333 qdrant/qdrant');
  }
})();

module.exports = { qdrant, COLLECTION_NAME };
