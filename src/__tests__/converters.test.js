'use strict';

const {
  responsesToChatCompletion,
  chatCompletionToResponse,
  chatBodyToResponsesBody,
  responsesBodyToChatBody,
  extractResponsesOutputText,
  extractResponsesFunctionCalls,
  normalizeUsageToChat,
  normalizeUsageToResponses,
} = require('../services/converters');
const {
  sanitizeToolCall,
  sanitizeChatTools,
  sanitizeResponsesTools,
  repairToolSchema,
} = require('../services/tools');

describe('Responses ⇄ chat translation', () => {
  describe('responsesToChatCompletion()', () => {
    it('maps text output to a chat completion', () => {
      const out = responsesToChatCompletion({
        id: 'resp_1',
        created_at: 1700000000,
        status: 'completed',
        output: [
          { type: 'reasoning', encrypted_content: 'abc' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] },
        ],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }, 'muse');

      expect(out.object).toBe('chat.completion');
      expect(out.model).toBe('muse');
      expect(out.choices[0].finish_reason).toBe('stop');
      expect(out.choices[0].message.content).toBe('Hello');
      expect(out.choices[0].message.reasoning_items).toHaveLength(1);
      expect(out.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    });

    it('maps function calls to tool_calls and reports tool_calls', () => {
      const out = responsesToChatCompletion({
        id: 'resp_2',
        status: 'completed',
        output: [{
          type: 'function_call',
          call_id: 'call_1',
          name: 'shell',
          arguments: '{"cmd":"ls"}',
        }],
      }, 'muse');

      expect(out.choices[0].finish_reason).toBe('tool_calls');
      expect(out.choices[0].message.content).toBeNull();
      expect(out.choices[0].message.tool_calls[0]).toEqual({
        id: 'call_1',
        type: 'function',
        function: { name: 'shell', arguments: '{"cmd":"ls"}' },
      });
    });

    it('maps an incomplete response to finish_reason length', () => {
      const out = responsesToChatCompletion({ id: 'r', status: 'incomplete', output: [] }, 'm');
      expect(out.choices[0].finish_reason).toBe('length');
    });
  });

  describe('chatCompletionToResponse()', () => {
    it('maps assistant text and tool calls', () => {
      const out = chatCompletionToResponse({
        id: 'chatcmpl-1',
        model: 'm',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hi',
            tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }, 'm');

      expect(out.object).toBe('response');
      expect(out.status).toBe('completed');
      expect(out.output[0]).toEqual({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hi' }],
      });
      expect(out.output[1]).toEqual({
        type: 'function_call',
        call_id: 'call_9',
        name: 'read',
        arguments: '{"path":"a"}',
        status: 'completed',
      });
      expect(out.usage).toEqual({ input_tokens: 1, output_tokens: 2, total_tokens: 3 });
    });
  });

  describe('chatBodyToResponsesBody()', () => {
    it('turns system messages into instructions and keeps the turns', () => {
      const out = chatBodyToResponsesBody({
        model: 'muse',
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'developer', content: 'second instruction' },
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
        max_tokens: 100,
        reasoning_effort: 'high',
      });

      expect(out.instructions).toBe('be terse\n\nsecond instruction');
      expect(out.max_output_tokens).toBe(100);
      expect(out.reasoning).toEqual({ effort: 'high', summary: 'auto' });
      expect(out.input).toEqual([
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
      ]);
    });

    it('maps tool results to function_call_output items', () => {
      const out = chatBodyToResponsesBody({
        model: 'muse',
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
        ],
      });

      expect(out.input).toEqual([
        { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'call_1' },
        { type: 'function_call_output', output: 'ok', call_id: 'call_1' },
      ]);
    });

    it('falls back to a placeholder input when there is nothing to send', () => {
      expect(chatBodyToResponsesBody({ model: 'muse', messages: [] }).input).toBe('Hello');
    });
  });

  describe('responsesBodyToChatBody()', () => {
    it('moves instructions into a system message', () => {
      const out = responsesBodyToChatBody({
        model: 'big-pickle',
        instructions: 'be brief',
        input: 'hello',
        max_output_tokens: 50,
        reasoning: { effort: 'high' },
      });

      expect(out.messages[0]).toEqual({ role: 'system', content: 'be brief' });
      expect(out.messages[1]).toEqual({ role: 'user', content: 'hello' });
      expect(out.max_tokens).toBe(50);
      expect(out.reasoning_effort).toBe('high');
    });

    it('nudges the model to use its tools when tools are present', () => {
      const out = responsesBodyToChatBody({
        model: 'big-pickle',
        instructions: 'be brief',
        input: 'hello',
        tools: [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: {} } }],
      });

      expect(out.messages[0].content).toContain('IMPORTANT: You have tools available.');
      expect(out.tools[0].function.name).toBe('shell');
    });

    it('converts typed function call items into assistant tool_calls', () => {
      const out = responsesBodyToChatBody({
        model: 'big-pickle',
        input: [
          { type: 'function_call', call_id: 'call_7', name: 'read', arguments: '{"path":"x"}' },
          { type: 'function_call_output', call_id: 'call_7', output: 'contents' },
        ],
      });

      expect(out.messages[0].role).toBe('assistant');
      expect(out.messages[0].tool_calls[0].function.name).toBe('read');
      expect(out.messages[1]).toEqual({ role: 'tool', content: 'contents', tool_call_id: 'call_7' });
    });

    it('drops encrypted reasoning items that chat backends reject', () => {
      const out = responsesBodyToChatBody({
        model: 'big-pickle',
        input: [{ type: 'reasoning', encrypted_content: 'zzz' }],
      });
      expect(out.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });
  });

  describe('extractors', () => {
    it('reads assistant text', () => {
      expect(extractResponsesOutputText({ output_text: 'shortcut' })).toBe('shortcut');
      expect(extractResponsesOutputText({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }] }],
      })).toBe('ab');
    });

    it('ignores server-side tool items', () => {
      const calls = extractResponsesFunctionCalls({
        output: [
          { type: 'web_search_call', id: 'ws_1' },
          { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
        ],
      });
      expect(calls).toHaveLength(1);
    });
  });

  describe('usage normalization', () => {
    it('converts chat usage to responses usage', () => {
      expect(normalizeUsageToResponses({ prompt_tokens: 3, completion_tokens: 4 }))
        .toEqual({ input_tokens: 3, output_tokens: 4, total_tokens: 7 });
    });

    it('converts responses usage to chat usage', () => {
      expect(normalizeUsageToChat({ input_tokens: 3, output_tokens: 4 }))
        .toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
    });
  });
});

describe('Tool sanitizers', () => {
  describe('sanitizeResponsesTools()', () => {
    it('flattens nested OpenAI function tools', () => {
      const tools = sanitizeResponsesTools([{
        type: 'function',
        function: { name: 'shell', description: 'd', parameters: { type: 'object', properties: {} } },
      }]);
      expect(tools).toEqual([{
        type: 'function',
        name: 'shell',
        description: 'd',
        parameters: { type: 'object', properties: {} },
      }]);
    });

    it('drops unknown variants and de-duplicates function tools', () => {
      const tools = sanitizeResponsesTools([
        { type: 'namespace', name: 'group' },
        { type: 'function', name: 'shell' },
        { type: 'function', name: 'shell' },
        { type: 'custom', name: 'weird' },
      ]);
      expect(tools.map((t) => t.name)).toEqual(['shell']);
    });

    it('unwraps namespace groups', () => {
      const tools = sanitizeResponsesTools([{
        type: 'namespace',
        tools: [{ type: 'function', name: 'read', parameters: {} }],
      }]);
      expect(tools.map((t) => t.name)).toEqual(['read']);
    });
  });

  describe('sanitizeChatTools()', () => {
    it('converts flat and Anthropic shapes into the nested chat shape', () => {
      const tools = sanitizeChatTools([
        { name: 'shell', input_schema: { type: 'object', properties: {} } },
        { type: 'function', name: 'read', description: 'd', parameters: { type: 'object', properties: {} } },
      ]);
      expect(tools[0].function.name).toBe('shell');
      expect(tools[1].function.name).toBe('read');
      expect(tools[1].function.description).toBe('d');
    });

    it('skips server-side tool types', () => {
      expect(sanitizeChatTools([{ type: 'web_search' }])).toEqual([]);
    });
  });

  describe('sanitizeToolCall()', () => {
    it('fills in ids and normalizes arguments to a JSON string', () => {
      const call = sanitizeToolCall({ function: { name: 'shell', arguments: { cmd: 'ls' } } });
      expect(call.type).toBe('function');
      expect(call.id).toMatch(/^call_/);
      expect(call.function.arguments).toBe('{"cmd":"ls"}');
    });

    it('replaces invalid argument strings with an empty object', () => {
      const call = sanitizeToolCall({ id: 'call_1', function: { name: 'shell', arguments: 'not json' } });
      expect(call.function.arguments).toBe('{}');
    });

    it('drops calls without a function name', () => {
      expect(sanitizeToolCall({ id: 'call_1', function: {} })).toBeNull();
    });
  });

  describe('repairToolSchema()', () => {
    it('removes required entries that are not declared in properties', () => {
      const schema = {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a', 'b'],
      };
      repairToolSchema(schema);
      expect(schema.required).toEqual(['a']);
    });

    it('deletes an empty required array and a null one', () => {
      const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['zz'] };
      repairToolSchema(schema);
      expect(schema.required).toBeUndefined();

      const nilSchema = { type: 'object', required: null };
      repairToolSchema(nilSchema);
      expect(nilSchema.required).toBeUndefined();
    });

    it('walks nested schemas', () => {
      const schema = {
        type: 'object',
        properties: {
          inner: {
            type: 'object',
            properties: { x: { type: 'string' } },
            required: ['x', 'ghost'],
          },
        },
      };
      repairToolSchema(schema);
      expect(schema.properties.inner.required).toEqual(['x']);
    });
  });
});
