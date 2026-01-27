# Migration Guide: Redis Queue Implementation

This guide helps you migrate from the synchronous message handling to the new asynchronous Redis queue system.

## What Changed

### Before (Synchronous)
- Messages were processed immediately in the request-response cycle
- The API endpoint waited for the entire LLM response before returning
- Concurrent requests could cause server overload

### After (Asynchronous with Redis Queue)
- Messages are immediately added to a Redis queue and return a `messageId`
- A background worker processes messages one at a time
- Clients poll for results using the `messageId`

## Setup Requirements

### 1. Install Redis

**Using Docker (Recommended):**
```bash
docker run -d --name askagent-redis -p 6379:6379 redis:latest
```

**Using Package Managers:**
```bash
# macOS
brew install redis
brew services start redis

# Ubuntu/Debian
sudo apt-get install redis-server
sudo service redis-server start

# Windows (WSL recommended)
# Follow Redis installation guide for Windows
```

### 2. Update Environment Variables

Add the following to your `.env` file:
```env
REDIS_URL=redis://localhost:6379
```

For remote Redis (e.g., Redis Cloud, AWS ElastiCache):
```env
REDIS_URL=redis://username:password@hostname:6379
```

### 3. Install Dependencies

If upgrading an existing installation:
```bash
npm install --legacy-peer-deps
```

The `redis` package is already in `package.json` and will be installed.

## API Changes

### Sending Messages

#### Old API Response:
```json
{
  "success": true,
  "data": {
    "userMessage": { ... },
    "assistantMessage": { ... },
    "metadata": { ... }
  }
}
```

#### New API Response (Immediate):
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

### Checking Message Status

New endpoint to poll for results:

```javascript
// Poll for result
const checkStatus = async (messageId) => {
  const response = await fetch(`/api/chat/status/${messageId}`);
  const data = await response.json();
  
  if (data.data.status === 'completed') {
    return data.data.result;
  }
  // Keep polling if status is 'processing'
};
```

### Client-Side Implementation Example

```javascript
// Send message
const sendMessage = async (agentId, content) => {
  const response = await fetch('/api/chat/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, content })
  });
  const { data } = await response.json();
  return data.messageId;
};

// Poll for result with exponential backoff
const getResult = async (messageId) => {
  let delay = 1000; // Start with 1 second
  const maxDelay = 5000; // Max 5 seconds between polls
  
  while (true) {
    const response = await fetch(`/api/chat/status/${messageId}`);
    const { data } = await response.json();
    
    if (data.status === 'completed') {
      return data.result;
    }
    
    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // Exponential backoff
    delay = Math.min(delay * 1.5, maxDelay);
  }
};

// Complete flow
const chat = async (agentId, message) => {
  const messageId = await sendMessage(agentId, message);
  const result = await getResult(messageId);
  
  console.log('User:', result.userMessage.content);
  console.log('Assistant:', result.assistantMessage.content);
};
```

## Monitoring

### Queue Statistics

Get real-time queue metrics:
```bash
GET /api/chat/queue/stats
```

Response:
```json
{
  "success": true,
  "data": {
    "queued": 5,
    "processing": 1,
    "failed": 0,
    "total": 6
  }
}
```

### Worker Logs

The worker logs all processing activities:
```
[Worker] Processing message msg_1234567890_abc123
[Worker] Processing message for agent: MyAgent
[Worker] Retrieved 5 relevant chunks
[Worker] Response generated in 2543ms
[Worker] Message msg_1234567890_abc123 processed successfully
```

## Configuration Options

### Worker Poll Interval

Modify `services/messageWorker.js`:
```javascript
this.pollInterval = 1000; // 1 second (default)
// Increase for lower CPU usage, decrease for faster processing
```

### Retry Configuration

Modify `services/messageQueue.js`:
```javascript
const MAX_RETRIES = 3; // Number of retries before moving to failed queue
```

### Result TTL

Results are cached in Redis for 1 hour by default. Modify in `services/messageQueue.js`:
```javascript
await this.redisClient.setEx(resultKey, 3600, ...); // 3600 seconds = 1 hour
```

## Troubleshooting

### Redis Connection Issues

**Problem:** "Redis client not initialized" error

**Solution:**
1. Ensure Redis is running: `redis-cli ping` (should return "PONG")
2. Check `REDIS_URL` in `.env`
3. Verify network connectivity to Redis host

### Messages Not Processing

**Problem:** Messages stay in "queued" status

**Solution:**
1. Check if the worker is running (look for "Message worker started" log)
2. Check worker logs for errors
3. Verify database connectivity (MongoDB, Qdrant)

### High Queue Buildup

**Problem:** Too many messages queued

**Solution:**
1. Check queue stats: `GET /api/chat/queue/stats`
2. Investigate worker errors in logs
3. Consider scaling workers (future enhancement)

## Backward Compatibility

The `/api/chat/widget` endpoint remains synchronous for backward compatibility with embedded widgets.

## Future Enhancements

Potential improvements to consider:
- Multiple workers for parallel processing
- Priority queues for urgent messages
- Dead letter queue for permanently failed messages
- Webhook callbacks when messages complete
- Redis Streams for better message tracking

## Rollback

If you need to rollback to synchronous processing:

1. Stop the server
2. Restore the old `controllers/chatController.js` from git history
3. Remove worker initialization from `index.js`
4. Restart the server

Note: This is not recommended as the synchronous approach doesn't handle concurrent requests well.
