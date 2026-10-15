'use strict';

const express = require('express');
const zen = require('../services/zenClient');
const { responsesSseToChatStream } = require('../services/converters');
const { openaiError, sendError, pipeSse } = require('../services/respond');
const { createLogger } = require('../services/logger');

const router = express.Router();
const log = createLogger('chat');

/**
 * POST /v1/chat/completions
 *
 * OpenAI-compatible chat completions, backed directly by the OpenCode Zen
 * gateway through the free-tier gate. Native OpenAI features all work:
 *
 *   - streaming (SSE)
 *   - tool / function calling (tools, tool_choice, streamed tool_calls)
 *   - response_format (JSON mode), temperature, top_p, seed, max_tokens, ...
 *   - vision (`image_url` parts, on multimodal free models)
 *
 * Two upstream behaviours are hidden from the client:
 *
 *   1. The Zen gate forces `stream: true` upstream. When the client did not ask
 *      for streaming, the SSE is folded back into a single chat.completion.
 *   2. Muse Spark free models only exist on /responses. The proxy routes them
 *      there and translates the answer (JSON or SSE) back to chat chunks.
 */
router.post('/chat/completions', async (req, res) => {
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
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    res.status(400).json(openaiError('The messages field is required and must be a non-empty array.', {
      code: 'missing_required_parameter',
      param: 'messages',
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
    const result = await zen.createChatCompletion(payload, { signal: controller.signal, key: req.zenKey });

    if (result.mode === 'json') {
      res.status(200).json(result.body);
      return;
    }

    if (result.upstreamFormat === 'chat') {
      pipeSse(req, res, result.stream);
      return;
    }

    // Muse Spark: upstream stayed on /responses — bridge SSB → chat chunks so
    // agents still receive native tool_calls.
    log.debug('translating responses SSE to chat', { model: result.wireModel });
    await responsesSseToChatStream(result.stream, res, result.wireModel);
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
