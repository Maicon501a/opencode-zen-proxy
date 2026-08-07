'use strict';

const { validateChatPayload } = require('../services/validation');

describe('validateChatPayload()', () => {
  it('should return null for a valid payload', () => {
    const result = validateChatPayload({
      model: 'opencode/deepseek-v4-flash-free',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result).toBeNull();
  });

  it('should reject non-object payloads', () => {
    for (const bad of [null, undefined, 'nope', 42, ['model']]) {
      const result = validateChatPayload(bad);
      expect(result).not.toBeNull();
      expect(result.status).toBe(400);
      expect(result.error.message).toContain('JSON object');
    }
  });

  it('should reject a missing model', () => {
    const result = validateChatPayload({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.status).toBe(400);
    expect(result.error.param).toBe('model');
    expect(result.error.code).toBe('missing_required_parameter');
  });

  it('should reject missing or empty messages', () => {
    const noMessages = validateChatPayload({ model: 'test-model' });
    expect(noMessages.error.param).toBe('messages');

    const emptyMessages = validateChatPayload({ model: 'test-model', messages: [] });
    expect(emptyMessages.error.param).toBe('messages');
  });
});