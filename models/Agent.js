const mongoose = require('mongoose');

const AgentSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    type: { type: String, enum: ['website', 'document'], required: true },
    description: { type: String },
    logoUrl: { type: String },
    sourceUrl: { type: String },
    vectorStoreId: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
});

const AgentModel = mongoose.models.Agent || mongoose.model('Agent', AgentSchema);

class Agent {
    /**
     * Create a new agent
     */
    static async create({ user_id, name, type, description, logo_url, source_url, vector_store_id, metadata }) {
        try {
            const agent = await AgentModel.create({
                userId: user_id,
                name,
                type,
                description,
                logoUrl: logo_url,
                sourceUrl: source_url,
                vectorStoreId: vector_store_id,
                metadata: metadata || {},
            });
            return this.formatAgent(agent);
        } catch (error) {
            console.error('Error creating agent:', error);
            throw error;
        }
    }

    /**
     * Find all agents for a user
     */
    static async findByUserId(userId) {
        try {
            const agents = await AgentModel.find({ userId }).sort({ createdAt: -1 }).lean();
            return agents.map(agent => this.formatAgent(agent));
        } catch (error) {
            console.error('Error finding agents:', error);
            throw error;
        }
    }

    /**
     * Find agent by ID
     */
    static async findById(id) {
        try {
            if (!mongoose.Types.ObjectId.isValid(id)) {
                return null;
            }
            const agent = await AgentModel.findById(id).lean();
            return agent ? this.formatAgent(agent) : null;
        } catch (error) {
            console.error('Error finding agent:', error);
            throw error;
        }
    }

    /**
     * Update an agent
     */
    static async update(id, updates) {
        try {
            if (!mongoose.Types.ObjectId.isValid(id)) {
                throw new Error('Invalid agent id');
            }

            const updatePayload = {};
            if (updates.name !== undefined) updatePayload.name = updates.name;
            if (updates.type !== undefined) updatePayload.type = updates.type;
            if (updates.description !== undefined) updatePayload.description = updates.description;
            if (updates.logo_url !== undefined) updatePayload.logoUrl = updates.logo_url;
            if (updates.source_url !== undefined) updatePayload.sourceUrl = updates.source_url;
            if (updates.vector_store_id !== undefined) updatePayload.vectorStoreId = updates.vector_store_id;
            if (updates.metadata !== undefined) updatePayload.metadata = updates.metadata;

            const agent = await AgentModel.findByIdAndUpdate(
                id,
                updatePayload,
                { new: true, runValidators: true }
            ).lean();

            if (!agent) {
                throw new Error('Agent not found');
            }

            return this.formatAgent(agent);
        } catch (error) {
            console.error('Error updating agent:', error);
            throw error;
        }
    }

    /**
     * Delete an agent
     */
    static async delete(id) {
        try {
            if (!mongoose.Types.ObjectId.isValid(id)) {
                throw new Error('Invalid agent id');
            }
            await AgentModel.findByIdAndDelete(id);
            return true;
        } catch (error) {
            console.error('Error deleting agent:', error);
            throw error;
        }
    }

    /**
     * Format agent data to match expected structure
     */
    static formatAgent(agent) {
        const doc = agent.toObject ? agent.toObject() : agent;
        return {
            id: (doc._id || doc.id).toString(),
            user_id: doc.userId,
            name: doc.name,
            type: doc.type,
            description: doc.description,
            logo_url: doc.logoUrl,
            source_url: doc.sourceUrl,
            vector_store_id: doc.vectorStoreId,
            metadata: doc.metadata || {},
            created_at: doc.createdAt,
            updated_at: doc.updatedAt,
        };
    }
}

module.exports = Agent;
