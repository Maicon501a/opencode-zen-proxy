'use strict';

const {
    normalizeChatPayload,
    resolveZenModel,
} = require('../services/zenClient');

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

    it('should add reasoning_content fallback to assistant messages', () => {
        const out = normalizeChatPayload({
            model: 'opencode/deepseek-v4-flash-free',
            messages: [
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: 'hello there' },
            ],
        });
        const assistant = out.messages.find((m) => m.role === 'assistant');
        expect(assistant.reasoning_content).toBe('hello there');
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

    it('should inject a temporal-context system message', () => {
        const out = normalizeChatPayload({
            model: 'opencode/deepseek-v4-flash-free',
            messages: [{ role: 'user', content: 'hi' }],
        });
        expect(out.messages[0].role).toBe('system');
        expect(out.messages[0].content).toContain('Temporal context:');
        expect(out.messages[0].content).toContain(String(new Date().getFullYear()));
    });

    it('should inject default reasoning effort', () => {
        const out = normalizeChatPayload({
            model: 'opencode/deepseek-v4-flash-free',
            messages: [{ role: 'user', content: 'hi' }],
        });
        expect(out.reasoning_effort).toBe('xhigh');
    });

    it('should keep a valid client reasoning effort', () => {
        const out = normalizeChatPayload({
            model: 'opencode/deepseek-v4-flash-free',
            messages: [{ role: 'user', content: 'hi' }],
            reasoning_effort: 'low',
        });
        expect(out.reasoning_effort).toBe('low');
    });

    it('should force include_usage on SSE streams', () => {
        const out = normalizeChatPayload({
            model: 'opencode/deepseek-v4-flash-free',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
        });
        expect(out.stream_options).toEqual({ include_usage: true });
    });

    it('should not add stream_options to non-streaming requests', () => {
        const out = normalizeChatPayload({
            model: 'opencode/deepseek-v4-flash-free',
            messages: [{ role: 'user', content: 'hi' }],
        });
        expect(out.stream_options).toBeUndefined();
    });

    it('should respect a client-specified include_usage', () => {
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
