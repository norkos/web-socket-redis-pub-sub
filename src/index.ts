import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

const PORT = process.env.PORT || 8080;

// Create HTTP server
const server = createServer();

// Create WebSocket server
const wss = new WebSocketServer({ 
  server,
  path: '/ws'
});

// Store connected clients
const clients = new Set<WebSocket>();

wss.on('connection', (ws: WebSocket, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`New client connected from ${clientIp}`);
  
  // Add client to set
  clients.add(ws);
  
  // Send welcome message
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Connected to WebSocket server',
    timestamp: new Date().toISOString()
  }));

  // Handle incoming messages
  ws.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      console.log(`Received message from ${clientIp}:`, message);

      // Echo message back to sender
      ws.send(JSON.stringify({
        type: 'echo',
        original: message,
        timestamp: new Date().toISOString()
      }));

      // Broadcast to all other clients (optional)
      if (message.broadcast) {
        clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'broadcast',
              from: clientIp,
              message: message,
              timestamp: new Date().toISOString()
            }));
          }
        });
      }
    } catch (error) {
      console.error('Error parsing message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid JSON format',
        timestamp: new Date().toISOString()
      }));
    }
  });

  // Handle client disconnect
  ws.on('close', () => {
    console.log(`Client ${clientIp} disconnected`);
    clients.delete(ws);
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error(`WebSocket error for ${clientIp}:`, error);
    clients.delete(ws);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`WebSocket server is running on ws://localhost:${PORT}/ws`);
  console.log(`HTTP server is running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  wss.close(() => {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
});

