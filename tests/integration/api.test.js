'use strict';

/**
 * Integration tests for the OpenCode Zen Proxy API.
 *
 * These tests verify the proxy routes, validation and model metadata without
 * touching the network (the live Zen catalog fetch is stubbed out).
 *
 * To run: pnpm test
 */

const http = require('http');
const { createApp } = require('../../src/server');
const zen = require('../../src/services/zenClient');

// Helper to make requests without starting a server
function request(app, method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const addr = `http://127.0.0.1:${port}`;

      const url = new URL(path, addr);
      const reqOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
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
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: parsed,
          });
        });
      });

      req.on('error', (err) => {
        server.close();
        reject(err);
      });

      if (options.body) {
        req.write(JSON.stringify(options.body));
      }
      req.end();
    });
  });
}

describe('API Integration Tests', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    // The model listing endpoint tries the live Zen catalog first. Keep the
    // suite hermetic: force the curated free-list fallback.
    jest.spyOn(zen, 'fetchModels').mockRejectedValue(new Error('offline (test)'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const res = await request(app, 'GET', '/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('opencode-zen-proxy');
    });
  });

  describe('GET /', () => {
    it('should return service info', async () => {
      const res = await request(app, 'GET', '/');
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('OpenCode Zen Proxy');
    });
  });

  describe('GET /docs', () => {
    it('should return documentation', async () => {
      const res = await request(app, 'GET', '/docs');
      expect(res.status).toBe(200);
      expect(res.body.service).toBe('OpenCode Zen Proxy');
      expect(res.body.freeModels).toBeInstanceOf(Array);
      expect(res.body.freeModels.length).toBeGreaterThan(0);
      expect(res.body.usage['Reasoning effort'].field).toBe('reasoning_effort');
    });
  });

  describe('GET /v1/models (keyless)', () => {
    it('should return 200 without auth header (keyless mode)', async () => {
      const res = await request(app, 'GET', '/v1/models');
      expect(res.status).toBe(200);
    });

    it('should return 200 with any auth header (keyless mode)', async () => {
      const res = await request(app, 'GET', '/v1/models', {
        headers: { Authorization: 'Bearer anything' },
      });
      expect(res.status).toBe(200);
    });
  });

  describe('GET /v1/models (authenticated)', () => {
    it('should return model list with valid auth', async () => {
      // With any non-empty Bearer token (we don't validate content unless ZEN_API_KEY is set)
      const res = await request(app, 'GET', '/v1/models', {
        headers: { Authorization: 'Bearer test-key' },
      });
      expect(res.status).toBe(200);
      expect(res.body.object).toBe('list');
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBeGreaterThan(4);

      // Verify model structure
      const model = res.body.data[0];
      expect(model.id).toBeDefined();
      expect(model.object).toBe('model');
    });
  });

  describe('GET /v1/models/:id (authenticated)', () => {
    it('should return specific model details', async () => {
      const res = await request(app, 'GET', '/v1/models/opencode/deepseek-v4.1-flash-free', {
        headers: { Authorization: 'Bearer test-key' },
      });
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('opencode/deepseek-v4.1-flash-free');
    });

    it('should return 404 for unknown model', async () => {
      const res = await request(app, 'GET', '/v1/models/nonexistent-model', {
        headers: { Authorization: 'Bearer test-key' },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /v1/models/free (authenticated)', () => {
    it('should return free models list', async () => {
      const res = await request(app, 'GET', '/v1/models/free', {
        headers: { Authorization: 'Bearer test-key' },
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBeGreaterThanOrEqual(5);
      // All should be free
      for (const model of res.body.data) {
        expect(model.free).toBe(true);
      }
    });
  });

  describe('POST /v1/chat/completions (validation)', () => {
    it('should return 400 if model is missing', async () => {
      const res = await request(app, 'POST', '/v1/chat/completions', {
        headers: {
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        },
        body: {
          messages: [{ role: 'user', content: 'Hello' }],
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.param).toBe('model');
    });

    it('should return 400 if messages is missing', async () => {
      const res = await request(app, 'POST', '/v1/chat/completions', {
        headers: {
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        },
        body: {
          model: 'test-model',
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.param).toBe('messages');
    });

    it('should return 400 if messages is empty', async () => {
      const res = await request(app, 'POST', '/v1/chat/completions', {
        headers: {
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        },
        body: {
          model: 'test-model',
          messages: [],
        },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /v1/responses (validation)', () => {
    it('should return 400 if model is missing', async () => {
      const res = await request(app, 'POST', '/v1/responses', {
        headers: { 'Content-Type': 'application/json' },
        body: { input: 'Hello' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.param).toBe('model');
    });

    it('should reject a non-object body', async () => {
      const res = await request(app, 'POST', '/v1/responses', {
        headers: { 'Content-Type': 'application/json' },
        body: 'nope',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('free model metadata', () => {
    it('exposes the API mode and effort vocabulary per model', async () => {
      const res = await request(app, 'GET', '/v1/models/free');
      expect(res.status).toBe(200);

      const muse = res.body.data.find((m) => m.id === 'opencode/muse-spark-1.3-contributor-free');
      expect(muse.apiMode).toBe('responses');
      expect(muse.endpoint).toBe('/v1/responses');

      const chat = res.body.data.find((m) => m.id === 'opencode/deepseek-v4.1-flash-free');
      expect(chat.apiMode).toBe('chat');
      expect(chat.reasoningEfforts).toEqual(['low', 'high', 'max']);
    });

    it('resolves aliases and effort suffixes on the detail endpoint', async () => {
      const res = await request(app, 'GET', '/v1/models/space-bunny');
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('opencode/space-bunny-free');
    });
  });

  describe('404 handling', () => {
    it('should return 404 for unknown routes', async () => {
      const res = await request(app, 'GET', '/unknown-route');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('route_not_found');
    });
  });
});
