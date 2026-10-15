'use strict';

const express = require('express');
const zen = require('../services/zenClient');
const {
  FREE_MODELS,
  PROVIDER_PREFIX,
  SHORT_ALIASES,
  ZEN_CHAT_EFFORTS,
  ZEN_DEFAULT_EFFORT,
  resolveModelId,
  resolveWireModel,
  modelApiMode,
  zenEffortsForModel,
  isFreeModel,
  getModelInfo,
} = require('../config/models');

const router = express.Router();

function freeModelPayload(model) {
  return {
    id: model.id,
    wireId: model.id.slice(PROVIDER_PREFIX.length),
    name: model.name,
    object: 'model',
    created: 1719792000,
    owned_by: 'opencode',
    free: true,
    apiMode: model.apiMode,
    endpoint: model.apiMode === 'responses' ? '/v1/responses' : '/v1/chat/completions',
    description: model.description,
    supportsStreaming: true,
    // The free-tier gate forces streaming upstream, but the proxy folds it back
    // for clients that don't stream, so both modes are always available.
    supportsTools: model.supportsTools,
    supportsVision: model.supportsVision,
    inputModalities: model.inputModalities || (model.supportsVision ? ['text', 'image'] : ['text']),
    // Context limits mirror models.dev — the same catalog the official client
    // reads — so editors can size their buffers and clients can configure
    // `limit.context` / `limit.output` correctly.
    contextWindow: model.contextWindow || null,
    maxOutput: model.maxOutput || null,
    context_length: model.contextWindow || null,
    reasoning: true,
    reasoningEfforts: zenEffortsForModel(model.id),
    defaultReasoningEffort: ZEN_DEFAULT_EFFORT,
  };
}

/**
 * GET /v1/models
 *
 * OpenAI-compatible model list. Tries the live Zen catalog first; on any
 * upstream failure it falls back to the curated free list so the endpoint
 * always answers.
 */
router.get('/models', async (_req, res) => {
  try {
    const result = await zen.fetchModels();
    const data = Array.isArray(result.data) ? result.data : [];
    const mapped = data.map((model) => {
      const id = typeof model.id === 'string' ? model.id : '';
      const known = id !== '' && isFreeModel(id);
      const info = known ? getModelInfo(id) : null;
      const merged = {
        ...model,
        id: known ? resolveModelId(id) : model.id,
        object: 'model',
        owned_by: 'opencode',
        free: known,
        apiMode: known ? modelApiMode(id) : 'chat',
      };
      if (info) {
        merged.name = model.name || info.name;
        merged.description = info.description;
        merged.supportsVision = info.supportsVision;
        merged.inputModalities = info.inputModalities || (info.supportsVision ? ['text', 'image'] : ['text']);
        merged.contextWindow = info.contextWindow || null;
        merged.maxOutput = info.maxOutput || null;
        merged.context_length = info.contextWindow || null;
      }
      return merged;
    });
    res.json({ object: 'list', data: mapped });
  } catch {
    res.json({ object: 'list', data: FREE_MODELS.map(freeModelPayload) });
  }
});

/**
 * GET /v1/models/free
 *
 * Curated free-tier list with capabilities. Declared before the wildcard route
 * so "free" is not captured as a model id.
 */
router.get('/models/free', (_req, res) => {
  res.json({
    object: 'list',
    data: FREE_MODELS.map(freeModelPayload),
    aliases: SHORT_ALIASES,
    effortSuffixes: ['-low', '-high', '-max'],
    effortVocabulary: ZEN_CHAT_EFFORTS,
    defaultReasoningEffort: ZEN_DEFAULT_EFFORT,
  });
});

/**
 * GET /v1/models/:modelId(*)
 *
 * Details for one model. The wildcard captures ids containing slashes, such as
 * "opencode/deepseek-v4.1-flash-free".
 */
router.get('/models/:modelId(*)', (req, res) => {
  const requested = req.params.modelId;
  const model = getModelInfo(requested);

  if (!model) {
    res.status(404).json({
      error: {
        message: `Model '${requested}' not found.`,
        type: 'invalid_request_error',
        param: null,
        code: 'model_not_found',
      },
    });
    return;
  }

  res.json({
    ...freeModelPayload(model),
    requestedId: requested,
    wireId: resolveWireModel(requested),
  });
});

module.exports = router;
