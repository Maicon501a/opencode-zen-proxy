'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

jest.setTimeout(30000);

/**
 * End-to-end egress test.
 *
 * A miniature SOCKS5 proxy stands in for the desktop app's embedded Tor; a
 * mock Zen gateway stands in for opencode.ai. The scenario:
 *
 *   1. request #1 → 429 (rate limited)
 *   2. the proxy asks the rotate manager for a fresh circuit
 *   3. request #2 → 200 SSE, folded back into a chat.completion
 *
 * Asserts the egress really went through SOCKS (the mock only listens on the
 * loopback interface the SOCKS tunnel can reach), the gate shapes the body
 * (stream:true + `read` tool + CLI user-agent) and the stats store counted the
 * rate limit, the rotation and the folded tokens.
 */

// ---------------------------------------------------------------------------
// Mini SOCKS5 server (CONNECT only, no auth) — the test's "Tor".
// ---------------------------------------------------------------------------

function startSocksServer() {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let stage = 'greeting';
      let buffer = Buffer.alloc(0);

      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        if (stage === 'greeting') {
          if (buffer.length < 2) return;
          const methods = buffer[1];
          if (buffer.length < 2 + methods) return;
          buffer = buffer.subarray(2 + methods);
          socket.write(Buffer.from([0x05, 0x00]));
          stage = 'request';
        }

        if (stage === 'request') {
          if (buffer.length < 4) return;
          const atyp = buffer[3];
          let host;
          let port;
          let headerLen;

          if (atyp === 0x01) {
            if (buffer.length < 10) return;
            host = Array.from(buffer.subarray(4, 8)).join('.');
            port = buffer.readUInt16BE(8);
            headerLen = 10;
          } else if (atyp === 0x03) {
            const nameLen = buffer[4];
            if (buffer.length < 7 + nameLen) return;
            host = buffer.subarray(5, 5 + nameLen).toString('utf8');
            port = buffer.readUInt16BE(5 + nameLen);
            headerLen = 7 + nameLen;
          } else {
            socket.destroy();
            return;
          }

          const rest = buffer.subarray(headerLen);
          stage = 'connected';
          socket.removeListener('data', onData);

          const target = net.connect(port, host, () => {
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            if (rest.length > 0) target.write(rest);
            socket.pipe(target);
            target.pipe(socket);
          });
          target.on('error', () => socket.destroy());
        }
      };

      socket.on('data', onData);
      socket.on('error', () => {});
    });

    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, sockets }));
  });
}

function closeServer(server, sockets) {
  return new Promise((resolve) => {
    if (sockets) {
      for (const socket of sockets) socket.destroy();
    }
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------

describe('egress isolation with rotation on rate limit', () => {
  let root;
  let socks;
  let zen;
  let manager;
  let zenCalls;
  let zenFailOnce;
  let managerCalls;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-proxy-egress-'));

    socks = await startSocksServer();

    zenCalls = [];
    zenFailOnce = true;
    zen = await new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          zenCalls.push({ url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') });

          if (zenFailOnce) {
            zenFailOnce = false;
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'RateLimited', message: 'slow down' } }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: 1700000000,
            model: 'deepseek-v4.1-flash-free',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
          })}\n\n`);
          res.write(`data: ${JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: 1700000000,
            model: 'deepseek-v4.1-flash-free',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });

    managerCalls = [];
    manager = await new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          managerCalls.push({ headers: req.headers, body: JSON.parse(raw || '{}') });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ip: '203.0.113.9', changed: true, message: 'fresh circuit' }));
        });
      });
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
  });

  afterAll(async () => {
    await closeServer(socks.server, socks.sockets);
    await closeServer(zen.server);
    await closeServer(manager.server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rotates the exit and replays through the fresh circuit', async () => {
    jest.resetModules();
    process.env.PROXY_DATA_DIR = root;
    process.env.ZEN_API_BASE_URL = `http://127.0.0.1:${zen.port}`;
    process.env.TOR_SOCKS = `socks5://127.0.0.1:${socks.port}`;
    process.env.IP_ROTATE_URL = `http://127.0.0.1:${manager.port}/rotate`;
    process.env.IP_ROTATE_TOKEN = 'egress-token';
    process.env.IP_ROTATE_MIN_GAP_MS = '0';
    process.env.IP_ROTATE_TIMEOUT_MS = '10000';
    process.env.WARP_AUTO_FAILOVER = 'false';
    delete process.env.ADMIN_TOKEN;

    const zenClient = require('../services/zenClient');
    const stats = require('../services/stats');

    const result = await zenClient.createChatCompletion({
      model: 'deepseek-v4.1-flash-free',
      messages: [{ role: 'user', content: 'hi' }],
    });

    // ---- the response was folded back to a chat.completion ----
    expect(result.mode).toBe('json');
    expect(result.body.choices[0].message.content).toBe('ok');
    expect(result.body.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });

    // ---- exactly one 429 then one replay, both through SOCKS ----
    expect(zenCalls).toHaveLength(2);

    // ---- the gate still shapes every upstream request ----
    for (const call of zenCalls) {
      expect(call.body.stream).toBe(true);
      expect(Array.isArray(call.body.tools)).toBe(true);
      expect(call.body.tools.some((tool) => tool.function && tool.function.name === 'read')).toBe(true);
      expect(call.headers['user-agent']).toMatch(/^opencode\//);
      expect(call.headers['x-opencode-session']).toMatch(/^ses_/);
    }

    // ---- the manager rotated exactly once, with the admin token ----
    expect(managerCalls).toHaveLength(1);
    expect(managerCalls[0].headers['x-admin-token']).toBe('egress-token');
    expect(managerCalls[0].body.reason).toMatch(/429/);

    // ---- stats counted the rate limit, the rotation and the tokens ----
    const snapshot = stats.snapshot();
    expect(snapshot.totals.requests).toBe(1);
    expect(snapshot.totals.ok).toBe(1);
    expect(snapshot.totals.rateLimits).toBe(1);
    expect(snapshot.totals.rotations).toBe(1);
    expect(snapshot.totals.promptTokens).toBe(5);
    expect(snapshot.totals.completionTokens).toBe(2);
    expect(snapshot.events.some((event) => event.type === 'rotation')).toBe(true);
    const requestEvent = snapshot.events.find((event) => event.type === 'request');
    expect(requestEvent.egress).toBe('tor');
    expect(requestEvent.rateLimited).toBe(true);

    // ---- the 429 body, headers and message were captured for inspection ----
    expect(snapshot.lastRejection).toBeTruthy();
    expect(snapshot.lastRejection.status).toBe(429);
    expect(snapshot.lastRejection.model).toBe('deepseek-v4.1-flash-free');
    expect(snapshot.lastRejection.retryAfter).toBe('30');
    expect(snapshot.lastRejection.message).toBe('slow down');
    expect(snapshot.lastRejection.body).toContain('slow down');
    expect(snapshot.lastRejection.headers['content-type']).toContain('application/json');
    expect(requestEvent.upstream.status).toBe(429);
  });

  it('does not rotate when the upstream is healthy', async () => {
    zenCalls.length = 0;
    managerCalls.length = 0;
    zenFailOnce = false;

    jest.resetModules();
    process.env.PROXY_DATA_DIR = path.join(root, 'healthy');
    process.env.ZEN_API_BASE_URL = `http://127.0.0.1:${zen.port}`;
    process.env.TOR_SOCKS = `socks5://127.0.0.1:${socks.port}`;
    process.env.IP_ROTATE_URL = `http://127.0.0.1:${manager.port}/rotate`;
    process.env.IP_ROTATE_MIN_GAP_MS = '0';
    process.env.WARP_AUTO_FAILOVER = 'false';

    const zenClient = require('../services/zenClient');
    await zenClient.createChatCompletion({
      model: 'space-bunny-free',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(zenCalls).toHaveLength(1);
    expect(managerCalls).toHaveLength(0);
  });
});
