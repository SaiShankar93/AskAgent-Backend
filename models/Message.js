const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
    agentId: { type: String, required: true, index: true },
    role: { type: String, required: true },
    content: { type: String, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, {
    timestamps: { createdAt: 'createdAt', updatedAt: false },
});

const MessageModel = mongoose.models.Message || mongoose.model('Message', MessageSchema);

class Message {
    /**
     * Create a new message
     */
    static async create({ agentId, role, content, metadata }) {
        try {
            const message = await MessageModel.create({
                agentId,
                role,
                content,
                metadata: metadata || {},
            });
            return this.formatMessage(message);
        } catch (error) {
            console.error('Error creating message:', error);
            throw error;
        }
    }

    /**
     * Get messages for an agent (with pagination)
     */
    static async findByAgentId(agentId, { limit = 50, offset = 0 } = {}) {
        try {
            const messages = await MessageModel.find({ agentId })
                .sort({ createdAt: 1 })
                .skip(offset)
                .limit(limit)
                .lean();
            return messages.map(msg => this.formatMessage(msg));
        } catch (error) {
            console.error('Error finding messages:', error);
            throw error;
        }
    }

    /**
     * Get recent messages for an agent
     */
    static async getRecent(agentId, limit = 20) {
        try {
            const messages = await MessageModel.find({ agentId })
                .sort({ createdAt: -1 })
                .limit(limit)
                .lean();
            return messages.reverse().map(msg => this.formatMessage(msg));
        } catch (error) {
            console.error('Error getting recent messages:', error);
            throw error;
        }
    }

    /**
     * Delete all messages for an agent
     */
    static async deleteByAgentId(agentId) {
        try {
            await MessageModel.deleteMany({ agentId });
            return true;
        } catch (error) {
            console.error('Error deleting messages:', error);
            throw error;
        }
    }

    /**
     * Get message count for an agent
     */
    static async countByAgentId(agentId) {
        try {
            return await MessageModel.countDocuments({ agentId });
        } catch (error) {
            console.error('Error counting messages:', error);
            throw error;
        }
    }

    /**
     * Get conversation context (last N messages) for RAG
     */
    static async getConversationContext(agentId, messageCount = 5) {
        try {
            const messages = await this.getRecent(agentId, messageCount);

            return messages.map(msg => ({
                role: msg.role,
                content: msg.content
            }));
        } catch (error) {
            console.error('Error getting conversation context:', error);
            throw error;
        }
    }

    /**
     * Format message data to match expected structure
     */
    static formatMessage(message) {
        const doc = message.toObject ? message.toObject() : message;
        return {
            id: (doc._id || doc.id).toString(),
            agent_id: doc.agentId,
            role: doc.role,
            content: doc.content,
            metadata: doc.metadata || {},
            created_at: doc.createdAt,
        };
    }
}

module.exports = Message;
