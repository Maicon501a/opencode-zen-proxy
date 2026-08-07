'use strict';

const {
  FREE_MODELS,
  ALL_MODELS,
  resolveModelId,
  isFreeModel,
  getModelInfo,
} = require('../config/models');

describe('Models Configuration', () => {
  describe('FREE_MODELS', () => {
    it('should contain the known free models', () => {
      expect(FREE_MODELS.length).toBeGreaterThanOrEqual(5);
    });

    it('should include deepseek-v4-flash-free', () => {
      const model = FREE_MODELS.find((m) => m.id === 'opencode/deepseek-v4-flash-free');
      expect(model).toBeDefined();
      expect(model.free).toBe(true);
      expect(model.supportsStreaming).toBe(true);
    });

    it('should include ling-3.0-flash-free and laguna-s-2.1-free', () => {
      expect(FREE_MODELS.find((m) => m.id === 'opencode/ling-3.0-flash-free')).toBeDefined();
      expect(FREE_MODELS.find((m) => m.id === 'opencode/laguna-s-2.1-free')).toBeDefined();
    });

    it('should mirror the upstream adapter free catalog (7 models)', () => {
      expect(FREE_MODELS).toHaveLength(7);
    });

    it('should have unique model IDs', () => {
      const ids = FREE_MODELS.map((m) => m.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should have all required fields', () => {
      for (const model of FREE_MODELS) {
        expect(model.id).toBeDefined();
        expect(model.name).toBeDefined();
        expect(model.provider).toBeDefined();
        expect(model.free).toBe(true);
        expect(typeof model.supportsStreaming).toBe('boolean');
      }
    });
  });

  describe('ALL_MODELS', () => {
    it('should include the free models', () => {
      expect(ALL_MODELS.length).toBeGreaterThanOrEqual(FREE_MODELS.length);
    });

    it('should have all models with opencode/ prefix', () => {
      for (const model of ALL_MODELS) {
        expect(model.id).toMatch(/^opencode\//);
      }
    });
  });

  describe('resolveModelId()', () => {
    it('should resolve canonical IDs', () => {
      expect(resolveModelId('opencode/deepseek-v4-flash-free')).toBe(
        'opencode/deepseek-v4-flash-free'
      );
    });

    it('should resolve short IDs without opencode/ prefix', () => {
      expect(resolveModelId('deepseek-v4-flash-free')).toBe(
        'opencode/deepseek-v4-flash-free'
      );
    });

    it('should resolve IDs without -free suffix', () => {
      const result = resolveModelId('deepseek-v4-flash');
      expect(result).toBe('opencode/deepseek-v4-flash-free');
    });

    it('should resolve short aliases for the new free models', () => {
      expect(resolveModelId('ling-3.0-flash')).toBe('opencode/ling-3.0-flash-free');
      expect(resolveModelId('laguna-s-2.1')).toBe('opencode/laguna-s-2.1-free');
      expect(resolveModelId('ling-3.0-flash-free')).toBe('opencode/ling-3.0-flash-free');
    });

    it('should return original ID for unknown models', () => {
      expect(resolveModelId('unknown-model')).toBe('unknown-model');
    });

    it('should return null for null/undefined input', () => {
      expect(resolveModelId(null)).toBeNull();
      expect(resolveModelId(undefined)).toBeNull();
    });
  });

  describe('isFreeModel()', () => {
    it('should return true for known free models', () => {
      expect(isFreeModel('opencode/deepseek-v4-flash-free')).toBe(true);
      expect(isFreeModel('deepseek-v4-flash-free')).toBe(true);
    });

    it('should return false for models not in the curated free list', () => {
      expect(isFreeModel('opencode/gpt-5.5')).toBe(false);
    });

    it('should return false for unknown models', () => {
      expect(isFreeModel('nonexistent-model')).toBe(false);
    });
  });

  describe('getModelInfo()', () => {
    it('should return model info for known models', () => {
      const info = getModelInfo('opencode/deepseek-v4-flash-free');
      expect(info).toBeDefined();
      expect(info.name).toBe('DeepSeek V4 Flash Free');
      expect(info.provider).toBe('deepseek');
    });

    it('should return model info with short alias', () => {
      const info = getModelInfo('deepseek-v4-flash-free');
      expect(info).toBeDefined();
      expect(info.name).toBe('DeepSeek V4 Flash Free');
    });

    it('should return null for unknown models', () => {
      expect(getModelInfo('nonexistent')).toBeNull();
    });
  });
});
