FROM node:20-alpine

WORKDIR /app

# Install dependencies during build for non-bind-mount workflows.
COPY package*.json ./
RUN npm install

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Copy app source for plain docker run usage.
COPY . .

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "run", "dev"]
