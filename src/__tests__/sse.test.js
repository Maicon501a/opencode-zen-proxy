'use strict';

const {
  sseDataPayloads,
  completedChatCompletionFromSse,
  completedResponseFromSse,
  isSseContentType,
} = require('../services/sse');

/** Wrap an array of strings in an async iterable, as a Node stream would be. */
function streamOf(...chunks) {
  return (async function* generate() {
    for (const chunk of chunks) yield chunk;
  }());
}

function sse(...lines) {
  return `${lines.join('\n')}\n`;
}

describe('SSE helpers (free-tier gate folding)', () => {
  describe('sseDataPayloads()', () => {
    it('yields only data payloads and skips [DONE]', async () => {
      const payloads = [];
      for await (const payload of sseDataPayloads(streamOf(
        'event: message\n',
        'data: {"a":1}\n',
        '\n',
        'data: [DONE]\n'
      ))) {
        payloads.push(payload);
      }
      expect(payloads).toEqual(['{"a":1}']);
    });

    it('reassembles payloads split across chunks', async () => {
      const payloads = [];
      for await (const payload of sseDataPayloads(streamOf('data: {"hel', 'lo":1}\n'))) {
        payloads.push(payload);
      }
      expect(payloads).toEqual(['{"hello":1}']);
    });

    it('handles CRLF line endings', async () => {
      const payloads = [];
      for await (const payload of sseDataPayloads(streamOf('data: {"a":1}\r\n\r\n'))) {
        payloads.push(payload);
      }
      expect(payloads).toEqual(['{"a":1}']);
    });
  });

  describe('completedChatCompletionFromSse()', () => {
    it('folds content, reasoning and usage into one chat.completion', async () => {
      const source = streamOf(sse(
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"mimo","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"mimo","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"mimo","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"mimo","choices":[{"index":0,"delta":{"reasoning_content":"think"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"mimo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
        'data: [DONE]'
      ));

      const out = await completedChatCompletionFromSse(source, 'mimo');
      expect(out.object).toBe('chat.completion');
      expect(out.id).toBe('chatcmpl-1');
      expect(out.model).toBe('mimo');
      expect(out.choices[0].finish_reason).toBe('stop');
      expect(out.choices[0].message).toEqual({
        role: 'assistant',
        content: 'Hello',
        reasoning_content: 'think',
      });
      expect(out.usage.total_tokens).toBe(12);
    });

    it('concatenates streamed tool_call arguments', async () => {
      const source = streamOf(sse(
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"shell","arguments":"{\\"cmd\\":"}}]},"finish_reason":null}]}',
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":null}]}',
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]'
      ));

      const out = await completedChatCompletionFromSse(source, 'm');
      const call = out.choices[0].message.tool_calls[0];
      expect(call.id).toBe('call_1');
      expect(call.function.name).toBe('shell');
      expect(call.function.arguments).toBe('{"cmd":"ls"}');
      expect(out.choices[0].finish_reason).toBe('tool_calls');
    });

    it('rejects a stream that ended without choices', async () => {
      await expect(
        completedChatCompletionFromSse(streamOf('data: [DONE]\n'), 'm')
      ).rejects.toThrow(/without choices/);
    });
  });

  describe('completedResponseFromSse()', () => {
    it('returns the response object carried by response.completed', async () => {
      const source = streamOf(sse(
        'data: {"type":"response.created","response":{"id":"r1"}}',
        'data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}'
      ));
      const out = await completedResponseFromSse(source);
      expect(out.id).toBe('r1');
      expect(out.status).toBe('completed');
    });

    it('aggregates response.incomplete instead of failing', async () => {
      const source = streamOf(sse(
        'data: {"type":"response.created","response":{"id":"r1"}}',
        'data: {"type":"response.incomplete","response":{"id":"r1","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}'
      ));
      const out = await completedResponseFromSse(source);
      expect(out.status).toBe('incomplete');
    });

    it('surfaces response.failed as an error', async () => {
      const source = streamOf(sse(
        'data: {"type":"response.failed","error":{"message":"boom"}}'
      ));
      await expect(completedResponseFromSse(source)).rejects.toThrow(/boom/);
    });
  });

  describe('isSseContentType()', () => {
    it('detects event streams', () => {
      expect(isSseContentType({ 'content-type': 'text/event-stream; charset=utf-8' })).toBe(true);
      expect(isSseContentType({ 'content-type': 'application/json' })).toBe(false);
      expect(isSseContentType({})).toBe(false);
    });
  });
});
