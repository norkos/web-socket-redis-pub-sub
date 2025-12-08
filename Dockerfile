FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for building)
RUN npm ci

# Copy source files
COPY . .

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 8080

# Set environment variables
ENV PORT=8080
ENV REDIS_HOST=redis
ENV REDIS_PORT=6379

# Start the server
CMD ["npm", "start"]

