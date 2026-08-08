'use strict';

/**
 * End-to-end integration tests for the proxying path, exercising the real
 * server routing through a local mocked upstream instead of the live Zen
 * gateway. This validates the full request lifecycle: auth, model resolution,
 * payload normalization, streaming, and error mapping.
 */

const http = require('http');
const { createApp } = require('../../src/server');
const { config } = require('../../src/config/constants');

function request(app, method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const reqOptions = {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(options.headers || {}),
        },
      };

      const req = http.request(reqOptions, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          server.close();
          const body = Buffer.concat(chunks).toString('utf-8');
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = body;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      });
      req.on('error', reject);
      if (options.body) req.write(JSON.stringify(options.body));
      req.end();
    });
  });
}

/**
 * Start a scriptable upstream HTTP server acting as the Zen gateway.
 * requests is an array where each handler receives (url, body) and returns
 * { status, json } or { status, stream } (raw SSE string).
 */
function startUpstream(handlers) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const handler = handlers.shift();
      const live = handler(server, req, res, Buffer.concat(chunks).toString('utf-8'));
      const { status, json, stream } = live;
      res.statusCode = status;
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.end(stream);
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(json));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('Upstream integration (mocked Zen gateway)', () => {
  let app;
  let upstream;
  let baseUrl;
  const saved = {};

  beforeAll(() => {
    // Snapshot the config values we mutate so we can restore them.
    saved.zenApiBaseUrl = config.zenApiBaseUrl;
    saved.zenApiKey = config.zenApiKey;
    saved.injectTemporalContext = config.injectTemporalContext;
    saved.warpAutoFailover = config.warpAutoFailover;
    saved.autoRouteMultimodal = config.autoRouteMultimodal;

    config.injectTemporalContext = false;
    config.warpAutoFailover = false;
    app = createApp();
  });

  afterAll(async () => {
    config.zenApiBaseUrl = saved.zenApiBaseUrl;
    config.zenApiKey = saved.zenApiKey;
    config.injectTemporalContext = saved.injectTemporalContext;
    config.warpAutoFailover = saved.warpAutoFailover;
    config.autoRouteMultimodal = saved.autoRouteMultimodal;
    if (upstream) upstream.close();
  });

  test('POST /v1/chat/completions forwards a normalized request and returns the response', async () => {
    let received = null;
    upstream = await startUpstream([
      (_server, _req, _res, body) => {
        received = JSON.parse(body);
        return {
          status: 200,
          json: {
            id: 'chatcmpl-1',
            object: 'chat.completion',
            model: received.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'hello' } }],
          },
        };
      },
    ]);
    baseUrl = `http://127.0.0.1:${upstream.address().port}/zen/v1`;
    config.zenApiBaseUrl = baseUrl;

    const res = await request(app, 'POST', '/v1/chat/completions', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer public' },
      body: {
        model: 'opencode/mimo-v2.5',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('mimo-v2.5-free');
    // The alias was resolved and the "opencode/" prefix stripped on the wire.
    expect(received.model).toBe('mimo-v2.5-free');
    // Message payload passed through untouched.
    expect(received.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  test('the upstream receives the configured bearer token', async () => {
    config.zenApiKey = 'public';
    upstream.close();
    let receivedAuth = null;
    upstream = await startUpstream([
      (_server, req, _res) => {
        receivedAuth = req.headers.authorization;
        return {
          status: 200,
          json: { id: 'x', object: 'chat.completion', model: 'mimo-v2.5-free', choices: [] },
        };
      },
    ]);
    config.zenApiBaseUrl = `http://127.0.0.1:${upstream.address().port}/zen/v1`;

    await request(app, 'POST', '/v1/chat/completions', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer anything' },
      body: { model: 'mimo-v2.5', messages: [{ role: 'user', content: 'hi' }] },
    });

    // The proxy sends its own configured key to upstream, overriding the client key.
    expect(receivedAuth).toBe('Bearer public');
  });

  test('streaming responses pass through as SSE', async () => {
    upstream.close();
    upstream = await startUpstream([
      (_req, _res) => {
        const sse = 'data: {"id":"x","choices":[{"delta":{"content":"hi"}}]}\n\n';
        return { status: 200, stream: sse };
      },
    ]);
    config.zenApiBaseUrl = `http://127.0.0.1:${upstream.address().port}/zen/v1`;

    const res = await request(app, 'POST', '/v1/chat/completions', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer public' },
      body: {
        model: 'deepseek-v4-flash-free',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch('text/event-stream');
    expect(res.body).toContain('"delta"');
    expect(res.body).toContain('"content":"hi"');
  });

  test('upstream errors are mapped to the OpenAI error envelope', async () => {
    upstream.close();
    upstream = await startUpstream([
      (_req, _res) => ({
        status: 401,
        json: { type: 'error', error: { type: 'AuthError', message: 'bad key' } },
      }),
    ]);
    config.zenApiBaseUrl = `http://127.0.0.1:${upstream.address().port}/zen/v1`;

    const res = await request(app, 'POST', '/v1/chat/completions', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer public' },
      body: {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('bad key');
    expect(typeof res.body.error.type).toBe('string');
  });

  test('image to a text-only model returns a clear 400 (no upstream call)', async () => {
    config.autoRouteMultimodal = false;
    upstream.close();
    let called = false;
    upstream = await startUpstream([
      () => {
        called = true;
        return { status: 200, json: { id: 'x', choices: [] } };
      },
    ]);
    config.zenApiBaseUrl = `http://127.0.0.1:${upstream.address().port}/zen/v1`;

    const res = await request(app, 'POST', '/v1/chat/completions', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer public' },
      body: {
        model: 'deepseek-v4-flash-free',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
      },
    });

    expect(called).toBe(false);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('model_does_not_support_content');
    expect(res.body.error.message).toContain('mimo-v2.5-free');
  });

  test('with AUTO_ROUTE_MULTIMODAL, image requests route to the multimodal model', async () => {
    config.autoRouteMultimodal = true;
    upstream.close();
    let received = null;
    upstream = await startUpstream([
      (_server, _req, _res, body) => {
        received = JSON.parse(body);
        return {
          status: 200,
          json: { id: 'x', object: 'chat.completion', model: received.model, choices: [] },
        };
      },
    ]);
    config.zenApiBaseUrl = `http://127.0.0.1:${upstream.address().port}/zen/v1`;

    const res = await request(app, 'POST', '/v1/chat/completions', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer public' },
      body: {
        model: 'deepseek-v4-flash-free',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
          },
        ],
      },
    });

    expect(res.status).toBe(200);
    // The wire model was switched to the multimodal free model.
    expect(received.model).toBe('mimo-v2.5-free');
    expect(res.body.model).toBe('mimo-v2.5-free');
    // Images still forwarded intact.
    expect(received.messages[0].content[0].type).toBe('image_url');
  });
});