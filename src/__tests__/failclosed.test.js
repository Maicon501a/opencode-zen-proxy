'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

jest.setTimeout(20000);

/**
 * Fail-closed egress tests.
 *
 * Regression guard for the silent-direct-dial bug: when an attempt's mode
 * promises an isolated egress (tor/warp) but the SOCKS endpoint is missing or
 * unreachable, the proxy must surface a network failure — the upstream must
 * NEVER be contacted over the machine's own route while stats still record
 * the isolated mode.
 */

function startUpstream() {
  return new Promise((resolve) => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      hits: () => hits,
    }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

describe('fail-closed egress', () => {
  let zen;
  let root;

  beforeAll(async () => {
    zen = await startUpstream();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-proxy-failclosed-'));
  });

  afterAll(async () => {
    await closeServer(zen.server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('openRequest rejects mode=tor without a SOCKS endpoint and never dials upstream', async () => {
    jest.resetModules();
    delete process.env.TOR_SOCKS;
    delete process.env.UPSTREAM_SOCKS5;

    const zenClient = require('../services/zenClient');
    const transport = require('../services/transport');
    transport.update({ socks5: null });

    const endpoint = { protocol: 'http:', hostname: '127.0.0.1', port: zen.port, path: '/probe' };
    await expect(
      zenClient.openRequest({ endpoint, headers: {}, body: null, mode: 'tor' })
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });

    expect(zen.hits()).toBe(0);
  });

  it('openRequest keeps the explicit direct mode working', async () => {
    jest.resetModules();
    const zenClient = require('../services/zenClient');

    const endpoint = { protocol: 'http:', hostname: '127.0.0.1', port: zen.port, path: '/probe' };
    const res = await zenClient.openRequest({ endpoint, headers: {}, body: null, mode: 'direct' });
    expect(res.statusCode).toBe(200);
    res.resume();
    await new Promise((resolve) => res.on('end', resolve));

    expect(zen.hits()).toBe(1);
  });

  it('a request through an unreachable tor endpoint fails without leaking direct', async () => {
    jest.resetModules();
    const deadPort = await freePort();

    process.env.TOR_SOCKS = `socks5://127.0.0.1:${deadPort}`;
    process.env.ZEN_API_BASE_URL = `http://127.0.0.1:${zen.port}`;
    process.env.PROXY_DATA_DIR = path.join(root, 'unreachable');
    process.env.WARP_AUTO_FAILOVER = 'false';
    delete process.env.IP_ROTATE_URL;

    const zenClient = require('../services/zenClient');
    const before = zen.hits();

    await expect(zenClient.createChatCompletion({
      model: 'deepseek-v4.1-flash-free',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(/Failed to reach the Zen API/);

    expect(zen.hits()).toBe(before);
  });

  it('probeSocks resolves on a live listener and rejects on a dead port', async () => {
    jest.resetModules();
    const warp = require('../services/warp');

    const live = net.createServer();
    await new Promise((resolve) => live.listen(0, '127.0.0.1', resolve));
    const port = live.address().port;

    await expect(warp.probeSocks('127.0.0.1', port)).resolves.toBeUndefined();

    await new Promise((resolve) => live.close(resolve));
    await expect(warp.probeSocks('127.0.0.1', port, 500)).rejects.toThrow(/not accepting connections/);
  });
});
