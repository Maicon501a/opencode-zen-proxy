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

module.exports = { validateChatPayload };