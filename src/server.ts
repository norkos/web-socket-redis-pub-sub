import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import Redis from 'ioredis';

const PORT = process.env.PORT || 8080;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB
const MAX_HTTP_REQUEST_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_TOPICS = 100;
const MAX_CLIENT_ID_LENGTH = 256;
const MAX_TOPIC_LENGTH = 128;
const RATE_LIMIT_MESSAGES_PER_SECOND = 10;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : null;

function sanitizeString(input: string, maxLength: number): string {
  if (!input || typeof input !== 'string') {
    return '';
  }
  // Remove control characters and limit length
  return input.replace(/[\x00-\x1F\x7F]/g, '').slice(0, maxLength).trim();
}

function sanitizeClientId(input: string): string {
  // Only allow alphanumeric, hyphens, underscores, and dots
  const sanitized = sanitizeString(input, MAX_CLIENT_ID_LENGTH);
  return sanitized.replace(/[^a-zA-Z0-9._-]/g, '');
}

function sanitizeTopic(input: string): string {
  // Only allow alphanumeric, hyphens, underscores, and dots
  const sanitized = sanitizeString(input, MAX_TOPIC_LENGTH);
  return sanitized.replace(/[^a-zA-Z0-9._-]/g, '');
}

function sanitizeForLogging(data: any): any {
  if (typeof data === 'string') {
    // Truncate long strings and remove sensitive patterns
    return data.slice(0, 200).replace(/password|token|secret|key/gi, '[REDACTED]');
  }
  if (typeof data === 'object' && data !== null) {
    const sanitized: any = Array.isArray(data) ? [] : {};
    for (const key in data) {
      if (key.toLowerCase().includes('password') || 
          key.toLowerCase().includes('token') || 
          key.toLowerCase().includes('secret') ||
          key.toLowerCase().includes('key')) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeForLogging(data[key]);
      }
    }
    return sanitized;
  }
  return data;
}

function debugLog(...args: any[]): void {
  if (DEBUG) {
    const sanitizedArgs = args.map(arg => sanitizeForLogging(arg));
    console.log(...sanitizedArgs);
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
    const sanitized = sanitizeClientId(clientIdParam);
    if (sanitized) {
      return sanitized;
    }
  }
  
  // Sanitize IP address
  const sanitizedIp = sanitizeString(clientIp, 45); // IPv6 max length
  const currentCount = ipClientCounts.get(sanitizedIp) || 0;
  const nextCount = currentCount + 1;
  ipClientCounts.set(sanitizedIp, nextCount);
  return `${sanitizedIp}-${nextCount}`;
}

function extractTopicsFromQueryParams(url: URL): string[] {
  const topicsParam = url.searchParams.get('topics');
  if (!topicsParam) {
    return [];
  }
  
  const topics = topicsParam.split(',')
    .map(t => sanitizeTopic(t.trim()))
    .filter(t => t);
  
  // Limit number of topics
  return topics.slice(0, MAX_TOPICS);
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

function safeJsonParse<T>(data: string, maxSize: number): T | null {
  if (data.length > maxSize) {
    return null;
  }
  
  try {
    // Use reviver to prevent prototype pollution
    return JSON.parse(data, (key, value) => {
      // Prevent prototype pollution
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return undefined;
      }
      return value;
    }) as T;
  } catch {
    return null;
  }
}

function forwardRedisMessageToWebSocket(
  redisSubscriber: Redis,
  clientWs: ClientWebSocket,
  ws: WebSocket,
  clientId: string
): void {
  redisSubscriber.on('message', (topic: string, message: string) => {
    if (clientWs.subscribedTopics?.has(topic) && ws.readyState === WebSocket.OPEN) {
      // Check message size
      if (message.length > MAX_MESSAGE_SIZE) {
        debugLog(`⚠️  Message from topic ${sanitizeString(topic, MAX_TOPIC_LENGTH)} exceeds size limit for client ${sanitizeString(clientId, MAX_CLIENT_ID_LENGTH)}`);
        return;
      }
      
      try {
        const parsedMessage = safeJsonParse<any>(message, MAX_MESSAGE_SIZE);
        if (parsedMessage === null) {
          debugLog(`Error parsing message from topic ${sanitizeString(topic, MAX_TOPIC_LENGTH)} for client ${sanitizeString(clientId, MAX_CLIENT_ID_LENGTH)}`);
          return;
        }
        
        const response = JSON.stringify({
          type: 'topic-message',
          topic: sanitizeString(topic, MAX_TOPIC_LENGTH),
          data: parsedMessage,
          timestamp: new Date().toISOString()
        });
        
        if (response.length > MAX_MESSAGE_SIZE) {
          debugLog(`⚠️  Response message exceeds size limit for client ${sanitizeString(clientId, MAX_CLIENT_ID_LENGTH)}`);
          return;
        }
        
        ws.send(response);
        debugLog(`📥 Forwarded message from topic ${sanitizeString(topic, MAX_TOPIC_LENGTH)} to client ${sanitizeString(clientId, MAX_CLIENT_ID_LENGTH)}`);
      } catch (error) {
        debugLog(`Error processing message from topic ${sanitizeString(topic, MAX_TOPIC_LENGTH)} for client ${sanitizeString(clientId, MAX_CLIENT_ID_LENGTH)}`);
      }
    }
  });

  redisSubscriber.on('error', (error: Error) => {
    debugLog(`Redis subscriber error for client ${sanitizeString(clientId, MAX_CLIENT_ID_LENGTH)}`);
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
      const sanitizedTopic = sanitizeTopic(topic);
      if (sanitizedTopic && !clientWs.subscribedTopics?.has(sanitizedTopic)) {
        clientWs.subscribedTopics!.add(sanitizedTopic);
        redisSubscriber.subscribe(sanitizedTopic);
        debugLog(`📡 Client ${sanitizeString(clientId, MAX_CLIENT_ID_LENGTH)} subscribed to topic: ${sanitizedTopic}`);
      }
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

function validateOrigin(origin: string | undefined): boolean {
  if (!ALLOWED_ORIGINS || ALLOWED_ORIGINS.length === 0) {
    return true; // No restrictions if not configured
  }
  
  if (!origin) {
    return false;
  }
  
  return ALLOWED_ORIGINS.includes(origin);
}

wss.on('connection', (ws: WebSocket, req) => {
  // Validate origin if configured
  const origin = req.headers.origin;
  if (!validateOrigin(origin)) {
    debugLog(`⚠️  Connection rejected from unauthorized origin: ${origin}`);
    ws.close(1008, 'Unauthorized origin');
    return;
  }
  
  const clientIp = req.socket.remoteAddress || 'unknown';
  const url = new URL(req.url || '/ws', `http://${req.headers.host}`);
  const clientId = generateClientIdFromQueryOrIp(url, clientIp);
  const redisTopic = `topic-${clientId}`;
  const initialTopics = extractTopicsFromQueryParams(url);
  
  const clientWs = initializeClientMetadata(ws, clientId, sanitizeString(clientIp, 45), redisTopic);
  const redisSubscriber = createRedisClient();
  clientWs.redisSubscriber = redisSubscriber;
  
  forwardRedisMessageToWebSocket(redisSubscriber, clientWs, ws, clientId);
  subscribeToInitialTopics(redisSubscriber, clientWs, initialTopics, clientId);
  
  debugLog(`New client connected - ID: ${sanitizeString(clientId, MAX_CLIENT_ID_LENGTH)}, IP: ${sanitizeString(clientIp, 45)}, Subscribed Topics: ${initialTopics.length}`);
  
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

interface IncomingMessage {
  type?: string;
  topics?: string[];
  [key: string]: any;
}

function validateMessageStructure(message: any): message is IncomingMessage {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }
  return true;
}

function parseIncomingMessage(data: Buffer, clientId: string): IncomingMessage | null {
  // Check message size before parsing
  if (data.length > MAX_MESSAGE_SIZE) {
    debugLog(`⚠️  Message size ${data.length} exceeds maximum ${MAX_MESSAGE_SIZE} from client ${sanitizeString(clientId, MAX_CLIENT_ID_LENGTH)}`);
    return null;
  }
  
  try {
    const message = safeJsonParse<IncomingMessage>(data.toString('utf8'), MAX_MESSAGE_SIZE);
    
    if (!message || !validateMessageStructure(message)) {
      debugLog(`Error parsing JSON from client ${sanitizeString(clientId, MAX_CLIENT_ID_LENGTH)}: Invalid structure`);
      return null;
    }
    
    return message;
  } catch (parseError) {
    debugLog(`Error parsing JSON from client ${sanitizeString(clientId, MAX_CLIENT_ID_LENGTH)}`);
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
  // Limit number of topics
  const limitedTopics = topics.slice(0, MAX_TOPICS);
  
  const topicsToSubscribe = limitedTopics
    .filter((topic: string) => typeof topic === 'string' && topic.trim())
    .map(topic => sanitizeTopic(topic))
    .filter(topic => topic);
  
  const newTopics: string[] = [];
  
  topicsToSubscribe.forEach((topic: string) => {
    if (!clientWs.subscribedTopics?.has(topic) && clientWs.subscribedTopics!.size < MAX_TOPICS) {
      clientWs.subscribedTopics?.add(topic);
      clientWs.redisSubscriber?.subscribe(topic);
      newTopics.push(topic);
      debugLog(`📡 Client ${sanitizeString(clientWs.clientId || 'unknown', MAX_CLIENT_ID_LENGTH)} subscribed to topic: ${topic}`);
    }
  });
  
  const response = JSON.stringify({
    type: 'subscribed',
    topics: newTopics,
    allSubscribedTopics: Array.from(clientWs.subscribedTopics || []).slice(0, MAX_TOPICS),
    timestamp: new Date().toISOString()
  });
  
  if (response.length <= MAX_MESSAGE_SIZE) {
    ws.send(response);
  } else {
    debugLog(`⚠️  Response message too large for client ${sanitizeString(clientWs.clientId || 'unknown', MAX_CLIENT_ID_LENGTH)}`);
  }
}

function handleUnsubscriptionRequest(
  ws: WebSocket,
  clientWs: ClientWebSocket,
  topics: string[]
): void {
  const topicsToUnsubscribe = topics
    .filter((topic: string) => typeof topic === 'string' && topic.trim())
    .map(topic => sanitizeTopic(topic))
    .filter(topic => topic);
  
  const removedTopics: string[] = [];
  
  topicsToUnsubscribe.forEach((topic: string) => {
    if (clientWs.subscribedTopics?.has(topic)) {
      clientWs.subscribedTopics.delete(topic);
      clientWs.redisSubscriber?.unsubscribe(topic);
      removedTopics.push(topic);
      debugLog(`📡 Client ${sanitizeString(clientWs.clientId || 'unknown', MAX_CLIENT_ID_LENGTH)} unsubscribed from topic: ${topic}`);
    }
  });
  
  const response = JSON.stringify({
    type: 'unsubscribed',
    topics: removedTopics,
    allSubscribedTopics: Array.from(clientWs.subscribedTopics || []),
    timestamp: new Date().toISOString()
  });
  
  if (response.length <= MAX_MESSAGE_SIZE) {
    ws.send(response);
  } else {
    debugLog(`⚠️  Response message too large for client ${sanitizeString(clientWs.clientId || 'unknown', MAX_CLIENT_ID_LENGTH)}`);
  }
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

class RateLimiter {
  private clientLimits = new Map<string, number[]>();
  private maxMessages: number;
  private timeWindow: number;

  constructor(maxMessages: number, timeWindowMs: number) {
    this.maxMessages = maxMessages;
    this.timeWindow = timeWindowMs;
  }

  canSend(clientId: string): boolean {
    const now = Date.now();
    const messages = this.clientLimits.get(clientId) || [];
    
    // Remove messages outside the time window
    const recentMessages = messages.filter(time => now - time < this.timeWindow);
    
    if (recentMessages.length >= this.maxMessages) {
      return false;
    }
    
    recentMessages.push(now);
    this.clientLimits.set(clientId, recentMessages);
    return true;
  }
}

const rateLimiter = new RateLimiter(RATE_LIMIT_MESSAGES_PER_SECOND, 1000);

async function processIncomingMessage(
  ws: WebSocket,
  clientWs: ClientWebSocket,
  message: IncomingMessage,
  redis: Redis
): Promise<void> {
  try {
    const clientId = sanitizeString(clientWs.clientId || 'unknown', MAX_CLIENT_ID_LENGTH);
    
    // Rate limiting
    if (!rateLimiter.canSend(clientId)) {
      debugLog(`⚠️  Rate limit exceeded for client ${clientId}`);
      sendErrorMessage(ws, 'Rate limit exceeded');
      return;
    }
    
    console.log(`Received message from client ${clientId} (IP: ${sanitizeString(clientWs.clientIp || 'unknown', 45)}):`, sanitizeForLogging(message));

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
    debugLog(`Error processing message from client ${sanitizeString(clientWs.clientId || 'unknown', MAX_CLIENT_ID_LENGTH)}`);
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
  const clientIdParam = url.searchParams.get('clientId');
  const topicsParam = url.searchParams.get('topics');
  
  // Sanitize inputs
  const clientId = clientIdParam ? sanitizeClientId(clientIdParam) : null;
  const topics = topicsParam ? sanitizeString(topicsParam, 1000) : null;
  
  const response = buildWebSocketInfoResponse(req, clientId, topics);
  sendJsonResponse(res, 200, response);
}

function handleConnectedClientsListEndpoint(req: any, res: any): void {
  const response = buildConnectedClientsResponse();
  sendJsonResponse(res, 200, response);
}

server.on('request', (req, res) => {
  // Limit request size
  let requestSize = 0;
  const chunks: Buffer[] = [];
  
  req.on('data', (chunk: Buffer) => {
    requestSize += chunk.length;
    if (requestSize > MAX_HTTP_REQUEST_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request entity too large' }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  
  req.on('end', () => {
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
  
  req.on('error', (error) => {
    debugLog(`Request error: ${error.message}`);
    if (!res.headersSent) {
      sendJsonResponse(res, 500, { error: 'Internal server error' });
    }
  });
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
