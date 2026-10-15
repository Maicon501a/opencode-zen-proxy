'use strict';

const { createLogger } = require('./logger');

const log = createLogger('transport');

/**
 * Upstream transport manager.
 *
 * Decides where the proxy's Zen-bound TCP connections exit:
 *
 *   - `direct` — the machine's normal route.
 *   - `tor`    — a local SOCKS5 listener. The desktop app points this at its
 *                embedded Tor daemon, so every Zen request exits through a
 *                Tor circuit ("IP isolation"). When the upstream throttles
 *                that exit, `rotate()` asks the manager (desktop app) for a
 *                fresh circuit and the request is replayed.
 *   - `warp`   — Cloudflare WARP's SOCKS5 listener (legacy failover).
 *
 * The whole state is mutable at runtime through the admin API so the desktop
 * UI can toggle isolation without restarting the proxy:
 *
 *   PUT /admin/transport { "socks5": "127.0.0.1:19050", ... }
 */

/** Parse "socks5://host:port", "host:port" or "[v6]:port" into {host, port}. */
function parseSocks(value) {
  if (!value) return null;
  let raw = String(value).trim();
  if (raw === '') return null;
  raw = raw.replace(/^socks5h?:\/\//i, '').replace(/\/+$/, '');
  const idx = raw.lastIndexOf(':');
  if (idx <= 0) return null;
  const host = raw.slice(0, idx).replace(/^\[|\]$/g, '');
  const port = parseInt(raw.slice(idx + 1), 10);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

const state = {
  socks5: parseSocks(process.env.TOR_SOCKS || process.env.UPSTREAM_SOCKS5 || ''),
  // Where to ask for a fresh exit (the desktop app's IP manager). Empty means
  // rotation is unavailable and rate-limited requests fall back to WARP.
  rotateUrl: (process.env.IP_ROTATE_URL || '').trim(),
  rotateToken: (process.env.IP_ROTATE_TOKEN || '').trim(),
  rotateOnRateLimit: process.env.IP_ROTATE_ON_RATE_LIMIT !== 'false',
  rotateTimeoutMs: parseInt(process.env.IP_ROTATE_TIMEOUT_MS, 10) || 120000,
  // Tor discards NEWNYM requests fired less than ~10s apart; keep a floor so
  // bursts of 429s don't spin the control port.
  minRotateGapMs: (() => {
    const parsed = parseInt(process.env.IP_ROTATE_MIN_GAP_MS, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 8000;
  })(),
  busy: false,
  rotateCount: 0,
  lastRotateAt: 0, // last SUCCESSFUL rotation
  lastRotateAttemptAt: 0, // last attempt (success or failure) — drives the gap floor
  lastRotateError: null,
  lastRotateIp: null,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fetch with an AbortController-based timeout (no AbortSignal.timeout). */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Current SOCKS5 egress when isolation is on. */
function socksEndpoint() {
  return state.socks5;
}

/** True when a rotate endpoint is configured on the manager side. */
function hasRotate() {
  return state.rotateUrl !== '';
}

/** True when the automatic rotate-on-rate-limit policy is on. */
function rotateEnabled() {
  return state.rotateOnRateLimit;
}

/**
 * Apply a partial transport update (admin API). Unknown/empty fields are
 * ignored; `socks5` may be nulled to go back to the direct route.
 */
function update(patch) {
  if (!patch || typeof patch !== 'object') return status();

  if ('socks5' in patch) {
    state.socks5 = patch.socks5 == null || patch.socks5 === ''
      ? null
      : parseSocks(patch.socks5);
    log.info('socks5 egress updated', { socks5: state.socks5 ? `${state.socks5.host}:${state.socks5.port}` : null });
  }
  if (typeof patch.rotateUrl === 'string') state.rotateUrl = patch.rotateUrl.trim();
  if (typeof patch.rotateToken === 'string') state.rotateToken = patch.rotateToken.trim();
  if (typeof patch.rotateOnRateLimit === 'boolean') state.rotateOnRateLimit = patch.rotateOnRateLimit;
  if (Number.isInteger(patch.rotateTimeoutMs) && patch.rotateTimeoutMs > 0) {
    state.rotateTimeoutMs = patch.rotateTimeoutMs;
  }
  return status();
}

/**
 * Ask the manager (desktop app → tor control port) for a fresh exit.
 *
 * The manager rotates the circuit synchronously and answers with the new
 * public IP, so a caller that sees `{ ok: true }` can immediately replay its
 * request on the new circuit.
 *
 * @returns {Promise<{ok: boolean, ip?: string|null, changed?: boolean, message?: string, error?: string}>}
 */
async function rotate(reason) {
  if (!hasRotate()) {
    return { ok: false, error: 'no rotate endpoint configured' };
  }

  // Serialize rotations: when a concurrent request already asked, wait for it
  // to finish and optimistically replay on whatever circuit came out.
  const waitStart = Date.now();
  while (state.busy && Date.now() - waitStart < state.rotateTimeoutMs) {
    await sleep(300);
  }
  if (state.busy) {
    return { ok: false, error: 'rotation still in progress' };
  }

  const sinceLast = Date.now() - state.lastRotateAttemptAt;
  if (sinceLast < state.minRotateGapMs) {
    await sleep(state.minRotateGapMs - sinceLast);
  }

  state.busy = true;
  state.lastRotateAttemptAt = Date.now();
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(
      state.rotateUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(state.rotateToken ? { 'X-Admin-Token': state.rotateToken } : {}),
        },
        body: JSON.stringify({ reason: String(reason || 'rate limit') }),
      },
      state.rotateTimeoutMs
    );

    const text = await res.text().catch(() => '');
    let payload = null;
    try {
      payload = text === '' ? null : JSON.parse(text);
    } catch {
      payload = null;
    }

    if (!res.ok) {
      const message = (payload && (payload.error || payload.message)) || `rotate endpoint HTTP ${res.status}`;
      state.lastRotateError = message;
      log.warn('rotate failed', { status: res.status, message });
      return { ok: false, error: message };
    }
    if (payload && payload.error) {
      state.lastRotateError = String(payload.error);
      log.warn('rotate rejected by manager', { error: payload.error });
      return { ok: false, error: String(payload.error) };
    }

    state.lastRotateAt = Date.now();
    state.rotateCount += 1;
    state.lastRotateError = null;
    state.lastRotateIp = (payload && payload.ip) || null;
    log.info('exit rotated', {
      ip: state.lastRotateIp,
      changed: payload ? payload.changed : undefined,
      ms: Date.now() - started,
      reason,
    });
    return {
      ok: true,
      ip: (payload && payload.ip) || null,
      changed: payload ? payload.changed : undefined,
      message: (payload && payload.message) || 'circuit rotated',
    };
  } catch (err) {
    const message = err && err.name === 'AbortError'
      ? `rotate request timed out after ${state.rotateTimeoutMs}ms`
      : `rotate request failed: ${err.message}`;
    state.lastRotateError = message;
    log.warn('rotate error', { message });
    return { ok: false, error: message };
  } finally {
    state.busy = false;
  }
}

/** Serializable status for /admin/transport, /health and the desktop UI. */
function status() {
  return {
    isolated: state.socks5 != null,
    socks5: state.socks5 ? `${state.socks5.host}:${state.socks5.port}` : null,
    rotateAvailable: hasRotate(),
    rotateOnRateLimit: state.rotateOnRateLimit,
    rotateCount: state.rotateCount,
    busy: state.busy,
    lastRotateAt: state.lastRotateAt ? new Date(state.lastRotateAt).toISOString() : null,
    lastRotateIp: state.lastRotateIp,
    lastRotateError: state.lastRotateError,
  };
}

/** Test seam: reset rotation counters. */
function reset() {
  state.busy = false;
  state.rotateCount = 0;
  state.lastRotateAt = 0;
  state.lastRotateAttemptAt = 0;
  state.lastRotateError = null;
  state.lastRotateIp = null;
}

module.exports = {
  state,
  update,
  rotate,
  status,
  socksEndpoint,
  hasRotate,
  rotateEnabled,
  parseSocks,
  reset,
};
