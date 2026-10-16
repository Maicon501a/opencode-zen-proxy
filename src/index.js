#!/usr/bin/env node

'use strict';

const { createApp } = require('./server');
const { config } = require('./config/constants');
const { FREE_MODELS } = require('./config/models');
const warp = require('./services/warp');
const transport = require('./services/transport');
const stats = require('./services/stats');
const keys = require('./services/keys');

const VERSION = '2.3.0';

const app = createApp();

const server = app.listen(config.port, config.host, () => {
  const authMode = config.clientApiKey
    ? 'client auth (CLIENT_API_KEY)'
    : 'keyless (open to local clients)';
  const base = `http://${config.host}:${config.port}`;

  console.log(`
  OpenCode Zen Proxy v${VERSION}
  Keyless OpenAI-compatible proxy for the OpenCode Zen free tier

  Server:            ${base}
  Health:            ${base}/health
  Models:            ${base}/v1/models
  Chat:              POST ${base}/v1/chat/completions
  Responses:         POST ${base}/v1/responses

  Upstream:          ${config.zenApiBaseUrl} (direct, no local binary)
  Free-tier gate:    on (official CLI headers, forced streaming, read tool)
  Auth mode:         ${authMode}
  Upstream key:      ${config.zenApiKey === 'public' ? '"public" (free-tier models)' : '(configured)'}
  Free models:       ${FREE_MODELS.length} (use with or without the "opencode/" prefix)
  Reasoning effort:  ${config.defaultReasoningEffort === '' ? 'upstream default (high), client may override' : config.defaultReasoningEffort}
  Egress:            ${transport.status().isolated ? `isolated (SOCKS5 ${transport.status().socks5})` : 'direct'}
  IP rotation:       ${transport.hasRotate() ? 'on (fresh exit on rate limit)' : 'off'}
  WARP failover:     ${warp.isEnabled() ? 'on (429/502/503/504 + gateway 500 + network failures)' : 'off'}

  Example:
    curl ${base}/v1/chat/completions \\
      -H "Content-Type: application/json" \\
      -d '{
        "model": "opencode/deepseek-v4.1-flash-free",
        "messages": [{"role": "user", "content": "Say hello!"}]
      }'
`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  try {
    stats.flush();
    keys.flush();
  } catch {
    // best effort — never block shutdown on persistence
  }
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
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
