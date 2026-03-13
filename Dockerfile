FROM node:20-alpine

WORKDIR /app

# Install dependencies during build for non-bind-mount workflows.
COPY package*.json ./
RUN npm install

# Copy app source for plain docker run usage.
COPY . .

CMD ["npm", "run", "dev"]
