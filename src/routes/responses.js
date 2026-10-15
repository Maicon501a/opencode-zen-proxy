'use strict';

const express = require('express');
const zen = require('../services/zenClient');
const { chatSseToResponsesStream } = require('../services/converters');
const { openaiError, sendError, pipeSse } = require('../services/respond');
const { createLogger } = require('../services/logger');

const router = express.Router();
const log = createLogger('responses');

/**
 * POST /v1/responses
 *
 * OpenAI Responses API surface, backed by the same Zen free tier.
 *
 *   - Muse Spark free models are native Responses models: the request is
 *     forwarded to /responses as-is.
 *   - Every other free model is a chat/completions model. The body is
 *     translated to chat, and the answer (SSE or JSON) is translated back to
 *     Responses events, so Responses-only clients can use the whole free
 *     catalog.
 *
 * As on /v1/chat/completions, the always-streaming gate is transparent: when
 * the client asks for a single object, the SSE is aggregated into it.
 */
router.post('/responses', async (req, res) => {
  const payload = req.body;

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    res.status(400).json(openaiError('Request body must be a JSON object.'));
    return;
  }
  if (!payload.model) {
    res.status(400).json(openaiError('The model field is required.', {
      code: 'missing_required_parameter',
      param: 'model',
    }));
    return;
  }

  // Abort the upstream when the client gives up. `req`'s 'close' fires as soon
  // as the body is consumed, so the disconnect signal comes from the response.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const result = await zen.createResponse(payload, { signal: controller.signal, key: req.zenKey });

    if (result.mode === 'json') {
      res.status(200).json(result.body);
      return;
    }

    if (result.upstreamFormat === 'responses') {
      pipeSse(req, res, result.stream);
      return;
    }

    log.debug('translating chat SSE to responses', { model: result.wireModel });
    await chatSseToResponsesStream(result.stream, res, result.wireModel);
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
