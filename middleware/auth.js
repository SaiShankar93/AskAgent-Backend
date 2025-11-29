const { Clerk } = require('@clerk/clerk-sdk-node');
const clerk = Clerk({ secretKey: process.env.CLERK_SECRET_KEY });

// Middleware to authenticate requests using Clerk JWT
const requireAuth = async (req, res, next) => {
    try {
        // Get the Authorization header
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized: No token provided' });
        }

        const token = authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({ error: 'Unauthorized: Invalid token format' });
        }

        try {
            // Verify the JWT token with Clerk
            const { sub: userId } = await clerk.verifyToken(token);

            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized: Invalid token' });
            }

            // Add the userId to the request object
            req.auth = { userId };
            next();
        } catch (error) {
            console.error('Token verification error:', error);
            return res.status(401).json({ error: 'Unauthorized: Invalid token' });
        }
    } catch (error) {
        console.error('Authentication error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

module.exports = { requireAuth };
