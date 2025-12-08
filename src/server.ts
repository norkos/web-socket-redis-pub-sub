import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import Redis from 'ioredis';

const PORT = process.env.PORT || 8080;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

// Create Redis client for PUB/SUB
const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  }
});

redis.on('connect', () => {
  console.log('✅ Connected to Redis');
});

redis.on('error', (error: Error) => {
  console.error('❌ Redis connection error:', error);
});

redis.on('close', () => {
  console.log('🔌 Redis connection closed');
});

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

// Track client count per IP address for human-readable IDs
const ipClientCounts = new Map<string, number>();

// Extend WebSocket to store client metadata
interface ClientWebSocket extends WebSocket {
  clientId?: string;
  clientIp?: string;
  redisTopic?: string;
  subscribedTopics?: Set<string>;
  redisSubscriber?: Redis;
}

wss.on('connection', (ws: WebSocket, req) => {
  const clientIp = req.socket.remoteAddress || 'unknown';
  
  // Extract clientId from WebSocket URL query parameters
  let clientId: string;
  const url = new URL(req.url || '/ws', `http://${req.headers.host}`);
  const clientIdParam = url.searchParams.get('clientId');
  
  if (clientIdParam) {
    // Use the clientId provided by the client
    clientId = clientIdParam;
  } else {
    // Fallback: Generate client ID based on IP and counter
    const currentCount = ipClientCounts.get(clientIp) || 0;
    const nextCount = currentCount + 1;
    ipClientCounts.set(clientIp, nextCount);
    clientId = `${clientIp}-${nextCount}`;
  }
  
  // Create Redis PUB/SUB topic for this client
  const redisTopic = `topic-${clientId}`;
  
  // Extract topics from query parameters (comma-separated)
  const topicsParam = url.searchParams.get('topics');
  const initialTopics = topicsParam ? topicsParam.split(',').map(t => t.trim()).filter(t => t) : [];
  
  // Store client metadata on the WebSocket object
  const clientWs = ws as ClientWebSocket;
  clientWs.clientId = clientId;
  clientWs.clientIp = clientIp;
  clientWs.redisTopic = redisTopic;
  clientWs.subscribedTopics = new Set<string>();
  
  // Create a Redis subscriber for this client
  const redisSubscriber = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    retryStrategy: (times: number) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    }
  });
  
  clientWs.redisSubscriber = redisSubscriber;
  
  // Subscribe to Redis messages and forward to WebSocket client
  redisSubscriber.on('message', (topic: string, message: string) => {
    if (clientWs.subscribedTopics?.has(topic) && ws.readyState === WebSocket.OPEN) {
      try {
        const parsedMessage = JSON.parse(message);
        ws.send(JSON.stringify({
          type: 'topic-message',
          topic: topic,
          data: parsedMessage,
          timestamp: new Date().toISOString()
        }));
        console.log(`📥 Forwarded message from topic ${topic} to client ${clientId}`);
      } catch (error) {
        console.error(`Error parsing message from topic ${topic} for client ${clientId}:`, error);
      }
    }
  });
  
  redisSubscriber.on('error', (error: Error) => {
    console.error(`Redis subscriber error for client ${clientId}:`, error);
  });
  
  // Subscribe to initial topics if provided
  if (initialTopics.length > 0) {
    initialTopics.forEach(topic => {
      clientWs.subscribedTopics!.add(topic);
      redisSubscriber.subscribe(topic);
      console.log(`📡 Client ${clientId} subscribed to topic: ${topic}`);
    });
  }
  
  console.log(`New client connected - ID: ${clientId}, IP: ${clientIp}, Redis Topic: ${redisTopic}, Subscribed Topics: ${initialTopics.join(', ') || 'none'}`);
  
  // Add client to set
  clients.add(ws);
  
  // Send welcome message
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Connected to WebSocket server',
    clientId: clientId,
    redisTopic: redisTopic,
    subscribedTopics: Array.from(clientWs.subscribedTopics),
    timestamp: new Date().toISOString()
  }));

  // Handle incoming messages
  ws.on('message', async (data: Buffer) => {
    const clientWs = ws as ClientWebSocket;
    let message: any;

    // Parse JSON first - this is the most likely source of errors
    try {
      message = JSON.parse(data.toString());
    } catch (parseError) {
      console.error(`Error parsing JSON from client ${clientWs.clientId}:`, parseError);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid JSON format',
        timestamp: new Date().toISOString()
      }));
      return;
    }

    // Process the message
    try {
      console.log(`Received message from client ${clientWs.clientId} (IP: ${clientWs.clientIp}):`, message);

      // Handle subscription/unsubscription requests
      if (message.type === 'subscribe' && Array.isArray(message.topics)) {
        const topicsToSubscribe = message.topics.filter((topic: string) => typeof topic === 'string' && topic.trim());
        const newTopics: string[] = [];
        
        topicsToSubscribe.forEach((topic: string) => {
          if (!clientWs.subscribedTopics?.has(topic)) {
            clientWs.subscribedTopics?.add(topic);
            clientWs.redisSubscriber?.subscribe(topic);
            newTopics.push(topic);
            console.log(`📡 Client ${clientWs.clientId} subscribed to topic: ${topic}`);
          }
        });
        
        ws.send(JSON.stringify({
          type: 'subscribed',
          topics: newTopics,
          allSubscribedTopics: Array.from(clientWs.subscribedTopics || []),
          timestamp: new Date().toISOString()
        }));
        return;
      }
      
      if (message.type === 'unsubscribe' && Array.isArray(message.topics)) {
        const topicsToUnsubscribe = message.topics.filter((topic: string) => typeof topic === 'string' && topic.trim());
        const removedTopics: string[] = [];
        
        topicsToUnsubscribe.forEach((topic: string) => {
          if (clientWs.subscribedTopics?.has(topic)) {
            clientWs.subscribedTopics.delete(topic);
            clientWs.redisSubscriber?.unsubscribe(topic);
            removedTopics.push(topic);
            console.log(`📡 Client ${clientWs.clientId} unsubscribed from topic: ${topic}`);
          }
        });
        
        ws.send(JSON.stringify({
          type: 'unsubscribed',
          topics: removedTopics,
          allSubscribedTopics: Array.from(clientWs.subscribedTopics || []),
          timestamp: new Date().toISOString()
        }));
        return;
      }

      // Publish message to Redis topic for this client
      if (clientWs.redisTopic) {
        try {
          const redisMessage = JSON.stringify({
            clientId: clientWs.clientId,
            clientIp: clientWs.clientIp,
            message: message,
            timestamp: new Date().toISOString()
          });
          
          await redis.publish(clientWs.redisTopic, redisMessage);
          console.log(`📤 Published message to Redis topic: ${clientWs.redisTopic}`);
        } catch (redisError) {
          console.error(`Redis publish error for client ${clientWs.clientId}:`, redisError);
          // Continue processing even if Redis fails - don't block the client
        }
      }
    } catch (error) {
      console.error(`Error processing message from client ${clientWs.clientId}:`, error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Error processing message',
        timestamp: new Date().toISOString()
      }));
    }
  });

  // Handle client disconnect
  ws.on('close', () => {
    const clientWs = ws as ClientWebSocket;
    console.log(`Client ${clientWs.clientId} (IP: ${clientWs.clientIp}, Redis Topic: ${clientWs.redisTopic}) disconnected`);
    
    // Clean up Redis subscriber
    if (clientWs.redisSubscriber) {
      clientWs.redisSubscriber.quit();
    }
    
    clients.delete(ws);
  });

  // Handle errors
  ws.on('error', (error) => {
    const clientWs = ws as ClientWebSocket;
    console.error(`WebSocket error for client ${clientWs.clientId} (IP: ${clientWs.clientIp}):`, error);
    
    // Clean up Redis subscriber
    if (clientWs.redisSubscriber) {
      clientWs.redisSubscriber.quit();
    }
    
    clients.delete(ws);
  });
});

// REST GET endpoint to get WebSocket connection information
server.on('request', (req, res) => {
  // GET endpoint for WebSocket information
  if (req.method === 'GET' && req.url?.startsWith('/api/websocket')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const clientId = url.searchParams.get('clientId');
    const topics = url.searchParams.get('topics');
    
    const host = req.headers.host || `localhost:${PORT}`;
    // Determine protocol: check for forwarded proto header (from proxy/load balancer)
    // or default to ws (wss would be used if behind HTTPS proxy)
    const forwardedProto = req.headers['x-forwarded-proto'];
    const protocol = forwardedProto === 'https' ? 'wss' : 'ws';
    
    // Include clientId and topics in WebSocket URL if provided
    let websocketUrl = `${protocol}://${host}/ws`;
    const params = new URLSearchParams();
    if (clientId) {
      params.set('clientId', clientId);
    }
    if (topics) {
      params.set('topics', topics);
    }
    if (params.toString()) {
      websocketUrl += `?${params.toString()}`;
    }
    
    const response = {
      websocket: {
        url: websocketUrl,
        path: '/ws',
        protocol: 'ws',
        clientId: clientId || null,
        topics: topics ? topics.split(',') : null,
        description: 'WebSocket connection endpoint for real-time communication'
      },
      connection: {
        instructions: [
          'Connect to the WebSocket URL using any WebSocket client',
          'Send messages as JSON format: { "text": "your message" }',
          'Subscribe to topics via URL query parameter: ?topics=topic1,topic2',
          'Or send subscription message: { "type": "subscribe", "topics": ["topic1", "topic2"] }',
          'Unsubscribe: { "type": "unsubscribe", "topics": ["topic1"] }'
        ]
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

  // GET endpoint for list of connected clients
  if (req.method === 'GET' && req.url === '/api/clients') {
    const connectedClients = Array.from(clients)
      .filter((client) => client.readyState === WebSocket.OPEN)
      .map((client) => {
        const clientWs = client as ClientWebSocket;
        return {
          clientId: clientWs.clientId || 'unknown'
        };
      });

    const response = {
      clients: connectedClients,
      count: connectedClients.length,
      timestamp: new Date().toISOString()
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
  console.log(`Connected clients endpoint: http://localhost:${PORT}/api/clients`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  wss.close(() => {
    server.close(() => {
      redis.quit(() => {
        console.log('Server and Redis closed');
        process.exit(0);
      });
    });
  });
});
