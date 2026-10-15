'use strict';

const crypto = require('crypto');
const { config, ZEN_GATE } = require('../config/constants');

/**
 * OpenCode Zen free-tier gate.
 *
 * Reverse-engineered against the official OpenCode 2 client (v2.0.29) and
 * confirmed with a live bisection of https://opencode.ai/zen/v1 (2026-10-15).
 * Since 2026-09-23 the Zen edge rejects third-party clients for free models
 * with `HTTP 403 FreeTierError` ("can only be used from within OpenCode").
 *
 * A live capture of the real client showed the full request (headers + body).
 * Removing piece after piece proved the 403 is decided by exactly two things:
 *
 *   1. `User-Agent` must carry an `opencode/...` prefix
 *      (e.g. `opencode/latest/2.0.29/cli`). Any other UA → 403.
 *   2. `X-Opencode-Session` must hold an `ascending` id minted the way the
 *      official CLI mints them — `ses_` + 12 hex chars + 14 base62 chars, where
 *      the hex part is a *time encoding*:
 *
 *          stamp = (0x1b000000046ffe - unix_ms * 4096) mod 2^48
 *
 *      The edge decodes that stamp back into a mint time. Ids whose prefix is
 *      random (the shape the port used before) are rejected with the same 403,
 *      while ids minted by the formula are accepted — even a full day old.
 *   3. The JSON body must contain a function tool named `read`. `shell` is NOT
 *      required any more (removing it still yielded 200), and an empty object
 *      schema is fine. Any `read` tool (client-provided or injected) satisfies
 *      it; a tool literally named `readX` does not.
 *
 * Everything else present in the live capture is OPTIONAL and was kept only so
 * the traffic stays indistinguishable from the real client:
 *
 *   - `b3` + `traceparent` — removing them still returned 200.
 *   - `x-opencode-client`, `x-opencode-project`, `x-opencode-session-id`,
 *     `x-session-affinity`, `x-session-id` — each was dropped in turn, still 200.
 *   - `Authorization: Bearer public` — omitting it still returned 200; a wrong
 *     bearer (`Bearer xxx`) hits the paid-path credential check and fails with
 *     `Invalid credential`. The keyless free tier is `public`.
 *
 * The same recipe works for BOTH dialects: `/chat/completions` (chat models)
 * and `/responses` (Muse Spark contributor models).
 */

const SESSION_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SESSION_PREFIX = 'ses_';
const SESSION_FORMAT = /^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/;

/**
 * `ascending` id clock. Lifted from the session ids the official CLI writes to
 * its own DB: `hex48(EPOCH - unix_ms * 4096)` matches `session.time_created`
 * with under 70 ms of lag across weeks of samples.
 */
const SESSION_EPOCH = 0x1b000000046ffen; // 7599824371478526
const SESSION_TICK = 4096n; // one millisecond of mint time
const SESSION_MASK = 0xffffffffffffn; // the id carries a 48-bit time stamp

/** The 12-hex prefix an official client would mint at `atMs`. */
function zenSessionStamp(atMs) {
  return ((SESSION_EPOCH - BigInt(atMs) * SESSION_TICK) & SESSION_MASK)
    .toString(16)
    .padStart(12, '0');
}

/**
 * Decode the mint time (unix ms) carried by a session id prefix.
 * Returns the integer ms value, or null when the id is malformed.
 */
function zenSessionMintTime(value) {
  if (!isZenSessionId(value)) return null;
  const stamp = BigInt(`0x${value.slice(SESSION_PREFIX.length, SESSION_PREFIX.length + 12)}`);
  return Number((SESSION_EPOCH - stamp) / SESSION_TICK);
}

/**
 * Mint a session id exactly like the official 2.0.29 client:
 *
 *   `ses_` + hex48(EPOCH - now_ms * 4096) + 14 random alphanumeric chars
 *
 * @param {number} [atMs] mint time override (tests)
 */
function newZenSessionId(atMs = Date.now()) {
  const bytes = crypto.randomBytes(14);
  let tail = '';
  for (let i = 0; i < 14; i += 1) {
    tail += SESSION_ALPHABET[bytes[i] % SESSION_ALPHABET.length];
  }
  return `${SESSION_PREFIX}${zenSessionStamp(atMs)}${tail}`;
}

/** Validate a session id against the official format. */
function isZenSessionId(value) {
  return typeof value === 'string' && SESSION_FORMAT.test(value);
}

/**
 * Headers that make the request look like the official OpenCode 2 CLI.
 * A fresh session id is generated on every call; the required bits are the
 * `opencode/...` User-Agent and the well-minted `X-Opencode-Session`.
 */
function zenGateHeaders() {
  const session = newZenSessionId();
  return {
    'User-Agent': ZEN_GATE.clientUa,
    'X-Opencode-Client': ZEN_GATE.clientHeader,
    'X-Opencode-Project': ZEN_GATE.projectHeader,
    'X-Opencode-Session': session,
    'X-Opencode-Session-Id': session,
    'X-Session-Affinity': session,
    'X-Session-Id': session,
  };
}

/** Authorization header for the Zen gateway (`Bearer public` by default). */
function zenAuthHeader() {
  return `Bearer ${config.zenApiKey}`;
}

/**
 * The gate tool payload appended when the client did not send a tool with the
 * required name. `chat: true` selects the chat/completions shape (nested under
 * `function`); `chat: false` selects the Responses shape (flat `name`).
 */
function gateTool(name, chat) {
  if (chat) {
    return {
      type: 'function',
      function: {
        name,
        description: `${name} tool`,
        parameters: { type: 'object', properties: {} },
      },
    };
  }
  return {
    type: 'function',
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
  };
}

/** Collect the function tool names present in a body. */
function toolNames(body, chat) {
  const names = new Set();
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    if (chat) {
      const fn = tool.function;
      if (fn && typeof fn === 'object' && typeof fn.name === 'string' && fn.name !== '') {
        names.add(fn.name);
      }
    } else if (typeof tool.name === 'string' && tool.name !== '') {
      names.add(tool.name);
    }
  }
  return names;
}

/**
 * Rewrite a Zen request body so it passes the free-tier gate: force streaming
 * and append the required function tools (`read` by default) when missing.
 *
 * Mutates and returns `body`. Non-object input is returned untouched.
 *
 * @param {object} body parsed JSON request body
 * @param {object} [options]
 * @param {boolean} [options.chat=true] chat/completions shape (vs Responses)
 * @returns {object} the gated body
 */
function applyZenGate(body, options = {}) {
  const chat = options.chat !== false;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;

  // The free tier only answers streamed requests, even when the downstream
  // client asked for a plain JSON response — the proxy folds the SSE back.
  body.stream = true;

  const tools = Array.isArray(body.tools) ? body.tools.slice() : [];
  const present = toolNames(body, chat);
  for (const name of ZEN_GATE.toolNames) {
    if (present.has(name)) continue;
    tools.push(gateTool(name, chat));
  }
  body.tools = tools;

  // Gateway accounting: ask for the usage block on the final chunk so a folded
  // non-streaming response still carries token counts.
  if (!body.stream_options || typeof body.stream_options !== 'object') {
    body.stream_options = { include_usage: true };
  } else if (body.stream_options.include_usage === undefined) {
    body.stream_options.include_usage = true;
  }

  // The Responses endpoint rejects the chat-only knob.
  if (!chat) delete body.stream_options;

  return body;
}

module.exports = {
  SESSION_ALPHABET,
  SESSION_EPOCH,
  zenSessionStamp,
  zenSessionMintTime,
  newZenSessionId,
  isZenSessionId,
  zenGateHeaders,
  zenAuthHeader,
  applyZenGate,
  toolNames,
};
