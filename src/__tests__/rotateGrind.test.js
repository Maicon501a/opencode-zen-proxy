'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

jest.setTimeout(30000);

/**
 * Rotate-and-replay grind tests.
 *
 * The proxy must never kill a request over a burned exit while rotation is
 * available: it keeps cycling circuits and replaying until one passes,
 * bounded only by the rotate retry policy (IP_ROTATE_MAX /
 * IP_ROTATE_RETRY_DEADLINE_MS) and by the client hanging up.
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

describe('rotate grind (burned exits never kill the request)', () => {
  let root;
  let socks;
  let zen;
  let manager;
  let zenCalls;
  let zen429Left;
  let managerCalls;
  let managerRefusalsLeft;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-proxy-grind-'));

    socks = await startSocksServer();

    zenCalls = [];
    zen429Left = 0;
    zen = await new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
          zenCalls.push({ url: req.url });

          if (zen429Left > 0) {
            zen429Left -= 1;
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'RateLimited', message: 'burned exit' } }));
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
    managerRefusalsLeft = 0;
    manager = await new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          managerCalls.push({ headers: req.headers, body: JSON.parse(raw || '{}') });
          res.writeHead(200, { 'Content-Type': 'application/json' });

          if (managerRefusalsLeft > 0) {
            managerRefusalsLeft -= 1;
            res.end(JSON.stringify({ error: 'cooldown de rotacao ativo' }));
            return;
          }

          res.end(JSON.stringify({ ip: `203.0.113.${managerCalls.length}`, changed: true, message: 'fresh circuit' }));
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

  function configure(env) {
    jest.resetModules();
    process.env.PROXY_DATA_DIR = path.join(root, `case-${Math.random().toString(36).slice(2)}`);
    process.env.ZEN_API_BASE_URL = `http://127.0.0.1:${zen.port}`;
    process.env.TOR_SOCKS = `socks5://127.0.0.1:${socks.port}`;
    process.env.IP_ROTATE_URL = `http://127.0.0.1:${manager.port}/rotate`;
    process.env.IP_ROTATE_MIN_GAP_MS = '0';
    process.env.IP_ROTATE_TIMEOUT_MS = '10000';
    process.env.WARP_AUTO_FAILOVER = 'false';
    delete process.env.ADMIN_TOKEN;
    delete process.env.IP_ROTATE_MAX;
    delete process.env.IP_ROTATE_RETRY_DEADLINE_MS;
    Object.assign(process.env, env || {});
  }

  it('keeps rotating until a clean exit passes', async () => {
    configure();
    zen429Left = 3;
    managerRefusalsLeft = 0;
    zenCalls.length = 0;
    managerCalls.length = 0;

    const zenClient = require('../services/zenClient');
    const stats = require('../services/stats');

    const result = await zenClient.createChatCompletion({
      model: 'deepseek-v4.1-flash-free',
      messages: [{ role: 'user', content: 'hi' }],
    });

    // ---- the fourth attempt (third fresh circuit) folded back a 200 ----
    expect(result.body.choices[0].message.content).toBe('ok');
    expect(zenCalls).toHaveLength(4);
    expect(managerCalls).toHaveLength(3);

    // ---- stats counted every rotation and the replay outcome ----
    const snapshot = stats.snapshot();
    expect(snapshot.totals.requests).toBe(1);
    expect(snapshot.totals.ok).toBe(1);
    expect(snapshot.totals.rotations).toBe(3);
    const requestEvent = snapshot.events.find((event) => event.type === 'request');
    expect(requestEvent.egress).toBe('tor');
    expect(requestEvent.rotations).toBe(3);
  });

  it('waits out a refused rotation instead of killing the request', async () => {
    configure();
    zen429Left = 1;
    managerRefusalsLeft = 1; // first NEWNYM refused (cooldown), second passes
    zenCalls.length = 0;
    managerCalls.length = 0;

    const zenClient = require('../services/zenClient');

    const result = await zenClient.createChatCompletion({
      model: 'deepseek-v4.1-flash-free',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.body.choices[0].message.content).toBe('ok');
    expect(managerCalls).toHaveLength(2);
    expect(zenCalls).toHaveLength(2);
  });

  it('gives up only when the rotate cap is exhausted', async () => {
    configure({ IP_ROTATE_MAX: '2' });
    zen429Left = 99; // every exit is burned
    managerRefusalsLeft = 0;
    zenCalls.length = 0;
    managerCalls.length = 0;

    const zenClient = require('../services/zenClient');

    await expect(zenClient.createChatCompletion({
      model: 'deepseek-v4.1-flash-free',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toMatchObject({ statusCode: 429, rotations: 2 });

    expect(zenCalls).toHaveLength(3); // initial + 2 replays
    expect(managerCalls).toHaveLength(2);
  });
});
