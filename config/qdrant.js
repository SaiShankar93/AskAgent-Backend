const { QdrantClient } = require('@qdrant/js-client-rest');

// Initialize Qdrant client
const qdrant = new QdrantClient({
    url: process.env.QDRANT_URL,
});

// Collection name for storing embeddings
const COLLECTION_NAME = 'askagent_embeddings';

// Test Qdrant connection
(async () => {
  try {
    const collections = await qdrant.getCollections();
    console.log('✅ Qdrant connected successfully');
    console.log(`Found ${collections.collections.length} collections`);
    
    // Create collection if it doesn't exist, or recreate if vector size is wrong
    const collectionExists = collections.collections.some(
      col => col.name === COLLECTION_NAME
    );

    const REQUIRED_VECTOR_SIZE = 1536; // text-embedding-3-small

    if (collectionExists) {
      const collectionInfo = await qdrant.getCollection(COLLECTION_NAME);
      const currentSize = collectionInfo.config?.params?.vectors?.size;
      if (currentSize && currentSize !== REQUIRED_VECTOR_SIZE) {
        console.warn(`⚠️  Collection has wrong vector size (${currentSize}), expected ${REQUIRED_VECTOR_SIZE}. Recreating...`);
        await qdrant.deleteCollection(COLLECTION_NAME);
        await qdrant.createCollection(COLLECTION_NAME, {
          vectors: { size: REQUIRED_VECTOR_SIZE, distance: 'Cosine' },
        });
        console.log(`✅ Recreated collection with correct vector size ${REQUIRED_VECTOR_SIZE}`);
      } else {
        console.log(`✅ Collection exists with correct vector size`);
      }
    } else {
      await qdrant.createCollection(COLLECTION_NAME, {
        vectors: {
          size: REQUIRED_VECTOR_SIZE, // OpenAI text-embedding-3-small dimension
          distance: 'Cosine',
        },
      });
      console.log(`✅ Created collection: ${COLLECTION_NAME}`);
    }

    // Ensure agentId index exists for filtering
    try {
      await qdrant.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'agentId',
        field_schema: 'keyword',
        wait: true,
      });
      console.log('✅ Created/verified agentId index');
    } catch (indexErr) {
      // Index might already exist, which is fine
      if (!indexErr.message?.includes('already exists')) {
        console.log('ℹ️ agentId index already exists or created');
      }
    }
  } catch (err) {
    console.error('❌ Qdrant connection error:', err.message);
    console.error('   Make sure Qdrant is running on http://localhost:6333');
    console.error('   Start with Docker: docker run -p 6333:6333 qdrant/qdrant');
  }
})();

module.exports = { qdrant, COLLECTION_NAME };
