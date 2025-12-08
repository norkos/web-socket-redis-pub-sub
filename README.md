# WebSocket Server (TypeScript)

A WebSocket server built with Node.js and TypeScript.

## Features

- WebSocket server using the `ws` library
- TypeScript support
- Client connection management
- Redis PUB/SUB integration
- Topic subscription system for clients
- REST API endpoints for WebSocket info and client list
- Debug logging support
- Graceful shutdown handling

## Installation

```bash
npm install
```

## Development

Run in development mode (with ts-node):
```bash
npm run dev
```

Build TypeScript to JavaScript:
```bash
npm run build
```

Run the compiled server:
```bash
npm start
```

Watch mode (auto-compile on changes):
```bash
npm run watch
```

## Usage

The server runs on `ws://localhost:8080/ws` by default.

### Running the Client

The project includes a client application that connects to the WebSocket server. You can run it with:

```bash
npm run client
```

#### Client ID

You can specify a custom client ID (name) when running the client. This is useful when running multiple client instances:

**Using command line argument:**
```bash
npm run client -- --name Alice
npm run client -- --name Bob
npm run client -- --name Charlie
```

**Using environment variable:**
```bash
CLIENT_NAME=Alice npm run client
CLIENT_NAME=Bob npm run client
```

If no name is provided, the client will use a random UUID as the client ID.

#### Topic Subscription (Friends)

Clients can subscribe to topics (friend topics) to receive messages published to those topics. Friend names are automatically prefixed with "topic-" to create topic names.

**Using command line argument:**
```bash
npm run client -- --name Alice --friend Bob,Charlie
```

**Using environment variable:**
```bash
FRIENDS=Bob,Charlie npm run client -- --name Alice
```

This will subscribe Alice to `topic-Bob` and `topic-Charlie`. When messages are published to these topics in Redis, Alice will receive them.

**Example: Running multiple client instances with friend subscriptions:**
```bash
# Terminal 1 - Alice subscribes to Bob and Charlie
npm run client -- --name Alice --friend Bob,Charlie

# Terminal 2 - Bob subscribes to Alice
npm run client -- --name Bob --friend Alice

# Terminal 3 - Charlie subscribes to Alice
npm run client -- --name Charlie --friend Alice
```

#### Debug Logging

Enable debug logging to see detailed connection, subscription, and message information:

**Using command line argument:**
```bash
npm run client -- --name Alice --debug
```

**Using environment variable:**
```bash
DEBUG=true npm run client -- --name Alice
```

By default, only received message content is logged. With debug enabled, you'll see connection status, subscription events, and other operational logs.

### Connecting with a WebSocket Client

You can test the server using any WebSocket client. Here's an example using Node.js:

```javascript
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8080/ws');

ws.on('open', () => {
  console.log('Connected');
  
  // Send a message
  ws.send(JSON.stringify({
    text: 'Hello, server!'
  }));
});

ws.on('message', (data) => {
  console.log('Received:', JSON.parse(data.toString()));
});

ws.on('error', (error) => {
  console.error('Error:', error);
});
```

### Message Format

Send messages as JSON:

```json
{
  "text": "Your message here"
}
```

- `text`: The message content

### Server Responses

The server sends different message types:

- `welcome`: Sent when a client connects, includes `clientId`, `redisTopic`, and `subscribedTopics`
- `topic-message`: Messages received from subscribed topics, includes `topic` and `data`
- `subscribed`: Confirmation when subscribing to topics, includes `topics` and `allSubscribedTopics`
- `unsubscribed`: Confirmation when unsubscribing from topics, includes `topics` and `allSubscribedTopics`
- `error`: Error messages

### Topic Subscription

Clients can subscribe to topics dynamically after connection:

**Subscribe to topics:**
```json
{
  "type": "subscribe",
  "topics": ["topic-Bob", "topic-Charlie"]
}
```

**Unsubscribe from topics:**
```json
{
  "type": "unsubscribe",
  "topics": ["topic-Bob"]
}
```

### API Endpoints

The server provides REST API endpoints:

**Get WebSocket connection information:**
```bash
GET /api/websocket?clientId=Alice&topics=topic-Bob,topic-Charlie
```

**Get list of connected clients:**
```bash
GET /api/clients
```

Returns:
```json
{
  "clients": [
    { "clientId": "Alice" },
    { "clientId": "Bob" }
  ],
  "count": 2,
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

## Docker

### Run Redis with Docker Compose

Start Redis:
```bash
docker-compose up -d redis
```

This will start Redis on `localhost:6379`.

### Run Everything with Docker Compose

To run both Redis and the server in Docker:
```bash
docker-compose up
```

Or in detached mode:
```bash
docker-compose up -d
```

### Build and Run Server Docker Image

Build the server image:
```bash
docker build -t web-socket-server .
```

Run the server container:
```bash
docker run -p 8080:8080 --network websocket-network web-socket-server
```

## Environment Variables

### Server

- `PORT`: Server port (default: 8080)
- `REDIS_HOST`: Redis host (default: localhost)
- `REDIS_PORT`: Redis port (default: 6379)
- `DEBUG`: Enable debug logging (set to `true` or `1` to enable)

### Client

- `CLIENT_NAME`: Client ID/name to use when connecting (if not provided, uses random UUID)
- `FRIENDS`: Comma-separated list of friend names to subscribe to (automatically prefixed with "topic-")
- `SERVER_URL`: Server URL to connect to (default: http://localhost:8080)
- `DEBUG`: Enable debug logging (set to `true` or `1` to enable)

**Example:**
```bash
CLIENT_NAME=Alice FRIENDS=Bob,Charlie DEBUG=true npm run client
```

## License

ISC

