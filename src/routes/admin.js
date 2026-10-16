'use strict';

const express = require('express');

const { config } = require('../config/constants');
const { FREE_MODELS } = require('../config/models');
const transport = require('../services/transport');
const stats = require('../services/stats');
const keys = require('../services/keys');
const warp = require('../services/warp');
const zen = require('../services/zenClient');
const { createLogger } = require('../services/logger');

const log = createLogger('admin');

const VERSION = '2.3.0';

/**
 * Admin API — the proxy's local control surface, consumed by the desktop app
 * (and usable with curl when it runs standalone).
 *
 * Security model: every /admin/* route requires the `X-Admin-Token` header to
 * match `ADMIN_TOKEN`. When no token is configured the API only answers
 * loopback callers, so an exposed proxy never leaks its controls.
 */
const router = express.Router();

function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function adminGuard(req, res, next) {
  if (config.adminToken) {
    const provided = req.headers['x-admin-token'] || '';
    if (provided !== config.adminToken) {
      res.status(401).json({
        error: { message: 'Invalid admin token.', type: 'auth_error', param: null, code: 'invalid_admin_token' },
      });
      return;
    }
    return next();
  }
  if (!isLoopback(req)) {
    res.status(403).json({
      error: { message: 'The admin API is loopback-only when no ADMIN_TOKEN is set.', type: 'auth_error', param: null, code: 'admin_forbidden' },
    });
    return;
  }
  return next();
}

router.use('/admin', adminGuard);

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

router.get('/admin/overview', (_req, res) => {
  const snapshot = stats.snapshot();
  res.json({
    object: 'zen.admin.overview',
    proxy: {
      version: VERSION,
      uptimeMs: Math.round(process.uptime() * 1000),
      bootedAt: snapshot.bootedAt,
      host: config.host,
      port: config.port,
      upstream: config.zenApiBaseUrl,
      gate: {
        userAgent: config.zenGate.clientUa,
        toolNames: config.zenGate.toolNames,
        forcedStreaming: true,
      },
      freeModels: FREE_MODELS.length,
    },
    transport: transport.status(),
    warp: warp.status(),
    keys: { requireKeys: keys.requiresKeys(), count: keys.count() },
    stats: {
      totals: snapshot.totals,
      models: snapshot.byModel.length,
    },
  });
});

// ---------------------------------------------------------------------------
// Stats & events
// ---------------------------------------------------------------------------

router.get('/admin/stats', (_req, res) => {
  res.json({ object: 'zen.admin.stats', ...stats.snapshot() });
});

router.post('/admin/stats/reset', (_req, res) => {
  res.json({ object: 'zen.admin.stats', ...stats.reset() });
});

router.get('/admin/events', (req, res) => {
  const after = parseInt(req.query.after, 10);
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 250);
  res.json({
    object: 'zen.admin.events',
    events: stats.eventsAfter(Number.isInteger(after) ? after : 0, limit),
    nextEventId: stats.snapshot().nextEventId,
  });
});

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

router.get('/admin/keys', (_req, res) => {
  res.json({
    object: 'zen.admin.keys',
    requireKeys: keys.requiresKeys(),
    keys: keys.list(),
    usage: stats.snapshot().byKey,
  });
});

router.post('/admin/keys', (req, res) => {
  const name = req.body && typeof req.body.name === 'string' ? req.body.name : '';
  const record = keys.create(name);
  stats.recordEvent('key', { action: 'created', key: record.name, keyId: record.id });
  res.status(201).json({ object: 'zen.admin.key', key: record });
});

router.delete('/admin/keys/:id', (req, res) => {
  const removed = keys.remove(req.params.id);
  if (!removed) {
    res.status(404).json({ error: { message: 'Key not found.', type: 'invalid_request_error', param: 'id', code: 'key_not_found' } });
    return;
  }
  stats.recordEvent('key', { action: 'removed', key: removed.name, keyId: removed.id });
  res.json({ object: 'zen.admin.key', removed: removed.id });
});

router.post('/admin/keys/:id/rotate', (req, res) => {
  const record = keys.rotateValue(req.params.id);
  if (!record) {
    res.status(404).json({ error: { message: 'Key not found.', type: 'invalid_request_error', param: 'id', code: 'key_not_found' } });
    return;
  }
  stats.recordEvent('key', { action: 'rotated', key: record.name, keyId: record.id });
  res.json({ object: 'zen.admin.key', key: record });
});

router.patch('/admin/keys/settings', (req, res) => {
  const requireKeys = req.body && req.body.requireKeys;
  if (typeof requireKeys !== 'boolean') {
    res.status(400).json({ error: { message: 'requireKeys must be a boolean.', type: 'invalid_request_error', param: 'requireKeys', code: 'invalid_parameter' } });
    return;
  }
  keys.setRequire(requireKeys);
  stats.recordEvent('key', { action: requireKeys ? 'requirement-on' : 'requirement-off' });
  res.json({ object: 'zen.admin.keys', requireKeys: keys.requiresKeys(), count: keys.count() });
});

// ---------------------------------------------------------------------------
// Transport (egress isolation)
// ---------------------------------------------------------------------------

router.get('/admin/transport', (_req, res) => {
  res.json({ object: 'zen.admin.transport', transport: transport.status(), warp: warp.status() });
});

router.put('/admin/transport', (req, res) => {
  const patch = req.body && typeof req.body === 'object' ? req.body : {};
  const status = transport.update(patch);
  log.info('transport updated via admin', { isolated: status.isolated, socks5: status.socks5 });
  res.json({ object: 'zen.admin.transport', transport: status });
});

router.post('/admin/rotate', async (req, res) => {
  const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason : 'manual';
  const result = await transport.rotate(reason);
  if (result.ok) {
    stats.recordEvent('rotation', { ip: result.ip || null, changed: result.changed, reason, message: result.message || null });
  }
  res.json({ object: 'zen.admin.rotate', ...result });
});

// ---------------------------------------------------------------------------
// Quick test — one tiny request through the full pipeline (gate + egress)
// ---------------------------------------------------------------------------

router.post('/admin/test', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const model = typeof body.model === 'string' && body.model !== '' ? body.model : 'deepseek-v4.1-flash-free';
  const prompt = typeof body.prompt === 'string' && body.prompt !== '' ? body.prompt.slice(0, 500) : 'ping — respond with one short sentence.';

  const started = Date.now();
  try {
    const result = await zen.createChatCompletion(
      { model, messages: [{ role: 'user', content: prompt }], max_tokens: 64, stream: false },
      {}
    );
    const latencyMs = Date.now() - started;
    const choice = result.body && Array.isArray(result.body.choices) ? result.body.choices[0] : null;
    const message = choice && choice.message ? choice.message : null;
    const preview = message && typeof message.content === 'string'
      ? message.content.slice(0, 200)
      : (result.body ? JSON.stringify(result.body).slice(0, 200) : '');
    res.json({
      object: 'zen.admin.test',
      ok: true,
      model,
      latencyMs,
      usage: result.body ? result.body.usage || null : null,
      preview,
    });
  } catch (err) {
    res.json({
      object: 'zen.admin.test',
      ok: false,
      model,
      latencyMs: Date.now() - started,
      error: err.message,
      status: err.statusCode || 500,
    });
  }
});

module.exports = router;
