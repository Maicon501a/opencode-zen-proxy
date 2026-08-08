'use strict';

const express = require('express');
const { FREE_MODELS } = require('../config/models');
const warp = require('../services/warp');

const router = express.Router();

/**
 * GET /health
 *
 * Health check endpoint for the proxy.
 */
router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'opencode-zen-proxy',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    warp: warp.status(),
  });
});

/**
 * GET /
 *
 * Root endpoint with basic info.
 */
router.get('/', (_req, res) => {
  res.json({
    name: 'OpenCode Zen Proxy',
    version: '1.0.0',
    description: 'OpenAI-compatible proxy for OpenCode Zen API',
    documentation: '/docs',
    health: '/health',
    models: '/v1/models',
    chat: '/v1/chat/completions (POST)',
  });
});

/**
 * GET /docs
 *
 * Quick documentation in JSON format.
 */
router.get('/docs', (_req, res) => {
  res.json({
    service: 'OpenCode Zen Proxy',
    usage: {
      'List Models': {
        method: 'GET',
        endpoint: '/v1/models',
      },
      'Chat Completions (non-streaming)': {
        method: 'POST',
        endpoint: '/v1/chat/completions',
        body: {
          model: 'opencode/deepseek-v4-flash-free',
          messages: [{ role: 'user', content: 'Hello!' }],
        },
      },
      'Chat Completions (streaming)': {
        method: 'POST',
        endpoint: '/v1/chat/completions',
        body: {
          model: 'opencode/deepseek-v4-flash-free',
          messages: [{ role: 'user', content: 'Hello!' }],
          stream: true,
        },
      },
    },
    'Model Aliases': 'You can omit the "opencode/" prefix and use short aliases (e.g. "mimo-v2.5" -> "mimo-v2.5-free").',
    authentication: 'Keyless. The proxy forwards "public" to Zen for free-tier models. Set CLIENT_API_KEY to gate client access.',
    'Free Models': FREE_MODELS.map((m) => m.id),
  });
});

module.exports = router;
