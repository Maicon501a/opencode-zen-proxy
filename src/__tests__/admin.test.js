'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

/**
 * Admin API tests — guard, keys CRUD, transport toggling and the effect of
 * `requireKeys` on the client surface. No upstream is contacted.
 */

let root;
let caseId = 0;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-proxy-admin-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function loadApp(env = {}) {
  caseId += 1;
  const dir = path.join(root, `case-${caseId}`);
  jest.resetModules();
  process.env.PROXY_DATA_DIR = dir;
  process.env.ADMIN_TOKEN = 'test-admin-token';
  delete process.env.CLIENT_API_KEY;
  delete process.env.TOR_SOCKS;
  delete process.env.UPSTREAM_SOCKS5;
  delete process.env.IP_ROTATE_URL;
  Object.assign(process.env, env);
  const { createApp } = require('../server');
  return createApp();
}

describe('admin guard', () => {
  it('rejects requests without the token', async () => {
    const app = loadApp();
    const res = await request(app).get('/admin/overview');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_admin_token');
  });

  it('accepts requests with the token', async () => {
    const app = loadApp();
    const res = await request(app).get('/admin/overview').set('X-Admin-Token', 'test-admin-token');
    expect(res.status).toBe(200);
    expect(res.body.object).toBe('zen.admin.overview');
    expect(res.body.proxy.upstream).toContain('opencode.ai');
    expect(res.body.proxy.gate.toolNames).toContain('read');
    expect(res.body.transport.isolated).toBe(false);
    expect(res.body.keys.count).toBe(0);
  });

  it('falls back to loopback when no token is configured', async () => {
    const app = loadApp({ ADMIN_TOKEN: '' });
    const res = await request(app).get('/admin/overview');
    expect(res.status).toBe(200);
  });
});

describe('keys CRUD via admin', () => {
  it('creates, lists, rotates and removes keys', async () => {
    const app = loadApp();
    const auth = { 'X-Admin-Token': 'test-admin-token' };

    const created = await request(app).post('/admin/keys').set(auth).send({ name: 'laptop' });
    expect(created.status).toBe(201);
    const key = created.body.key;
    expect(key.key).toMatch(/^sk-zen-/);

    const list = await request(app).get('/admin/keys').set(auth);
    expect(list.status).toBe(200);
    expect(list.body.keys).toHaveLength(1);
    expect(list.body.keys[0].name).toBe('laptop');

    const rotated = await request(app).post(`/admin/keys/${key.id}/rotate`).set(auth);
    expect(rotated.status).toBe(200);
    expect(rotated.body.key.key).not.toBe(key.key);

    const removed = await request(app).delete(`/admin/keys/${key.id}`).set(auth);
    expect(removed.status).toBe(200);

    const again = await request(app).delete(`/admin/keys/${key.id}`).set(auth);
    expect(again.status).toBe(404);
  });

  it('requireKeys blocks the client surface until a valid key is presented', async () => {
    const app = loadApp();
    const auth = { 'X-Admin-Token': 'test-admin-token' };

    // Open by default: a valid-body request is not rejected by auth (it would
    // reach the upstream — use a body that fails fast instead: no network).
    const open = await request(app)
      .post('/v1/chat/completions')
      .send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(open.status).toBe(400); // missing model — reached the route

    const created = await request(app).post('/admin/keys').set(auth).send({ name: 'agent' });
    const keyValue = created.body.key.key;

    const flip = await request(app).patch('/admin/keys/settings').set(auth).send({ requireKeys: true });
    expect(flip.status).toBe(200);
    expect(flip.body.requireKeys).toBe(true);

    const blocked = await request(app)
      .post('/v1/chat/completions')
      .send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(blocked.status).toBe(401);
    expect(blocked.body.error.code).toBe('invalid_api_key');

    const allowed = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${keyValue}`)
      .send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(allowed.status).toBe(400); // auth passed; validation rejected

    const wrong = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer sk-zen-nope')
      .send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(wrong.status).toBe(401);
  });
});

describe('transport admin', () => {
  it('reads and updates the egress', async () => {
    const app = loadApp();
    const auth = { 'X-Admin-Token': 'test-admin-token' };

    const before = await request(app).get('/admin/transport').set(auth);
    expect(before.body.transport.isolated).toBe(false);

    const updated = await request(app)
      .put('/admin/transport')
      .set(auth)
      .send({ socks5: '127.0.0.1:19050', rotateOnRateLimit: true });
    expect(updated.status).toBe(200);
    expect(updated.body.transport.isolated).toBe(true);
    expect(updated.body.transport.socks5).toBe('127.0.0.1:19050');

    const after = await request(app).get('/admin/transport').set(auth);
    expect(after.body.transport.isolated).toBe(true);
  });
});

describe('stats & events admin', () => {
  it('serves a snapshot, events and reset', async () => {
    const app = loadApp();
    const auth = { 'X-Admin-Token': 'test-admin-token' };

    const stats = await request(app).get('/admin/stats').set(auth);
    expect(stats.status).toBe(200);
    expect(stats.body.totals.requests).toBe(0);

    const events = await request(app).get('/admin/events?after=0&limit=10').set(auth);
    expect(events.status).toBe(200);
    expect(Array.isArray(events.body.events)).toBe(true);

    const reset = await request(app).post('/admin/stats/reset').set(auth);
    expect(reset.status).toBe(200);
  });
});
