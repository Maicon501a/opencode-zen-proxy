'use strict';

const { Transform } = require('stream');

/**
 * SSE usage tap.
 *
 * The gate forces `stream: true` upstream even when the client asked for a
 * plain JSON answer, and clients that DO stream get the raw SSE — so token
 * usage for streamed requests only exists inside the event stream.
 *
 * This tap sits between the upstream response and whoever consumes it (the
 * raw pipe or a dialect translator): every byte passes through unchanged, and
 * on the side it scans `data:` payloads for the terminal usage object of both
 * dialects:
 *
 *   chat/completions → any chunk with a non-empty `usage`
 *   responses        → `response.completed` / `response.incomplete` events
 *
 * `onEnd` fires exactly once, when the stream finishes, errors or is
 * destroyed (client aborted). The callback receives the last seen usage in
 * whichever dialect it arrived plus an `aborted` flag.
 *
 * @param {import('stream').Readable} upstream real upstream response
 * @param {{ onEnd: (info: {usage: object|null, aborted: boolean, error: string|null, bytes: number}) => void }} hooks
 * @returns {Transform}
 */
function tapSseUsage(upstream, { onEnd } = {}) {
  let buffer = '';
  let usage = null;
  let bytes = 0;
  let finalized = false;
  let aborted = false;
  let errorMessage = null;

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    if (typeof onEnd === 'function') {
      onEnd({ usage, aborted, error: errorMessage, bytes });
    }
  };

  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      // Scanning is best-effort: parsing problems never abort the stream.
      try {
        buffer += chunk.toString('utf8');
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
          buffer = buffer.slice(newlineIndex + 1);
          if (line.startsWith('data:')) {
            const payload = line.slice('data:'.length).trim();
            if (payload !== '' && payload !== '[DONE]') {
              try {
                const event = JSON.parse(payload);
                if (event && typeof event === 'object') {
                  if (event.usage && typeof event.usage === 'object' && Object.keys(event.usage).length > 0) {
                    usage = event.usage;
                  }
                  if (
                    (event.type === 'response.completed' || event.type === 'response.incomplete')
                    && event.response
                    && event.response.usage
                  ) {
                    usage = event.response.usage;
                  }
                  if (event.type === 'response.failed' || event.type === 'error') {
                    errorMessage = 'upstream stream reported an error event';
                  }
                }
              } catch {
                // partial or non-JSON payload — ignore
              }
            }
          }
        }
        // Cap the scan buffer: a pathological stream without newlines should
        // not grow memory unboundedly.
        if (buffer.length > 256 * 1024) buffer = buffer.slice(-4096);
      } catch {
        // never fail the stream because of stats scanning
      }
      callback(null, chunk);
    },

    flush(callback) {
      finalize();
      callback();
    },

    destroy(err, callback) {
      // Distinguish "client went away / aborted" from "upstream errored".
      if (err) errorMessage = err.message || String(err);
      aborted = true;
      finalize();
      callback(err);
    },
  });

  // Propagate an upstream error into the tap so consumers see it, and make
  // sure destroying the tap tears the real upstream down (pipe() alone does
  // not forward destroy/error across the boundary).
  upstream.on('error', (err) => {
    if (!finalized) {
      errorMessage = err.message || String(err);
    }
    tap.destroy(err);
  });
  tap.once('close', () => {
    if (!upstream.destroyed) upstream.destroy();
    finalize();
  });

  return tap;
}

module.exports = { tapSseUsage };
