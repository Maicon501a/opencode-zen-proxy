'use strict';

const express = require('express');
const warp = require('../services/warp');
const transport = require('../services/transport');
const { FREE_MODELS } = require('../config/models');

const router = express.Router();

const VERSION = '2.1.0';

/**
 * GET /health
 */
router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'opencode-zen-proxy',
    version: VERSION,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    upstream: 'https://opencode.ai/zen/v1',
    zenGate: 'free-tier (official CLI headers + forced streaming)',
    transport: transport.status(),
    warp: warp.status(),
  });
});

/**
 * GET /warp/status
 *
 * Current WARP failover state (is the isolated SOCKS egress active?).
 */
router.get('/warp/status', (_req, res) => {
  res.json({ status: 'ok', warp: warp.status() });
});

/**
 * GET /
 */
router.get('/', (_req, res) => {
  res.json({
    name: 'OpenCode Zen Proxy',
    version: VERSION,
    description: 'Keyless OpenAI-compatible proxy for the OpenCode Zen free tier',
    documentation: '/docs',
    health: '/health',
    models: '/v1/models',
    chat: 'POST /v1/chat/completions',
    responses: 'POST /v1/responses',
  });
});

/**
 * GET /docs
 */
router.get('/docs', (_req, res) => {
  res.json({
    service: 'OpenCode Zen Proxy',
    version: VERSION,
    usage: {
      'List models': { method: 'GET', endpoint: '/v1/models' },
      'Free models (curated)': { method: 'GET', endpoint: '/v1/models/free' },
      'Chat completions': {
        method: 'POST',
        endpoint: '/v1/chat/completions',
        body: {
          model: 'opencode/deepseek-v4.1-flash-free',
          messages: [{ role: 'user', content: 'Hello!' }],
          stream: true,
        },
      },
      'Responses API': {
        method: 'POST',
        endpoint: '/v1/responses',
        body: {
          model: 'opencode/muse-spark-1.3-contributor-free',
          input: 'Hello!',
          stream: true,
        },
      },
      'Reasoning effort': {
        field: 'reasoning_effort',
        vocabulary: 'low | high | max (chat models)',
        aliasSuffixes: ['-low', '-high', '-max'],
        example: 'opencode/space-bunny-free-max',
      },
      'Media input': {
        image: { type: 'image_url', image_url: { url: 'data:image/png;base64,... or https URL' } },
        video: { type: 'video_url', video_url: { url: 'data:video/mp4;base64,...' } },
        audio: { type: 'input_audio', input_audio: { data: '<base64>', format: 'wav' } },
        models: 'mimo-v2.6 (image/audio/video) · space-bunny & step-5 (image/video) · glm-5.3-flash (image/video/pdf) · muse 1.2/1.3 (image/video/audio/pdf)',
      },
    },
    authentication: 'Keyless. The proxy presents itself as the official OpenCode CLI and forwards "public" to Zen.',
    freeModels: FREE_MODELS.map((model) => model.id),
    notes: [
      'The Zen free-tier gate requires streamed requests; non-streaming clients get the folded SSE back as one JSON object.',
      'Muse Spark free models are Responses-only and are translated automatically for chat clients.',
      'Zen rate-limits by egress IP. On 429/502/503/504 (or a gateway 500) the proxy retries once through Cloudflare WARP.',
      'The last rejected upstream response (status, headers, retry-after, message, body up to 2KB) is kept as lastRejection in the stats snapshot and surfaced in the desktop event feed and logs.',
      'The 200k context advertised for deepseek-v4.1-flash-free is conservative catalog metadata: prompts of 395,297 and 919,735 tokens were accepted live (200 OK in 11.5s and 17.0s, measured 2026-10-15). The real ceiling is 1,048,576 tokens (2^20) — same window as the paid variant; raise limit.context in clients if needed.',
    ],
  });
});

module.exports = router;
