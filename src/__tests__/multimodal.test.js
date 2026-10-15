'use strict';

const { normalizeMultimodalMessages } = require('../services/multimodal');

describe('OpenAI-compatible image input', () => {
  it('preserves canonical image_url parts', () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image' },
        { type: 'image_url', image_url: { url: 'https://example.com/image.png', detail: 'high' } },
      ],
    }];

    expect(normalizeMultimodalMessages(messages)).toEqual(messages);
  });

  it('normalizes string image URLs used by older compatible clients', () => {
    const result = normalizeMultimodalMessages([{
      role: 'user',
      content: [{ type: 'image_url', image_url: 'data:image/png;base64,AAAA' }],
    }]);

    expect(result[0].content[0]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' },
    });
  });

  it('accepts Responses-style input_image parts on chat completions', () => {
    const result = normalizeMultimodalMessages([{
      role: 'user',
      content: [{ type: 'input_image', image_url: 'https://example.com/image.jpg', detail: 'low' }],
    }]);

    expect(result[0].content[0]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://example.com/image.jpg', detail: 'low' },
    });
  });

  it('returns an OpenAI-style validation error for malformed image parts', () => {
    expect(() => normalizeMultimodalMessages([{
      role: 'user',
      content: [{ type: 'image_url', image_url: {} }],
    }])).toThrow(expect.objectContaining({
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_image',
      param: 'messages.0.content.0.image_url.url',
    }));
  });

  it('does not alter text-only messages', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    expect(normalizeMultimodalMessages(messages)).toEqual(messages);
  });
});
