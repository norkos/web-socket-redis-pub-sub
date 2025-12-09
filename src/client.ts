import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { get } from 'http';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';

function getClientId(): string {
  const args = process.argv.slice(2);
  const nameIndex = args.indexOf('--name');
  if (nameIndex !== -1 && args[nameIndex + 1]) {
    return args[nameIndex + 1];
  }
  
  if (process.env.CLIENT_NAME) {
    return process.env.CLIENT_NAME;
  }
  
  return randomUUID();
}

function getObseredTopics(): string[] {
  const args = process.argv.slice(2);
  let friends: string[] = [];
  
  const friendIndex = args.indexOf('--friend');
  if (friendIndex !== -1 && args[friendIndex + 1]) {
    friends = args[friendIndex + 1].split(',').map(f => f.trim()).filter(f => f);
  } else if (process.env.FRIENDS) {
    friends = process.env.FRIENDS.split(',').map(f => f.trim()).filter(f => f);
  }
  
  return friends.map(friend => `topic-${friend}`);
}

function getDebugFlag(): boolean {
  const args = process.argv.slice(2);
  if (args.includes('--debug')) {
    return true;
  }
  return process.env.DEBUG === 'true' || process.env.DEBUG === '1';
}

const DEBUG = getDebugFlag();

function debugLog(...args: any[]): void {
  if (DEBUG) {
    console.log(...args);
  }
}

const CLIENT_ID = getClientId();
const INITIAL_TOPICS = getObseredTopics();

function fetchWebSocketUrl(clientId: string, topics: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/websocket', SERVER_URL);
    url.searchParams.set('clientId', clientId);
    if (topics.length > 0) {
      url.searchParams.set('topics', topics.join(','));
    }
    
    debugLog(`📡 Fetching WebSocket URL from ${url.toString()}...`);
    
    get(url.toString(), (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          const websocketUrl = response.websocket?.url;
          
          if (websocketUrl) {
            debugLog(`✅ Got WebSocket URL: ${websocketUrl}`);
            resolve(websocketUrl);
          } else {
            reject(new Error('WebSocket URL not found in server response'));
          }
        } catch (error) {
          reject(new Error(`Failed to parse server response: ${error}`));
        }
      });
    }).on('error', (error) => {
      reject(new Error(`Failed to fetch WebSocket URL: ${error.message}`));
    });
  });
}

function setupPeriodicGeolocationUpdates(ws: WebSocket, clientId: string): NodeJS.Timeout {
  return setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      const message = {
        text: ` ${clientId} updating geolocation`,
        clientId: clientId,
        timestamp: new Date().toISOString()
      };
      
      ws.send(JSON.stringify(message));
      console.log(`📤 Sent message: ${message.text}`);
    } else {
      debugLog('⚠️  WebSocket not open, clearing interval');
    }
  }, 20000); // 20 seconds
}

function handleIncomingWebSocketMessage(data: Buffer): void {
  try {
    const message = JSON.parse(data.toString());
    
    switch (message.type) {
      case 'topic-message':
        console.log(`📥 Received message from topic "${message.topic}":`, message.data);
        break;
      
      case 'welcome':
        debugLog('📥 Welcome message:', message);
        if (message.subscribedTopics && message.subscribedTopics.length > 0) {
          debugLog(`✅ Subscribed to topics: ${message.subscribedTopics.join(', ')}`);
        }
        break;
      
      case 'subscribed':
        debugLog(`✅ Subscribed to topics: ${message.topics.join(', ')}`);
        debugLog(`📋 All subscribed topics: ${message.allSubscribedTopics.join(', ')}`);
        break;
      
      case 'unsubscribed':
        debugLog(`❌ Unsubscribed from topics: ${message.topics.join(', ')}`);
        debugLog(`📋 All subscribed topics: ${message.allSubscribedTopics.join(', ')}`);
        break;
      
      default:
        console.log('📥 Received:', message);
        break;
    }
  } catch (error) {
    console.error('Error parsing message:', error);
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

