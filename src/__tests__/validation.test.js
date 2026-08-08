'use strict';

const { validateChatPayload, hasNonTextContent } = require('../services/validation');

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

describe('hasNonTextContent()', () => {
  it('should detect image_url parts in content arrays', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }] },
    ];
    expect(hasNonTextContent(messages)).toBe(true);
  });

  it('should detect input_audio parts', () => {
    const messages = [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }];
    expect(hasNonTextContent(messages)).toBe(true);
  });

  it('should detect base64 images in user/tool string content', () => {
    expect(hasNonTextContent([{ role: 'user', content: 'data:image/png;base64,AAAA' }])).toBe(true);
    expect(hasNonTextContent([{ role: 'tool', content: 'data:image/webp;base64,BBBB' }])).toBe(true);
  });

  it('should ignore system prose that merely mentions data:image', () => {
    const messages = [{ role: 'system', content: 'You may use data:image/png;base64 for screenshots.' }];
    expect(hasNonTextContent(messages)).toBe(false);
  });

  it('should return false for pure text conversations', () => {
    const messages = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi!' },
    ];
    expect(hasNonTextContent(messages)).toBe(false);
  });

  it('should handle non-array input', () => {
    expect(hasNonTextContent(undefined)).toBe(false);
    expect(hasNonTextContent(null)).toBe(false);
    expect(hasNonTextContent('nope')).toBe(false);
  });
});