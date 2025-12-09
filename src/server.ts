import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import Redis from 'ioredis';

const PORT = process.env.PORT || 8080;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

function debugLog(...args: any[]): void {
  if (DEBUG) {
    console.log(...args);
  }
}

function createRedisRetryStrategy() {
  return (times: number) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  };
}

function createRedisClient(): Redis {
  return new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    retryStrategy: createRedisRetryStrategy()
  });
}

function setupRedisEventHandlers(redis: Redis): void {
  redis.on('connect', () => {
    debugLog('✅ Connected to Redis');
  });

  redis.on('error', (error: Error) => {
    debugLog('❌ Redis connection error:', error);
  });

  redis.on('close', () => {
    debugLog('🔌 Redis connection closed');
  });
}

const redis = createRedisClient();
setupRedisEventHandlers(redis);

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

function generateClientIdFromQueryOrIp(url: URL, clientIp: string): string {
  const clientIdParam = url.searchParams.get('clientId');
  
  if (clientIdParam) {
    return clientIdParam;
  }
  
  const currentCount = ipClientCounts.get(clientIp) || 0;
  const nextCount = currentCount + 1;
  ipClientCounts.set(clientIp, nextCount);
  return `${clientIp}-${nextCount}`;
}

function extractTopicsFromQueryParams(url: URL): string[] {
  const topicsParam = url.searchParams.get('topics');
  return topicsParam ? topicsParam.split(',').map(t => t.trim()).filter(t => t) : [];
}

function initializeClientMetadata(
  ws: WebSocket,
  clientId: string,
  clientIp: string,
  redisTopic: string
): ClientWebSocket {
  const clientWs = ws as ClientWebSocket;
  clientWs.clientId = clientId;
  clientWs.clientIp = clientIp;
  clientWs.redisTopic = redisTopic;
  clientWs.subscribedTopics = new Set<string>();
  return clientWs;
}

function forwardRedisMessageToWebSocket(
  redisSubscriber: Redis,
  clientWs: ClientWebSocket,
  ws: WebSocket,
  clientId: string
): void {
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
        debugLog(`📥 Forwarded message from topic ${topic} to client ${clientId}`);
      } catch (error) {
        debugLog(`Error parsing message from topic ${topic} for client ${clientId}:`, error);
      }
    }
  });

  redisSubscriber.on('error', (error: Error) => {
    debugLog(`Redis subscriber error for client ${clientId}:`, error);
  });
}

function subscribeToInitialTopics(
  redisSubscriber: Redis,
  clientWs: ClientWebSocket,
  topics: string[],
  clientId: string
): void {
  if (topics.length > 0) {
    topics.forEach(topic => {
      clientWs.subscribedTopics!.add(topic);
      redisSubscriber.subscribe(topic);
      debugLog(`📡 Client ${clientId} subscribed to topic: ${topic}`);
    });
  }
}

function sendWelcomeMessageToClient(
  ws: WebSocket,
  clientWs: ClientWebSocket,
  clientId: string,
  redisTopic: string
): void {
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Connected to WebSocket server',
    clientId: clientId,
    redisTopic: redisTopic,
    subscribedTopics: Array.from(clientWs.subscribedTopics || []),
    timestamp: new Date().toISOString()
  }));
}

wss.on('connection', (ws: WebSocket, req) => {
  const clientIp = req.socket.remoteAddress || 'unknown';
  const url = new URL(req.url || '/ws', `http://${req.headers.host}`);
  const clientId = generateClientIdFromQueryOrIp(url, clientIp);
  const redisTopic = `topic-${clientId}`;
  const initialTopics = extractTopicsFromQueryParams(url);
  
  const clientWs = initializeClientMetadata(ws, clientId, clientIp, redisTopic);
  const redisSubscriber = createRedisClient();
  clientWs.redisSubscriber = redisSubscriber;
  
  forwardRedisMessageToWebSocket(redisSubscriber, clientWs, ws, clientId);
  subscribeToInitialTopics(redisSubscriber, clientWs, initialTopics, clientId);
  
  debugLog(`New client connected - ID: ${clientId}, IP: ${clientIp}, Redis Topic: ${redisTopic}, Subscribed Topics: ${initialTopics.join(', ') || 'none'}`);
  
  clients.add(ws);
  sendWelcomeMessageToClient(ws, clientWs, clientId, redisTopic);

  ws.on('message', async (data: Buffer) => {
    const clientWs = ws as ClientWebSocket;
    const message = parseIncomingMessage(data, clientWs.clientId || 'unknown');

    if (message === null) {
      sendErrorMessage(ws, 'Invalid JSON format');
      return;
    }

    await processIncomingMessage(ws, clientWs, message, redis);
  });

  ws.on('close', () => {
    const clientWs = ws as ClientWebSocket;
    cleanupClientResources(clientWs, ws);
  });

  ws.on('error', (error) => {
    const clientWs = ws as ClientWebSocket;
    debugLog(`WebSocket error for client ${clientWs.clientId} (IP: ${clientWs.clientIp}):`, error);
    cleanupClientResources(clientWs, ws);
  });
});

function parseIncomingMessage(data: Buffer, clientId: string): any | null {
  try {
    return JSON.parse(data.toString());
  } catch (parseError) {
    debugLog(`Error parsing JSON from client ${clientId}:`, parseError);
    return null;
  }
}

function sendErrorMessage(ws: WebSocket, message: string): void {
  ws.send(JSON.stringify({
    type: 'error',
    message: message,
    timestamp: new Date().toISOString()
  }));
}

function handleSubscriptionRequest(
  ws: WebSocket,
  clientWs: ClientWebSocket,
  topics: string[]
): void {
  const topicsToSubscribe = topics.filter((topic: string) => typeof topic === 'string' && topic.trim());
  const newTopics: string[] = [];
  
  topicsToSubscribe.forEach((topic: string) => {
    if (!clientWs.subscribedTopics?.has(topic)) {
      clientWs.subscribedTopics?.add(topic);
      clientWs.redisSubscriber?.subscribe(topic);
      newTopics.push(topic);
      debugLog(`📡 Client ${clientWs.clientId} subscribed to topic: ${topic}`);
    }
  });
  
  ws.send(JSON.stringify({
    type: 'subscribed',
    topics: newTopics,
    allSubscribedTopics: Array.from(clientWs.subscribedTopics || []),
    timestamp: new Date().toISOString()
  }));
}

function handleUnsubscriptionRequest(
  ws: WebSocket,
  clientWs: ClientWebSocket,
  topics: string[]
): void {
  const topicsToUnsubscribe = topics.filter((topic: string) => typeof topic === 'string' && topic.trim());
  const removedTopics: string[] = [];
  
  topicsToUnsubscribe.forEach((topic: string) => {
    if (clientWs.subscribedTopics?.has(topic)) {
      clientWs.subscribedTopics.delete(topic);
      clientWs.redisSubscriber?.unsubscribe(topic);
      removedTopics.push(topic);
      debugLog(`📡 Client ${clientWs.clientId} unsubscribed from topic: ${topic}`);
    }
  });
  
  ws.send(JSON.stringify({
    type: 'unsubscribed',
    topics: removedTopics,
    allSubscribedTopics: Array.from(clientWs.subscribedTopics || []),
    timestamp: new Date().toISOString()
  }));
}

async function publishClientMessageToRedis(
  redis: Redis,
  clientWs: ClientWebSocket,
  message: any
): Promise<void> {
  if (!clientWs.redisTopic) {
    return;
  }

  try {
    const redisMessage = JSON.stringify({
      clientId: clientWs.clientId,
      clientIp: clientWs.clientIp,
      message: message,
      timestamp: new Date().toISOString()
    });
    
    await redis.publish(clientWs.redisTopic, redisMessage);
    debugLog(`📤 Published message to Redis topic: ${clientWs.redisTopic}`);
  } catch (redisError) {
    debugLog(`Redis publish error for client ${clientWs.clientId}:`, redisError);
  }
}

async function processIncomingMessage(
  ws: WebSocket,
  clientWs: ClientWebSocket,
  message: any,
  redis: Redis
): Promise<void> {
  try {
    console.log(`Received message from client ${clientWs.clientId} (IP: ${clientWs.clientIp}):`, message);

    if (message.type === 'subscribe' && Array.isArray(message.topics)) {
      handleSubscriptionRequest(ws, clientWs, message.topics);
      return;
    }
    
    if (message.type === 'unsubscribe' && Array.isArray(message.topics)) {
      handleUnsubscriptionRequest(ws, clientWs, message.topics);
      return;
    }

    await publishClientMessageToRedis(redis, clientWs, message);
  } catch (error) {
    debugLog(`Error processing message from client ${clientWs.clientId}:`, error);
    sendErrorMessage(ws, 'Error processing message');
  }
}

function cleanupClientResources(clientWs: ClientWebSocket, ws: WebSocket): void {
  debugLog(`Client ${clientWs.clientId} (IP: ${clientWs.clientIp}, Redis Topic: ${clientWs.redisTopic}) disconnected`);
  
  if (clientWs.redisSubscriber) {
    clientWs.redisSubscriber.quit();
  }
  
  clients.delete(ws);
}

function buildWebSocketUrl(req: any, clientId: string | null, topics: string | null): string {
  const host = req.headers.host || `localhost:${PORT}`;
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = forwardedProto === 'https' ? 'wss' : 'ws';
  
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
  return websocketUrl;
}

function buildWebSocketInfoResponse(req: any, clientId: string | null, topics: string | null): any {
  const websocketUrl = buildWebSocketUrl(req, clientId, topics);
  
  return {
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
}

function buildConnectedClientsResponse(): any {
  const connectedClients = Array.from(clients)
    .filter((client) => client.readyState === WebSocket.OPEN)
    .map((client) => {
      const clientWs = client as ClientWebSocket;
      return {
        clientId: clientWs.clientId || 'unknown'
      };
    });

  return {
    clients: connectedClients,
    count: connectedClients.length,
    timestamp: new Date().toISOString()
  };
}

function sendJsonResponse(res: any, statusCode: number, data: any): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function handleWebSocketInfoEndpoint(req: any, res: any): void {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const clientId = url.searchParams.get('clientId');
  const topics = url.searchParams.get('topics');
  const response = buildWebSocketInfoResponse(req, clientId, topics);
  sendJsonResponse(res, 200, response);
}

function handleConnectedClientsListEndpoint(req: any, res: any): void {
  const response = buildConnectedClientsResponse();
  sendJsonResponse(res, 200, response);
}

server.on('request', (req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/api/websocket')) {
    handleWebSocketInfoEndpoint(req, res);
    return;
  }

  if (req.method === 'GET' && req.url === '/api/clients') {
    handleConnectedClientsListEndpoint(req, res);
    return;
  }

  sendJsonResponse(res, 404, { error: 'Not Found' });
});

function logServerStartup(): void {
  debugLog(`WebSocket server is running on ws://localhost:${PORT}/ws`);
  debugLog(`HTTP server is running on http://localhost:${PORT}`);
  debugLog(`WebSocket info endpoint: http://localhost:${PORT}/api/websocket`);
  debugLog(`Connected clients endpoint: http://localhost:${PORT}/api/clients`);
}

function shutdownServer(): void {
  debugLog('\nShutting down server...');
  wss.close(() => {
    server.close(() => {
      redis.quit(() => {
        debugLog('Server and Redis closed');
        process.exit(0);
      });
    });
  });
}

server.listen(PORT, logServerStartup);
process.on('SIGINT', shutdownServer);
