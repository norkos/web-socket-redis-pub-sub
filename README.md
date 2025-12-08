# WebSocket Server (TypeScript)

A WebSocket server built with Node.js and TypeScript.

## Features

- WebSocket server using the `ws` library
- TypeScript support
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

**Example: Running multiple client instances:**
```bash
# Terminal 1
npm run client -- --name Alice

# Terminal 2
npm run client -- --name Bob

# Terminal 3
npm run client -- --name Charlie
```

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

- `welcome`: Sent when a client connects
- `echo`: Echo of your message
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

### Server

- `PORT`: Server port (default: 8080)
- `REDIS_HOST`: Redis host (default: localhost)
- `REDIS_PORT`: Redis port (default: 6379)
- `SERVER_URL`: Server URL for client to fetch WebSocket endpoint (default: http://localhost:8080)

### Client

- `CLIENT_NAME`: Client ID/name to use when connecting (if not provided, uses random UUID)
- `SERVER_URL`: Server URL to connect to (default: http://localhost:8080)

## License

ISC

