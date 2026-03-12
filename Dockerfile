FROM node:20-alpine

# Install build tools needed by native addons (better-sqlite3, etc.)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Default command — nodemon hot-reload
# Note: node_modules are NOT copied here.
# Run `docker compose run --rm server npm install` once after first build.
CMD ["npm", "run", "dev"]
