'use strict';

const dns = require('dns');
const { execFile } = require('child_process');
const { config } = require('../config/constants');
const { createLogger } = require('./logger');

const log = createLogger('warp');

/**
 * Cloudflare WARP failover manager.
 *
 * Zen rate-limits per egress IP. When the upstream rejects a request for
 * reasons that plausibly depend on our IP, the proxy can reroute its
 * Zen-bound traffic through WARP's local SOCKS5 listener
 * (`warp-cli mode proxy`) so it exits from a different IP — WITHOUT touching
 * the machine's normal external connection. Only the requests the proxy
 * explicitly sends to that SOCKS port traverse WARP; everything else keeps
 * routing through the default gateway.
 *
 * Trigger conditions mirror the Go proxy (`internal/warp/warp.go`):
 *
 *   - HTTP 429 / 502 / 503 / 504
 *   - HTTP 500 carrying the gateway's internal-error envelope
 *     ("internal server error" / "upstream error")
 *   - network failures (connection reset/refused, DNS, timeouts)
 *
 * Auth, model and validation errors are never replayed through WARP, and a
 * stream that already started is never restarted.
 *
 * The module degrades gracefully: if `warp-cli` is missing, activation fails
 * and the original upstream error is surfaced instead of crashing.
 */

const state = {
  active: false,
  connected: false,
  ready: null, // Promise | null
  lastError: null,
  activatedAt: null,
  lastAttemptAt: null,
  egress: null, // "host:port" once active
};

function runWarpCli(args) {
  return new Promise((resolve, reject) => {
    execFile(
      config.warpBinPath,
      args,
      { windowsHide: true, timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`warp-cli ${args.join(' ')} failed: ${(stderr || err.message).trim()}`));
          return;
        }
        resolve(String(stdout || '').trim());
      }
    );
  });
}

async function ensureWarpReady() {
  if (state.active) return state;

  await runWarpCli(['proxy', 'port', String(config.warpSocksPort)]);
  await runWarpCli(['mode', 'proxy']);
  await runWarpCli(['connect']);

  // Give the tunnel a moment to come up before we verify.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const status = await runWarpCli(['status']);
  if (!/connected/i.test(status)) {
    throw new Error(`WARP did not reach Connected state: ${status}`);
  }

  state.active = true;
  state.connected = true;
  state.activatedAt = Date.now();
  state.egress = `${config.warpSocksHost}:${config.warpSocksPort}`;
  state.lastError = null;
  log.info('active', { socks: state.egress });
  return state;
}

/**
 * Activate WARP proxy mode. Safe to call concurrently: a single shared promise
 * is reused until success or failure.
 */
function activate() {
  if (!config.warpAutoFailover) {
    return Promise.reject(new Error('WARP failover disabled (WARP_AUTO_FAILOVER=false)'));
  }
  state.lastAttemptAt = Date.now();
  if (!state.ready) {
    state.ready = ensureWarpReady().catch((err) => {
      state.lastError = err.message;
      state.ready = null; // allow retry on the next trigger
      throw err;
    });
  }
  return state.ready.then(() => state);
}

/**
 * Drop the current WARP state (used when WARP starts failing mid-flight or on
 * shutdown/test teardown).
 */
function markInactive(reason) {
  if (state.active) log.warn('marked inactive', { reason: reason || 'unknown' });
  state.active = false;
  state.connected = false;
  state.ready = null;
  if (reason) state.lastError = reason;
}

/** Reset the failover state (shutdown / test teardown). */
function reset() {
  state.active = false;
  state.connected = false;
  state.ready = null;
  state.lastError = null;
  state.activatedAt = null;
  state.lastAttemptAt = null;
  state.egress = null;
}

function isActive() {
  return state.active;
}

function isEnabled() {
  return config.warpAutoFailover;
}

/** Local SOCKS5 endpoint used as the WARP egress. */
function socksEndpoint() {
  return { host: config.warpSocksHost, port: config.warpSocksPort };
}

/**
 * Should this upstream failure be retried through a different egress IP?
 *
 * A 500 is retried only for the gateway's internal-error envelope; validation,
 * auth and model errors are not blindly sent through WARP.
 */
function shouldFailover(status, body) {
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  if (status !== 500) return false;
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  const low = text.toLowerCase();
  return low.includes('internal server error')
    || low.includes('internal_server_error')
    || low.includes('upstream error')
    || low.includes('upstream_error');
}

/** Does this error look like a transport failure rather than an HTTP answer? */
function isNetworkFailure(err) {
  if (!err) return false;
  const code = err.code || '';
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return true;
  }
  const text = String(err.message || '').toLowerCase();
  return text.includes('connection reset')
    || text.includes('connection refused')
    || text.includes('socket hang up')
    || text.includes('no such host')
    || text.includes('getaddrinfo')
    || text.includes('i/o timeout')
    || text.includes('timed out');
}

/** Resolve the upstream hostname once so the SOCKS tunnel can be opened. */
function resolveHost(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, (err, address) => {
      if (err) reject(err);
      else resolve(address);
    });
  });
}

function status() {
  return {
    enabled: config.warpAutoFailover,
    autoFailover: config.warpAutoFailover,
    active: state.active,
    connected: state.connected,
    socks: state.active ? `${config.warpSocksHost}:${config.warpSocksPort}` : null,
    egress: state.egress || null,
    activatedAt: state.activatedAt ? new Date(state.activatedAt).toISOString() : null,
    lastAttemptAt: state.lastAttemptAt ? new Date(state.lastAttemptAt).toISOString() : null,
    lastError: state.lastError || null,
    cooldownMs: config.warpCooldownMs,
  };
}

module.exports = {
  activate,
  markInactive,
  reset,
  status,
  isActive,
  isEnabled,
  socksEndpoint,
  shouldFailover,
  isNetworkFailure,
  resolveHost,
};
