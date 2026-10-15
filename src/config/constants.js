'use strict';

const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

/**
 * OpenCode Zen free-tier gate — constants reverse engineered from the official
 * OpenCode 2 client and confirmed against a live bisection of
 * https://opencode.ai/zen/v1 (2026-10-15).
 *
 * Since 2026-09-23 the Zen edge rejects third-party clients for free models
 * with `HTTP 403 FreeTierError` ("can only be used from within OpenCode").
 * A request is only accepted when ALL of the following hold:
 *
 *   1. `User-Agent` matches `opencode/<channel>/<version>/<name>`
 *      (e.g. `opencode/latest/2.0.29/cli`). Any other UA → 403.
 *   2. `X-Opencode-Session` carries an `ascending` session id minted the way
 *      the official CLI mints them: `ses_` + hex48(EPOCH - unix_ms * 4096)
 *      + 14 alphanumeric chars. The edge decodes the stamp and rejects ids
 *      whose time encoding is random. See SESSION_EPOCH in zenGate.js.
 *   3. The JSON body is streamed (`"stream": true`).
 *   4. The JSON body `tools` array contains a function tool named `read`
 *      (`shell` is legacy — no longer required; descriptions/parameters are
 *      not inspected).
 *
 * Tool name casing, extra tools and the rest of the payload are untouched.
 * See src/services/zenGate.js for the implementation.
 */
const ZEN_GATE = {
  // Mirrors the official OpenCode 2 CLI user agent.
  clientUa: process.env.ZEN_CLIENT_UA || 'opencode/latest/2.0.29/cli',
  // Identifies the official CLI surface.
  clientHeader: process.env.ZEN_CLIENT_SURFACE || 'cli',
  // Stable 40-hex project fingerprint. The official client sends a per-project
  // sha1; the gateway does not require it, but it keeps traffic
  // indistinguishable from the real client.
  projectHeader:
    process.env.ZEN_PROJECT_HEADER || '5b259a0dee5146efb4be735cf465ba92bf944710',
  // Function tool names the gate requires to be present in the request body.
  // Only `read` is validated today (`shell` is a harmless legacy extra).
  toolNames: (process.env.ZEN_GATE_TOOLS || 'read')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== ''),
};

const config = {
  // ----- Server -----
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',
  // Base64 data URIs are ~33% larger than the source file; keep this generous
  // enough for screenshots sent by coding clients.
  maxRequestSize: process.env.MAX_REQUEST_SIZE || '50mb',

  // ----- OpenCode Zen (direct, keyless for free models) -----
  // The Zen gateway accepts "public" as a bearer token that unlocks the
  // free-tier models. This is exactly what the opencode CLI does internally
  // when no API key is set:
  //   options: hasKey ? {} : { apiKey: "public" }
  // No local `opencode serve` binary is required.
  zenApiBaseUrl: process.env.ZEN_API_BASE_URL || 'https://opencode.ai/zen/v1',
  zenApiKey: process.env.ZEN_API_KEY || process.env.OPENCODE_API_KEY || 'public',

  // Paths on the Zen gateway. Free chat models live on /chat/completions;
  // Muse Spark contributor free models are Responses-only.
  zenChatPath: '/chat/completions',
  zenResponsesPath: '/responses',

  // ----- Free-tier gate -----
  // Always on: the gateway refuses non-streaming requests for free models.
  zenGate: ZEN_GATE,

  // ----- Optional: gate client access to the proxy -----
  // When set, clients must send this key in their Authorization header.
  // When unset (default), the proxy is open for local use.
  clientApiKey: process.env.CLIENT_API_KEY || '',

  // ----- Desktop app / admin surface -----
  // Where stats.json, api-keys.json and friends live. The desktop app points
  // this at its own data directory; standalone runs keep it next to the repo.
  dataDir: process.env.PROXY_DATA_DIR || path.resolve(__dirname, '../../data'),
  // Token required by the /admin/* API. When empty, /admin/* is reachable
  // from loopback only (the proxy must never expose it publicly).
  adminToken: (process.env.ADMIN_TOKEN || '').trim(),

  // ----- Reasoning effort -----
  // The Go proxy never invents an effort: omitted means "upstream default"
  // (Zen free models default to `high`). Set this env var only if you want to
  // force an effort onto every request. Clients can always override per
  // request via `reasoning_effort`, or per model via the `-low`/`-high`/`-max`
  // alias suffix (e.g. `opencode/space-bunny-free-max`).
  defaultReasoningEffort: (process.env.DEFAULT_REASONING_EFFORT || '').toLowerCase().trim(),

  // ----- Upstream timeouts -----
  // Long generations with maximum thinking can take a while; 10 minutes
  // matches the Go proxy's tolerance for slow reasoning models.
  upstreamTimeoutMs: parseInt(process.env.UPSTREAM_TIMEOUT_MS, 10) || 600000,
  // How long a single upstream attempt may take before it is discarded.
  upstreamHeadersTimeoutMs: parseInt(process.env.UPSTREAM_HEADERS_TIMEOUT_MS, 10) || 120000,

  // ----- WARP IP failover (rate-limit / egress escape hatch) -----
  // When Zen rejects the request because of our egress IP (429/502/503/504, or
  // a 500 carrying the gateway's internal-error envelope, or a network
  // failure), reroute Zen traffic through Cloudflare WARP's local SOCKS5
  // listener so it exits from a different IP. ONLY requests the proxy sends to
  // that SOCKS port traverse WARP — the machine's normal connection is
  // untouched.
  warpAutoFailover: process.env.WARP_AUTO_FAILOVER !== 'false', // default ON
  warpSocksHost: process.env.WARP_SOCKS_HOST || '127.0.0.1',
  warpSocksPort: parseInt(process.env.WARP_SOCKS_PORT, 10) || 40000,
  // How long to wait before trying to activate WARP again after a failed
  // attempt.
  warpCooldownMs: parseInt(process.env.WARP_COOLDOWN_MS, 10) || 60000,
  // Path to the warp-cli binary (defaults to "warp-cli" on PATH).
  warpBinPath: process.env.WARP_BIN_PATH || 'warp-cli',

  // ----- Logging -----
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

config.hostname = os.hostname();

module.exports = { config, ZEN_GATE };
