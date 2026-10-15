'use strict';

/**
 * Normalize image content parts to the Chat Completions wire format.
 *
 * The canonical OpenAI shape is:
 *   { type: 'image_url', image_url: { url: 'https://...' } }
 *
 * Some OpenAI-compatible clients use the Responses API name (`input_image`)
 * or send `image_url` as a string. Accept both without changing canonical
 * requests, text parts, tool messages, or any unknown future content types.
 */
function normalizeImagePart(part, path) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
  if (part.type !== 'image_url' && part.type !== 'input_image') return part;

  const value = part.image_url;
  const imageUrl = typeof value === 'string' ? { url: value } : value;

  if (!imageUrl || typeof imageUrl !== 'object' || Array.isArray(imageUrl)) {
    throw invalidImageError(`${path}.image_url`, 'must be a URL string or an object containing url.');
  }
  if (typeof imageUrl.url !== 'string' || imageUrl.url.trim() === '') {
    throw invalidImageError(`${path}.image_url.url`, 'must be a non-empty URL or data URI.');
  }

  const normalizedImageUrl = { ...imageUrl, url: imageUrl.url.trim() };
  // Responses API places detail beside image_url, while Chat Completions
  // places it inside the image_url object.
  if (part.detail !== undefined && normalizedImageUrl.detail === undefined) {
    normalizedImageUrl.detail = part.detail;
  }

  const normalized = { ...part, type: 'image_url', image_url: normalizedImageUrl };
  delete normalized.detail;
  return normalized;
}

function normalizeMultimodalMessages(messages) {
  return messages.map((message, messageIndex) => {
    if (!message || typeof message !== 'object' || !Array.isArray(message.content)) {
      return message;
    }

    return {
      ...message,
      content: message.content.map((part, partIndex) =>
        normalizeImagePart(part, `messages.${messageIndex}.content.${partIndex}`)
      ),
    };
  });
}

function invalidImageError(param, reason) {
  const error = new Error(`Invalid image content: ${param} ${reason}`);
  error.statusCode = 400;
  error.type = 'invalid_request_error';
  error.code = 'invalid_image';
  error.param = param;
  return error;
}

module.exports = { normalizeMultimodalMessages, normalizeImagePart };
