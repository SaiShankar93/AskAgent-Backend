const mongoose = require('mongoose');

let isConnected = false;

async function connectToDatabase() {
    if (isConnected) {
        return mongoose.connection;
    }

    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/askagent';

    mongoose.set('strictQuery', true);

    await mongoose.connect(mongoUri, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
    });

    isConnected = true;
    console.log(`✅ Connected to MongoDB database: ${mongoose.connection.name}`);
    return mongoose.connection;
}

module.exports = connectToDatabase; 
