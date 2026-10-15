'use strict';

const crypto = require('crypto');
const { sanitizeChatTools, sanitizeResponsesTools, sanitizeToolCall, sanitizeToolCallsList, asString } = require('./tools');
const { sseDataPayloads, writeSseEvent, writeSseDone } = require('./sse');

/**
 * Wire-format converters between the OpenAI Chat Completions API and the
 * OpenAI Responses API.
 *
 * Port of the Go proxy's translators (internal/proxyhttp). Needed because Zen's
 * free tier is split across both endpoints:
 *
 *   - chat models  → /chat/completions
 *   - Muse models  → /responses
 *
 * A client may speak either dialect, so the proxy keeps the client's dialect on
 * the outside and translates to whatever the model actually needs.
 */

function newId(prefix) {
  return `${prefix}${crypto.randomUUID().replace(/-/g, '')}`;
}

function randomCallId() {
  return `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function toInt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** Adapt chat-style usage into Responses-style usage numbers. */
function normalizeUsageToResponses(usage) {
  if (!usage || typeof usage !== 'object') return {};
  const out = {};
  if (usage.prompt_tokens !== undefined) out.input_tokens = usage.prompt_tokens;
  else if (usage.input_tokens !== undefined) out.input_tokens = usage.input_tokens;

  if (usage.completion_tokens !== undefined) out.output_tokens = usage.completion_tokens;
  else if (usage.output_tokens !== undefined) out.output_tokens = usage.output_tokens;

  if (usage.reasoning_tokens !== undefined) {
    out.output_tokens = toInt(out.output_tokens) + toInt(usage.reasoning_tokens);
  }
  if (usage.total_tokens !== undefined) out.total_tokens = usage.total_tokens;
  else out.total_tokens = toInt(out.input_tokens) + toInt(out.output_tokens);
  return out;
}

/** Adapt Responses-style usage into chat-style usage numbers. */
function normalizeUsageToChat(usage) {
  if (!usage || typeof usage !== 'object') return {};
  const out = {};
  if (usage.prompt_tokens !== undefined) out.prompt_tokens = usage.prompt_tokens;
  else if (usage.input_tokens !== undefined) out.prompt_tokens = usage.input_tokens;

  if (usage.completion_tokens !== undefined) out.completion_tokens = usage.completion_tokens;
  else if (usage.output_tokens !== undefined) out.completion_tokens = usage.output_tokens;

  if (usage.total_tokens !== undefined) out.total_tokens = usage.total_tokens;
  else out.total_tokens = toInt(out.prompt_tokens) + toInt(out.completion_tokens);
  return out;
}

// ---------------------------------------------------------------------------
// Responses extraction helpers
// ---------------------------------------------------------------------------

const TEXT_PART_TYPES = new Set([
  'input_text',
  'output_text',
  'text',
  'summary_text',
  'reasoning_text',
]);

/** Flatten a Responses content value (string or typed parts) into plain text. */
function flattenResponsesContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (typeof part === 'string') {
      out += part;
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if (!TEXT_PART_TYPES.has(asString(part.type))) continue;
    if (typeof part.text === 'string') out += part.text;
  }
  return out;
}

/** Pull assistant text out of a Responses object. */
function extractResponsesOutputText(response) {
  if (!response || typeof response !== 'object') return '';
  if (typeof response.output_text === 'string' && response.output_text !== '') {
    return response.output_text;
  }
  let out = '';
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const type = asString(item.type);
    if (type === 'message' || type === '') {
      out += flattenResponsesContent(item.content);
      if (typeof item.text === 'string') out += item.text;
    }
  }
  return out;
}

/** Convert a Responses function_call item into an OpenAI chat tool_call. */
function responsesItemToChatToolCall(item) {
  if (!item || typeof item !== 'object') return null;
  const type = asString(item.type).trim().toLowerCase();
  if (type !== 'function_call' && type !== 'custom_tool_call') return null;

  const name = asString(item.name);
  if (name === '') return null;

  let callId = asString(item.call_id) || asString(item.id) || randomCallId();

  let args = '';
  if (typeof item.arguments === 'string') args = item.arguments;
  else if (item.arguments != null) args = JSON.stringify(item.arguments);
  else if (typeof item.input === 'string') args = item.input;
  else if (item.input != null) args = JSON.stringify(item.input);
  if (args === '') args = '{}';

  return sanitizeToolCall({
    id: callId,
    type: 'function',
    function: { name, arguments: args },
  });
}

/** Client function_call items from a Responses output array. */
function extractResponsesFunctionCalls(response) {
  const output = response && Array.isArray(response.output) ? response.output : [];
  const calls = [];
  for (const item of output) {
    const call = responsesItemToChatToolCall(item);
    if (call) calls.push(call);
  }
  return calls;
}

/** Reasoning items carrying encrypted content (Codex continuation handles). */
function responsesReasoningItems(response) {
  const output = response && Array.isArray(response.output) ? response.output : [];
  const items = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    if (asString(item.type) !== 'reasoning') continue;
    if (asString(item.encrypted_content) === '') continue;
    items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Chat completion ↔ Response object
// ---------------------------------------------------------------------------

/**
 * Map a chat.completion JSON body to a Responses-like object.
 */
function chatCompletionToResponse(chat, model) {
  const input = chat && typeof chat === 'object' ? chat : {};
  const text = (() => {
    const choice = Array.isArray(input.choices) ? input.choices[0] : null;
    const message = choice && choice.message && typeof choice.message === 'object' ? choice.message : null;
    return message && typeof message.content === 'string' ? message.content : '';
  })();
  const toolCalls = (() => {
    const choice = Array.isArray(input.choices) ? input.choices[0] : null;
    const message = choice && choice.message && typeof choice.message === 'object' ? choice.message : null;
    return message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  })();

  const resolvedModel = model || asString(input.model);
  const output = [];

  if (text !== '' || toolCalls.length === 0) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    });
  }

  for (const rawCall of toolCalls) {
    const call = sanitizeToolCall(rawCall);
    if (!call) continue;
    const fn = call.function || {};
    output.push({
      type: 'function_call',
      call_id: call.id,
      name: fn.name,
      arguments: fn.arguments || '{}',
      status: 'completed',
    });
  }

  const out = {
    id: input.id,
    object: 'response',
    model: resolvedModel,
    status: 'completed',
    output,
  };
  if (input.usage) out.usage = normalizeUsageToResponses(input.usage);
  return out;
}

/**
 * Map a Responses object to an OpenAI chat.completion body.
 */
function responsesToChatCompletion(response, model) {
  const input = response && typeof response !== 'object' ? {} : response || {};
  const resolvedModel = model || asString(input.model);
  const id = asString(input.id) || newId('chatcmpl-');
  const text = extractResponsesOutputText(input);
  const toolCalls = extractResponsesFunctionCalls(input);
  const created = typeof input.created_at === 'number'
    ? toInt(input.created_at)
    : Math.floor(Date.now() / 1000);

  const message = { role: 'assistant' };
  const reasoningItems = responsesReasoningItems(input);
  if (reasoningItems.length > 0) message.reasoning_items = reasoningItems;

  let finish = 'stop';
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
    // OpenAI: content is null on a tool-only turn; keep text when present.
    message.content = text === '' ? null : text;
    finish = 'tool_calls';
  } else {
    message.content = text;
  }

  // Responses "incomplete" (e.g. max_output_tokens) maps to OpenAI "length".
  if (asString(input.status) === 'incomplete' && finish === 'stop') finish = 'length';

  const out = {
    id,
    object: 'chat.completion',
    created,
    model: resolvedModel,
    choices: [{ index: 0, message, finish_reason: finish }],
  };
  if (input.usage) out.usage = normalizeUsageToChat(input.usage);
  return out;
}

// ---------------------------------------------------------------------------
// Request bodies: chat → responses and back
// ---------------------------------------------------------------------------

/**
 * Convert an OpenAI chat/completions body into a Responses body.
 * `read` gate tool is added later by applyZenGate.
 */
function chatBodyToResponsesBody(body) {
  const input = body && typeof body === 'object' ? body : {};
  const out = {};

  if (typeof input.model === 'string' && input.model !== '') out.model = input.model;
  if (typeof input.stream === 'boolean') out.stream = input.stream;
  if (input.temperature !== undefined) out.temperature = input.temperature;
  if (input.top_p !== undefined) out.top_p = input.top_p;
  if (input.max_tokens !== undefined) out.max_output_tokens = input.max_tokens;
  else if (input.max_completion_tokens !== undefined) out.max_output_tokens = input.max_completion_tokens;

  // Client-provided effort only — never invent a default.
  if (typeof input.reasoning_effort === 'string' && input.reasoning_effort.trim() !== '') {
    out.reasoning = { effort: input.reasoning_effort, summary: 'auto' };
  } else if (input.reasoning && typeof input.reasoning === 'object') {
    out.reasoning = input.reasoning;
  }

  if (input.tools !== undefined) {
    const tools = sanitizeResponsesTools(input.tools);
    if (tools.length > 0) {
      out.tools = tools;
      out.tool_choice = input.tool_choice !== undefined ? input.tool_choice : 'auto';
    }
  }

  const messages = Array.isArray(input.messages) ? input.messages : [];
  const items = [];
  const instructions = [];

  for (const rawMessage of messages) {
    if (!rawMessage || typeof rawMessage !== 'object') continue;
    const role = asString(rawMessage.role).trim().toLowerCase();
    const content = flattenResponsesContent(rawMessage.content);

    if (role === 'system' || role === 'developer') {
      if (content !== '') instructions.push(content);
      continue;
    }

    const effectiveRole = role === '' ? 'user' : role;

    if (effectiveRole === 'tool') {
      const item = { type: 'function_call_output', output: content };
      const callId = asString(rawMessage.tool_call_id);
      if (callId !== '') item.call_id = callId;
      items.push(item);
      continue;
    }

    if (effectiveRole === 'assistant') {
      const reasoningItems = Array.isArray(rawMessage.reasoning_items) ? rawMessage.reasoning_items : [];
      for (const reasoning of reasoningItems) {
        if (!reasoning || typeof reasoning !== 'object') continue;
        if (asString(reasoning.type) !== 'reasoning') continue;
        if (asString(reasoning.encrypted_content) === '') continue;
        items.push(reasoning);
      }
    }

    const toolCalls = Array.isArray(rawMessage.tool_calls) ? rawMessage.tool_calls : [];
    if (toolCalls.length > 0) {
      for (const rawCall of toolCalls) {
        const call = sanitizeToolCall(rawCall);
        if (!call) continue;
        const fn = call.function || {};
        const item = {
          type: 'function_call',
          name: asString(fn.name),
          arguments: asString(fn.arguments),
        };
        if (asString(call.id) !== '') item.call_id = call.id;
        items.push(item);
      }
      if (content !== '') {
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: content }],
        });
      }
      continue;
    }

    items.push({
      type: 'message',
      role: effectiveRole === 'assistant' ? 'assistant' : effectiveRole,
      content: [
        {
          type: effectiveRole === 'assistant' ? 'output_text' : 'input_text',
          text: content,
        },
      ],
    });
  }

  if (instructions.length > 0) out.instructions = instructions.join('\n\n');
  if (items.length === 0) out.input = typeof input.input === 'string' && input.input !== '' ? input.input : 'Hello';
  else out.input = items;

  return out;
}

/** Convert a Responses `input` value into chat messages. */
function responsesInputToChatMessages(input) {
  if (typeof input === 'string') {
    if (input.trim() === '') return [];
    return [{ role: 'user', content: input }];
  }
  if (!Array.isArray(input)) {
    if (input && typeof input === 'object') return responsesInputToChatMessages([input]);
    return [];
  }

  const out = [];
  for (const rawItem of input) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const role = asString(rawItem.role);

    // Already a chat message shape (possibly with tool_calls).
    if (role !== '') {
      const normalizedRole = role.toLowerCase();
      const message = { role: normalizedRole };
      let content = flattenResponsesContent(rawItem.content);
      if (content === '' && typeof rawItem.content === 'string') content = rawItem.content;

      if (rawItem.tool_calls !== undefined) {
        message.tool_calls = Array.isArray(rawItem.tool_calls)
          ? sanitizeToolCallsList(rawItem.tool_calls)
          : rawItem.tool_calls;
        message.content = content !== '' ? content : null;
        out.push(message);
        continue;
      }

      if (normalizedRole === 'tool') {
        const callId = asString(rawItem.tool_call_id);
        if (callId !== '') message.tool_call_id = callId;
        message.content = content;
        out.push(message);
        continue;
      }

      if (content === '') continue;
      if (normalizedRole !== 'system' && normalizedRole !== 'developer' && normalizedRole !== 'assistant') {
        message.role = 'user';
      }
      message.content = content;
      out.push(message);
      continue;
    }

    // Responses typed items.
    const type = asString(rawItem.type);
    switch (type) {
      case 'message':
      case '': {
        let messageRole = asString(rawItem.role) || 'user';
        const content = flattenResponsesContent(rawItem.content);
        if (content === '') continue;
        out.push({ role: messageRole, content });
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const callId = asString(rawItem.call_id) || asString(rawItem.id) || randomCallId();
        const args = typeof rawItem.arguments === 'string'
          ? rawItem.arguments
          : rawItem.arguments != null
            ? JSON.stringify(rawItem.arguments)
            : '';
        out.push({
          role: 'assistant',
          content: null,
          tool_calls: sanitizeToolCallsList([
            { id: callId, type: 'function', function: { name: asString(rawItem.name), arguments: args } },
          ]),
        });
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = asString(rawItem.call_id) || asString(rawItem.id);
        let outputText = typeof rawItem.output === 'string'
          ? rawItem.output
          : rawItem.output != null
            ? JSON.stringify(rawItem.output)
            : '';
        if (outputText === '') outputText = flattenResponsesContent(rawItem.content);
        const message = { role: 'tool', content: outputText };
        if (callId !== '') message.tool_call_id = callId;
        out.push(message);
        break;
      }
      case 'reasoning':
        // Encrypted/internal reasoning history is not valid on chat backends.
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Convert an OpenAI Responses body into a chat/completions body.
 */
function responsesBodyToChatBody(body) {
  const input = body && typeof body === 'object' ? body : {};
  const out = {};

  if (typeof input.model === 'string' && input.model !== '') out.model = input.model;
  if (typeof input.stream === 'boolean') out.stream = input.stream;
  if (input.temperature !== undefined) out.temperature = input.temperature;
  if (input.top_p !== undefined) out.top_p = input.top_p;
  if (input.max_output_tokens !== undefined) out.max_tokens = input.max_output_tokens;
  else if (input.max_tokens !== undefined) out.max_tokens = input.max_tokens;

  if (typeof input.reasoning_effort === 'string' && input.reasoning_effort.trim() !== '') {
    out.reasoning_effort = input.reasoning_effort;
  } else if (input.reasoning && typeof input.reasoning === 'object') {
    const effort = asString(input.reasoning.effort);
    if (effort.trim() !== '') out.reasoning_effort = effort;
  }

  if (input.tools !== undefined) {
    const tools = sanitizeChatTools(input.tools);
    if (tools.length > 0) {
      out.tools = tools;
      if (input.tool_choice !== undefined) out.tool_choice = input.tool_choice;
    }
  }

  let messages = responsesInputToChatMessages(input.input);

  const instructions = asString(input.instructions).trim();
  if (instructions !== '') {
    let content = instructions;
    // When tools are available, nudge the model to actually use them instead
    // of reasoning indefinitely — the classic agent-stall on coding clients.
    if (out.tools) {
      content += '\n\nIMPORTANT: You have tools available. Use them directly to accomplish tasks. '
        + 'Keep your reasoning concise and act promptly. Do not reason at length without taking action. '
        + 'If you know which tool to call, call it immediately rather than planning extensively.';
    }
    messages = [{ role: 'system', content }, ...messages];
  }

  if (messages.length === 0) messages = [{ role: 'user', content: 'Hello' }];
  out.messages = messages;
  return out;
}

/** Extract a human-readable message from an SSE error payload. */
function sseErrorPayloadMessage(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const error = payload.error;
  if (typeof error === 'string' && error !== '') return error;
  if (error && typeof error === 'object') {
    const message = asString(error.message) || asString(error.detail) || asString(error.type);
    if (message !== '') return message;
  }
  if (asString(payload.type) === 'error') {
    return asString(payload.message) || 'upstream error';
  }
  return '';
}

/** Detect a quota/limit error delivered inside an SSE payload. */
function isQuotaPayload(payload) {
  const message = sseErrorPayloadMessage(payload);
  if (message === '') return { quota: false, message: '' };
  const quota = /quota|rate.?limit|too many requests|insufficient|exceeded|limit reached|余额|quota_exhausted/i.test(message);
  return { quota, message };
}

module.exports = {
  newId,
  randomCallId,
  normalizeUsageToResponses,
  normalizeUsageToChat,
  flattenResponsesContent,
  extractResponsesOutputText,
  extractResponsesFunctionCalls,
  responsesItemToChatToolCall,
  responsesReasoningItems,
  chatCompletionToResponse,
  responsesToChatCompletion,
  chatBodyToResponsesBody,
  responsesBodyToChatBody,
  responsesInputToChatMessages,
  sseErrorPayloadMessage,
  isQuotaPayload,
  responsesSseToChatStream,
  chatSseToResponsesStream,
};

// ---------------------------------------------------------------------------
// Streaming translators
//
// Declared as function declarations (hoisted) so the export list above can
// reference them while the module graph stays flat.
// ---------------------------------------------------------------------------

/**
 * Translate a Responses SSE stream into OpenAI chat.completion.chunk SSE.
 *
 * This is how a Muse Spark model answers a chat client: the upstream stayed on
 * /responses (its only endpoint), and this bridges the dialects so agents such
 * as Kilo/OpenCode receive native tool_calls.
 */
async function responsesSseToChatStream(source, res, model) {
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  }

  const id = newId('chatcmpl-');
  const created = Math.floor(Date.now() / 1000);

  const writeDelta = (delta, finish) => {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish === undefined ? null : finish }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  writeDelta({ role: 'assistant' }, null);

  const toolIndexByKey = new Map();
  const argDeltaSeen = new Set();
  const seenReasoning = new Set();
  let nextToolIdx = 0;
  let sawToolCall = false;

  const resolveToolIdx = (...keys) => {
    for (const key of keys) {
      if (key === '') continue;
      if (toolIndexByKey.has(key)) return { index: toolIndexByKey.get(key), found: true };
    }
    return { index: -1, found: false };
  };
  const markToolKeys = (index, ...keys) => {
    for (const key of keys) if (key !== '') toolIndexByKey.set(key, index);
  };
  const anyArgSeen = (...keys) => keys.some((key) => key !== '' && argDeltaSeen.has(key));

  const emitReasoning = (item) => {
    if (asString(item.type) !== 'reasoning' || asString(item.encrypted_content) === '') return;
    const key = asString(item.id) || asString(item.encrypted_content);
    if (seenReasoning.has(key)) return;
    seenReasoning.add(key);
    writeDelta({ reasoning_items: [item] }, null);
  };

  const emitToolCallStart = (item, allowFullArgs) => {
    const call = responsesItemToChatToolCall(item);
    if (!call) return;
    const callId = asString(call.id);
    const itemId = asString(item.id);
    const fn = call.function || {};
    const name = asString(fn.name);
    const fullArgs = asString(fn.arguments);
    const args = allowFullArgs ? fullArgs : '';

    const existing = resolveToolIdx(itemId, callId);
    if (existing.found) {
      if (allowFullArgs && args !== '' && !anyArgSeen(itemId, callId)) {
        writeDelta({ tool_calls: [{ index: existing.index, function: { arguments: args } }] }, null);
        argDeltaSeen.add(itemId || callId);
      }
      return;
    }

    const index = nextToolIdx;
    nextToolIdx += 1;
    markToolKeys(index, itemId, callId);
    sawToolCall = true;
    writeDelta({
      tool_calls: [{
        index,
        id: callId,
        type: 'function',
        function: { name, arguments: args },
      }],
    }, null);
    if (args !== '') argDeltaSeen.add(itemId || callId);
  };

  const emitToolArgsDelta = (itemId, callId, delta) => {
    if (delta === '') return;
    const key = itemId || callId;
    const existing = resolveToolIdx(itemId, callId);
    if (existing.found) {
      sawToolCall = true;
      writeDelta({ tool_calls: [{ index: existing.index, function: { arguments: delta } }] }, null);
    } else {
      const index = nextToolIdx;
      nextToolIdx += 1;
      markToolKeys(index, itemId, callId);
      sawToolCall = true;
      writeDelta({
        tool_calls: [{
          index,
          id: callId,
          type: 'function',
          function: { name: '', arguments: delta },
        }],
      }, null);
    }
    if (key !== '') argDeltaSeen.add(key);
  };

  const finishStream = (usage, forceReason) => {
    let finish = 'stop';
    if (sawToolCall) finish = 'tool_calls';
    else if (forceReason !== '') finish = forceReason;

    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
    };
    if (usage) chunk.usage = normalizeUsageToChat(usage);
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    writeSseDone(res);
    res.end();
  };

  for await (const payload of sseDataPayloads(source)) {
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;

    const typ = asString(event.type);
    switch (typ) {
      case 'response.output_text.delta':
        if (typeof event.delta === 'string' && event.delta !== '') {
          writeDelta({ content: event.delta }, null);
        }
        break;
      case 'response.output_item.added':
        if (event.item && typeof event.item === 'object') emitToolCallStart(event.item, false);
        break;
      case 'response.output_item.done':
        if (event.item && typeof event.item === 'object') {
          emitReasoning(event.item);
          emitToolCallStart(event.item, true);
        }
        break;
      case 'response.function_call_arguments.delta': {
        let delta = asString(event.delta);
        if (delta === '') delta = asString(event.arguments);
        emitToolArgsDelta(asString(event.item_id), asString(event.call_id), delta);
        break;
      }
      case 'response.function_call_arguments.done': {
        const itemId = asString(event.item_id);
        const callId = asString(event.call_id);
        const args = asString(event.arguments);
        if (args === '' || anyArgSeen(itemId, callId)) break;
        emitToolArgsDelta(itemId, callId, args);
        break;
      }
      case 'response.completed':
      case 'response.done':
      case 'response.incomplete': {
        const forceReason = typ === 'response.incomplete' ? 'length' : '';
        const response = event.response && typeof event.response === 'object' ? event.response : null;
        if (!response) {
          finishStream(null, forceReason);
          return;
        }
        for (const item of responsesReasoningItems(response)) emitReasoning(item);
        for (const call of extractResponsesFunctionCalls(response)) {
          emitToolCallStart({
            type: 'function_call',
            call_id: asString(call.id),
            id: asString(call.id),
            name: asString(call.function && call.function.name),
            arguments: asString(call.function && call.function.arguments),
          }, true);
        }
        finishStream(response.usage || null, forceReason);
        return;
      }
      case 'response.failed':
      case 'error': {
        const message = sseErrorPayloadMessage(event) || 'zen responses stream failed';
        const chunk = { error: { message, type: 'upstream_error', code: 'stream_failed' } };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        writeSseDone(res);
        res.end();
        return;
      }
      default:
        break;
    }
  }

  finishStream(null, '');
}

/**
 * Translate an OpenAI chat.completion SSE stream into Responses SSE.
 *
 * This is the reverse bridge: a Responses client (Codex-style) asking for a
 * chat-only Zen free model.
 */
async function chatSseToResponsesStream(source, res, model) {
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  }

  const respId = newId('resp_');
  const created = Math.floor(Date.now() / 1000);
  const base = { id: respId, object: 'response', created_at: created, model };

  const writeEvent = (eventName, payload) => writeSseEvent(res, eventName, payload);
  const fail = (message, code) => {
    writeEvent('response.failed', {
      type: 'response.failed',
      response: { ...base, status: 'failed', error: { message, type: 'upstream_error', code } },
    });
    writeSseDone(res);
    res.end();
  };

  writeEvent('response.created', { type: 'response.created', response: { ...base, status: 'in_progress' } });

  const pendingTools = new Map();
  let lastUsage = null;
  let sawContent = false;
  let sawToolCall = false;
  let sawReasoning = false;

  for await (const payload of sseDataPayloads(source)) {
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!chunk || typeof chunk !== 'object') continue;

    const quota = isQuotaPayload(chunk);
    if (quota.quota) {
      fail(quota.message, 'quota_exhausted');
      return;
    }
    const errorMessage = sseErrorPayloadMessage(chunk);
    if (errorMessage !== '') {
      fail(errorMessage, 'upstream_error');
      return;
    }

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    if (choices.length === 0) {
      if (chunk.usage) lastUsage = chunk.usage;
      continue;
    }

    const choice = choices[0] && typeof choices[0] === 'object' ? choices[0] : {};
    const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : null;
    if (!delta) continue;

    // 1. Reasoning (DeepSeek-style chain-of-thought).
    const reasoningText = asString(delta.reasoning_content) || asString(delta.reasoning);
    if (reasoningText !== '') {
      sawReasoning = true;
      writeEvent('response.reasoning_text.delta', {
        type: 'response.reasoning_text.delta',
        delta: reasoningText,
      });
    }

    // 2. Assistant text.
    if (typeof delta.content === 'string' && delta.content !== '') {
      writeEvent('response.output_text.delta', {
        type: 'response.output_text.delta',
        delta: delta.content,
      });
      sawContent = true;
    }

    // 3. Tool calls.
    const rawCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const rawCall of rawCalls) {
      if (!rawCall || typeof rawCall !== 'object') continue;
      const index = typeof rawCall.index === 'number' ? rawCall.index : 0;

      let pending = pendingTools.get(index);
      if (!pending) {
        pending = { index, id: '', name: '', args: '', started: false };
        pendingTools.set(index, pending);
      }
      if (asString(rawCall.id) !== '') pending.id = rawCall.id;
      const fn = rawCall.function && typeof rawCall.function === 'object' ? rawCall.function : {};
      if (asString(fn.name) !== '') pending.name = fn.name;
      const argsDelta = asString(fn.arguments);
      if (argsDelta !== '') pending.args += argsDelta;

      if (!pending.started && pending.id !== '' && pending.name !== '') {
        writeEvent('response.output_item.added', {
          type: 'response.output_item.added',
          item: {
            type: 'function_call',
            call_id: pending.id,
            id: pending.id,
            name: pending.name,
            arguments: pending.args === '' ? '{}' : pending.args,
            status: 'in_progress',
          },
        });
        pending.started = true;
        sawToolCall = true;
      }

      if (pending.started && argsDelta !== '') {
        writeEvent('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: pending.id,
          call_id: pending.id,
          delta: argsDelta,
        });
      }
    }

    if (asString(choice.finish_reason) !== '' && chunk.usage) lastUsage = chunk.usage;
  }

  for (const pending of pendingTools.values()) {
    if (!pending.started) continue;
    writeEvent('response.output_item.done', {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: pending.id,
        id: pending.id,
        name: pending.name,
        arguments: pending.args === '' ? '{}' : pending.args,
        status: 'completed',
      },
    });
  }

  if (!sawContent && !sawToolCall) {
    const message = sawReasoning
      ? 'Upstream sent reasoning but no final assistant content.'
      : 'Upstream ended without assistant content, tool calls, or an error payload.';
    fail(message, 'empty_upstream_response');
    return;
  }

  const output = [];
  if (sawContent) {
    output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] });
  }
  if (sawToolCall) {
    for (const pending of pendingTools.values()) {
      if (!pending.started) continue;
      output.push({
        type: 'function_call',
        call_id: pending.id,
        name: pending.name,
        arguments: pending.args === '' ? '{}' : pending.args,
        status: 'completed',
      });
    }
  }

  const completed = {
    type: 'response.completed',
    response: { ...base, status: 'completed', output },
  };
  if (lastUsage) completed.response.usage = normalizeUsageToResponses(lastUsage);
  writeEvent('response.completed', completed);
  writeSseDone(res);
  res.end();
}
