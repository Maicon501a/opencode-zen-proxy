'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { config } = require('../config/constants');
const { ALL_MODELS } = require('../config/models');
const warp = require('./warp');

/**
 * OpenCode Zen API client (direct mode).
 *
 * The Zen gateway at https://opencode.ai/zen/v1 is itself fully
 * OpenAI-compatible: chat completions, tool/function calling and SSE
 * streaming all pass through untouched. The only adjustments the proxy
 * makes are:
 *
 *   1. Inject the bearer token ("public" unlocks free-tier models, or a
 *      real ZEN_API_KEY when configured).
 *   2. Strip the "opencode/" prefix from the requested model id, since Zen
 *      expects the bare id (e.g. "deepseek-v4-flash-free").
 *
 * Everything else — messages, tools, tool_choice, response_format, stream —
 * is forwarded verbatim so native tool calling works end-to-end.
 */

/**
 * Normalize a Zen error body into the OpenAI error envelope.
 *
 * Zen uses:   { "type": "error", "error": { "type": "AuthError", "message": "..." } }
 * OpenAI:     { "error": { "message": "...", "type": "...", "code": "..." } }
 */
function normalizeZenError(httpStatus, body) {
  if (body && body.type === 'error' && body.error) {
    return {
      message: body.error.message || 'Unknown error',
      type: body.error.type || 'api_error',
      code: body.error.type || `http_${httpStatus}`,
    };
  }
  if (body && body.error) {
    return {
      message: body.error.message || 'Unknown error',
      type: body.error.type || 'api_error',
      code: body.error.code || `http_${httpStatus}`,
    };
  }
  return {
    message: typeof body === 'string' ? body : `HTTP ${httpStatus} from upstream`,
    type: 'api_error',
    code: `http_${httpStatus}`,
  };
}

/**
 * Core HTTP(S) request helper. For streaming requests it resolves with the
 * raw response stream so the caller can pipe it straight to the client.
 *
 * @param {string} method
 * @param {string} path            - path under the Zen base URL (e.g. /chat/completions)
 * @param {object} headers         - pre-built headers (auth injected here)
 * @param {string|null} body       - stringified JSON body, if any
 * @param {boolean} stream         - whether to stream the response
 * @param {boolean} useWarpSocks   - whether to route the request through WARP local SOCKS proxy
 * @returns {Promise<{stream:boolean, response?:object, data?:object, statusCode:number}>}
 */
function requestZenApi(method, path, headers, body, stream = false, useWarpSocks = false) {
  return new Promise((resolve, reject) => {
    const baseUrl = new URL(config.zenApiBaseUrl);
    const options = {
      hostname: baseUrl.hostname,
      port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
      path: `${baseUrl.pathname.replace(/\/+$/, '')}${path}`,
      method,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      timeout: 600000, // 10 minutes for long-running generations
    };

    if (useWarpSocks && config.warpAutoFailover) {
      const proxyUrl = `socks5://${config.warpSocksHost}:${config.warpSocksPort}`;
      options.agent = new SocksProxyAgent(proxyUrl);
    }

    const requester = baseUrl.protocol === 'http:' ? http : https;

    const req = requester.request(options, (res) => {
      const statusCode = res.statusCode;

      // Stream the body straight through on success.
      if (stream && statusCode === 200) {
        return resolve({ stream: true, response: res, statusCode });
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');

        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }

        if (statusCode >= 200 && statusCode < 300) {
          return resolve({ stream: false, data: parsed, statusCode });
        }

        const err = normalizeZenError(statusCode, parsed);
        const error = new Error(err.message);
        error.statusCode = statusCode;
        error.code = err.code;
        error.type = err.type;
        reject(error);
      });
    });

    req.on('error', (err) => {
      const error = new Error(`Failed to connect to Zen API: ${err.message}`);
      error.statusCode = 502;
      error.code = 'upstream_connection_error';
      reject(error);
    });

    req.on('timeout', () => {
      req.destroy();
      const error = new Error('Zen API request timed out after 10 minutes');
      error.statusCode = 504;
      error.code = 'upstream_timeout';
      reject(error);
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Build the bearer auth header value.
 */
function getAuthHeader() {
  return `Bearer ${config.zenApiKey}`;
}

/**
 * Short aliases for OpenCode Zen free models, derived at load time from the
 * single source of truth in config/models.js. The gateway only knows the bare
 * canonical ids (e.g. "deepseek-v4-flash-free"); friendly short names (as used
 * by opencode, Kilo and other clients) are mapped here so a request never hits
 * a non-existent model.
 *
 * Each canonical "opencode/<bare>" id contributes the bare id itself and, when
 * it ends with "-free", the alias without that suffix (e.g. "mimo-v2.5").
 * Because this table is generated from ALL_MODELS it can never drift from the
 * catalog (e.g. big-pickle stays covered automatically).
 */
const ZEN_MODEL_ALIASES = {};
for (const model of ALL_MODELS) {
  const bare = model.id.startsWith('opencode/')
    ? model.id.slice('opencode/'.length)
    : model.id;
  ZEN_MODEL_ALIASES[bare] = bare;
  if (bare.endsWith('-free')) {
    ZEN_MODEL_ALIASES[bare.replace('-free', '')] = bare;
  }
}

/**
 * Strip OpenAI Responses-API-style suffixes from a model id. Clients built
 * against the /responses endpoint (Codex, SDKs) send ids like
 * "model@responses" or "model-responses"; the chat/completions gateway only
 * wants the bare model id.
 */
function stripResponsesSuffix(model) {
  const low = model.toLowerCase();
  for (const suffix of ['-responses', '@responses', '/responses']) {
    if (low.endsWith(suffix)) {
      return model.slice(0, model.length - suffix.length);
    }
  }
  return model;
}

/**
 * Resolve a client-supplied model id to the canonical Zen wire id:
 *   1. strips any "opencode/" provider prefix
 *   2. strips "-responses" / "@responses" / "/responses" suffixes
 *   3. maps short aliases to their canonical "-free" ids
 *
 * Unknown ids pass through unchanged so Zen can apply its own routing.
 */
function resolveZenModel(model) {
  if (typeof model !== 'string') return model;
  let m = stripResponsesSuffix(model.trim());
  if (m.toLowerCase().startsWith('opencode/')) {
    m = m.slice('opencode/'.length);
  }
  return ZEN_MODEL_ALIASES[m.toLowerCase()] || m;
}

/**
 * Reasoning effort values accepted by the Zen/DeepSeek gateway for reasoning
 * models. Confirmed empirically: the provider rejects "none"/"minimal" with
 *   "unknown variant, expected one of `high`, `low`, `medium`, `max`, `xhigh`".
 */
const VALID_REASONING_EFFORTS = ['low', 'medium', 'high', 'max', 'xhigh'];

/**
 * Determines if an error/status indicates a network failure or upstream gateway error
 * that might be bypassed by using the WARP proxy.
 */
function isFailoverEligible(err, statusCode, responseBody) {
  // Network errors
  if (err && (err.code === 'upstream_connection_error' || err.code === 'upstream_timeout' || err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND')) {
    return true;
  }

  // Gateway HTTP errors
  if (statusCode === 429 || statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return true;
  }

  // Check for 500 internal server error with specific messages from upstream (Cloudflare/DeepSeek gateway)
  if (statusCode === 500 && responseBody) {
    const bodyStr = typeof responseBody === 'string' ? responseBody.toLowerCase() : JSON.stringify(responseBody).toLowerCase();
    return bodyStr.includes('internal server error') ||
      bodyStr.includes('internal_server_error') ||
      bodyStr.includes('upstream error') ||
      bodyStr.includes('upstream_error');
  }

  return false;
}

/**
 * Normalize a client-supplied reasoning_effort value into one the gateway
 * accepts, falling back to the configured default. Non-reasoning requests
 * (or invalid values that don't match a known effort) are left untouched so
 * the upstream can apply its own behavior.
 */
function resolveReasoningEffort(clientValue) {
  if (typeof clientValue === 'string' && VALID_REASONING_EFFORTS.includes(clientValue.toLowerCase())) {
    return clientValue.toLowerCase();
  }
  return config.defaultReasoningEffort;
}

/**
 * Determines if an error is a pure network/transport failure (no HTTP status
 * involved). Used to detect a stale WARP tunnel: if a WARP-routed request dies
 * at the transport level the cached Connected state is invalidated.
 */
function isNetworkFailure(err) {
  if (!err) return false;
  const code = String(err.code || '');
  return [
    'upstream_connection_error',
    'upstream_timeout',
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'ETIMEDOUT',
    'ECONNABORTED',
    'EHOSTUNREACH',
    'ENETUNREACH',
  ].includes(code);
}

/**
 * Execute an upstream request function with WARP failover, mirroring the
 * grok-kimi-proxy-route flow:
 *
 *   1. If WARP is already active, route through it.
 *   2. If that WARP-routed request dies with a network error, invalidate the
 *      stale state and retry once on the default route.
 *   3. If a direct request fails with a failover-eligible error, ACTIVATE
 *      WARP on demand (warp-cli) and retry through the SOCKS endpoint.
 *   4. If activation fails, the original error is propagated.
 *
 * @param {(viaWarp: boolean) => Promise<object>} requestFn
 * @returns {Promise<object>} the upstream result
 */
async function requestWithWarpFailover(requestFn) {
  const viaWarp = warp.isActive();
  try {
    return await requestFn(viaWarp);
  } catch (err) {
    if (viaWarp && warp.enabled() && isNetworkFailure(err)) {
      // Stale WARP state: invalidate and retry on the default route.
      warp.markInactive(err.message);
      console.warn(`[WARP Failover] Stale WARP state; retrying direct: ${err.message}`);
      return requestFn(false);
    }
    if (!viaWarp && warp.enabled() && isFailoverEligible(err, err.statusCode, err.message)) {
      console.warn(`[WARP Failover] Upstream failure (${err.statusCode || err.code}). Activating WARP...`);
      try {
        await warp.activate();
      } catch (activateErr) {
        console.error(`[WARP Failover] WARP activation failed: ${activateErr.message}`);
        throw err;
      }
      // Recurse so the retry itself can handle a stale/again-failing tunnel.
      return requestWithWarpFailover(requestFn);
    }
    throw err;
  }
}

/**
 * Build the temporal-context line telling the model the real present date.
 * Mirrors the upstream adapter so the model does not assume it is stuck in
 * its training cutoff (2023-2024).
 */
function temporalContextLine() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  return (
    `Temporal context: today is ${dateStr}. The current year is ${now.getFullYear()}. ` +
    'Treat this as ground truth for "today", "this year", recency, and time-sensitive ' +
    'answers — do not assume you are stuck in 2023–2024.'
  );
}

/**
 * Prepend/merge the current date/year into a system message so the model knows
 * the present (e.g. 2026). No-op when disabled via INJECT_TEMPORAL_CONTEXT=false
 * or when the conversation already carries a Temporal context marker.
 */
function ensureTemporalContext(messages) {
  if (!config.injectTemporalContext || !Array.isArray(messages)) return messages;
  const line = temporalContextLine();
  if (messages.length > 0 && messages[0] && messages[0].role === 'system') {
    if (typeof messages[0].content === 'string' && !messages[0].content.includes('Temporal context:')) {
      return messages.map((m, i) => (i === 0 ? { ...m, content: `${line}\n\n${m.content}` } : m));
    }
    return messages;
  }
  return [{ role: 'system', content: line }, ...messages];
}

/**
 * Normalize a client chat-completion payload before it goes on the wire.
 *
 * Pure function (no I/O) so the transformation is unit-testable. It:
 *   - resolves the model id (strips "opencode/" prefix, "-responses" suffixes
 *     and maps short aliases like "mimo-v2.5" -> "mimo-v2.5-free")
 *   - adds a reasoning_content fallback to assistant messages that lost it
 *   - injects the current date/year as temporal context (config-gated)
 *   - injects the default reasoning_effort when the client did not send a
 *     valid one
 *   - forces stream_options.include_usage on SSE streams so usage is reported
 *
 * @param {object} payload - raw OpenAI chat completion request body
 * @returns {object} normalized payload
 */
function normalizeChatPayload(payload) {
  const normalized = { ...payload };
  if (normalized.model) {
    normalized.model = resolveZenModel(normalized.model);
  }

  // Sanitize messages: ensure assistant messages in history that lost reasoning_content
  // get a fallback so OpenCode Zen / DeepSeek upstream does not reject with 400
  if (Array.isArray(normalized.messages)) {
    normalized.messages = normalized.messages.map((msg) => {
      if (msg && msg.role === 'assistant' && !msg.reasoning_content) {
        return {
          ...msg,
          reasoning_content: msg.content || 'Thought process completed.',
        };
      }
      return msg;
    });
  }

  // Inject current date/year so the model knows the present (e.g. 2026) instead
  // of assuming its training cutoff. Mirrors the upstream adapter.
  normalized.messages = ensureTemporalContext(normalized.messages);

  // Inject default reasoning effort when the client did not request a valid
  // one. The field is forwarded as-is; Zen/DeepSeek only honors it on
  // reasoning-capable models and ignores it elsewhere.
  normalized.reasoning_effort = resolveReasoningEffort(normalized.reasoning_effort);

  // Ensure usage is reported on SSE streams — without stream_options many
  // providers omit usage in streamed responses. Respect a client-specified value.
  if (normalized.stream === true) {
    if (normalized.stream_options === null || normalized.stream_options === undefined) {
      normalized.stream_options = { include_usage: true };
    } else if (normalized.stream_options.include_usage === undefined) {
      normalized.stream_options = { ...normalized.stream_options, include_usage: true };
    }
  }

  return normalized;
}

/**
 * Forward a chat completion request to the Zen API.
 *
 * The payload is passed through unchanged except for:
 *   - the model id (strips the "opencode/" prefix and maps short aliases)
 *   - reasoning_effort, which defaults to the configured maximum ("xhigh")
 *     when the client does not specify a valid value, so reasoning models
 *     always think at full depth. Clients can override per-request with any
 *     of: low | medium | high | max | xhigh.
 *   - a temporal-context system message with the current date/year
 *   - stream_options.include_usage on SSE streams
 *
 * tools, tool_choice, response_format, temperature, top_p, seed, stream,
 * max_tokens, etc. all reach the upstream model intact, preserving native
 * OpenAI function calling.
 *
 * @param {object} payload - the raw OpenAI chat completion request body
 * @returns {Promise<object>} Zen response ({stream, response|data, statusCode})
 */
async function forwardChatCompletion(payload) {
  const normalized = normalizeChatPayload(payload);
  const headers = { Authorization: getAuthHeader() };
  const isStream = normalized.stream === true;
  const body = JSON.stringify(normalized);

  return requestWithWarpFailover((viaWarp) =>
    requestZenApi('POST', '/chat/completions', headers, body, isStream, viaWarp)
  );
}

/**
 * Fetch the list of models from the Zen API.
 */
async function fetchModels() {
  const headers = { Authorization: getAuthHeader() };
  return requestWithWarpFailover((viaWarp) =>
    requestZenApi('GET', '/models', headers, null, false, viaWarp)
  );
}

module.exports = {
  forwardChatCompletion,
  fetchModels,
  normalizeZenError,
  normalizeChatPayload,
  resolveZenModel,
  stripResponsesSuffix,
  ZEN_MODEL_ALIASES,
  resolveReasoningEffort,
  ensureTemporalContext,
  isFailoverEligible,
  isNetworkFailure,
  requestWithWarpFailover,
  VALID_REASONING_EFFORTS,
};
