'use strict';

/**
 * Validate an OpenAI chat-completions request body.
 *
 * @param {*} payload - raw request body
 * @returns {null|{status:number, error:object}} null when valid, otherwise an
 *   OpenAI-compatible error envelope plus the HTTP status to return.
 */
function validateChatPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      status: 400,
      error: {
        message: 'Request body must be a JSON object.',
        type: 'invalid_request_error',
      },
    };
  }

  if (!payload.model) {
    return {
      status: 400,
      error: {
        message: 'The model field is required.',
        type: 'invalid_request_error',
        param: 'model',
        code: 'missing_required_parameter',
      },
    };
  }

  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return {
      status: 400,
      error: {
        message: 'The messages field is required and must be a non-empty array.',
        type: 'invalid_request_error',
        param: 'messages',
        code: 'missing_required_parameter',
      },
    };
  }

  return null;
}

/**
 * Detect non-text content (images/audio) in a chat messages array.
 *
 * OpenAI multimodal requests carry content arrays with typed parts such as
 * { type: "image_url" } or { type: "input_audio" }; some clients also inline
 * base64 data URIs in user/tool strings. System-prompt prose that merely
 * mentions "data:image/..." is deliberately ignored (role === 'system').
 *
 * @param {*} messages - the chat messages array
 * @returns {boolean} true when the request carries non-text content
 */
function hasNonTextContent(messages) {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    const content = msg && msg.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object' && part.type && part.type !== 'text') {
          return true;
        }
      }
    } else if (
      typeof content === 'string' &&
      (msg.role === 'user' || msg.role === 'tool') &&
      /data:image\/(png|jpe?g|gif|webp);base64,/i.test(content)
    ) {
      return true;
    }
  }
  return false;
}

module.exports = { validateChatPayload, hasNonTextContent };