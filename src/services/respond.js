'use strict';

const { createLogger } = require('./logger');

const log = createLogger('http');

/** Standard OpenAI error envelope. */
function openaiError(message, { type = 'invalid_request_error', code = null, param = null } = {}) {
  return { error: { message, type, param, code } };
}

/**
 * Write an error in OpenAI format, preserving the upstream status code.
 */
function sendError(res, err) {
  const status = err && err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  const type = err && err.type ? err.type : status >= 500 ? 'server_error' : 'invalid_request_error';
  const message = (err && err.message) || 'An unexpected error occurred.';

  if (res.headersSent) {
    log.warn('error after headers sent; terminating stream', { message });
    res.end();
    return;
  }

  log.error('request failed', { status, message });
  res.status(status).json(openaiError(message, { type, code: (err && err.code) || null }));
}

/**
 * Pipe an upstream SSE stream straight through. The Zen gateway already emits
 * OpenAI-format chunks, so no transformation is needed.
 *
 * The upstream is destroyed when the client disconnects, which keeps the
 * proxy from holding a socket open for an abandoned stream.
 */
function pipeSse(req, res, upstream) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  upstream.pipe(res);

  upstream.on('error', (err) => {
    log.warn('upstream stream error', { message: err.message });
    if (!res.headersSent) sendError(res, err);
    else res.end();
  });

  // `req`'s 'close' fires as soon as the request body is consumed, so client
  // disconnects must be detected on the response instead: 'close' with an
  // unfinished response means the socket went away mid-stream.
  res.on('close', () => {
    if (!res.writableEnded && !upstream.destroyed) upstream.destroy();
  });
}

module.exports = { openaiError, sendError, pipeSse };
