'use strict';

const http = require('http');

/**
 * Transport manager tests — SOCKS parsing, runtime updates and the rotate
 * client against a local fake manager.
 */

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function loadTransport(env = {}) {
  jest.resetModules();
  delete process.env.TOR_SOCKS;
  delete process.env.UPSTREAM_SOCKS5;
  delete process.env.IP_ROTATE_URL;
  delete process.env.IP_ROTATE_TOKEN;
  delete process.env.IP_ROTATE_MIN_GAP_MS;
  delete process.env.IP_ROTATE_TIMEOUT_MS;
  delete process.env.PROXY_DATA_DIR;
  Object.assign(process.env, env);
  return require('../services/transport');
}

describe('parseSocks', () => {
  it('accepts host:port and socks5:// forms', () => {
    const transport = loadTransport();
    expect(transport.parseSocks('127.0.0.1:19050')).toEqual({ host: '127.0.0.1', port: 19050 });
    expect(transport.parseSocks('socks5://127.0.0.1:19050')).toEqual({ host: '127.0.0.1', port: 19050 });
    expect(transport.parseSocks('socks5h://localhost:9050/')).toEqual({ host: 'localhost', port: 9050 });
    expect(transport.parseSocks('[::1]:9050')).toEqual({ host: '::1', port: 9050 });
  });

  it('rejects garbage', () => {
    const transport = loadTransport();
    expect(transport.parseSocks('')).toBeNull();
    expect(transport.parseSocks('127.0.0.1')).toBeNull();
    expect(transport.parseSocks('host:notaport')).toBeNull();
    expect(transport.parseSocks('host:99999')).toBeNull();
  });
});

describe('runtime updates', () => {
  it('toggles isolation through update()', () => {
    const transport = loadTransport();
    expect(transport.status().isolated).toBe(false);

    transport.update({ socks5: '127.0.0.1:19050', rotateOnRateLimit: true });
    expect(transport.status().isolated).toBe(true);
    expect(transport.socksEndpoint()).toEqual({ host: '127.0.0.1', port: 19050 });

    transport.update({ socks5: null });
    expect(transport.status().isolated).toBe(false);
    expect(transport.socksEndpoint()).toBeNull();
  });

  it('initializes from the environment', () => {
    const transport = loadTransport({
      TOR_SOCKS: 'socks5://127.0.0.1:29999',
      IP_ROTATE_URL: 'http://127.0.0.1:1/rotate',
    });
    expect(transport.status().isolated).toBe(true);
    expect(transport.status().socks5).toBe('127.0.0.1:29999');
    expect(transport.hasRotate()).toBe(true);
  });
});

describe('rotate()', () => {
  it('reports unavailable without an endpoint', async () => {
    const transport = loadTransport();
    const result = await transport.rotate('test');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no rotate endpoint/);
  });

  it('calls the manager with the admin token and surfaces the new IP', async () => {
    const seen = [];
    const { server, port } = await listen((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        seen.push({ token: req.headers['x-admin-token'], body: JSON.parse(raw || '{}') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ip: '203.0.113.7', changed: true, message: 'new circuit' }));
      });
    });

    try {
      const transport = loadTransport({
        IP_ROTATE_URL: `http://127.0.0.1:${port}/rotate`,
        IP_ROTATE_TOKEN: 'secret-token',
        IP_ROTATE_MIN_GAP_MS: '0',
      });
      const result = await transport.rotate('unit test');
      expect(result.ok).toBe(true);
      expect(result.ip).toBe('203.0.113.7');
      expect(result.changed).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0].token).toBe('secret-token');
      expect(seen[0].body.reason).toBe('unit test');

      const status = transport.status();
      expect(status.rotateCount).toBe(1);
      expect(status.lastRotateIp).toBe('203.0.113.7');
      expect(status.lastRotateError).toBeNull();
    } finally {
      await close(server);
    }
  });

  it('surfaces manager errors', async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'tor disabled' }));
    });

    try {
      const transport = loadTransport({
        IP_ROTATE_URL: `http://127.0.0.1:${port}/rotate`,
        IP_ROTATE_MIN_GAP_MS: '0',
      });
      const result = await transport.rotate('unit test');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/tor disabled/);
      expect(transport.status().lastRotateError).toMatch(/tor disabled/);
      expect(transport.status().rotateCount).toBe(0);
    } finally {
      await close(server);
    }
  });

  it('serializes concurrent rotations', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const { server, port } = await listen((_req, res) => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ip: `203.0.113.${calls}`, changed: true }));
      }, 150);
    });

    try {
      const transport = loadTransport({
        IP_ROTATE_URL: `http://127.0.0.1:${port}/rotate`,
        IP_ROTATE_MIN_GAP_MS: '0',
      });
      const [a, b] = await Promise.all([transport.rotate('a'), transport.rotate('b')]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(calls).toBe(2);
      expect(maxInFlight).toBe(1);
    } finally {
      await close(server);
    }
  });
});
