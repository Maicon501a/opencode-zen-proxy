'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');

const { config } = require('../config/constants');
const {
  resolveWireModel,
  modelApiMode,
  extractZenEffort,
  mapZenReasoningEffort,
} = require('../config/models');
const { applyZenGate, zenGateHeaders, zenAuthHeader } = require('./zenGate');
const {
  completedChatCompletionFromSse,
  completedResponseFromSse,
  isSseContentType,
} = require('./sse');
const {
  chatBodyToResponsesBody,
  responsesBodyToChatBody,
  responsesToChatCompletion,
  chatCompletionToResponse,
} = require('./converters');
const { normalizeMultimodalMessages } = require('./multimodal');
const { socks5Connect } = require('./socks5');
const warp = require('./warp');
const transport = require('./transport');
const stats = require('./stats');
const { tapSseUsage } = require('./statsTap');
const { createLogger } = require('./logger');

const log = createLogger('zen');

/**
 * OpenCode Zen client.
 *
 * Speaks to https://opencode.ai/zen/v1 the way the official OpenCode 2 CLI
 * does — through the free-tier gate — and bridges the two OpenAI dialects the
 * gateway exposes:
 *
 *   - chat models      → /chat/completions
 *   - Muse free models → /responses
 *
 * A client may ask in either dialect; the proxy keeps the client's dialect on
 * the outside and translates to whatever the model needs (see converters.js).
 *
 * Three upstream quirks are handled transparently:
 *
 *   1. FREE-TIER GATE — every request must look like the official CLI
 *      (opencode User-Agent + a time-encoded X-Opencode-Session) and must be
 *      streamed with a `read` function tool present. See zenGate.js.
 *   2. ALWAYS-STREAMING UPSTREAM — because of (1) the gateway never returns a
 *      plain JSON body, even when the client asked for one. The SSE is folded
 *      back into a single chat.completion / response object.
 *   3. EGRESS RATE LIMITS — Zen throttles per IP. Three egress modes exist,
 *      picked in this order:
 *
 *        a. TOR (isolated) — when the desktop app points `transport` at its
 *           embedded Tor SOCKS5 listener, every Zen request exits through a
 *           circuit. On 429/502/503/504 the proxy asks the manager for a
 *           FRESH circuit (new exit IP) and replays the request.
 *        b. WARP           — Cloudflare WARP's SOCKS5 listener, used when no
 *           Tor egress is configured (or as the fallback after a failed
 *           rotation).
 *        c. DIRECT         — the machine's normal route.
 *
 *      The classes of failures that trigger a retry are the same for every
 *      egress (see warp.shouldFailover): 429/502/503/504, a 500 carrying the
 *      gateway's internal-error envelope, and network failures.
 *
 * Every forwarded request is also bracketed by the stats store (tokens in /
 * out, latency, egress, rotations) for the desktop dashboard.
 *
 * Reasoning effort is never invented: the value is normalized to the
 * vocabulary the target endpoint accepts, and an effort-suffixed model alias
 * (`...-low` / `-high` / `-max`) overrides a client-sent field, exactly like
 * the Go proxy.
 */

let lastWarpAttemptAt = 0;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function apiError(message, statusCode, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.type = extra.type || 'api_error';
  err.code = extra.code || null;
  err.param = extra.param || null;
  return err;
}

/**
 * Normalize a Zen error body into the OpenAI error envelope.
 *
 * Zen uses:   { "type": "error", "error": { "type": "AuthError", "message": "..." } }
 * OpenAI:     { "error": { "message": "...", "type": "...", "code": "..." } }
 */
function normalizeZenError(statusCode, body) {
  let parsed = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }
  }

  if (parsed && typeof parsed === 'object' && parsed.type === 'error' && parsed.error) {
    return {
      message: parsed.error.message || 'Unknown error',
      type: parsed.error.type || 'api_error',
      code: parsed.error.type || `http_${statusCode}`,
    };
  }
  if (parsed && typeof parsed === 'object' && parsed.error) {
    const error = typeof parsed.error === 'string' ? { message: parsed.error } : parsed.error;
    return {
      message: error.message || 'Unknown error',
      type: error.type || 'api_error',
      code: error.code || `http_${statusCode}`,
    };
  }
  return {
    message: typeof parsed === 'string' && parsed.trim() !== ''
      ? parsed.trim()
      : `HTTP ${statusCode} from upstream`,
    type: 'api_error',
    code: `http_${statusCode}`,
  };
}

// ---------------------------------------------------------------------------
// Request planning
// ---------------------------------------------------------------------------

/**
 * Resolve the upstream path, shape and body for a client request.
 *
 * @param {object} payload parsed client body
 * @param {'chat'|'responses'} clientFormat dialect the client is speaking
 * @returns {{ body: object, upstreamPath: string, upstreamFormat: 'chat'|'responses', wireModel: string }}
 */
function planUpstreamRequest(payload, clientFormat) {
  const requestedModel = typeof payload.model === 'string' ? payload.model : '';
  const wireModel = resolveWireModel(requestedModel);
  const upstreamFormat = modelApiMode(wireModel);

  let body;
  if (clientFormat === 'chat' && upstreamFormat === 'chat') {
    body = { ...payload };
    body.model = wireModel;
    body.messages = normalizeMultimodalMessages(body.messages);
  } else if (clientFormat === 'chat' && upstreamFormat === 'responses') {
    body = chatBodyToResponsesBody(payload);
    body.model = wireModel;
  } else if (clientFormat === 'responses' && upstreamFormat === 'responses') {
    body = { ...payload };
    body.model = wireModel;
  } else {
    body = responsesBodyToChatBody(payload);
    body.model = wireModel;
    if (Array.isArray(body.messages)) body.messages = normalizeMultimodalMessages(body.messages);
  }

  // Effort vocabulary of the target endpoint.
  const suffixEffort = extractZenEffort(requestedModel).effort;
  if (suffixEffort !== '') {
    if (upstreamFormat === 'chat') body.reasoning_effort = suffixEffort;
    else body.reasoning = { ...(body.reasoning || {}), effort: suffixEffort };
  }

  if (upstreamFormat === 'chat') {
    if (typeof body.reasoning_effort === 'string') {
      const mapped = mapZenReasoningEffort(wireModel, body.reasoning_effort);
      if (mapped !== '') body.reasoning_effort = mapped;
      else delete body.reasoning_effort;
    } else if (config.defaultReasoningEffort !== '') {
      const mapped = mapZenReasoningEffort(wireModel, config.defaultReasoningEffort);
      if (mapped !== '') body.reasoning_effort = mapped;
    }
  } else {
    if (body.reasoning && typeof body.reasoning === 'object' && typeof body.reasoning.effort === 'string') {
      const mapped = mapZenReasoningEffort(wireModel, body.reasoning.effort);
      if (mapped !== '') body.reasoning.effort = mapped;
      else delete body.reasoning.effort;
    } else if (config.defaultReasoningEffort !== '') {
      const mapped = mapZenReasoningEffort(wireModel, config.defaultReasoningEffort);
      if (mapped !== '') body.reasoning = { ...(body.reasoning || {}), effort: mapped, summary: 'auto' };
    }
  }

  // Free-tier gate: force streaming + the required `read` tool, endpoint-shaped.
  applyZenGate(body, { chat: upstreamFormat === 'chat' });

  return {
    body,
    wireModel,
    upstreamFormat,
    upstreamPath: upstreamFormat === 'chat' ? config.zenChatPath : config.zenResponsesPath,
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function zenEndpoint(path) {
  const base = new URL(config.zenApiBaseUrl);
  const port = base.port || (base.protocol === 'https:' ? 443 : 80);
  return {
    protocol: base.protocol,
    hostname: base.hostname,
    port: Number(port),
    path: `${base.pathname.replace(/\/+$/, '')}${path}`,
  };
}

/**
 * Open a request to the Zen gateway.
 *
 * `mode` selects the egress:
 *   - 'direct' → the machine's normal route (plain https.request)
 *   - 'tor'    → transport's SOCKS5 listener (embedded Tor), TLS-wrapped
 *   - 'warp'   → Cloudflare WARP's SOCKS5 listener, TLS-wrapped
 *
 * In SOCKS modes a raw tunnel is opened to the gateway and wrapped in TLS
 * before the HTTP request rides on top — so only this request exits through
 * the isolated IP.
 */
function openRequest({ endpoint, headers, body, mode = 'direct', signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const onResponse = (res) => {
      if (settled) return;
      settled = true;
      resolve(res);
    };

    const send = (socket) => {
      const options = {
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: endpoint.path,
        method: body == null ? 'GET' : 'POST',
        headers,
        timeout: timeoutMs || config.upstreamTimeoutMs,
        agent: false,
      };
      if (socket) options.createConnection = () => socket;

      // Only HTTPS is supported upstream; http:// is tolerated for local mocks.
      const requester = endpoint.protocol === 'http:' ? http : https;
      const req = requester.request(options, onResponse);

      req.on('error', fail);
      req.on('timeout', () => {
        req.destroy(apiError('Zen API request timed out', 504, { code: 'upstream_timeout' }));
      });
      if (signal) {
        signal.addEventListener('abort', () => req.destroy(apiError('Client aborted the request', 499, { code: 'client_aborted' })));
      }
      if (body == null) req.end();
      else req.end(body);
    };

    const socks = mode === 'warp'
      ? warp.socksEndpoint()
      : mode === 'tor'
        ? transport.socksEndpoint()
        : null;

    // Fail closed: when the attempt's mode promises an isolated egress but the
    // SOCKS endpoint is missing (the desktop app can revoke it mid-flight),
    // the request must NEVER silently downgrade to the machine's own route —
    // that would leak the real IP while stats still record the isolated mode.
    // Surface it as a network failure so the failover chain decides.
    if (mode !== 'direct' && !socks) {
      fail(apiError(`${mode} egress unavailable: no SOCKS5 endpoint configured`, 502, {
        code: 'ECONNREFUSED',
      }));
      return;
    }

    if (!socks) {
      send(null);
      return;
    }

    socks5Connect(socks.host, socks.port, endpoint.hostname, endpoint.port)
      .then((netSocket) => {
        if (endpoint.protocol !== 'https:') {
          send(netSocket);
          return;
        }
        const tlsSocket = tls.connect(
          { socket: netSocket, servername: endpoint.hostname },
          () => send(tlsSocket)
        );
        tlsSocket.on('error', fail);
      })
      .catch(fail);
  });
}

/** Parse an upstream JSON body, failing with an OpenAI-shaped 502 on garbage. */
function parseJsonBody(text) {
  if (text == null || text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw apiError('Upstream returned a malformed JSON body', 502, { code: 'upstream_invalid_json' });
  }
}

/** Read a response body with a byte cap. */
function readBody(res, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit) {
        res.destroy();
        reject(apiError('Upstream response too large', 502, { code: 'upstream_body_too_large' }));
      }
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

/**
 * Ask the manager (desktop app) for a fresh exit and replay on the new
 * circuit. Records the rotation in the stats event feed.
 */
async function rotateExit(reason, statsCtx) {
  const result = await transport.rotate(reason);
  if (result.ok) {
    stats.recordEvent('rotation', {
      model: statsCtx ? statsCtx.model : null,
      ip: result.ip || null,
      changed: result.changed,
      reason,
      message: result.message || null,
    });
    return true;
  }
  log.warn('exit rotation failed', { reason, error: result.error });
  return false;
}

const CAPTURE_BODY_LIMIT = 2048;
const CAPTURE_HEADER_LIMIT = 300;

function truncate(value, limit) {
  const text = String(value == null ? '' : value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Best-effort human message from an upstream error body (JSON envelopes from
 * the gateway and plain-text responses both end up readable).
 */
function upstreamErrorMessage(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const nested = parsed.error && typeof parsed.error === 'object'
        ? (parsed.error.message || parsed.error.type || parsed.error.code)
        : parsed.error;
      const candidate = nested || parsed.message;
      if (typeof candidate === 'string' && candidate !== '') {
        return truncate(candidate.replace(/\s+/g, ' ').trim(), 300);
      }
    }
  } catch {
    // not JSON — fall through to the raw body
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat ? truncate(flat, 300) : null;
}

/**
 * Snapshot of a rejected upstream response (status + headers + bounded body).
 * Rate limits and free-tier quota notices land here so they can be inspected
 * later from the dashboard instead of vanishing with the retry.
 */
function captureRejection(res, text) {
  const headers = {};
  for (const [name, value] of Object.entries(res.headers || {})) {
    if (value == null) continue;
    headers[name] = truncate(Array.isArray(value) ? value.join(', ') : value, CAPTURE_HEADER_LIMIT);
  }
  return {
    status: res.statusCode,
    statusMessage: res.statusMessage || null,
    at: new Date().toISOString(),
    message: upstreamErrorMessage(text),
    retryAfter: headers['retry-after'] || null,
    headers,
    body: truncate(text || '', CAPTURE_BODY_LIMIT),
  };
}

/**
 * Execute the request with the egress policy described at the top of this
 * file: Tor isolation with circuit rotation (primary), WARP failover
 * (fallback), direct route (last resort).
 *
 * @returns {Promise<{res: import('http').IncomingMessage, egress: string, rotations: number, rateLimited: boolean, rejection: object|null, rateLimitInfo: object|null}>}
 */
async function sendWithFailover({ endpoint, headers, body, signal, statsCtx }) {
  const warpEnabled = warp.isEnabled();
  const torAvailable = transport.socksEndpoint() != null;
  const canRotate = torAvailable && transport.hasRotate() && transport.rotateEnabled();

  let mode = torAvailable ? 'tor' : (warpEnabled && warp.isActive() ? 'warp' : 'direct');
  let warpTried = mode === 'warp';
  let rotateBudget = canRotate ? 2 : 0;
  let rotations = 0;
  let rateLimited = false;
  let lastError = null;
  let lastRejection = null;
  let rateLimitRejection = null;

  const MAX_ATTEMPTS = 6;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let res;
    try {
      res = await openRequest({ endpoint, headers, body, mode, signal });
    } catch (err) {
      lastError = err;

      // The client hung up: nothing to retry, and no failover to trigger.
      if (err && err.code === 'client_aborted') throw err;

      if (mode === 'warp' && warpEnabled && warp.isNetworkFailure(err)) {
        // WARP went stale mid-flight: drop it and fall back.
        warp.markInactive(err.message);
        mode = torAvailable ? 'tor' : 'direct';
        log.warn('warp stale, falling back', { to: mode, reason: err.message });
        continue;
      }

      if (mode === 'tor' && rotateBudget > 0 && transport.socksEndpoint() != null && warp.isNetworkFailure(err)) {
        rotateBudget -= 1;
        if (await rotateExit(`network failure: ${err.message}`, statsCtx)) {
          rotations += 1;
          continue;
        }
      }

      if (mode !== 'warp' && !warpTried && warpEnabled && warp.isNetworkFailure(err)) {
        warpTried = true;
        if (await activateWarp()) {
          mode = 'warp';
          log.warn('network failure, retrying through WARP');
          continue;
        }
      }

      const wrapped = apiError(`Failed to reach the Zen API: ${err.message}`, 502, {
        code: err.code || 'upstream_connection_error',
      });
      wrapped.egress = mode;
      wrapped.rateLimited = rateLimited;
      wrapped.rotations = rotations;
      wrapped.upstream = lastRejection;
      wrapped.rateLimitInfo = rateLimitRejection;
      throw wrapped;
    }

    if (res.statusCode >= 400) {
      const text = await readBody(res).catch(() => '');
      const rejection = captureRejection(res, text);
      lastRejection = rejection;

      if (warp.shouldFailover(res.statusCode, text)) {
        rateLimited = true;
        rateLimitRejection = rejection;
        log.warn('rate limit / quota response captured', {
          status: rejection.status,
          retryAfter: rejection.retryAfter,
          message: rejection.message,
        });

        if (mode === 'tor' && rotateBudget > 0) {
          rotateBudget -= 1;
          if (await rotateExit(`upstream HTTP ${res.statusCode}`, statsCtx)) {
            rotations += 1;
            log.warn('upstream rejection, replaying on fresh circuit', { status: res.statusCode });
            continue;
          }
        }

        if (mode !== 'warp' && !warpTried && warpEnabled) {
          warpTried = true;
          if (await activateWarp()) {
            mode = 'warp';
            log.warn('upstream rejection, retrying through WARP', { status: res.statusCode });
            continue;
          }
        }
      }

      const normalized = normalizeZenError(res.statusCode, text);
      const error = apiError(normalized.message, res.statusCode, {
        type: normalized.type,
        code: normalized.code,
      });
      error.egress = mode;
      error.rateLimited = rateLimited;
      error.rotations = rotations;
      error.upstream = rejection;
      error.rateLimitInfo = rateLimitRejection;
      throw error;
    }

    return { res, egress: mode, rotations, rateLimited, rejection: lastRejection, rateLimitInfo: rateLimitRejection };
  }

  const fallback = lastError
    ? apiError(`Failed to reach the Zen API: ${lastError.message}`, 502, {
      code: lastError.code || 'upstream_connection_error',
    })
    : apiError('Zen API request failed after egress attempts', 502, { code: 'upstream_unreachable' });
  fallback.rateLimited = rateLimited;
  fallback.rotations = rotations;
  fallback.upstream = lastRejection;
  fallback.rateLimitInfo = rateLimitRejection;
  throw fallback;
}

/** Activate WARP, honouring the cooldown between activation attempts. */
async function activateWarp() {
  const now = Date.now();
  if (now - lastWarpAttemptAt < config.warpCooldownMs) {
    log.warn('warp activation skipped (cooldown)');
    return false;
  }
  lastWarpAttemptAt = now;
  try {
    await warp.activate();
    return true;
  } catch (err) {
    log.warn('warp activation failed', { reason: err.message });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Turn a successful upstream response into the shape the route should emit.
 */
async function shapeSuccess({ res, upstreamFormat, clientFormat, wireModel, clientWantsStream }) {
  const isSse = isSseContentType(res.headers);

  if (!isSse) {
    // Plain JSON answer (cached error envelopes, or a gateway that honoured
    // `stream: false` despite the gate).
    const text = await readBody(res);
    const data = parseJsonBody(text);
    const clientBody = upstreamFormat === clientFormat
      ? data
      : upstreamFormat === 'responses'
        ? responsesToChatCompletion(data, wireModel)
        : chatCompletionToResponse(data, wireModel);
    return { mode: 'json', body: clientBody, upstreamFormat };
  }

  // Upstream is streaming. The gate makes this the normal path, so when the
  // client asked for plain JSON we fold the SSE back into one object.
  if (!clientWantsStream) {
    if (upstreamFormat === 'chat') {
      const folded = await completedChatCompletionFromSse(res, wireModel);
      const clientBody = clientFormat === 'chat'
        ? folded
        : chatCompletionToResponse(folded, wireModel);
      return { mode: 'json', body: clientBody, upstreamFormat, usage: folded.usage };
    }
    const folded = await completedResponseFromSse(res);
    const clientBody = clientFormat === 'responses'
      ? folded
      : responsesToChatCompletion(folded, wireModel);
    return { mode: 'json', body: clientBody, upstreamFormat, usage: folded.usage };
  }

  return { mode: 'stream', stream: res, upstreamFormat, clientFormat, wireModel };
}

/**
 * Shared entry point for both client dialects.
 *
 * @param {object} payload client body
 * @param {'chat'|'responses'} clientFormat
 * @param {{ signal?: AbortSignal }} [options]
 */
async function forward(payload, clientFormat, options = {}) {
  const plan = planUpstreamRequest(payload, clientFormat);
  const endpoint = zenEndpoint(plan.upstreamPath);
  const clientWantsStream = payload.stream === true;

  const ctx = stats.beginRequest({
    model: plan.wireModel,
    clientFormat,
    upstreamFormat: plan.upstreamFormat,
    stream: clientWantsStream,
    keyId: options.key && options.key.id,
    keyName: options.key && options.key.name,
  });
  const startedAt = Date.now();

  const headers = {
    Authorization: zenAuthHeader(),
    'Content-Type': 'application/json',
    // The free-tier gate forces streaming upstream, so always advertise SSE.
    Accept: 'text/event-stream',
    'Accept-Encoding': 'identity',
    ...zenGateHeaders(),
  };

  const body = JSON.stringify(plan.body);

  log.debug('upstream request', {
    path: plan.upstreamPath,
    model: plan.wireModel,
    clientFormat,
    upstreamFormat: plan.upstreamFormat,
    stream: clientWantsStream,
  });

  let shipped;
  try {
    shipped = await sendWithFailover({
      endpoint,
      headers,
      body,
      signal: options.signal,
      statsCtx: ctx,
    });
  } catch (err) {
    stats.endRequest(ctx, {
      ok: false,
      status: err.statusCode || 502,
      latencyMs: Date.now() - startedAt,
      error: err.message,
      egress: err.egress || null,
      rotations: err.rotations || 0,
      rateLimited: err.rateLimited === true,
      rateLimit: err.rateLimitInfo || null,
      upstream: err.upstream || null,
    });
    throw err;
  }

  const { res, egress, rotations, rateLimited, rejection, rateLimitInfo } = shipped;
  log.debug('upstream response', { status: res.statusCode, egress, rotations });

  let shaped;
  try {
    shaped = await shapeSuccess({
      res,
      upstreamFormat: plan.upstreamFormat,
      clientFormat,
      wireModel: plan.wireModel,
      clientWantsStream,
    });
  } catch (err) {
    stats.endRequest(ctx, {
      ok: false,
      status: err.statusCode || 502,
      latencyMs: Date.now() - startedAt,
      error: err.message,
      egress,
      rotations,
      rateLimited,
      rateLimit: rateLimitInfo,
      upstream: rejection,
    });
    throw err;
  }

  if (shaped.mode === 'json') {
    stats.endRequest(ctx, {
      ok: true,
      status: 200,
      latencyMs: Date.now() - startedAt,
      usage: shaped.usage || (shaped.body && shaped.body.usage),
      egress,
      rotations,
      rateLimited,
      rateLimit: rateLimitInfo,
      upstream: rejection,
    });
    return { ...shaped, wireModel: plan.wireModel, clientFormat };
  }

  // Streaming: the raw SSE passes through a tap that watches for the terminal
  // usage object; the bracket closes when the stream ends (or the client
  // aborts), so streamed tokens are counted too.
  const tap = tapSseUsage(res, {
    onEnd: (info) => {
      stats.endRequest(ctx, {
        ok: !info.error,
        status: 200,
        latencyMs: Date.now() - startedAt,
        usage: info.usage,
        egress,
        rotations,
        rateLimited,
        rateLimit: rateLimitInfo,
        upstream: rejection,
        aborted: info.aborted,
        error: info.error || null,
      });
    },
  });
  res.pipe(tap);

  return { ...shaped, stream: tap, wireModel: plan.wireModel, clientFormat };
}

/** OpenAI-compatible chat completion (client speaks chat/completions). */
function createChatCompletion(payload, options) {
  return forward(payload, 'chat', options);
}

/** OpenAI-compatible response (client speaks the Responses API). */
function createResponse(payload, options) {
  return forward(payload, 'responses', options);
}

/**
 * Fetch the live Zen catalog. Falls back to the curated free list when the
 * gateway is unreachable (handled by the route).
 */
async function fetchModels() {
  const endpoint = zenEndpoint('/models');
  const headers = {
    Authorization: zenAuthHeader(),
    Accept: 'application/json',
    ...zenGateHeaders(),
  };

  const res = await openRequest({
    endpoint,
    headers,
    body: null,
    mode: transport.socksEndpoint() != null
      ? 'tor'
      : (warp.isEnabled() && warp.isActive() ? 'warp' : 'direct'),
    // The catalog is a convenience endpoint: never let it hold the client for
    // the full generation timeout — the route falls back to the curated list.
    timeoutMs: 20000,
  });

  const text = await readBody(res, 2 * 1024 * 1024);
  if (res.statusCode >= 400) {
    const normalized = normalizeZenError(res.statusCode, text);
    throw apiError(normalized.message, res.statusCode, {
      type: normalized.type,
      code: normalized.code,
    });
  }
  return parseJsonBody(text);
}

/** Test seam: reset the WARP activation cooldown and egress state. */
function resetFailoverState() {
  lastWarpAttemptAt = 0;
  warp.reset();
  transport.reset();
}

module.exports = {
  createChatCompletion,
  createResponse,
  fetchModels,
  // Test seam: exercised directly by the fail-closed egress tests.
  openRequest,
  planUpstreamRequest,
  normalizeZenError,
  shapeSuccess,
  resetFailoverState,
};
