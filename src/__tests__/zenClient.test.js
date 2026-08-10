'use strict';

const {
    normalizeChatPayload,
    resolveZenModel,
} = require('../services/zenClient');
const { config } = require('../config/constants');

describe('normalizeChatPayload()', () => {
    it('should resolve model aliases on the wire', () => {
        const out = normalizeChatPayload({
            model: 'opencode/mimo-v2.5',
            messages: [{ role: 'user', content: 'hi' }],
        });
        expect(out.model).toBe('mimo-v2.5-free');
    });

    it('should resolve short model names without -free suffix', () => {
        const out = normalizeChatPayload({
            model: 'deepseek-v4-flash',
            messages: [{ role: 'user', content: 'hi' }],
        });
        expect(out.model).toBe('deepseek-v4-flash-free');
    });

    it('should strip responses suffixes from the model', () => {
        const out = normalizeChatPayload({
            model: 'opencode/deepseek-v4-flash-free-responses',
            messages: [{ role: 'user', content: 'hi' }],
        });
        expect(out.model).toBe('deepseek-v4-flash-free');
    });

    it('should not invent reasoning_content for assistant messages', () => {
        const payload = {
            model: 'opencode/deepseek-v4-flash-free',
            messages: [
                { role: 'user', content: 'hi' },
                {
                    role: 'assistant',
                    content: 'I need a tool.',
                    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'inspect', arguments: '{}' } }],
                },
                { role: 'tool', tool_call_id: 'call_1', content: 'tool result' },
            ],
        };
        const original = JSON.parse(JSON.stringify(payload));
        const out = normalizeChatPayload(payload);
        const assistant = out.messages.find((m) => m.role === 'assistant');

        expect(assistant).not.toHaveProperty('reasoning_content');
        expect(assistant.tool_calls).toEqual(original.messages[1].tool_calls);
        expect(payload).toEqual(original);
    });

    it('should preserve an explicitly empty reasoning_content value', () => {
        const out = normalizeChatPayload({
            model: 'opencode/deepseek-v4-flash-free',
            messages: [
                { role: 'assistant', content: null, reasoning_content: '' },
            ],
        });
        const assistant = out.messages.find((m) => m.role === 'assistant');
        expect(assistant).toHaveProperty('reasoning_content', '');
    });

    it('should keep existing reasoning_content on assistant messages', () => {
        const out = normalizeChatPayload({
            model: 'opencode/deepseek-v4-flash-free',
            messages: [
                { role: 'assistant', content: 'hello', reasoning_content: 'thought...' },
            ],
        });
        const assistant = out.messages.find((m) => m.role === 'assistant');
        expect(assistant.reasoning_content).toBe('thought...');
    });

    it('should not inject temporal context when transparent mode is disabled', () => {
        const original = config.injectTemporalContext;
        config.injectTemporalContext = false;
        const out = normalizeChatPayload({
            model: 'opencode/deepseek-v4-flash-free',
            messages: [{ role: 'user', content: 'hi' }],
        });
        config.injectTemporalContext = original;
        expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('should inject temporal context only when explicitly enabled', () => {
        const original = config.injectTemporalContext;
        config.injectTemporalContext = true;
        const out = normalizeChatPayload({
            model: 'opencode/deepseek-v4-flash-free',
            messages: [{ role: 'user', content: 'hi' }],
        });
        config.injectTemporalContext = original;
        expect(out.messages[0].role).toBe('system');
        expect(out.messages[0].content).toContain('Temporal context:');
    });

    it('should not inject default reasoning effort unless explicitly enabled', () => {
        const out = normalizeChatPayload({
            model: 'opencode/deepseek-v4-flash-free',
            messages: [{ role: 'user', content: 'hi' }],
        });
        if (config.injectDefaultReasoningEffort) {
            expect(out.reasoning_effort).toBe(config.defaultReasoningEffort);
        } else {
            expect(out.reasoning_effort).toBeUndefined();
        }
    });

    it('should keep a valid client reasoning effort', () => {
        const out = normalizeChatPayload({
            model: 'opencode/deepseek-v4-flash-free',
            messages: [{ role: 'user', content: 'hi' }],
            reasoning_effort: 'low',
        });
        expect(out.reasoning_effort).toBe('low');
    });

    it('should not add stream_options to SSE requests', () => {
        const out = normalizeChatPayload({
            model: 'opencode/deepseek-v4-flash-free',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
        });
        expect(out.stream_options).toBeUndefined();
    });

    it('should not add stream_options to non-streaming requests', () => {
        const out = normalizeChatPayload({
            model: 'opencode/deepseek-v4-flash-free',
            messages: [{ role: 'user', content: 'hi' }],
        });
        expect(out.stream_options).toBeUndefined();
    });

    it('should preserve client-specified stream_options verbatim', () => {
        const out = normalizeChatPayload({
            model: 'opencode/deepseek-v4-flash-free',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
            stream_options: { include_usage: false },
        });
        expect(out.stream_options).toEqual({ include_usage: false });
    });

    it('should preserve tools, tool_choice and other fields verbatim', () => {
        const tools = [{ type: 'function', function: { name: 'get_weather' } }];
        const out = normalizeChatPayload({
            model: 'opencode/deepseek-v4-flash-free',
            messages: [{ role: 'user', content: 'hi' }],
            tools,
            tool_choice: 'auto',
            temperature: 0.7,
            max_tokens: 100,
        });
        expect(out.tools).toBe(tools);
        expect(out.tool_choice).toBe('auto');
        expect(out.temperature).toBe(0.7);
        expect(out.max_tokens).toBe(100);
    });

    it('should not mutate the original payload', () => {
        const payload = {
            model: 'mimo-v2.5',
            messages: [{ role: 'user', content: 'hi' }],
        };
        normalizeChatPayload(payload);
        expect(payload.model).toBe('mimo-v2.5');
        expect(payload.messages).toHaveLength(1);
    });
});

describe('resolveZenModel() wire id never keeps the opencode/ namespace', () => {
    it('should resolve every known free model to a bare id', () => {
        for (const m of [
            'opencode/deepseek-v4-flash-free',
            'opencode/big-pickle',
            'opencode/mimo-v2.5-free',
            'opencode/nemotron-3-ultra-free',
            'opencode/north-mini-code-free',
            'opencode/ling-3.0-flash-free',
            'opencode/laguna-s-2.1-free',
        ]) {
            expect(resolveZenModel(m)).not.toContain('opencode/');
        }
    });
});
