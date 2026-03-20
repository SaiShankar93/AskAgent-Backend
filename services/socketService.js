/**
 * Singleton Socket.io server.
 *
 * Initialised once from index.js (init(httpServer)).
 * Every other module calls emit() to push events to clients.
 */

const { Server } = require('socket.io');

let io = null;

/**
 * Call this once during server boot, passing the raw http.Server instance.
 */
function init(httpServer) {
    io = new Server(httpServer, {
        cors: {
            origin: process.env.FRONTEND_URL || '*',
            methods: ['GET', 'POST'],
            credentials: true,
        },
        transports: ['websocket', 'polling'],
    });

    io.on('connection', (socket) => {
        console.log(`[Socket] Client connected: ${socket.id}`);

        // Client joins a room for a specific agent so it only receives events
        // for agents it cares about.
        socket.on('join:agent', (agentId) => {
            socket.join(`agent:${agentId}`);
            console.log(`[Socket] ${socket.id} joined room: agent:${agentId}`);
        });

        socket.on('leave:agent', (agentId) => {
            socket.leave(`agent:${agentId}`);
        });

        socket.on('disconnect', () => {
            console.log(`[Socket] Client disconnected: ${socket.id}`);
        });
    });

    console.log('[Socket] Server initialised ✓');
    return io;
}

/**
 * Emit an event to all clients listening on a specific agent room.
 * Safe to call even before init() — events are dropped silently.
 *
 * @param {string} agentId
 * @param {string} event     - e.g. 'agent:progress', 'agent:page-scraped'
 * @param {object} payload
 */
function emitToAgent(agentId, event, payload) {
    if (!io) return;
    io.to(`agent:${agentId}`).emit(event, { agentId, ...payload });
}

function getIO() {
    return io;
}

module.exports = { init, emitToAgent, getIO };
