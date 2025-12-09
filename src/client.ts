import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { get } from 'http';
import { get as httpsGet } from 'https';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB
const MAX_HTTP_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_TOPICS = 100;
const MAX_CLIENT_ID_LENGTH = 256;
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
  const sanitized = sanitizeString(input, 128);
  return sanitized.replace(/[^a-zA-Z0-9._-]/g, '');
}

function getClientId(): string {
  const args = process.argv.slice(2);
  const nameIndex = args.indexOf('--name');
  if (nameIndex !== -1 && args[nameIndex + 1]) {
    return sanitizeClientId(args[nameIndex + 1]) || randomUUID();
  }
  
  if (process.env.CLIENT_NAME) {
    return sanitizeClientId(process.env.CLIENT_NAME) || randomUUID();
  }
  
  return randomUUID();
}

function getObseredTopics(): string[] {
  const args = process.argv.slice(2);
  let friends: string[] = [];
  
  const friendIndex = args.indexOf('--friend');
  if (friendIndex !== -1 && args[friendIndex + 1]) {
    friends = args[friendIndex + 1].split(',').map(f => sanitizeTopic(f.trim())).filter(f => f);
  } else if (process.env.FRIENDS) {
    friends = process.env.FRIENDS.split(',').map(f => sanitizeTopic(f.trim())).filter(f => f);
  }
  
  // Limit number of topics
  const sanitizedTopics = friends.slice(0, MAX_TOPICS).map(friend => `topic-${friend}`);
  return sanitizedTopics;
}

function getDebugFlag(): boolean {
  const args = process.argv.slice(2);
  if (args.includes('--debug')) {
    return true;
  }
  return process.env.DEBUG === 'true' || process.env.DEBUG === '1';
}

const DEBUG = getDebugFlag();

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

const CLIENT_ID = getClientId();
const INITIAL_TOPICS = getObseredTopics();

function validateWebSocketUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    
    // Only allow ws:// and wss:// protocols
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      return false;
    }
    
    // Validate origin if ALLOWED_ORIGINS is set
    if (ALLOWED_ORIGINS && ALLOWED_ORIGINS.length > 0) {
      const origin = `${url.protocol}//${url.host}`;
      if (!ALLOWED_ORIGINS.includes(origin)) {
        return false;
      }
    }
    
    return true;
  } catch {
    return false;
  }
}

function safeJsonParse<T>(data: string, maxSize: number): T | null {
  if (data.length > maxSize) {
    throw new Error(`Response size exceeds maximum allowed size of ${maxSize} bytes`);
  }
  
  // Use reviver to prevent prototype pollution
  return JSON.parse(data, (key, value) => {
    // Prevent prototype pollution
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return undefined;
    }
    return value;
  }) as T;
}

function fetchWebSocketUrl(clientId: string, topics: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/websocket', SERVER_URL);
    url.searchParams.set('clientId', clientId);
    if (topics.length > 0) {
      url.searchParams.set('topics', topics.join(','));
    }
    
    debugLog(`📡 Fetching WebSocket URL from ${url.host}...`);
    
    const httpModule = url.protocol === 'https:' ? httpsGet : get;
    
    const request = httpModule(url.toString(), (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }
      
      let data = '';
      let totalSize = 0;
      
      res.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_HTTP_RESPONSE_SIZE) {
          res.destroy();
          reject(new Error(`Response size exceeds maximum allowed size of ${MAX_HTTP_RESPONSE_SIZE} bytes`));
          return;
        }
        data += chunk.toString('utf8');
      });
      
      res.on('end', () => {
        try {
          const response = safeJsonParse<any>(data, MAX_HTTP_RESPONSE_SIZE);
          const websocketUrl = response?.websocket?.url;
          
          if (!websocketUrl || typeof websocketUrl !== 'string') {
            reject(new Error('WebSocket URL not found in server response'));
            return;
          }
          
          if (!validateWebSocketUrl(websocketUrl)) {
            reject(new Error('Invalid or unauthorized WebSocket URL'));
            return;
          }
          
          debugLog(`✅ Got WebSocket URL from ${new URL(websocketUrl).host}`);
          resolve(websocketUrl);
        } catch (error) {
          reject(new Error(`Failed to parse server response: ${error instanceof Error ? error.message : 'Unknown error'}`));
        }
      });
      
      res.on('error', (error) => {
        reject(new Error(`Failed to read response: ${error.message}`));
      });
    });
    
    request.on('error', (error) => {
      reject(new Error(`Failed to fetch WebSocket URL: ${error.message}`));
    });
    
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

class RateLimiter {
  private messages: number[] = [];
  private maxMessages: number;
  private timeWindow: number;

  constructor(maxMessages: number, timeWindowMs: number) {
    this.maxMessages = maxMessages;
    this.timeWindow = timeWindowMs;
  }

  canSend(): boolean {
    const now = Date.now();
    // Remove messages outside the time window
    this.messages = this.messages.filter(time => now - time < this.timeWindow);
    
    if (this.messages.length >= this.maxMessages) {
      return false;
    }
    
    this.messages.push(now);
    return true;
  }
}

const rateLimiter = new RateLimiter(RATE_LIMIT_MESSAGES_PER_SECOND, 1000);

function setupPeriodicGeolocationUpdates(ws: WebSocket, clientId: string): NodeJS.Timeout {
  return setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      if (!rateLimiter.canSend()) {
        debugLog('⚠️  Rate limit exceeded, skipping message');
        return;
      }
      
      const message = {
        text: ` ${clientId} updating geolocation`,
        clientId: clientId,
        timestamp: new Date().toISOString()
      };
      
      const messageStr = JSON.stringify(message);
      if (messageStr.length > MAX_MESSAGE_SIZE) {
        debugLog('⚠️  Message too large, skipping');
        return;
      }
      
      ws.send(messageStr);
      console.log(`📤 Sent message: ${message.text}`);
    } else {
      debugLog('⚠️  WebSocket not open, clearing interval');
    }
  }, 20000); // 20 seconds
}

interface WebSocketMessage {
  type: string;
  topic?: string;
  data?: any;
  subscribedTopics?: string[];
  topics?: string[];
  allSubscribedTopics?: string[];
  message?: string;
  timestamp?: string;
}

function validateMessageStructure(message: any): message is WebSocketMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }
  
  if (typeof message.type !== 'string') {
    return false;
  }
  
  // Validate message size
  const messageStr = JSON.stringify(message);
  if (messageStr.length > MAX_MESSAGE_SIZE) {
    return false;
  }
  
  return true;
}

function handleIncomingWebSocketMessage(data: Buffer): void {
  // Check message size before parsing
  if (data.length > MAX_MESSAGE_SIZE) {
    console.error(`⚠️  Message size ${data.length} exceeds maximum ${MAX_MESSAGE_SIZE}`);
    return;
  }
  
  try {
    const message = safeJsonParse<WebSocketMessage>(data.toString('utf8'), MAX_MESSAGE_SIZE);
    
    if (!message || !validateMessageStructure(message)) {
      console.error('⚠️  Invalid message structure');
      return;
    }
    
    switch (message.type) {
      case 'topic-message':
        if (message.topic && typeof message.topic === 'string') {
          console.log(`📥 Received message from topic "${sanitizeString(message.topic, 128)}":`, sanitizeForLogging(message.data));
        }
        break;
      
      case 'welcome':
        debugLog('📥 Welcome message received');
        if (Array.isArray(message.subscribedTopics) && message.subscribedTopics.length > 0) {
          const sanitizedTopics = message.subscribedTopics.map(t => sanitizeString(t, 128)).filter(t => t);
          debugLog(`✅ Subscribed to topics: ${sanitizedTopics.join(', ')}`);
        }
        break;
      
      case 'subscribed':
        if (Array.isArray(message.topics)) {
          const sanitizedTopics = message.topics.map(t => sanitizeString(t, 128)).filter(t => t);
          debugLog(`✅ Subscribed to topics: ${sanitizedTopics.join(', ')}`);
        }
        if (Array.isArray(message.allSubscribedTopics)) {
          const sanitizedAll = message.allSubscribedTopics.map(t => sanitizeString(t, 128)).filter(t => t);
          debugLog(`📋 All subscribed topics: ${sanitizedAll.join(', ')}`);
        }
        break;
      
      case 'unsubscribed':
        if (Array.isArray(message.topics)) {
          const sanitizedTopics = message.topics.map(t => sanitizeString(t, 128)).filter(t => t);
          debugLog(`❌ Unsubscribed from topics: ${sanitizedTopics.join(', ')}`);
        }
        if (Array.isArray(message.allSubscribedTopics)) {
          const sanitizedAll = message.allSubscribedTopics.map(t => sanitizeString(t, 128)).filter(t => t);
          debugLog(`📋 All subscribed topics: ${sanitizedAll.join(', ')}`);
        }
        break;
      
      default:
        console.log('📥 Received:', sanitizeForLogging(message));
        break;
    }
  } catch (error) {
    console.error('Error parsing message:', error instanceof Error ? error.message : 'Unknown error');
  }
}

function setupWebSocketEventHandlers(ws: WebSocket, clientId: string, interval: NodeJS.Timeout): void {
  ws.on('message', (data: Buffer) => {
    handleIncomingWebSocketMessage(data);
  });

  ws.on('error', (error) => {
    debugLog('❌ WebSocket error:', error);
  });

  ws.on('close', (code, reason) => {
    clearInterval(interval);
    debugLog('Interval cleared');
    debugLog(`🔌 Connection closed. Code: ${code}, Reason: ${reason.toString()}`);
    process.exit(0);
  });

  process.on('SIGINT', () => {
    debugLog('\n🛑 Shutting down client...');
    clearInterval(interval);
    ws.close();
    process.exit(0);
  });
}

async function connectToWebSocket() {
  try {
    const WEBSOCKET_URL = await fetchWebSocketUrl(CLIENT_ID, INITIAL_TOPICS);
    debugLog(`Client ID: ${CLIENT_ID}`);
    if (INITIAL_TOPICS.length > 0) {
      debugLog(`Subscribing to friend topics: ${INITIAL_TOPICS.join(', ')}`);
    }
    debugLog(`🔌 Connecting to ${WEBSOCKET_URL}...`);
    
    const ws = new WebSocket(WEBSOCKET_URL);

    ws.on('open', () => {
      debugLog('✅ Connected to WebSocket server');
      
      const interval = setupPeriodicGeolocationUpdates(ws, CLIENT_ID);
      setupWebSocketEventHandlers(ws, CLIENT_ID, interval);
    });
    
  } catch (error) {
    debugLog('❌ Failed to connect:', error);
    process.exit(1);
  }
}

connectToWebSocket();

