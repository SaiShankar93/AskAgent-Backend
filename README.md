# AskAgent Backend

A chatbot application backend with RAG (Retrieval Augmented Generation) capabilities that allows users to chat with their website or document content.

## Features

- **Document/Website Processing**: Upload documents or provide website URLs to create a knowledge base
- **Vector Database Storage**: Stores processed content in Qdrant vector database
- **RAG-based Chat**: Chat with your data using OpenAI's LLM with context retrieval
- **Memory Service**: Maintains conversation history and agent identity
- **Redis Queue System**: Asynchronous message processing with queue-based architecture

## Redis Queue Implementation

The application now uses Redis for asynchronous message processing to handle concurrent requests efficiently.

### How It Works

1. **Message Enqueueing**: When a user sends a chat message via `/api/chat/send`, the message is immediately added to a Redis queue and returns a `messageId`
2. **Background Worker**: A dedicated worker process continuously polls the queue and processes messages one at a time
3. **Result Retrieval**: Clients can poll `/api/chat/status/:messageId` to check if their message has been processed
4. **FIFO Processing**: Messages are processed in First-In-First-Out order
5. **Retry Mechanism**: Failed messages are automatically retried up to 3 times before being moved to a failed queue

### Queue Architecture

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │ POST /api/chat/send
       ▼
┌─────────────────┐
│ Chat Controller │
└────────┬────────┘
         │ enqueue(message)
         ▼
┌─────────────────┐
│  Redis Queue    │
│  (FIFO)         │
└────────┬────────┘
         │ dequeue()
         ▼
┌─────────────────┐
│ Message Worker  │
│  (Background)   │
└────────┬────────┘
         │ process & store result
         ▼
┌─────────────────┐
│ Redis Results   │
│  (TTL: 1 hour)  │
└─────────────────┘
```

### API Endpoints

#### Send Message (Asynchronous)
```
POST /api/chat/send
```
**Request:**
```json
{
  "agentId": "agent_id_here",
  "content": "Your message"
}
```
**Response:**
```json
{
  "success": true,
  "data": {
    "messageId": "msg_1234567890_abc123",
    "status": "queued",
    "message": "Your message has been queued for processing"
  }
}
```

#### Check Message Status
```
GET /api/chat/status/:messageId
```
**Response (Processing):**
```json
{
  "success": true,
  "data": {
    "messageId": "msg_1234567890_abc123",
    "status": "processing",
    "queueStats": {
      "queued": 5,
      "processing": 2,
      "failed": 0,
      "total": 7
    }
  }
}
```

**Response (Completed):**
```json
{
  "success": true,
  "data": {
    "messageId": "msg_1234567890_abc123",
    "status": "completed",
    "result": {
      "userMessage": {...},
      "assistantMessage": {...},
      "metadata": {...}
    },
    "completedAt": 1234567890
  }
}
```

#### Get Queue Statistics
```
GET /api/chat/queue/stats
```
**Response:**
```json
{
  "success": true,
  "data": {
    "queued": 5,
    "processing": 2,
    "failed": 0,
    "total": 7
  }
}
```

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and configure your environment variables:
   ```bash
   cp .env.example .env
   ```
4. Make sure Redis is running:
   ```bash
   # Using Docker
   docker run -d -p 6379:6379 redis:latest
   
   # Or install locally
   # macOS: brew install redis && brew services start redis
   # Ubuntu: sudo apt-get install redis-server && sudo service redis-server start
   ```
5. Start the server:
   ```bash
   npm run dev
   ```

## Environment Variables

See `.env.example` for all required environment variables. Key variables:

- `REDIS_URL`: Redis connection URL (default: `redis://localhost:6379`)
- `MONGODB_URI`: MongoDB connection string
- `OPENAI_API_KEY`: Your OpenAI API key
- `PORT`: Server port (default: 5000)

## Development

```bash
# Development mode with auto-reload
npm run dev

# Production mode
npm start

# Run tests
npm test
```

## Architecture

- **Express.js**: Web framework
- **MongoDB**: Database for agents and messages
- **Redis**: Message queue for asynchronous processing
- **Qdrant**: Vector database for embeddings
- **OpenAI**: LLM for response generation
- **Langchain**: RAG implementation

## Queue System Benefits

1. **Scalability**: Handles multiple concurrent requests without blocking
2. **Reliability**: Automatic retry mechanism for failed messages
3. **Observability**: Queue statistics and message tracking
4. **Performance**: Non-blocking API responses
5. **Resilience**: Failed messages are tracked and can be inspected

## License

ISC
