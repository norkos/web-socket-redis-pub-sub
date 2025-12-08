import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { get } from 'http';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';

// Get CLIENT_ID from command line argument (--name) or environment variable (CLIENT_NAME)
// Usage: npm run client -- --name Alice
// Or: CLIENT_NAME=Alice npm run client
// If not provided, falls back to random UUID
function getClientId(): string {
  // Check command line arguments for --name
  const args = process.argv.slice(2);
  const nameIndex = args.indexOf('--name');
  if (nameIndex !== -1 && args[nameIndex + 1]) {
    return args[nameIndex + 1];
  }
  
  // Check environment variable
  if (process.env.CLIENT_NAME) {
    return process.env.CLIENT_NAME;
  }
  
  // Fall back to random UUID if no name provided
  return randomUUID();
}

// Get friends from command line argument (--friend) or environment variable (FRIENDS)
// Usage: npm run client -- --name Alice --friend Bob,Charlie
// Or: FRIENDS=Bob,Charlie npm run client
// Friend names are automatically prefixed with "topic-" to create topic names
function getTopics(): string[] {
  const args = process.argv.slice(2);
  let friends: string[] = [];
  
  // Check command line arguments for --friend
  const friendIndex = args.indexOf('--friend');
  if (friendIndex !== -1 && args[friendIndex + 1]) {
    friends = args[friendIndex + 1].split(',').map(f => f.trim()).filter(f => f);
  } else if (process.env.FRIENDS) {
    // Check environment variable
    friends = process.env.FRIENDS.split(',').map(f => f.trim()).filter(f => f);
  }
  
  // Add "topic-" prefix to each friend name
  return friends.map(friend => `topic-${friend}`);
}

// Get debug flag from command line argument (--debug) or environment variable (DEBUG)
// Usage: npm run client -- --debug
// Or: DEBUG=true npm run client
function getDebugFlag(): boolean {
  const args = process.argv.slice(2);
  if (args.includes('--debug')) {
    return true;
  }
  return process.env.DEBUG === 'true' || process.env.DEBUG === '1';
}

const DEBUG = getDebugFlag();

// Debug logging function
function debugLog(...args: any[]): void {
  if (DEBUG) {
    console.log(...args);
  }
}

const CLIENT_ID = getClientId();
const INITIAL_TOPICS = getTopics();

// Function to fetch WebSocket URL from server
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

// Main function to connect to WebSocket
async function connectToWebSocket() {
  try {
    const WEBSOCKET_URL = await fetchWebSocketUrl(CLIENT_ID, INITIAL_TOPICS);
    debugLog(`Client ID: ${CLIENT_ID}`);
    if (INITIAL_TOPICS.length > 0) {
      debugLog(`Subscribing to friend topics: ${INITIAL_TOPICS.join(', ')}`);
    }
    debugLog(`🔌 Connecting to ${WEBSOCKET_URL}...`);
    
    // Create WebSocket connection
    const ws = new WebSocket(WEBSOCKET_URL);

    // Connection opened
    ws.on('open', () => {
      debugLog('✅ Connected to WebSocket server');
      
      // If topics weren't provided in URL, subscribe via message (if needed)
      // The server already handles topics from URL query params
      
      // Start sending messages every 20 seconds
      const interval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          const message = {
            text: ` ${CLIENT_ID} updating geolocation`,
            clientId: CLIENT_ID,
            timestamp: new Date().toISOString()
          };
          
          ws.send(JSON.stringify(message));
          console.log(`📤 Sent message: ${message.text}`);
        } else {
          debugLog('⚠️  WebSocket not open, clearing interval');
          clearInterval(interval);
        }
      }, 20000); // 20 seconds

      // Clean up interval on close
      ws.on('close', () => {
        clearInterval(interval);
        debugLog('Interval cleared');
      });
    });

    // Handle incoming messages
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'topic-message') {
          // Keep message content as regular log (not debug)
          console.log(`📥 Received message from topic "${message.topic}":`, message.data);
        } else if (message.type === 'welcome') {
          debugLog('📥 Welcome message:', message);
          if (message.subscribedTopics && message.subscribedTopics.length > 0) {
            debugLog(`✅ Subscribed to topics: ${message.subscribedTopics.join(', ')}`);
          }
        } else if (message.type === 'subscribed') {
          debugLog(`✅ Subscribed to topics: ${message.topics.join(', ')}`);
          debugLog(`📋 All subscribed topics: ${message.allSubscribedTopics.join(', ')}`);
        } else if (message.type === 'unsubscribed') {
          debugLog(`❌ Unsubscribed from topics: ${message.topics.join(', ')}`);
          debugLog(`📋 All subscribed topics: ${message.allSubscribedTopics.join(', ')}`);
        } else {
          // Keep message content as regular log (not debug)
          console.log('📥 Received:', message);
        }
      } catch (error) {
        console.error('Error parsing message:', error);
      }
    });

    // Handle errors
    ws.on('error', (error) => {
      debugLog('❌ WebSocket error:', error);
    });

    // Handle connection close
    ws.on('close', (code, reason) => {
      debugLog(`🔌 Connection closed. Code: ${code}, Reason: ${reason.toString()}`);
      process.exit(0);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      debugLog('\n🛑 Shutting down client...');
      ws.close();
      process.exit(0);
    });
    
  } catch (error) {
    debugLog('❌ Failed to connect:', error);
    process.exit(1);
  }
}

// Start the client
connectToWebSocket();

