'use strict';

const {
  FREE_MODELS,
  ALL_MODELS,
  resolveModelId,
  resolveWireModel,
  extractZenEffort,
  modelApiMode,
  zenEffortsForModel,
  mapZenReasoningEffort,
  isFreeModel,
  getModelInfo,
} = require('../config/models');

describe('Zen free model catalog', () => {
  describe('FREE_MODELS', () => {
    it('exposes the whole free tier', () => {
      expect(FREE_MODELS.length).toBeGreaterThanOrEqual(9);
    });

    it('uses the opencode/ namespace', () => {
      for (const model of FREE_MODELS) {
        expect(model.id).toMatch(/^opencode\//);
      }
    });

    it('has unique ids and complete metadata', () => {
      const ids = FREE_MODELS.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const model of FREE_MODELS) {
        expect(typeof model.name).toBe('string');
        expect(['chat', 'responses']).toContain(model.apiMode);
        expect(model.supportsTools).toBe(true);
        expect(typeof model.supportsVision).toBe('boolean');
      }
    });

    it('keeps the models the live Zen catalog serves today', () => {
      const ids = FREE_MODELS.map((m) => m.id);
      expect(ids).toEqual(expect.arrayContaining([
        'opencode/space-bunny-free',
        'opencode/deepseek-v4.1-flash-free',
        'opencode/glm-5.3-flash-free',
        'opencode/cat-jam-free',
        'opencode/mimo-v2.6-flash-free',
        'opencode/nemotron-3.5-lightning-free',
        'opencode/nemotron-3.5-super-vl-free',
        'opencode/step-5-preview-free',
        'opencode/longcat-2.5-preview-free',
        'opencode/big-pickle',
        'opencode/muse-spark-1.3-contributor-free',
        'opencode/muse-spark-1.2-contributor-free',
      ]));
    });

    it('has no duplicate catalog entries in ALL_MODELS', () => {
      expect(ALL_MODELS.length).toBe(FREE_MODELS.length);
    });
  });

  describe('resolveWireModel()', () => {
    it('strips the opencode/ prefix, since Zen expects bare ids', () => {
      expect(resolveWireModel('opencode/deepseek-v4.1-flash-free')).toBe('deepseek-v4.1-flash-free');
    });

    it('resolves the short aliases the catalog accepts', () => {
      expect(resolveWireModel('space-bunny')).toBe('space-bunny-free');
      expect(resolveWireModel('deepseek-v4.1')).toBe('deepseek-v4.1-flash-free');
      expect(resolveWireModel('deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash-free');
      expect(resolveWireModel('glm-5.3-flash')).toBe('glm-5.3-flash-free');
      expect(resolveWireModel('cat-jam')).toBe('cat-jam-free');
      expect(resolveWireModel('mimo-v2.6')).toBe('mimo-v2.6-flash-free');
      expect(resolveWireModel('mimo-v2.6-flash')).toBe('mimo-v2.6-flash-free');
      expect(resolveWireModel('longcat-2.5')).toBe('longcat-2.5-preview-free');
      expect(resolveWireModel('step-5')).toBe('step-5-preview-free');
      expect(resolveWireModel('muse-spark-1.3-free')).toBe('muse-spark-1.3-contributor-free');
      expect(resolveWireModel('muse-spark-1.2')).toBe('muse-spark-1.2-contributor-free');
      expect(resolveWireModel('nemotron-3.5-lightning')).toBe('nemotron-3.5-lightning-free');
      expect(resolveWireModel('nemotron-3.5-super-vl')).toBe('nemotron-3.5-super-vl-free');
    });

    it('strips an effort suffix so it never reaches the wire', () => {
      expect(resolveWireModel('opencode/space-bunny-free-max')).toBe('space-bunny-free');
      expect(resolveWireModel('deepseek-v4.1-flash-free-low')).toBe('deepseek-v4.1-flash-free');
    });

    it('passes unknown ids through so paid models still work', () => {
      expect(resolveWireModel('gpt-5.6-luna')).toBe('gpt-5.6-luna');
    });
  });

  describe('resolveModelId()', () => {
    it('returns the canonical opencode/ id', () => {
      expect(resolveModelId('deepseek-v4.1-flash-free')).toBe('opencode/deepseek-v4.1-flash-free');
      expect(resolveModelId('opencode/big-pickle')).toBe('opencode/big-pickle');
    });

    it('handles nullish input', () => {
      expect(resolveModelId(null)).toBeNull();
      expect(resolveModelId(undefined)).toBeNull();
    });
  });

  describe('extractZenEffort()', () => {
    it('splits the effort suffix like the Go proxy does', () => {
      expect(extractZenEffort('opencode/space-bunny-free-max')).toEqual({
        base: 'opencode/space-bunny-free',
        effort: 'max',
      });
      expect(extractZenEffort('space-bunny-free')).toEqual({
        base: 'space-bunny-free',
        effort: '',
      });
    });

    it('is case insensitive', () => {
      expect(extractZenEffort('Space-Bunny-Free-HIGH').effort).toBe('high');
    });
  });

  describe('modelApiMode()', () => {
    it('routes Muse Spark models to the Responses API', () => {
      expect(modelApiMode('opencode/muse-spark-1.3-contributor-free')).toBe('responses');
      expect(modelApiMode('muse-spark-1.2')).toBe('responses');
    });

    it('routes everything else to chat/completions', () => {
      expect(modelApiMode('opencode/deepseek-v4.1-flash-free')).toBe('chat');
      expect(modelApiMode('space-bunny')).toBe('chat');
    });
  });

  describe('reasoning effort vocabulary', () => {
    it('limits chat models to low/high/max (Zen error 1210)', () => {
      expect(zenEffortsForModel('opencode/space-bunny-free')).toEqual(['low', 'high', 'max']);
    });

    it('allows the wider OpenAI vocabulary on Responses models', () => {
      expect(zenEffortsForModel('opencode/muse-spark-1.3-contributor-free')).toContain('xhigh');
      expect(zenEffortsForModel('opencode/muse-spark-1.3-contributor-free')).toContain('none');
    });

    it('maps generic values onto the chat vocabulary', () => {
      expect(mapZenReasoningEffort('space-bunny', 'medium')).toBe('high');
      expect(mapZenReasoningEffort('space-bunny', 'minimal')).toBe('high');
      expect(mapZenReasoningEffort('space-bunny', 'xhigh')).toBe('max');
      expect(mapZenReasoningEffort('space-bunny', 'ultra')).toBe('max');
      expect(mapZenReasoningEffort('space-bunny', 'none')).toBe('low');
      expect(mapZenReasoningEffort('space-bunny', 'max')).toBe('max');
      expect(mapZenReasoningEffort('space-bunny', 'low')).toBe('low');
      expect(mapZenReasoningEffort('space-bunny', 'bogus')).toBe('');
      expect(mapZenReasoningEffort('space-bunny', '')).toBe('');
    });

    it('maps generic values onto the Responses vocabulary', () => {
      const muse = 'opencode/muse-spark-1.3-contributor-free';
      expect(mapZenReasoningEffort(muse, 'max')).toBe('xhigh');
      expect(mapZenReasoningEffort(muse, 'ultra')).toBe('xhigh');
      expect(mapZenReasoningEffort(muse, 'none')).toBe('none');
      expect(mapZenReasoningEffort(muse, 'medium')).toBe('medium');
      expect(mapZenReasoningEffort(muse, 'bogus')).toBe('');
    });
  });

  describe('lookups', () => {
    it('identifies free models', () => {
      expect(isFreeModel('opencode/deepseek-v4.1-flash-free')).toBe(true);
      expect(isFreeModel('deepseek-v4.1-flash-free')).toBe(true);
      expect(isFreeModel('opencode/gpt-5.6-luna')).toBe(false);
    });

    it('returns catalog metadata', () => {
      const model = getModelInfo('mimo-v2.6-flash-free');
      expect(model.name).toBe('MiMo V2.6 Flash Free');
      expect(model.supportsVision).toBe(true);
      expect(getModelInfo('nope')).toBeNull();
    });
  });
});
