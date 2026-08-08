#!/usr/bin/env node

'use strict';

const { createApp } = require('./server');
const { config } = require('./config/constants');
const { FREE_MODELS } = require('./config/models');
const warp = require('./services/warp');

const app = createApp();

const server = app.listen(config.port, config.host, () => {
  const authMode = config.clientApiKey
    ? 'client auth (CLIENT_API_KEY)'
    : 'keyless (open to local clients)';
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              OpenCode Zen Proxy v1.0.0                       ║
║        OpenAI-compatible proxy for OpenCode Zen API          ║
╚══════════════════════════════════════════════════════════════╝

  Server running at: http://${config.host}:${config.port}
  Health check:      http://${config.host}:${config.port}/health
  Models list:       http://${config.host}:${config.port}/v1/models
  Chat completions:  POST http://${config.host}:${config.port}/v1/chat/completions

  Backend:           ${config.zenApiBaseUrl} (direct, no local binary)
  Auth mode:         ${authMode}
  Upstream key:      ${config.zenApiKey === 'public' ? '"public" (free-tier models)' : '(configured)'}
  Free models:       ${FREE_MODELS.length} models (use with or without "opencode/" prefix)
  Temporal context:  ${config.injectTemporalContext ? 'on (injects current date)' : 'off'}
  WARP failover:     ${config.warpAutoFailover ? `on (socks5://${config.warpSocksHost}:${config.warpSocksPort}, auto-activates warp-cli on failure)` : 'off'}
  WARP status:       ${warp.status().active ? 'active (tunnel up)' : 'idle (activated on demand)'}

  Examples:
    curl http://${config.host}:${config.port}/v1/chat/completions \\
      -H "Content-Type: application/json" \\
      -d '{
        "model": "opencode/deepseek-v4-flash-free",
        "messages": [{"role": "user", "content": "Say hello!"}]
      }'
`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdown('UNCAUGHT_EXCEPTION');
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
