'use strict';

const crypto = require('crypto');

/**
 * Tool payload sanitizers.
 *
 * Port of the Go proxy's `internal/proxyhttp/tools.go`. Clients (OpenCode,
 * Kilo, Cline, Codex) all describe tools slightly differently and strict
 * backends reject the variations — `type: "namespace"` produces an opaque 422
 * on xAI-compatible Responses endpoints, and dangling `required` entries break
 * strict JSON-schema validators.
 *
 * These helpers normalize both directions:
 *   - chat/completions nested function tools  ({ type, function: {...} })
 *   - Responses flat function tools           ({ type, name, parameters })
 */

/** Tool type variants the Responses API accepts. */
const ALLOWED_TOOL_TYPES = new Set([
  'function',
  'web_search',
  'x_search',
  'collections_search',
  'file_search',
  'code_execution',
  'code_interpreter',
  'mcp',
  'shell',
]);

const SAFE_SERVER_TOOL_KEYS = [
  'filters',
  'allowed_domains',
  'excluded_domains',
  'enable_image_understanding',
  'enable_image_search',
  'vector_store_ids',
  'max_num_results',
];

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function firstNonEmpty(a, b) {
  return a !== '' && a != null ? a : b || '';
}

/** Fresh `call_` id in the same shape OpenAI uses. */
function newCallId() {
  return `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function cloneMap(map) {
  return { ...map };
}

/** Tools may arrive as an array or as a `{ name: definition }` object. */
function flattenToolList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const out = [];
    for (const [name, def] of Object.entries(raw)) {
      if (!def || typeof def !== 'object') continue;
      const copy = cloneMap(def);
      if (asString(copy.type) === '') copy.type = 'function';
      if (asString(copy.name) === '') copy.name = name;
      if (copy.function && typeof copy.function === 'object' && asString(copy.function.name) === '') {
        copy.function = { ...copy.function, name };
      }
      out.push(copy);
    }
    return out;
  }
  return [];
}

/**
 * Drop entries from every `required` array that are not declared in the
 * sibling `properties` object. Only schema-bearing keywords are walked so
 * example/default payloads embedded in descriptions stay untouched.
 */
function repairToolSchema(node) {
  if (Array.isArray(node)) {
    for (const item of node) repairToolSchema(item);
    return;
  }
  if (!node || typeof node !== 'object') return;

  const props = node.properties && typeof node.properties === 'object' ? node.properties : null;
  if (props) {
    for (const sub of Object.values(props)) repairToolSchema(sub);
  }

  if ('required' in node && node.required == null) {
    delete node.required;
  } else if (Array.isArray(node.required)) {
    const kept = node.required.filter((entry) => props && Object.hasOwn(props, asString(entry)));
    if (kept.length === 0) delete node.required;
    else node.required = kept;
  } else if (node.required !== undefined) {
    delete node.required;
  }

  for (const key of ['items', 'prefixItems', 'anyOf', 'oneOf', 'allOf']) {
    if (node[key] !== undefined) repairToolSchema(node[key]);
  }
  if (node.additionalProperties !== undefined) repairToolSchema(node.additionalProperties);
  for (const key of ['$defs', 'definitions']) {
    const defs = node[key];
    if (defs && typeof defs === 'object') {
      for (const sub of Object.values(defs)) repairToolSchema(sub);
    }
  }
}

/** Normalize a single tool entry into the flat Responses function shape. */
function normalizeOneTool(tool) {
  const type = asString(tool.type).trim().toLowerCase();

  // Nested OpenAI shape: { type: "function", function: { name, parameters } }
  if (tool.function && typeof tool.function === 'object') {
    const fn = tool.function;
    const name = asString(fn.name) || asString(tool.name);
    if (name === '') return null;
    const out = {
      type: 'function',
      name,
      description: firstNonEmpty(asString(fn.description), asString(tool.description)),
    };
    if (fn.parameters != null) out.parameters = fn.parameters;
    else if (fn.input_schema != null) out.parameters = fn.input_schema;
    else if (tool.parameters != null) out.parameters = tool.parameters;
    else out.parameters = { type: 'object', properties: {} };
    return out;
  }

  // Anthropic shape: no type (or type "tool") + name/input_schema.
  if (type === '' || type === 'tool') {
    const name = asString(tool.name);
    if (name === '') return null;
    const out = {
      type: 'function',
      name,
      description: asString(tool.description),
    };
    if (tool.input_schema != null) out.parameters = tool.input_schema;
    else if (tool.parameters != null) out.parameters = tool.parameters;
    else out.parameters = { type: 'object', properties: {} };
    return out;
  }

  if (!ALLOWED_TOOL_TYPES.has(type)) {
    // Drop unknown variants (namespace, custom, provider-defined, ...).
    return null;
  }

  // Built-in server tools: keep the type plus known optional filters.
  if (type !== 'function') {
    const out = { type };
    for (const key of SAFE_SERVER_TOOL_KEYS) {
      if (tool[key] !== undefined) out[key] = tool[key];
    }
    return out;
  }

  // Flat function tool.
  const name = asString(tool.name);
  if (name === '') return null;
  const out = { type: 'function', name, description: asString(tool.description) };
  if (tool.parameters != null) out.parameters = tool.parameters;
  else if (tool.input_schema != null) out.parameters = tool.input_schema;
  else out.parameters = { type: 'object', properties: {} };
  return out;
}

/** Sanitize a Responses-shaped tool list (flat function tools). */
function sanitizeResponsesTools(raw) {
  const list = flattenToolList(raw);
  const out = [];
  const seenFunctions = new Set();
  let hasWeb = false;
  let hasXSearch = false;

  const push = (entry) => {
    const norm = normalizeOneTool(entry);
    if (!norm) return;

    if (asString(norm.type) === 'function') {
      const name = asString(norm.name);
      if (name === '' || seenFunctions.has(name)) return;
      seenFunctions.add(name);
      repairToolSchema(norm.parameters);
    } else if (norm.type === 'web_search') {
      if (hasWeb) return;
      hasWeb = true;
    } else if (norm.type === 'x_search') {
      if (hasXSearch) return;
      hasXSearch = true;
    }
    out.push(norm);
  };

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const type = asString(item.type).trim().toLowerCase();

    // Unwrap nested groups OpenCode sometimes sends as type=namespace/provider.
    if (type === 'namespace' || type === 'provider' || type === 'group') {
      if (Array.isArray(item.tools)) {
        for (const nested of sanitizeResponsesTools(item.tools)) push(nested);
      }
      continue;
    }
    push(item);
  }

  return out;
}

/** Keep only function tools in the OpenAI nested chat shape. */
function sanitizeChatTools(raw) {
  const list = flattenToolList(raw);
  const out = [];
  const seen = new Set();

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const type = asString(item.type).toLowerCase();

    if (type === 'namespace' || type === 'provider' || type === 'group') {
      if (Array.isArray(item.tools)) out.push(...sanitizeChatTools(item.tools));
      continue;
    }

    let name = '';
    let description = '';
    let parameters = null;
    if (item.function && typeof item.function === 'object') {
      name = asString(item.function.name);
      description = asString(item.function.description);
      parameters = item.function.parameters ?? item.function.input_schema ?? null;
    } else if (type === 'function' || type === '' || type === 'tool') {
      name = asString(item.name);
      description = asString(item.description);
      parameters = item.parameters ?? item.input_schema ?? null;
    } else {
      // Server-side tool types are not valid on chat/completions.
      continue;
    }

    if (name === '' || seen.has(name)) continue;
    seen.add(name);

    const schema = parameters && typeof parameters === 'object'
      ? parameters
      : { type: 'object', properties: {} };
    repairToolSchema(schema);

    out.push({
      type: 'function',
      function: { name, description, parameters: schema },
    });
  }

  return out;
}

/** True when a sanitized Responses tool list contains a function tool. */
function hasFunctionTool(tools) {
  return Array.isArray(tools) && tools.some((t) => asString(t && t.type).toLowerCase() === 'function');
}

/**
 * Normalize a single OpenAI-style tool_call so downstream clients always get a
 * valid shape: non-empty id, type `function`, non-empty name and an
 * `arguments` value that is a valid JSON string.
 *
 * Returns null when the call has no usable function name.
 */
function sanitizeToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return null;

  const out = cloneMap(toolCall);
  if (asString(out.id) === '') out.id = newCallId();
  if (asString(out.type).toLowerCase() !== 'function') out.type = 'function';

  const fn = out.function && typeof out.function === 'object' ? { ...out.function } : {};
  out.function = fn;

  const name = asString(fn.name).trim();
  if (name === '') return null;
  fn.name = name;

  const args = fn.arguments;
  if (typeof args === 'string') {
    if (args === '') {
      fn.arguments = '{}';
    } else {
      try {
        JSON.parse(args);
        fn.arguments = args;
      } catch {
        fn.arguments = '{}';
      }
    }
  } else if (args == null) {
    fn.arguments = '{}';
  } else if (typeof args === 'object') {
    try {
      fn.arguments = JSON.stringify(args);
    } catch {
      fn.arguments = '{}';
    }
  } else {
    fn.arguments = JSON.stringify(args);
  }

  return out;
}

/** Apply sanitizeToolCall to a list, dropping invalid entries. */
function sanitizeToolCallsList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const sanitized = sanitizeToolCall(item);
    if (sanitized && asString(sanitized.id) !== '') out.push(sanitized);
  }
  return out;
}

/** Extract the tool names present in either chat or Responses shape. */
function toolNames(raw, chat = true) {
  const names = [];
  for (const item of flattenToolList(raw)) {
    if (!item || typeof item !== 'object') continue;
    const name = chat ? asString(item.function && item.function.name) : asString(item.name);
    if (name !== '') names.push(name);
  }
  return names;
}

module.exports = {
  ALLOWED_TOOL_TYPES,
  asString,
  firstNonEmpty,
  newCallId,
  cloneMap,
  flattenToolList,
  repairToolSchema,
  normalizeOneTool,
  sanitizeResponsesTools,
  sanitizeChatTools,
  hasFunctionTool,
  sanitizeToolCall,
  sanitizeToolCallsList,
  toolNames,
};
