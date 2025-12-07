# WebSocketServer Design Pattern Explanation

## The Pattern: **Composition** (Has-A Relationship)

The `WebSocketServer` uses **Composition** to attach itself to an existing HTTP server. This is a fundamental design pattern in the `ws` library.

## Why This Pattern?

### 1. **WebSocket Protocol Requirement**
WebSocket connections **must** start as HTTP requests. The client sends an HTTP request with special headers:
```
GET /ws HTTP/1.1
Host: localhost:8080
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: ...
Sec-WebSocket-Version: 13
```

The server responds with:
```
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: ...
```

After this handshake, the connection **upgrades** from HTTP to WebSocket protocol.

### 2. **The Composition Pattern**

```typescript
const server = createServer();  // HTTP server
const wss = new WebSocketServer({ server });  // WebSocketServer composes HTTP server
```

**Relationship**: `WebSocketServer` **has-a** `HTTPServer`, not **is-a** `HTTPServer`

- `WebSocketServer` doesn't extend `HTTPServer`
- `WebSocketServer` uses `HTTPServer` internally
- `WebSocketServer` listens for HTTP upgrade requests on the HTTP server

### 3. **How It Works Internally**

When you pass `server` to `WebSocketServer`:

1. `WebSocketServer` attaches an `'upgrade'` event listener to the HTTP server
2. When an HTTP request comes in with `Upgrade: websocket` header:
   - HTTP server emits `'upgrade'` event
   - `WebSocketServer` intercepts it
   - Performs the WebSocket handshake
   - Creates a `WebSocket` connection
   - Emits `'connection'` event on `WebSocketServer`

### 4. **Benefits of This Pattern**

#### ✅ **Single Port**
```typescript
server.listen(8080);  // Both HTTP and WebSocket on same port
// HTTP:  http://localhost:8080/
// WebSocket: ws://localhost:8080/ws
```

#### ✅ **Mixed Protocol Support**
You can serve both HTTP endpoints and WebSocket on the same server:
```typescript
server.on('request', (req, res) => {
  if (req.url === '/api') {
    res.end('HTTP API response');
  }
  // WebSocketServer handles /ws automatically
});
```

#### ✅ **Resource Efficiency**
- Reuses existing HTTP server infrastructure
- No need for separate ports or servers
- Shared connection handling

#### ✅ **Standards Compliance**
- Follows WebSocket specification (RFC 6455)
- Standard HTTP upgrade mechanism

## Alternative Pattern: Standalone WebSocketServer

You can also create a standalone WebSocketServer (without passing a server):

```typescript
const wss = new WebSocketServer({ port: 8080 });
```

**What happens internally:**
- `WebSocketServer` creates its own HTTP server
- Still uses the same composition pattern internally
- Just hides the HTTP server from you

## Design Pattern Classification

This is primarily:
1. **Composition Pattern** - WebSocketServer composes HTTP server
2. **Adapter Pattern** - Adapts WebSocket functionality to HTTP infrastructure
3. **Observer Pattern** - Listens to HTTP server's 'upgrade' events

## Code Flow

```
1. Client sends HTTP request with Upgrade header
   ↓
2. HTTP server receives request
   ↓
3. HTTP server emits 'upgrade' event
   ↓
4. WebSocketServer (listening for 'upgrade') intercepts
   ↓
5. WebSocketServer performs handshake
   ↓
6. Connection upgraded to WebSocket
   ↓
7. WebSocketServer emits 'connection' event
   ↓
8. Your code handles WebSocket connection
```

## Summary

The `WebSocketServer` contains a reference to an HTTP server because:
- **WebSocket protocol requires HTTP handshake** (specification requirement)
- **Composition pattern** allows code reuse and flexibility
- **Single port** for both protocols (convenience)
- **Standards compliance** with RFC 6455

This is a well-established pattern in network programming where higher-level protocols build upon lower-level ones.

