'use strict';

const express = require('express');
const zen = require('../services/zenClient');
const { config } = require('../config/constants');
const { getModelInfo, FREE_MODELS } = require('../config/models');
const { validateChatPayload, hasNonTextContent } = require('../services/validation');
const { createCompletionSseFilter } = require('../services/sse');

const router = express.Router();

/**
 * POST /v1/chat/completions
 *
 * OpenAI-compatible chat completions endpoint, backed directly by the
 * OpenCode Zen gateway. The request body is forwarded verbatim (minus the
 * "opencode/" model prefix), so native OpenAI features all work:
 *
 *   - streaming (SSE)
 *   - tool / function calling
 *   - tool_choice
 *   - response_format (JSON mode)
 *   - temperature, top_p, seed, max_tokens, ...
 *
 * No local `opencode serve` instance is required.
 */
router.post('/chat/completions', async (req, res, next) => {
  try {
    const payload = req.body;

    const validationError = validateChatPayload(payload);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.error });
    }

    // Multimodal guard: a known text-only model receiving images/audio would
    // be rejected by Zen with a cryptic 400. Fail fast with a clear message,
    // or (opt-in via AUTO_ROUTE_MULTIMODAL=true) route to a multimodal model.
    const modelInfo = getModelInfo(payload.model);
    if (modelInfo && !modelInfo.multimodal && hasNonTextContent(payload.messages)) {
      const multimodal = FREE_MODELS.find((m) => m.multimodal);
      if (config.autoRouteMultimodal && multimodal) {
        console.warn(
          `[Multimodal] Model '${payload.model}' is text-only but request has images/audio; routing to '${multimodal.id}'.`
        );
        payload.model = multimodal.id;
      } else {
        return res.status(400).json({
          error: {
            message:
              `Model '${payload.model}' only supports text input, but the request contains images/audio. ` +
              (multimodal
                ? `Use a multimodal model like '${multimodal.id.replace('opencode/', '')}' (e.g. 'mimo-v2.5-free') for image input, or enable AUTO_ROUTE_MULTIMODAL=true to route automatically.`
                : ''),
            type: 'invalid_request_error',
            param: 'model',
            code: 'model_does_not_support_content',
          },
        });
      }
    }

    const result = await zen.forwardChatCompletion(payload);

    if (result.stream) {
      // Pipe the upstream SSE stream straight through to the client. The Zen
      // gateway already emits OpenAI-format chunks, so no transformation is
      // needed. Setting these headers and aborting the upstream on client
      // disconnect keeps things clean for streaming clients.
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const upstream = result.response;
      const filtered = createCompletionSseFilter();
      const handleStreamError = (err) => {
        if (!res.headersSent) {
          next(err);
        } else {
          res.end();
        }
      };

      // Preserve every upstream SSE event until the protocol terminator. Zen
      // currently appends a cost event after [DONE]; that event is not part of
      // the completion stream and causes strict OpenAI-compatible clients to
      // report "response contained no choices".
      upstream.on('error', handleStreamError);
      filtered.on('error', handleStreamError);
      upstream.pipe(filtered).pipe(res);

      req.on('close', () => {
        if (!upstream.destroyed) upstream.destroy();
        if (!filtered.destroyed) filtered.destroy();
      });
      return;
    }

    // Non-streaming: return the parsed JSON body unchanged.
    res.status(result.statusCode).json(result.data);
  } catch (err) {
    // Translate Zen error envelopes into OpenAI format and keep the status.
    const status = err.statusCode || 500;
    res.status(status).json({
      error: {
        message: err.message,
        type: err.type || 'api_error',
        code: err.code || null,
      },
    });
  }
});

module.exports = router;
