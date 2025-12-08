# WebSocket Server (TypeScript)

A WebSocket server built with Node.js and TypeScript.

## Features

- WebSocket server using the `ws` library
- TypeScript support
- Message broadcasting
- Client connection management
- Redis PUB/SUB integration
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

### Connecting with a WebSocket Client

You can test the server using any WebSocket client. Here's an example using Node.js:

```javascript
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8080/ws');

ws.on('open', () => {
  console.log('Connected');
  
  // Send a message
  ws.send(JSON.stringify({
    text: 'Hello, server!',
    broadcast: false
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
  "text": "Your message here",
  "broadcast": true
}
```

- `text`: The message content
- `broadcast`: If `true`, the message will be sent to all connected clients

### Server Responses

The server sends different message types:

- `welcome`: Sent when a client connects
- `echo`: Echo of your message
- `broadcast`: Messages from other clients (when broadcast is enabled)
- `error`: Error messages

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

- `PORT`: Server port (default: 8080)
- `REDIS_HOST`: Redis host (default: localhost)
- `REDIS_PORT`: Redis port (default: 6379)

## License

ISC

