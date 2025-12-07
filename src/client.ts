import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { get } from 'http';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';
const CLIENT_ID = randomUUID();

// Function to fetch WebSocket URL from server
function fetchWebSocketUrl(): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/websocket', SERVER_URL);
    
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
    const WEBSOCKET_URL = await fetchWebSocketUrl();
    console.log(`Client ID: ${CLIENT_ID}`);
    console.log(`🔌 Connecting to ${WEBSOCKET_URL}...`);
    
    // Create WebSocket connection
    const ws = new WebSocket(WEBSOCKET_URL);

    // Connection opened
    ws.on('open', () => {
      console.log('✅ Connected to WebSocket server');
      
      // Start sending broadcast messages every 10 seconds
      const interval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          const message = {
            text: `Broadcast message from client ${CLIENT_ID}`,
            broadcast: true,
            clientId: CLIENT_ID,
            timestamp: new Date().toISOString()
          };
          
          ws.send(JSON.stringify(message));
          console.log(`📤 Sent broadcast message: ${message.text}`);
        } else {
          console.log('⚠️  WebSocket not open, clearing interval');
          clearInterval(interval);
        }
      }, 10000); // 10 seconds

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
        console.log('📥 Received:', message);
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

