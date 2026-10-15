'use strict';

const { planUpstreamRequest } = require('../services/zenClient');
const { config } = require('../config/constants');

describe('Upstream request planning', () => {
  describe('endpoint selection', () => {
    it('keeps chat models on /chat/completions', () => {
      const plan = planUpstreamRequest(
        { model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hi' }] },
        'chat'
      );
      expect(plan.upstreamPath).toBe('/chat/completions');
      expect(plan.upstreamFormat).toBe('chat');
      expect(plan.wireModel).toBe('deepseek-v4.1-flash-free');
      expect(plan.body.model).toBe('deepseek-v4.1-flash-free');
    });

    it('routes Muse Spark models to /responses even for chat clients', () => {
      const plan = planUpstreamRequest(
        { model: 'muse-spark-1.3', messages: [{ role: 'user', content: 'hi' }] },
        'chat'
      );
      expect(plan.upstreamPath).toBe('/responses');
      expect(plan.upstreamFormat).toBe('responses');
      expect(plan.wireModel).toBe('muse-spark-1.3-contributor-free');
      expect(plan.body.input).toBeDefined();
      expect(plan.body.messages).toBeUndefined();
    });

    it('translates a Responses request for a chat-only model', () => {
      const plan = planUpstreamRequest(
        {
          model: 'opencode/big-pickle',
          input: [{ role: 'user', content: 'hi' }],
          instructions: 'be brief',
        },
        'responses'
      );
      expect(plan.upstreamPath).toBe('/chat/completions');
      expect(plan.body.messages[0]).toEqual({ role: 'system', content: 'be brief' });
      expect(plan.body.messages[1]).toEqual({ role: 'user', content: 'hi' });
    });

    it('keeps a native Responses request on /responses', () => {
      const plan = planUpstreamRequest(
        { model: 'opencode/muse-spark-1.2-contributor-free', input: 'hello' },
        'responses'
      );
      expect(plan.upstreamPath).toBe('/responses');
      expect(plan.body.input).toBe('hello');
    });
  });

  describe('free-tier gate', () => {
    it('always forces streaming upstream', () => {
      const plan = planUpstreamRequest(
        { model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }], stream: false },
        'chat'
      );
      expect(plan.body.stream).toBe(true);
    });

    it('always provides the read gate tool', () => {
      const plan = planUpstreamRequest(
        { model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] },
        'chat'
      );
      const names = plan.body.tools.map((tool) => tool.function.name);
      expect(names).toContain('read');
    });

    it('uses the flat tool shape on the Responses endpoint', () => {
      const plan = planUpstreamRequest(
        { model: 'muse-spark-1.3', messages: [{ role: 'user', content: 'hi' }] },
        'chat'
      );
      const names = plan.body.tools.map((tool) => tool.name);
      expect(names).toContain('read');
    });
  });

  describe('reasoning effort', () => {
    it('maps a client value onto the chat vocabulary', () => {
      const plan = planUpstreamRequest(
        { model: 'space-bunny', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'xhigh' },
        'chat'
      );
      expect(plan.body.reasoning_effort).toBe('max');
    });

    it('drops an effort the target endpoint does not understand', () => {
      const plan = planUpstreamRequest(
        { model: 'space-bunny', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'bogus' },
        'chat'
      );
      expect(plan.body.reasoning_effort).toBeUndefined();
    });

    it('never invents an effort by default', () => {
      const plan = planUpstreamRequest(
        { model: 'space-bunny', messages: [{ role: 'user', content: 'hi' }] },
        'chat'
      );
      expect(plan.body.reasoning_effort).toBeUndefined();
      expect(config.defaultReasoningEffort).toBe('');
    });

    it('lets an effort-suffixed alias override the client field', () => {
      const plan = planUpstreamRequest(
        {
          model: 'opencode/space-bunny-free-low',
          messages: [{ role: 'user', content: 'hi' }],
          reasoning_effort: 'max',
        },
        'chat'
      );
      expect(plan.body.model).toBe('space-bunny-free');
      expect(plan.body.reasoning_effort).toBe('low');
    });

    it('carries the effort into the Responses reasoning object', () => {
      const plan = planUpstreamRequest(
        { model: 'muse-spark-1.3', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'max' },
        'chat'
      );
      expect(plan.body.reasoning.effort).toBe('xhigh');
    });
  });

  describe('payload hygiene', () => {
    it('normalizes Responses-style image parts for chat upstreams', () => {
      const plan = planUpstreamRequest(
        {
          model: 'mimo-v2.6-flash-free',
          messages: [{
            role: 'user',
            content: [{ type: 'input_image', image_url: 'https://example.com/a.png' }],
          }],
        },
        'chat'
      );
      expect(plan.body.messages[0].content[0]).toEqual({
        type: 'image_url',
        image_url: { url: 'https://example.com/a.png' },
      });
    });

    it('does not leak the client stream preference downstream', () => {
      const plan = planUpstreamRequest(
        { model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }], stream: false },
        'chat'
      );
      // The gate always streams; the route decides how to answer the client.
      expect(plan.body.stream).toBe(true);
      expect(plan.body.stream_options).toEqual({ include_usage: true });
    });
  });
});
