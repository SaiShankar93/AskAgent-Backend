const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const connectToDatabase  = require('./config/mongo');

dotenv.config();

const app = express();

app.use(cors({
    origin: "*",
    credentials: true,
}));

app.use(express.json());

// Load routes
const agentRoutes = require('./routes/agentRoutes');
const chatRoutes = require('./routes/chatRoutes');

app.use('/api/agents', agentRoutes);
app.use('/api/chat', chatRoutes);

const PORT = process.env.PORT || 5000;

// Initialize MongoDB then start server
(async () => {
    try {
        await connectToDatabase();
        app.listen(PORT, () => {
            console.log(`AskAgent backend running on port ${PORT}`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
})();
