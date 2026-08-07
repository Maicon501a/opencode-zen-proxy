'use strict';

/**
 * Free-tier models on OpenCode Zen.
 *
 * These are accessible without a real API key using the "public" bearer
 * token (the same behavior as the opencode CLI when no key is configured).
 * The list mirrors the models Zen itself reports under GET /models.
 *
 * Note: Free models may collect usage data for model improvement.
 * Do not submit sensitive/confidential data when using free endpoints.
 */
const FREE_MODELS = [
  {
    id: 'opencode/deepseek-v4-flash-free',
    name: 'DeepSeek V4 Flash Free',
    provider: 'deepseek',
    family: 'deepseek-v4',
    free: true,
    description: 'Fast, efficient model from DeepSeek. Optimized for coding tasks.',
    supportsStreaming: true,
    supportsTools: true,
  },
  {
    id: 'opencode/big-pickle',
    name: 'Big Pickle',
    provider: 'big-pickle',
    family: 'big-pickle',
    free: true,
    description: 'Experimental free model for testing and feedback.',
    supportsStreaming: true,
    supportsTools: true,
  },
  {
    id: 'opencode/mimo-v2.5-free',
    name: 'MiMo V2.5 Free',
    provider: 'mimo',
    family: 'mimo-v2.5',
    free: true,
    description: 'Latest MiMo V2.5 model, free tier.',
    supportsStreaming: true,
    supportsTools: true,
  },
  {
    id: 'opencode/nemotron-3-ultra-free',
    name: 'Nemotron 3 Ultra Free',
    provider: 'nvidia',
    family: 'nemotron-3',
    free: true,
    description: 'Free tier of NVIDIA Nemotron 3 Ultra.',
    supportsStreaming: true,
    supportsTools: true,
  },
  {
    id: 'opencode/north-mini-code-free',
    name: 'North Mini Code',
    provider: 'north',
    family: 'north',
    free: true,
    description: 'Compact code-focused model from North, free tier.',
    supportsStreaming: true,
    supportsTools: true,
  },
  {
    id: 'opencode/ling-3.0-flash-free',
    name: 'Ling 3.0 Flash Free',
    provider: 'ling',
    family: 'ling-3.0',
    free: true,
    description: 'Flash-fast model from Ling, free tier.',
    supportsStreaming: true,
    supportsTools: true,
  },
  {
    id: 'opencode/laguna-s-2.1-free',
    name: 'Laguna S 2.1 Free',
    provider: 'laguna',
    family: 'laguna-s-2.1',
    free: true,
    description: 'Laguna S 2.1 model, free tier.',
    supportsStreaming: true,
    supportsTools: true,
  },
];

const ALL_MODELS = [...FREE_MODELS];

/**
 * Maps various model ID aliases to the canonical opencode/ prefixed ID.
 * Lets clients omit the "opencode/" prefix.
 */
const MODEL_ALIASES = {};

for (const model of ALL_MODELS) {
  MODEL_ALIASES[model.id] = model.id;
  const shortId = model.id.replace('opencode/', '');
  MODEL_ALIASES[shortId] = model.id;
  if (shortId.endsWith('-free')) {
    const withoutFree = shortId.replace('-free', '');
    MODEL_ALIASES[withoutFree] = model.id;
  }
}

/**
 * Resolve any model ID alias to the canonical ID (with opencode/ prefix).
 * Unknown ids pass through unchanged so they can reach Zen verbatim.
 */
function resolveModelId(modelId) {
  if (!modelId) return null;
  return MODEL_ALIASES[modelId] || modelId;
}

/**
 * Check if a model is known to be free on OpenCode Zen.
 */
function isFreeModel(modelId) {
  const canonicalId = resolveModelId(modelId);
  if (!canonicalId) return false;
  return FREE_MODELS.some((m) => m.id === canonicalId);
}

/**
 * Get model metadata by ID.
 */
function getModelInfo(modelId) {
  const canonicalId = resolveModelId(modelId);
  if (!canonicalId) return null;
  return ALL_MODELS.find((m) => m.id === canonicalId) || null;
}

module.exports = {
  FREE_MODELS,
  ALL_MODELS,
  MODEL_ALIASES,
  resolveModelId,
  isFreeModel,
  getModelInfo,
};
