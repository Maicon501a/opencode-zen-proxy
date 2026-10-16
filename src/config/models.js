'use strict';

/**
 * OpenCode Zen free-tier catalog.
 *
 * Mirrors the live catalog the official client sees on
 * https://opencode.ai/zen/v1/models. Every model here is reachable with the
 * bearer token `public` (no login, no key) — but only through the free-tier
 * gate implemented in src/services/zenGate.js.
 *
 * Two API families exist:
 *
 *   - `chat`      → OpenAI chat/completions (most free models).
 *   - `responses` → OpenAI Responses API (Muse Spark contributor free tier).
 *                   Sending a Muse Spark model to chat/completions produces an
 *                   opaque HTTP 500, so the proxy routes it to /responses and
 *                   translates the answer back for chat clients.
 *
 * Reasoning: Zen error 1210 — free chat models always think and only accept
 * `low` / `high` / `max`. The Responses-based Muse models accept the wider
 * OpenAI vocabulary (`none`|`minimal`|`low`|`medium`|`high`|`xhigh`).
 *
 * Note: free models may collect usage data for model improvement. Do not
 * submit sensitive or confidential data through them.
 */

/** Effort levels accepted by Zen's chat/completions free models. */
const ZEN_CHAT_EFFORTS = ['low', 'high', 'max'];

/** Effort levels accepted by Zen's Responses-based free models. */
const ZEN_RESPONSES_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/** Effort applied by the upstream when the client omits `reasoning_effort`. */
const ZEN_DEFAULT_EFFORT = 'high';

/** Effort suffixes accepted as model aliases: `<model>-low|-high|-max`. */
const ZEN_EFFORT_SUFFIXES = ['-max', '-high', '-low'];

const PROVIDER_PREFIX = 'opencode/';

/**
 * Free models, in the order the live Zen catalog exposes them.
 * `id` keeps the `opencode/` namespace so clients can select Zen
 * unambiguously; the prefix is stripped before the request hits the wire.
 */
const FREE_MODELS = [
  {
    id: 'opencode/space-bunny-free',
    name: 'Space Bunny Free',
    apiMode: 'chat',
    supportsTools: true,
    supportsVision: true,
    inputModalities: ['text', 'image', 'video'],
    contextWindow: 1048576,
    maxOutput: 524288,
    reasoning: true,
    description: 'OpenCode Zen free tier · reasoning · multimodal',
  },
  {
    id: 'opencode/deepseek-v4.1-flash-free',
    name: 'DeepSeek V4.1 Flash Free',
    apiMode: 'chat',
    supportsTools: true,
    supportsVision: true,
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    maxOutput: 32000,
    reasoning: true,
    description: 'OpenCode Zen free tier · DeepSeek · janela real 1M (2²⁰)',
  },
  {
    id: 'opencode/glm-5.3-flash-free',
    name: 'GLM 5.3 Flash Free',
    apiMode: 'chat',
    supportsTools: true,
    supportsVision: true,
    inputModalities: ['text', 'image', 'video', 'pdf'],
    contextWindow: 900000,
    maxOutput: 32000,
    reasoning: true,
    description: 'OpenCode Zen free tier · Z.ai GLM · entrada real ~922k (ver docs)',
  },
  {
    id: 'opencode/cat-jam-free',
    name: 'Cat Jam Free',
    apiMode: 'chat',
    supportsTools: true,
    supportsVision: false,
    inputModalities: ['text'],
    contextWindow: 262144,
    maxOutput: 131072,
    reasoning: true,
    description: 'OpenCode Zen free tier · 262k de contexto',
  },
  {
    id: 'opencode/mimo-v2.6-flash-free',
    name: 'MiMo V2.6 Flash Free',
    apiMode: 'chat',
    supportsTools: true,
    supportsVision: true,
    inputModalities: ['text', 'image', 'audio', 'video'],
    contextWindow: 200000,
    maxOutput: 32000,
    reasoning: true,
    description: 'OpenCode Zen free tier · multimodal · 200k de contexto',
  },
  {
    id: 'opencode/nemotron-3.5-lightning-free',
    name: 'Nemotron 3.5 Lightning Free',
    apiMode: 'chat',
    supportsTools: true,
    supportsVision: false,
    inputModalities: ['text'],
    contextWindow: 262144,
    maxOutput: 262144,
    reasoning: true,
    description: 'OpenCode Zen free tier · NVIDIA · 262k de contexto',
  },
  {
    id: 'opencode/nemotron-3.5-super-vl-free',
    name: 'Nemotron 3.5 Super VL Free',
    apiMode: 'chat',
    supportsTools: true,
    supportsVision: true,
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    maxOutput: 131072,
    reasoning: true,
    description: 'OpenCode Zen free tier · NVIDIA · 1M de contexto',
  },
  {
    id: 'opencode/step-5-preview-free',
    name: 'Step 5 Preview Free',
    apiMode: 'chat',
    supportsTools: true,
    supportsVision: true,
    inputModalities: ['text', 'image', 'video'],
    contextWindow: 1000000,
    maxOutput: 65536,
    reasoning: true,
    description: 'OpenCode Zen free tier · preview · 1M de contexto',
  },
  {
    id: 'opencode/longcat-2.5-preview-free',
    name: 'LongCat 2.5 Preview Free',
    apiMode: 'chat',
    supportsTools: true,
    supportsVision: true,
    inputModalities: ['text', 'image'],
    contextWindow: 1000000,
    maxOutput: 131072,
    reasoning: true,
    description: 'OpenCode Zen free tier · preview · 1M de contexto',
  },
  {
    id: 'opencode/big-pickle',
    name: 'Big Pickle',
    apiMode: 'chat',
    supportsTools: true,
    supportsVision: false,
    inputModalities: ['text'],
    contextWindow: 200000,
    maxOutput: 32000,
    reasoning: true,
    description: 'OpenCode Zen free tier · experimental · 200k de contexto',
  },
  {
    id: 'opencode/muse-spark-1.3-contributor-free',
    name: 'Muse Spark 1.3 Free',
    apiMode: 'responses',
    supportsTools: true,
    supportsVision: true,
    inputModalities: ['text', 'image', 'video', 'pdf', 'audio'],
    contextWindow: 1048576,
    maxOutput: 131072,
    reasoning: true,
    description: 'OpenCode Zen contributor free tier · Responses API · 1M de contexto',
  },
  {
    id: 'opencode/muse-spark-1.2-contributor-free',
    name: 'Muse Spark 1.2 Free',
    apiMode: 'responses',
    supportsTools: true,
    supportsVision: true,
    inputModalities: ['text', 'image', 'video', 'pdf', 'audio'],
    contextWindow: 1048576,
    maxOutput: 131072,
    reasoning: true,
    description: 'OpenCode Zen contributor free tier · Responses API · 1M de contexto',
  },
];

/**
 * Short aliases accepted by the resolver, mirroring the Go proxy's
 * `resolveOpenCodeZenModel`. Keys are bare (no `opencode/` prefix).
 */
const SHORT_ALIASES = {
  'space-bunny': 'space-bunny-free',
  'deepseek-v4.1': 'deepseek-v4.1-flash-free',
  'deepseek-v4.1-flash': 'deepseek-v4.1-flash-free',
  'glm-5.3-flash': 'glm-5.3-flash-free',
  'cat-jam': 'cat-jam-free',
  'mimo-v2.6': 'mimo-v2.6-flash-free',
  'mimo-v2.6-flash': 'mimo-v2.6-flash-free',
  'nemotron-3.5-lightning': 'nemotron-3.5-lightning-free',
  'nemotron-3.5-super-vl': 'nemotron-3.5-super-vl-free',
  'step-5': 'step-5-preview-free',
  'step-5-preview': 'step-5-preview-free',
  'longcat-2.5': 'longcat-2.5-preview-free',
  'longcat-2.5-preview': 'longcat-2.5-preview-free',
  'muse-spark-1.3-contributor': 'muse-spark-1.3-contributor-free',
  'muse-spark-1.3-free': 'muse-spark-1.3-contributor-free',
  'muse-spark-1.3': 'muse-spark-1.3-contributor-free',
  'muse-spark-1.2-contributor': 'muse-spark-1.2-contributor-free',
  'muse-spark-1.2-free': 'muse-spark-1.2-contributor-free',
  'muse-spark-1.2': 'muse-spark-1.2-contributor-free',
};

const ALL_MODELS = [...FREE_MODELS];

const WIRE_TO_MODEL = new Map();
for (const model of ALL_MODELS) {
  WIRE_TO_MODEL.set(model.id.slice(PROVIDER_PREFIX.length), model);
  WIRE_TO_MODEL.set(model.id, model);
}

/** Every alias (canonical, bare and short) mapped onto the canonical id. */
const MODEL_ALIASES = {};
for (const model of ALL_MODELS) {
  MODEL_ALIASES[model.id] = model.id;
  const bare = model.id.slice(PROVIDER_PREFIX.length);
  MODEL_ALIASES[bare] = model.id;
}
for (const [shortId, wireId] of Object.entries(SHORT_ALIASES)) {
  const model = WIRE_TO_MODEL.get(wireId);
  if (model) MODEL_ALIASES[shortId] = model.id;
}

/**
 * Split an effort suffix (`-low` / `-high` / `-max`) off a Zen model id,
 * mirroring the Go proxy's `ExtractZenEffort`.
 *
 *   "opencode/space-bunny-free-max" → { base: "opencode/space-bunny-free", effort: "max" }
 *   "space-bunny-free"              → { base: "space-bunny-free", effort: "" }
 */
function extractZenEffort(model) {
  const value = String(model == null ? '' : model).trim().toLowerCase();
  for (const suffix of ZEN_EFFORT_SUFFIXES) {
    if (value.endsWith(suffix)) {
      return { base: value.slice(0, -suffix.length), effort: suffix.slice(1) };
    }
  }
  return { base: value, effort: '' };
}

/**
 * Resolve a request model id to the exact identifier the Zen wire expects
 * (bare, no `opencode/` prefix, no effort suffix).
 *
 * Unknown ids pass through untouched so they can still reach the gateway
 * (paid models, future free models).
 */
function resolveWireModel(model) {
  if (model == null || model === '') return '';
  let value = String(model).trim();
  if (value.toLowerCase().startsWith(PROVIDER_PREFIX)) {
    value = value.slice(PROVIDER_PREFIX.length);
  }
  const { base } = extractZenEffort(value);
  value = base;
  const aliased = SHORT_ALIASES[value] || value;
  return aliased;
}

/**
 * Resolve any model alias to the canonical `opencode/`-prefixed id used by the
 * /v1/models endpoints. Unknown ids pass through unchanged.
 */
function resolveModelId(model) {
  if (!model) return null;
  const wire = resolveWireModel(model);
  const known = WIRE_TO_MODEL.get(wire);
  if (known) return known.id;
  return String(model).trim();
}

/** Native endpoint family for a model: `chat` or `responses`. */
function modelApiMode(model) {
  const wire = resolveWireModel(model).toLowerCase();
  return wire.startsWith('muse-spark') ? 'responses' : 'chat';
}

/** Effort levels accepted for a model. */
function zenEffortsForModel(model) {
  return modelApiMode(model) === 'responses' ? ZEN_RESPONSES_EFFORTS : ZEN_CHAT_EFFORTS;
}

/** Default effort the upstream applies when the client omits the field. */
function defaultZenEffort() {
  return ZEN_DEFAULT_EFFORT;
}

/**
 * Map a generic effort value onto the vocabulary the model's endpoint accepts.
 * An empty return means "omit the field entirely".
 */
function mapZenReasoningEffort(model, effort) {
  const value = String(effort == null ? '' : effort).trim().toLowerCase();
  if (value === '') return '';

  if (modelApiMode(model) !== 'responses') {
    switch (value) {
      case 'low':
      case 'high':
      case 'max':
        return value;
      case 'medium':
      case 'minimal':
        return 'high';
      case 'xhigh':
      case 'extra_high':
      case 'extra-high':
      case 'ultra':
        return 'max';
      case 'off':
      case 'none':
      case 'disabled':
        return 'low';
      default:
        return '';
    }
  }

  switch (value) {
    case 'none':
    case 'off':
    case 'disabled':
      return 'none';
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value;
    case 'max':
    case 'ultra':
    case 'extra_high':
    case 'extra-high':
      return 'xhigh';
    default:
      return '';
  }
}

/** Check if a model is a known free-tier Zen model. */
function isFreeModel(model) {
  const wire = resolveWireModel(model);
  if (!wire) return false;
  return FREE_MODELS.some((m) => m.id.slice(PROVIDER_PREFIX.length) === wire);
}

/** Full catalog entry for a model id (null when unknown). */
function getModelInfo(model) {
  if (!model) return null;
  return WIRE_TO_MODEL.get(resolveWireModel(model)) || null;
}

module.exports = {
  FREE_MODELS,
  ALL_MODELS,
  MODEL_ALIASES,
  SHORT_ALIASES,
  ZEN_CHAT_EFFORTS,
  ZEN_RESPONSES_EFFORTS,
  ZEN_DEFAULT_EFFORT,
  PROVIDER_PREFIX,
  extractZenEffort,
  resolveWireModel,
  resolveModelId,
  modelApiMode,
  zenEffortsForModel,
  defaultZenEffort,
  mapZenReasoningEffort,
  isFreeModel,
  getModelInfo,
};
