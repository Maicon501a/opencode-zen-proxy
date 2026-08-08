'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const config = {
  // Server
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',

  // OpenCode Zen API (direct, keyless for free models).
  // The Zen gateway accepts "public" as a bearer token that unlocks the
  // free-tier models (deepseek-v4-flash-free, mimo-v2.5-free, ...). This is
  // exactly what the opencode CLI does internally when no API key is set:
  //   options: hasKey ? {} : { apiKey: "public" }
  // No local `opencode serve` binary is required.
  zenApiBaseUrl: process.env.ZEN_API_BASE_URL || 'https://opencode.ai/zen/v1',
  zenApiKey: process.env.ZEN_API_KEY || process.env.OPENCODE_API_KEY || 'public',

  // Optional: when set, the proxy enforces this key on incoming clients
  // (otherwise any client key is accepted, for local use).
  clientApiKey: process.env.CLIENT_API_KEY || '',

  // Reasoning effort applied to reasoning-capable models when the client does
  // not specify one. Valid values (confirmed against the Zen/DeepSeek gateway):
  //   "low" | "medium" | "high" | "max" | "xhigh"
  // "xhigh" maximizes chain-of-thought length. Set via env to override.
  defaultReasoningEffort: process.env.DEFAULT_REASONING_EFFORT || 'xhigh',

  // When true, a system message with the current date/year is injected into
  // every request so the model knows the present and does not assume its
  // training cutoff (2023-2024). Set INJECT_TEMPORAL_CONTEXT=false to disable.
  injectTemporalContext: process.env.INJECT_TEMPORAL_CONTEXT !== 'false',

  // When true, requests carrying images/audio that target a known text-only
  // model are automatically routed to a multimodal free model (mimo-v2.5-free)
  // instead of being rejected with 400.
  autoRouteMultimodal: process.env.AUTO_ROUTE_MULTIMODAL === 'true',

  // Warp SOCKS Failover config. Mirrors the grok-kimi-proxy-route WARP manager:
  // on a failover-eligible error the proxy ACTIVATES WARP on demand via
  // warp-cli (proxy port -> mode proxy -> connect -> verify Connected) and
  // retries the request through the local SOCKS5 endpoint.
  warpAutoFailover: process.env.WARP_AUTO_FAILOVER !== 'false',
  warpSocksHost: process.env.WARP_SOCKS_HOST || '127.0.0.1',
  warpSocksPort: parseInt(process.env.WARP_SOCKS_PORT, 10) || 40000,
  // Path to the warp-cli binary. Auto-detected from Program Files on Windows;
  // otherwise resolved from PATH. Empty means "warp-cli" from PATH.
  warpBinPath: process.env.WARP_BIN_PATH || '',
  // Per warp-cli command timeout in ms (Go default: 30s).
  warpCommandTimeout: parseInt(process.env.WARP_COMMAND_TIMEOUT, 10) || 30000,
  // Wait after `warp-cli connect` before checking status, in ms (Go: 1500ms).
  warpStartupWait: parseInt(process.env.WARP_STARTUP_WAIT, 10) || 1500,
  // Cooldown after a failed activation, in ms, so a burst of 500s cannot
  // spawn a storm of warp-cli processes (Go default: 1min).
  warpCooldown:
    parseInt(process.env.WARP_COOLDOWN_MS, 10) ||
    parseInt(process.env.WARP_COOLDOWN, 10) ||
    60000,
  // Send the global --accept-tos flag on every warp-cli command. Required in
  // headless/container environments where the acceptance is not persisted.
  warpAcceptTos: process.env.WARP_ACCEPT_TOS !== 'false',

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
};

module.exports = { config };
