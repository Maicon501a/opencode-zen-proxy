'use strict';

const { execFile } = require('child_process');
const { config } = require('../config/constants');

/**
 * WARP failover manager — ports the grok-kimi-proxy-route WARP manager
 * (internal/warp/warp.go) to Node.
 *
 * The proxy does NOT assume a WARP client is already listening on the SOCKS
 * port. On a failover-eligible Zen failure it ACTIVATES WARP on demand by
 * driving the `warp-cli` binary:
 *
 *   warp-cli proxy port <port>   # expose a local SOCKS5 endpoint
 *   warp-cli mode proxy          # switch WARP into proxy mode
 *   warp-cli connect             # bring the tunnel up
 *   (wait startupWait)           # let the tunnel settle
 *   warp-cli status              # verify it reached "Connected"
 *
 * Concurrent activations are coalesced and failed activations are subject to
 * a cooldown so a burst of 500s cannot spawn a storm of warp-cli processes.
 * When a WARP-routed request fails with a network error the cached
 * "active" state is invalidated (MarkInactive) so the next eligible error
 * re-runs warp-cli instead of believing a stale Connected state forever.
 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class WarpManager {
  /**
   * @param {object} cfg
   * @param {boolean} cfg.enabled
   * @param {string} cfg.host          - SOCKS listen host
   * @param {number} cfg.port          - SOCKS listen port
   * @param {string} cfg.binary        - warp-cli binary path (default "warp-cli")
   * @param {number} cfg.commandTimeout- ms per warp-cli command
   * @param {number} cfg.startupWait   - ms to wait after `connect`
   * @param {number} cfg.cooldown      - ms to cool down after a failed activation
   */
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.binary = cfg.binary || 'warp-cli';
    this.commandTimeout = cfg.commandTimeout || 30000;
    this.startupWait = cfg.startupWait === undefined ? 1500 : cfg.startupWait;
    this.cooldown = cfg.cooldown === undefined ? 60000 : cfg.cooldown;
    this.active = false;
    this.activating = false;
    this.wait = null;
    this.lastAttempt = null;
    this.lastError = '';
    this.activatedAt = null;
  }

  enabled() {
    return !!this.cfg.enabled;
  }

  isActive() {
    return this.active;
  }

  /**
   * Invalidate the cached Connected state after a WARP-routed request fails.
   * The next qualifying Zen error can then re-run warp-cli.
   */
  markInactive(reason) {
    this.active = false;
    if (reason) this.lastError = String(reason);
  }

  /**
   * Bring WARP proxy mode up. Coalesces concurrent triggers and is
   * cooldown-limited after a failed activation. Resolves when the tunnel is
   * Connected; rejects otherwise.
   */
  async activate() {
    if (!this.enabled()) {
      throw new Error('WARP failover disabled');
    }
    if (this.active) {
      return;
    }
    // Coalesce concurrent activation triggers.
    if (this.activating && this.wait) {
      await this.wait.promise;
      if (this.active) return;
      throw new Error(this.lastError || 'WARP activation failed');
    }
    // Cooldown after a failed activation.
    if (this.lastAttempt && Date.now() - this.lastAttempt < this.cooldown) {
      throw new Error(this.lastError || 'WARP activation is cooling down');
    }

    this.activating = true;
    this.lastAttempt = Date.now();
    const wait = deferred();
    this.wait = wait;
    try {
      await this.ensureReady();
      this.active = true;
      this.lastError = '';
      this.activatedAt = new Date();
    } catch (err) {
      this.active = false;
      this.lastError = err.message;
      throw err;
    } finally {
      this.activating = false;
      wait.resolve();
    }
  }

  async ensureReady() {
    await this.runCLI('proxy', 'port', String(this.cfg.port));
    await this.runCLI('mode', 'proxy');
    await this.runCLI('connect');
    if (this.startupWait > 0) {
      await new Promise((r) => setTimeout(r, this.startupWait));
    }
    const status = await this.runCLI('status');
    const low = String(status).toLowerCase();
    if (low.includes('disconnected') || !low.includes('connected')) {
      throw new Error(`WARP did not reach Connected state: ${status.trim()}`);
    }
  }

  /**
   * Run a single warp-cli command with the configured timeout. Rejects with a
   * descriptive message that includes the command and any stderr/stdout.
   */
  runCLI(...args) {
    return new Promise((resolve, reject) => {
      execFile(this.binary, args, { timeout: this.commandTimeout }, (err, stdout, stderr) => {
        if (err) {
          const detail = String(stdout || stderr || '').trim();
          const msg = detail || err.message;
          return reject(new Error(`warp-cli ${args.join(' ')} failed: ${msg}`));
        }
        resolve(String(stdout || '').trim());
      });
    });
  }

  status() {
    return {
      enabled: this.enabled(),
      active: this.active,
      activating: this.activating,
      socks: `${this.cfg.host}:${this.cfg.port}`,
      binary: this.binary,
      cooldown_ms: this.cooldown,
      last_error: this.lastError,
      activated_at: this.activatedAt ? this.activatedAt.toISOString() : null,
      last_attempt_at: this.lastAttempt ? new Date(this.lastAttempt).toISOString() : null,
    };
  }
}

const warp = new WarpManager({
  enabled: config.warpAutoFailover,
  host: config.warpSocksHost,
  port: config.warpSocksPort,
  binary: config.warpBinPath || 'warp-cli',
  commandTimeout: config.warpCommandTimeout,
  startupWait: config.warpStartupWait,
  cooldown: config.warpCooldown,
});

module.exports = warp;
module.exports.WarpManager = WarpManager;
