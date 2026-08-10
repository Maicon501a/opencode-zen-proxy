'use strict';

const { Transform } = require('stream');

function isDoneFrame(frame) {
  return frame.split(/\r?\n/).some((line) => line.trim() === 'data: [DONE]');
}

/**
 * Keep upstream SSE bytes intact until the first OpenAI stream terminator.
 * Anything after data: [DONE] is discarded because it is outside the
 * completion protocol and strict clients may try to parse it as a completion.
 */
function createCompletionSseFilter() {
  let buffer = '';
  let done = false;

  return new Transform({
    transform(chunk, encoding, callback) {
      if (done) return callback();

      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk.toString(encoding);

      while (!done) {
        const separator = /\r?\n\r?\n/.exec(buffer);
        if (!separator) return callback();

        const end = separator.index + separator[0].length;
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end);
        this.push(frame);

        if (isDoneFrame(frame)) {
          done = true;
          buffer = '';
          this.push(null);
        }
      }

      return callback();
    },

    flush(callback) {
      if (!done && buffer) this.push(buffer);
      callback();
    },
  });
}

module.exports = { createCompletionSseFilter };
