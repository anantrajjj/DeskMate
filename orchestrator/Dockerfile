FROM node:20-slim

WORKDIR /app

# Install dependencies first for Docker layer caching
COPY package.json package-lock.json* ./
RUN npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Expose the orchestrator port
EXPOSE 3001

# Run the compiled JavaScript
CMD ["node", "dist/index.js"]
