'use strict';

/**
 * SSE helpers for the Zen free-tier gate.
 *
 * The gate forces `stream: true` on every upstream request, even when the
 * downstream client asked for a plain JSON response. These helpers fold the
 * always-streaming upstream back into the shape the client expects:
 *
 *   - `completedChatCompletionFromSse` — port of the Go proxy's
 *     `completedChatCompletionFromSSE` (internal/proxyhttp/zen_gate.go).
 *   - `completedResponseFromSse` — port of `completedResponseFromSSE`
 *     (internal/proxyhttp/codex_sse.go), used for Responses-based models.
 *
 * Content, reasoning and tool_call argument deltas are concatenated per
 * choice/tool index; usage is taken from the final chunk that carries it.
 */

/** Matches the Go proxy's io.LimitReader(r, 64<<20) guard. */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;

/**
 * Yield the `data:` payloads of an SSE stream, ignoring comments, event names
 * and the terminal `[DONE]` sentinel.
 *
 * @param {AsyncIterable<Buffer|string>} source
 * @returns {AsyncGenerator<string>}
 */
async function* sseDataPayloads(source) {
  let buffer = '';
  let seen = 0;

  for await (const chunk of source) {
    seen += chunk.length;
    if (seen > MAX_STREAM_BYTES) break;

    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);

      if (!line.startsWith('data:')) continue;
      const payload = line.slice('data:'.length).trim();
      if (payload === '' || payload === '[DONE]') continue;
      yield payload;
    }
  }

  // Trailing line without a newline terminator.
  const tail = buffer.trim();
  if (tail.startsWith('data:')) {
    const payload = tail.slice('data:'.length).trim();
    if (payload !== '' && payload !== '[DONE]') yield payload;
  }
}

/**
 * Aggregate an OpenAI chat/completions SSE stream into a single
 * `chat.completion` JSON object.
 *
 * @param {AsyncIterable<Buffer|string>} source
 * @param {string} [model] model id to report (falls back to the stream value)
 * @returns {Promise<object>}
 */
async function completedChatCompletionFromSse(source, model) {
  const choices = new Map();
  const choiceOrder = [];
  let id = '';
  let created = 0;
  let streamModel = model || '';
  let usage = null;

  const choiceFor = (index) => {
    let entry = choices.get(index);
    if (!entry) {
      entry = {
        role: 'assistant',
        content: '',
        reasoning: '',
        finish: '',
        toolCalls: new Map(),
        toolOrder: [],
      };
      choices.set(index, entry);
      choiceOrder.push(index);
    }
    return entry;
  };

  for await (const payload of sseDataPayloads(source)) {
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!chunk || typeof chunk !== 'object') continue;

    if (typeof chunk.id === 'string' && chunk.id !== '') id = chunk.id;
    if (typeof chunk.created === 'number' && chunk.created !== 0) created = chunk.created;
    if (typeof chunk.model === 'string' && chunk.model !== '' && !model) streamModel = chunk.model;
    if (chunk.usage && typeof chunk.usage === 'object' && Object.keys(chunk.usage).length > 0) {
      usage = chunk.usage;
    }

    const rawChoices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const rawChoice of rawChoices) {
      if (!rawChoice || typeof rawChoice !== 'object') continue;
      const index = typeof rawChoice.index === 'number' ? rawChoice.index : 0;
      const acc = choiceFor(index);

      if (typeof rawChoice.finish_reason === 'string' && rawChoice.finish_reason !== '') {
        acc.finish = rawChoice.finish_reason;
      }

      // A bare JSON fallback (non-chunk) carries `message` instead of `delta`.
      const delta = rawChoice.delta && typeof rawChoice.delta === 'object'
        ? rawChoice.delta
        : rawChoice.message && typeof rawChoice.message === 'object'
          ? rawChoice.message
          : null;
      if (!delta) continue;

      if (typeof delta.role === 'string' && delta.role !== '') acc.role = delta.role;
      if (typeof delta.content === 'string' && delta.content !== '') acc.content += delta.content;
      for (const key of ['reasoning_content', 'reasoning']) {
        if (typeof delta[key] === 'string' && delta[key] !== '') acc.reasoning += delta[key];
      }

      const rawToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const rawCall of rawToolCalls) {
        if (!rawCall || typeof rawCall !== 'object') continue;
        const toolIndex = typeof rawCall.index === 'number' ? rawCall.index : 0;
        let call = acc.toolCalls.get(toolIndex);
        if (!call) {
          call = { id: '', type: 'function', name: '', arguments: '' };
          acc.toolCalls.set(toolIndex, call);
          acc.toolOrder.push(toolIndex);
        }
        if (typeof rawCall.id === 'string' && rawCall.id !== '') call.id = rawCall.id;
        if (typeof rawCall.type === 'string' && rawCall.type !== '') call.type = rawCall.type;
        if (rawCall.function && typeof rawCall.function === 'object') {
          if (typeof rawCall.function.name === 'string' && rawCall.function.name !== '') {
            call.name += rawCall.function.name;
          }
          if (typeof rawCall.function.arguments === 'string' && rawCall.function.arguments !== '') {
            call.arguments += rawCall.function.arguments;
          }
        }
      }
    }
  }

  if (choiceOrder.length === 0) {
    throw new Error('zen chat stream ended without choices');
  }

  const sortedIndexes = [...choiceOrder].sort((a, b) => a - b);
  const outChoices = sortedIndexes.map((index) => {
    const acc = choices.get(index);
    const message = { role: acc.role || 'assistant', content: acc.content };
    if (acc.reasoning !== '') message.reasoning_content = acc.reasoning;

    if (acc.toolOrder.length > 0) {
      const calls = [...acc.toolOrder].sort((a, b) => a - b).map((toolIndex) => {
        const call = acc.toolCalls.get(toolIndex);
        return {
          id: call.id,
          type: call.type || 'function',
          function: { name: call.name, arguments: call.arguments },
        };
      });
      message.tool_calls = calls;
    }

    return {
      index,
      message,
      finish_reason: acc.finish === '' ? 'stop' : acc.finish,
    };
  });

  const out = {
    id: id === '' ? 'chatcmpl-zen' : id,
    object: 'chat.completion',
    created: Math.trunc(created),
    model: streamModel,
    choices: outChoices,
  };
  if (usage) out.usage = usage;
  return out;
}

/**
 * Aggregate a Responses API SSE stream into a single `response` object.
 *
 * `response.incomplete` (e.g. max_output_tokens hit mid-reasoning) still
 * carries the full response object — a partial answer beats a 502.
 *
 * @param {AsyncIterable<Buffer|string>} source
 * @returns {Promise<object>}
 */
async function completedResponseFromSse(source) {
  for await (const payload of sseDataPayloads(source)) {
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;

    switch (event.type) {
      case 'response.completed':
      case 'response.done':
      case 'response.incomplete':
        if (event.response && event.response !== null) return event.response;
        break;
      case 'response.failed':
      case 'error': {
        const detail = event.error ? JSON.stringify(event.error) : '';
        throw new Error(
          detail ? `zen responses stream failed: ${detail}` : 'zen responses stream failed',
        );
      }
      default:
        break;
    }
  }
  throw new Error('zen responses stream ended without response.completed');
}

/** True when an upstream response is an SSE stream. */
function isSseContentType(headers) {
  const value = headers && (headers['content-type'] || headers['Content-Type']);
  return typeof value === 'string' && value.toLowerCase().includes('text/event-stream');
}

/**
 * Write one SSE event (optional `event:` name + `data:` payload).
 */
function writeSseEvent(res, eventName, payload) {
  if (eventName) res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** Terminate an SSE stream. */
function writeSseDone(res) {
  res.write('data: [DONE]\n\n');
}

module.exports = {
  MAX_STREAM_BYTES,
  sseDataPayloads,
  completedChatCompletionFromSse,
  completedResponseFromSse,
  isSseContentType,
  writeSseEvent,
  writeSseDone,
};
