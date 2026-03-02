# Bun Native WebSocket Server

Lightweight WebSocket server built with Bun native API.  
In-memory room management, IP rate limiting, and online duration sync to external ExpressJS API.

## Features

-   Native Bun WebSocket (no framework)
    
-   In-memory room & user tracking
    
-   Multiple connections per user
    
-   Admin receives full user list
    
-   IP-based connection limit
    
-   Session duration calculation
    
-   Sync duration to external API
## Run Server

```bash
bun run bun_ws.js
```
Server listens on port `3001`.
