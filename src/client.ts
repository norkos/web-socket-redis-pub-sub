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

// Get topics from command line argument (--topics) or environment variable (TOPICS)
// Usage: npm run client -- --name Alice --topics topic-Bob,topic-Charlie
// Or: TOPICS=topic-Bob,topic-Charlie npm run client
function getTopics(): string[] {
  const args = process.argv.slice(2);
  
  // Check command line arguments for --topics
  const topicsIndex = args.indexOf('--topics');
  if (topicsIndex !== -1 && args[topicsIndex + 1]) {
    return args[topicsIndex + 1].split(',').map(t => t.trim()).filter(t => t);
  }
  
  // Check environment variable
  if (process.env.TOPICS) {
    return process.env.TOPICS.split(',').map(t => t.trim()).filter(t => t);
  }
  
  return [];
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
    
    console.log(`📡 Fetching WebSocket URL from ${url.toString()}...`);
    
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
            console.log(`✅ Got WebSocket URL: ${websocketUrl}`);
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
    console.log(`Client ID: ${CLIENT_ID}`);
    if (INITIAL_TOPICS.length > 0) {
      console.log(`Subscribing to topics: ${INITIAL_TOPICS.join(', ')}`);
    }
    console.log(`🔌 Connecting to ${WEBSOCKET_URL}...`);
    
    // Create WebSocket connection
    const ws = new WebSocket(WEBSOCKET_URL);

    // Connection opened
    ws.on('open', () => {
      console.log('✅ Connected to WebSocket server');
      
      // If topics weren't provided in URL, subscribe via message (if needed)
      // The server already handles topics from URL query params
      
      // Start sending messages every 20 seconds
      const interval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          const message = {
            text: `Sending geolocation from ${CLIENT_ID}`,
            clientId: CLIENT_ID,
            timestamp: new Date().toISOString()
          };
          
          ws.send(JSON.stringify(message));
          console.log(`📤 Sent message: ${message.text}`);
        } else {
          console.log('⚠️  WebSocket not open, clearing interval');
          clearInterval(interval);
        }
      }, 20000); // 20 seconds

      // Clean up interval on close
      ws.on('close', () => {
        clearInterval(interval);
        console.log('Interval cleared');
      });
    });

    // Handle incoming messages
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'topic-message') {
          console.log(`📥 Received message from topic "${message.topic}":`, message.data);
        } else if (message.type === 'welcome') {
          console.log('📥 Welcome message:', message);
          if (message.subscribedTopics && message.subscribedTopics.length > 0) {
            console.log(`✅ Subscribed to topics: ${message.subscribedTopics.join(', ')}`);
          }
        } else if (message.type === 'subscribed') {
          console.log(`✅ Subscribed to topics: ${message.topics.join(', ')}`);
          console.log(`📋 All subscribed topics: ${message.allSubscribedTopics.join(', ')}`);
        } else if (message.type === 'unsubscribed') {
          console.log(`❌ Unsubscribed from topics: ${message.topics.join(', ')}`);
          console.log(`📋 All subscribed topics: ${message.allSubscribedTopics.join(', ')}`);
        } else {
          console.log('📥 Received:', message);
        }
      } catch (error) {
        console.error('Error parsing message:', error);
      }
    });

    // Handle errors
    ws.on('error', (error) => {
      console.error('❌ WebSocket error:', error);
    });

    // Handle connection close
    ws.on('close', (code, reason) => {
      console.log(`🔌 Connection closed. Code: ${code}, Reason: ${reason.toString()}`);
      process.exit(0);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n🛑 Shutting down client...');
      ws.close();
      process.exit(0);
    });
    
  } catch (error) {
    console.error('❌ Failed to connect:', error);
    process.exit(1);
  }
}

// Start the client
connectToWebSocket();

