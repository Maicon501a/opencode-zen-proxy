'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Stats store tests.
 *
 * Each case loads the module in a fresh registry pointed at its own data dir,
 * so aggregates never leak between cases.
 */

let root;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-proxy-stats-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

let caseId = 0;

function loadStats() {
  caseId += 1;
  const dir = path.join(root, `case-${caseId}`);
  jest.resetModules();
  process.env.PROXY_DATA_DIR = dir;
  delete process.env.TOR_SOCKS;
  delete process.env.UPSTREAM_SOCKS5;
  delete process.env.IP_ROTATE_URL;
  delete process.env.ADMIN_TOKEN;
  return { stats: require('../services/stats'), dir };
}

describe('normalizeUsage', () => {
  it('maps chat/completions usage', () => {
    const { stats } = loadStats();
    expect(stats.normalizeUsage({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }))
      .toEqual({ prompt: 10, completion: 4, total: 14 });
  });

  it('maps responses usage', () => {
    const { stats } = loadStats();
    expect(stats.normalizeUsage({ input_tokens: 7, output_tokens: 3, total_tokens: 10 }))
      .toEqual({ prompt: 7, completion: 3, total: 10 });
  });

  it('derives the total when only parts exist', () => {
    const { stats } = loadStats();
    expect(stats.normalizeUsage({ prompt_tokens: 2, completion_tokens: 3 }))
      .toEqual({ prompt: 2, completion: 3, total: 5 });
  });

  it('returns null for empty usage', () => {
    const { stats } = loadStats();
    expect(stats.normalizeUsage(null)).toBeNull();
    expect(stats.normalizeUsage({})).toBeNull();
    expect(stats.normalizeUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })).toBeNull();
  });
});

describe('request aggregation', () => {
  it('folds a successful request into totals, model, key, daily and events', () => {
    const { stats } = loadStats();
    const ctx = stats.beginRequest({
      model: 'opencode/deepseek-v4.1-flash-free',
      wireModel: 'deepseek-v4.1-flash-free',
      clientFormat: 'chat',
      upstreamFormat: 'chat',
      stream: false,
      keyId: 'key_abc',
      keyName: 'laptop',
    });

    stats.endRequest(ctx, {
      ok: true,
      status: 200,
      latencyMs: 120,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      egress: 'tor',
      rotations: 1,
      rateLimited: true,
    });

    const snap = stats.snapshot();
    expect(snap.totals.requests).toBe(1);
    expect(snap.totals.ok).toBe(1);
    expect(snap.totals.errors).toBe(0);
    expect(snap.totals.promptTokens).toBe(10);
    expect(snap.totals.completionTokens).toBe(5);
    expect(snap.totals.totalTokens).toBe(15);
    expect(snap.totals.rateLimits).toBe(1);
    expect(snap.totals.rotations).toBe(1);

    expect(snap.byModel).toHaveLength(1);
    expect(snap.byModel[0].model).toBe('deepseek-v4.1-flash-free');
    expect(snap.byModel[0].avgLatencyMs).toBe(120);

    expect(snap.byKey).toHaveLength(1);
    expect(snap.byKey[0].id).toBe('key_abc');
    expect(snap.byKey[0].name).toBe('laptop');

    expect(snap.daily).toHaveLength(1);
    expect(snap.daily[0].requests).toBe(1);

    expect(snap.events).toHaveLength(1);
    expect(snap.events[0].type).toBe('request');
    expect(snap.events[0].promptTokens).toBe(10);
    expect(snap.events[0].egress).toBe('tor');
    expect(snap.events[0].rateLimited).toBe(true);
  });

  it('records failures and aborts', () => {
    const { stats } = loadStats();
    const ctx = stats.beginRequest({ model: 'x', wireModel: 'm1' });
    stats.endRequest(ctx, { ok: false, status: 429, error: 'slow down', rateLimited: true });

    const ctx2 = stats.beginRequest({ model: 'x', wireModel: 'm1', stream: true });
    stats.endRequest(ctx2, { ok: true, status: 200, aborted: true, usage: { prompt_tokens: 3, completion_tokens: 1 } });

    const snap = stats.snapshot();
    expect(snap.totals.requests).toBe(2);
    expect(snap.totals.errors).toBe(1);
    expect(snap.totals.aborted).toBe(1);
    expect(snap.totals.rateLimits).toBe(1);
    expect(snap.events.map((event) => event.type)).toEqual(['error', 'request']);
    expect(snap.events[0].message).toBe('slow down');
  });

  it('keeps the last upstream rejection (status, headers, body)', () => {
    const { stats } = loadStats();
    const ctx = stats.beginRequest({ model: 'x', wireModel: 'm2' });
    const event = stats.endRequest(ctx, {
      ok: false,
      status: 429,
      error: 'daily free tier quota reached',
      rateLimited: true,
      rateLimit: {
        status: 429,
        statusMessage: 'Too Many Requests',
        retryAfter: '120',
        message: 'daily free tier quota reached',
        headers: { 'retry-after': '120', 'content-type': 'application/json' },
        body: '{"error":{"message":"daily free tier quota reached"}}',
      },
    });

    expect(event.upstream.status).toBe(429);
    const snap = stats.snapshot();
    expect(snap.lastRejection.model).toBe('m2');
    expect(snap.lastRejection.rateLimited).toBe(true);
    expect(snap.lastRejection.retryAfter).toBe('120');
    expect(snap.lastRejection.body).toContain('quota reached');
  });

  it('filters events by id and limits the count', () => {
    const { stats } = loadStats();
    for (let i = 0; i < 5; i += 1) {
      const ctx = stats.beginRequest({ model: 'x', wireModel: 'm' });
      stats.endRequest(ctx, { ok: true, status: 200, latencyMs: 1 });
    }
    const all = stats.eventsAfter(0, 100);
    expect(all).toHaveLength(5);
    const tail = stats.eventsAfter(all[2].id, 100);
    expect(tail).toHaveLength(2);
    expect(stats.eventsAfter(0, 3)).toHaveLength(3);
  });
});

describe('persistence', () => {
  it('round-trips through the stats file', () => {
    caseId += 1;
    const dir = path.join(root, `persist-${caseId}`);

    jest.resetModules();
    process.env.PROXY_DATA_DIR = dir;
    const stats1 = require('../services/stats');
    const ctx = stats1.beginRequest({ model: 'x', wireModel: 'persist-model' });
    stats1.endRequest(ctx, { ok: true, status: 200, usage: { prompt_tokens: 42, completion_tokens: 8 } });
    stats1.flush();

    expect(fs.existsSync(path.join(dir, 'stats.json'))).toBe(true);

    jest.resetModules();
    const stats2 = require('../services/stats');
    const snap = stats2.snapshot();
    expect(snap.totals.requests).toBe(1);
    expect(snap.totals.promptTokens).toBe(42);
    expect(snap.byModel[0].model).toBe('persist-model');
  });

  it('reset wipes aggregates and the file', () => {
    const { stats, dir } = loadStats();
    const ctx = stats.beginRequest({ model: 'x', wireModel: 'm' });
    stats.endRequest(ctx, { ok: true, status: 200 });
    stats.reset();
    expect(stats.snapshot().totals.requests).toBe(0);
    expect(stats.snapshot().events).toHaveLength(0);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8'));
    expect(onDisk.totals.requests).toBe(0);
  });
});
