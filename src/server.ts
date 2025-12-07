import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { randomUUID } from 'crypto';

const PORT = process.env.PORT || 8080;

// Create HTTP server
const server = createServer();

// WebSocketServer COMPOSES the HTTP server (has-a relationship)
// It doesn't inherit from it, but uses it internally
const wss = new WebSocketServer({ 
  server,  // Composition: WebSocketServer uses HTTP server
  path: '/ws'
});

// Store connected clients
const clients = new Set<WebSocket>();

// Extend WebSocket to store client metadata
interface ClientWebSocket extends WebSocket {
  clientId?: string;
  clientIp?: string;
}

wss.on('connection', (ws: WebSocket, req) => {
  const clientIp = req.socket.remoteAddress;
  const clientId = randomUUID();
  
  // Store client metadata on the WebSocket object
  (ws as ClientWebSocket).clientId = clientId;
  (ws as ClientWebSocket).clientIp = clientIp;
  
  console.log(`New client connected - ID: ${clientId}, IP: ${clientIp}`);
  
  // Add client to set
  clients.add(ws);
  
  // Send welcome message
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Connected to WebSocket server',
    clientId: clientId,
    timestamp: new Date().toISOString()
  }));

  // Handle incoming messages
  ws.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      const clientWs = ws as ClientWebSocket;
      console.log(`Received message from client ${clientWs.clientId} (IP: ${clientWs.clientIp}):`, message);

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
            const clientWs = client as ClientWebSocket;
            client.send(JSON.stringify({
              type: 'broadcast',
              from: {
                clientId: clientWs.clientId,
                clientIp: clientWs.clientIp
              },
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
    const clientWs = ws as ClientWebSocket;
    console.log(`Client ${clientWs.clientId} (IP: ${clientWs.clientIp}) disconnected`);
    clients.delete(ws);
  });

  // Handle errors
  ws.on('error', (error) => {
    const clientWs = ws as ClientWebSocket;
    console.error(`WebSocket error for client ${clientWs.clientId} (IP: ${clientWs.clientIp}):`, error);
    clients.delete(ws);
  });
});

// REST GET endpoint to get WebSocket connection information
server.on('request', (req, res) => {
  // GET endpoint for WebSocket information
  if (req.method === 'GET' && req.url === '/api/websocket') {
    const host = req.headers.host || `localhost:${PORT}`;
    // Determine protocol: check for forwarded proto header (from proxy/load balancer)
    // or default to ws (wss would be used if behind HTTPS proxy)
    const forwardedProto = req.headers['x-forwarded-proto'];
    const protocol = forwardedProto === 'https' ? 'wss' : 'ws';
    
    const websocketUrl = `${protocol}://${host}/ws`;
    
    const response = {
      websocket: {
        url: websocketUrl,
        path: '/ws',
        protocol: 'ws',
        description: 'WebSocket connection endpoint for real-time communication'
      },
      connection: {
        instructions: [
          'Connect to the WebSocket URL using any WebSocket client',
          'Send messages as JSON format: { "text": "your message", "broadcast": false }',
          'Set broadcast: true to send message to all connected clients'
        ],
        example: {
          javascript: `const ws = new WebSocket('${websocketUrl}');
ws.onopen = () => console.log('Connected');
ws.onmessage = (event) => console.log('Received:', JSON.parse(event.data));
ws.send(JSON.stringify({ text: 'Hello', broadcast: false }));`
        }
      },
      server: {
        status: 'running',
        connectedClients: clients.size,
        timestamp: new Date().toISOString()
      }
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response, null, 2));
    return;
  }

  // Default 404 for other routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

// Start server
server.listen(PORT, () => {
  console.log(`WebSocket server is running on ws://localhost:${PORT}/ws`);
  console.log(`HTTP server is running on http://localhost:${PORT}`);
  console.log(`WebSocket info endpoint: http://localhost:${PORT}/api/websocket`);
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

