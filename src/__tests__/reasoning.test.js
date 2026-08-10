'use strict';

const {
  resolveReasoningEffort,
  VALID_REASONING_EFFORTS,
  resolveZenModel,
  stripResponsesSuffix,
  ZEN_MODEL_ALIASES,
  ensureTemporalContext,
} = require('../services/zenClient');
const { config } = require('../config/constants');

describe('Reasoning Effort', () => {
  describe('VALID_REASONING_EFFORTS', () => {
    it('should list the gateway-accepted efforts', () => {
      expect(VALID_REASONING_EFFORTS).toEqual(
        expect.arrayContaining(['low', 'medium', 'high', 'max', 'xhigh'])
      );
    });

    it('should not include the rejected values none/minimal', () => {
      expect(VALID_REASONING_EFFORTS).not.toContain('none');
      expect(VALID_REASONING_EFFORTS).not.toContain('minimal');
    });
  });

  describe('resolveReasoningEffort()', () => {
    it('should return a valid client value unchanged (lowercased)', () => {
      expect(resolveReasoningEffort('low')).toBe('low');
      expect(resolveReasoningEffort('HIGH')).toBe('high');
      expect(resolveReasoningEffort('Xhigh')).toBe('xhigh');
    });

    it('should fall back to the configured default when value is invalid', () => {
      expect(resolveReasoningEffort('bogus')).toBe(config.defaultReasoningEffort);
      expect(resolveReasoningEffort('none')).toBe(config.defaultReasoningEffort);
    });

    it('should fall back to the default when value is missing', () => {
      expect(resolveReasoningEffort(undefined)).toBe(config.defaultReasoningEffort);
      expect(resolveReasoningEffort(null)).toBe(config.defaultReasoningEffort);
    });

    it('should use the configured default', () => {
      expect(VALID_REASONING_EFFORTS).toContain(config.defaultReasoningEffort);
    });
  });
});

describe('resolveZenModel()', () => {
  it('should map short aliases to canonical -free ids', () => {
    expect(resolveZenModel('mimo-v2.5')).toBe('mimo-v2.5-free');
    expect(resolveZenModel('nemotron-3-ultra')).toBe('nemotron-3-ultra-free');
    expect(resolveZenModel('north-mini-code')).toBe('north-mini-code-free');
    expect(resolveZenModel('ling-3.0-flash')).toBe('ling-3.0-flash-free');
    expect(resolveZenModel('laguna-s-2.1')).toBe('laguna-s-2.1-free');
    expect(resolveZenModel('deepseek-v4-flash')).toBe('deepseek-v4-flash-free');
  });

  it('should map aliases even with the opencode/ prefix', () => {
    expect(resolveZenModel('opencode/mimo-v2.5')).toBe('mimo-v2.5-free');
  });

  it('should strip Responses-API suffixes', () => {
    expect(resolveZenModel('opencode/deepseek-v4-flash-free-responses')).toBe(
      'deepseek-v4-flash-free'
    );
    expect(resolveZenModel('deepseek-v4-flash-free@responses')).toBe('deepseek-v4-flash-free');
    expect(resolveZenModel('deepseek-v4-flash-free/responses')).toBe('deepseek-v4-flash-free');
  });

  it('should leave canonical ids untouched', () => {
    expect(resolveZenModel('opencode/deepseek-v4-flash-free')).toBe(
      'deepseek-v4-flash-free'
    );
    expect(resolveZenModel('opencode/big-pickle')).toBe('big-pickle');
  });

  it('should pass unknown models through unchanged', () => {
    expect(resolveZenModel('opencode/gpt-5.5')).toBe('gpt-5.5');
    expect(resolveZenModel('grok-4.5')).toBe('grok-4.5');
  });

  it('should handle non-string input', () => {
    expect(resolveZenModel(undefined)).toBeUndefined();
    expect(resolveZenModel(null)).toBeNull();
  });

  it('should cover the whole alias table', () => {
    for (const [alias, canonical] of Object.entries(ZEN_MODEL_ALIASES)) {
      expect(resolveZenModel(alias)).toBe(canonical);
    }
  });
});

describe('stripResponsesSuffix()', () => {
  it('should strip known responses suffixes', () => {
    expect(stripResponsesSuffix('model-responses')).toBe('model');
    expect(stripResponsesSuffix('model@responses')).toBe('model');
    expect(stripResponsesSuffix('model/responses')).toBe('model');
  });

  it('should leave ids without the suffix unchanged', () => {
    expect(stripResponsesSuffix('deepseek-v4-flash-free')).toBe('deepseek-v4-flash-free');
  });
});

describe('ensureTemporalContext()', () => {
  let originalInjectTemporalContext;

  beforeAll(() => {
    originalInjectTemporalContext = config.injectTemporalContext;
    config.injectTemporalContext = true;
  });

  afterAll(() => {
    config.injectTemporalContext = originalInjectTemporalContext;
  });

  it('should prepend a system message when conversation has no system message', () => {
    const out = ensureTemporalContext([{ role: 'user', content: 'hi' }]);
    expect(out.length).toBe(2);
    expect(out[0].role).toBe('system');
    expect(out[0].content).toContain('Temporal context:');
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('should merge into an existing system message', () => {
    const out = ensureTemporalContext([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
    ]);
    expect(out.length).toBe(2);
    expect(out[0].content).toContain('Temporal context:');
    expect(out[0].content).toContain('You are a helpful assistant.');
    expect(out[0].content.indexOf('Temporal context:')).toBe(0);
  });

  it('should not double-inject when marker is already present', () => {
    const sys = { role: 'system', content: 'Temporal context: today is Monday. ...' };
    const out = ensureTemporalContext([sys, { role: 'user', content: 'hi' }]);
    expect(out[0]).toBe(sys);
    expect(out.length).toBe(2);
  });

  it('should prepend a system message to an empty conversation', () => {
    const out = ensureTemporalContext([]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('system');
    expect(out[0].content).toContain('Temporal context:');
  });

  it('should be a no-op on non-array input', () => {
    expect(ensureTemporalContext(undefined)).toBeUndefined();
    expect(ensureTemporalContext(null)).toBeNull();
    expect(ensureTemporalContext('nope')).toBe('nope');
  });
});
