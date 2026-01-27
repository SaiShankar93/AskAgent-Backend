const { getRedisClient } = require('../config/redis');

const QUEUE_NAME = 'chat:messages';
const PROCESSING_QUEUE = 'chat:processing';
const FAILED_QUEUE = 'chat:failed';
const MAX_RETRIES = 3;

class MessageQueueService {
    constructor() {
        this.redisClient = null;
    }

    initialize() {
        this.redisClient = getRedisClient();
    }

    /**
     * Add a message to the queue for processing
     * @param {Object} messageData - The message data to process
     * @returns {Promise<string>} - The message ID
     */
    async enqueue(messageData) {
        if (!this.redisClient) {
            this.initialize();
        }

        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const message = {
            id: messageId,
            data: messageData,
            timestamp: Date.now(),
            retries: 0,
            status: 'queued',
        };

        // Add to the queue (FIFO using LPUSH/RPOP)
        await this.redisClient.lPush(QUEUE_NAME, JSON.stringify(message));
        
        console.log(`[Queue] Message ${messageId} added to queue`);
        return messageId;
    }

    /**
     * Dequeue a message for processing
     * @returns {Promise<Object|null>} - The message object or null if queue is empty
     */
    async dequeue() {
        if (!this.redisClient) {
            this.initialize();
        }

        // Atomically move from main queue to processing queue
        const messageStr = await this.redisClient.rPopLPush(QUEUE_NAME, PROCESSING_QUEUE);
        
        if (!messageStr) {
            return null;
        }

        const message = JSON.parse(messageStr);
        console.log(`[Queue] Message ${message.id} dequeued for processing`);
        return message;
    }

    /**
     * Mark a message as successfully processed
     * @param {string} messageId - The message ID
     * @param {Object} result - The processing result
     */
    async markComplete(messageId, result) {
        if (!this.redisClient) {
            this.initialize();
        }

        // Remove from processing queue
        await this.removeFromProcessing(messageId);
        
        // Store the result with expiration (1 hour)
        const resultKey = `result:${messageId}`;
        await this.redisClient.setEx(resultKey, 3600, JSON.stringify({
            status: 'completed',
            result,
            completedAt: Date.now(),
        }));

        console.log(`[Queue] Message ${messageId} marked as complete`);
    }

    /**
     * Mark a message as failed and retry or move to failed queue
     * @param {string} messageId - The message ID
     * @param {Error} error - The error that occurred
     */
    async markFailed(messageId, error) {
        if (!this.redisClient) {
            this.initialize();
        }

        // Find the message in processing queue
        const message = await this.findInProcessing(messageId);
        
        if (!message) {
            console.error(`[Queue] Message ${messageId} not found in processing queue`);
            return;
        }

        message.retries += 1;
        message.lastError = error.message;
        message.lastErrorAt = Date.now();

        // Remove from processing queue
        await this.removeFromProcessing(messageId);

        if (message.retries < MAX_RETRIES) {
            // Retry by putting back to main queue
            message.status = 'retrying';
            await this.redisClient.lPush(QUEUE_NAME, JSON.stringify(message));
            console.log(`[Queue] Message ${messageId} retrying (attempt ${message.retries + 1}/${MAX_RETRIES})`);
        } else {
            // Move to failed queue
            message.status = 'failed';
            await this.redisClient.lPush(FAILED_QUEUE, JSON.stringify(message));
            console.error(`[Queue] Message ${messageId} moved to failed queue after ${MAX_RETRIES} retries`);
        }
    }

    /**
     * Get the result of a processed message
     * @param {string} messageId - The message ID
     * @returns {Promise<Object|null>} - The result or null if not found
     */
    async getResult(messageId) {
        if (!this.redisClient) {
            this.initialize();
        }

        const resultKey = `result:${messageId}`;
        const resultStr = await this.redisClient.get(resultKey);
        
        if (!resultStr) {
            return null;
        }

        return JSON.parse(resultStr);
    }

    /**
     * Get queue statistics
     * @returns {Promise<Object>} - Queue statistics
     */
    async getStats() {
        if (!this.redisClient) {
            this.initialize();
        }

        const [queuedCount, processingCount, failedCount] = await Promise.all([
            this.redisClient.lLen(QUEUE_NAME),
            this.redisClient.lLen(PROCESSING_QUEUE),
            this.redisClient.lLen(FAILED_QUEUE),
        ]);

        return {
            queued: queuedCount,
            processing: processingCount,
            failed: failedCount,
            total: queuedCount + processingCount + failedCount,
        };
    }

    /**
     * Find a message in the processing queue
     * @private
     */
    async findInProcessing(messageId) {
        const processingMessages = await this.redisClient.lRange(PROCESSING_QUEUE, 0, -1);
        
        for (const msgStr of processingMessages) {
            const msg = JSON.parse(msgStr);
            if (msg.id === messageId) {
                return msg;
            }
        }
        
        return null;
    }

    /**
     * Remove a message from the processing queue
     * @private
     */
    async removeFromProcessing(messageId) {
        const processingMessages = await this.redisClient.lRange(PROCESSING_QUEUE, 0, -1);
        
        for (const msgStr of processingMessages) {
            const msg = JSON.parse(msgStr);
            if (msg.id === messageId) {
                await this.redisClient.lRem(PROCESSING_QUEUE, 1, msgStr);
                break;
            }
        }
    }

    /**
     * Clear all queues (for testing/maintenance)
     */
    async clearAll() {
        if (!this.redisClient) {
            this.initialize();
        }

        await Promise.all([
            this.redisClient.del(QUEUE_NAME),
            this.redisClient.del(PROCESSING_QUEUE),
            this.redisClient.del(FAILED_QUEUE),
        ]);

        console.log('[Queue] All queues cleared');
    }
}

// Export singleton instance
const messageQueueService = new MessageQueueService();

module.exports = messageQueueService;
