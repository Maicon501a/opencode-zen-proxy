'use strict';

const fs = require('fs');
const path = require('path');

const { config } = require('../config/constants');
const { createLogger } = require('./logger');

const log = createLogger('stats');

/**
 * Usage statistics store.
 *
 * Every forwarded request is bracketed with `beginRequest` / `endRequest`;
 * rotations, rate limits and key management land in the same ring buffer of
 * events so the desktop UI can render a single live feed.
 *
 * What is tracked:
 *   - totals: requests / errors / prompt+completion tokens / rate limits / rotations
 *   - per model: same counters plus average latency and last use
 *   - per API key: requests and tokens (attribution)
 *   - daily buckets (last 120 days) for the dashboard charts
 *   - events: last 250 request/rotation/key/system events
 *
 * The snapshot is flushed to `<dataDir>/stats.json` (debounced, atomic write)
 * and reloaded on boot so the counters survive restarts.
 */

const FLUSH_DEBOUNCE_MS = 3000;
const MAX_EVENTS = 250;
const DAILY_KEEP_DAYS = 120;

function emptyTotals() {
  return {
    requests: 0,
    ok: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    rateLimits: 0,
    rotations: 0,
    aborted: 0,
  };
}

const state = {
  version: 1,
  bootedAt: new Date().toISOString(),
  totals: emptyTotals(),
  byModel: {},
  byKey: {},
  daily: {},
  events: [],
  nextEventId: 1,
  lastRejection: null,
};

let flushTimer = null;
let dirty = false;

function statsFile() {
  return path.join(config.dataDir, 'stats.json');
}

// ---------------------------------------------------------------------------
// Usage normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a usage object from either dialect into
 * `{ prompt, completion, total }`.
 *
 *   chat/completions → { prompt_tokens, completion_tokens, total_tokens }
 *   responses        → { input_tokens, output_tokens, total_tokens }
 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const prompt = num(usage.prompt_tokens) || num(usage.input_tokens);
  const completion = num(usage.completion_tokens) || num(usage.output_tokens);
  const total = num(usage.total_tokens) || prompt + completion;
  if (prompt === 0 && completion === 0 && total === 0) return null;
  return { prompt, completion, total };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function load() {
  try {
    const raw = fs.readFileSync(statsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    if (parsed.totals && typeof parsed.totals === 'object') {
      state.totals = { ...emptyTotals(), ...parsed.totals };
    }
    if (parsed.byModel && typeof parsed.byModel === 'object') state.byModel = parsed.byModel;
    if (parsed.byKey && typeof parsed.byKey === 'object') state.byKey = parsed.byKey;
    if (parsed.daily && typeof parsed.daily === 'object') state.daily = parsed.daily;
    if (parsed.lastRejection && typeof parsed.lastRejection === 'object') {
      state.lastRejection = parsed.lastRejection;
    }
    if (Array.isArray(parsed.events)) {
      state.events = parsed.events.slice(-MAX_EVENTS);
      state.nextEventId = state.events.reduce((max, event) => Math.max(max, event.id || 0), 0) + 1;
    }
    pruneDaily();
    log.info('stats loaded', { file: statsFile(), requests: state.totals.requests });
  } catch {
    // First boot or unreadable file: start clean.
  }
}

function pruneDaily() {
  const cutoff = new Date(Date.now() - DAILY_KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  for (const day of Object.keys(state.daily)) {
    if (day < cutoff) delete state.daily[day];
  }
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_DEBOUNCE_MS);
  if (flushTimer.unref) flushTimer.unref();
}

function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = `${statsFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, statsFile());
  } catch (err) {
    log.warn('stats flush failed', { message: err.message });
  }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function dayKey() {
  return nowIso().slice(0, 10);
}

function pushEvent(event) {
  const entry = { id: state.nextEventId++, ts: nowIso(), ...event };
  state.events.push(entry);
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
  return entry;
}

/**
 * Record a standalone event (rotation, rate limit, key changes, system).
 */
function recordEvent(type, data = {}) {
  const entry = pushEvent({ type, ...data });
  scheduleFlush();
  return entry;
}

/**
 * Bracket a forwarded request.
 *
 * @returns {{ id: number, startedAt: number, model: string, keyId: string|null, keyName: string|null }}
 */
function beginRequest({ model, wireModel, clientFormat, upstreamFormat, stream, keyId, keyName } = {}) {
  return {
    startedAt: Date.now(),
    model: wireModel || model || 'unknown',
    modelName: model || wireModel || 'unknown',
    clientFormat: clientFormat || null,
    upstreamFormat: upstreamFormat || null,
    stream: stream === true,
    keyId: keyId || null,
    keyName: keyName || null,
  };
}

/**
 * Close a request bracket and fold the outcome into the aggregates.
 *
 * @param {object} ctx returned by beginRequest
 * @param {object} outcome
 * @param {boolean} outcome.ok
 * @param {number}  [outcome.status]
 * @param {number}  [outcome.latencyMs]
 * @param {string}  [outcome.error]
 * @param {object}  [outcome.usage] raw usage from either dialect
 * @param {'direct'|'tor'|'warp'} [outcome.egress]
 * @param {number}  [outcome.rotations]
 * @param {boolean} [outcome.rateLimited]
 * @param {object}  [outcome.rateLimit] captured rejected response (rate limit)
 * @param {object}  [outcome.upstream]  captured rejected response (any 4xx/5xx)
 * @param {boolean} [outcome.aborted]
 */
function endRequest(ctx, outcome = {}) {
  if (!ctx) return null;
  const ok = outcome.ok === true;
  const usage = normalizeUsage(outcome.usage);
  const latencyMs = outcome.latencyMs != null ? outcome.latencyMs : Date.now() - ctx.startedAt;
  const model = ctx.model;

  // ---- totals ----
  state.totals.requests += 1;
  if (ok) state.totals.ok += 1; else state.totals.errors += 1;
  if (usage) {
    state.totals.promptTokens += usage.prompt;
    state.totals.completionTokens += usage.completion;
    state.totals.totalTokens += usage.total;
  }
  if (outcome.rateLimited) state.totals.rateLimits += 1;
  if (outcome.rotations) state.totals.rotations += outcome.rotations;
  if (outcome.aborted) state.totals.aborted += 1;

  // Keep the last rejected upstream response around (status, headers, body)
  // so rate limits and free-tier quota notices stay inspectable after the
  // retry already succeeded on a fresh circuit.
  const rejection = outcome.rateLimit || outcome.upstream || null;
  if (rejection && typeof rejection === 'object') {
    state.lastRejection = {
      at: rejection.at || nowIso(),
      model,
      rateLimited: outcome.rateLimited === true,
      ...rejection,
    };
  }

  // ---- per model ----
  const entry = state.byModel[model] || {
    requests: 0, ok: 0, errors: 0, promptTokens: 0, completionTokens: 0,
    totalLatencyMs: 0, rateLimits: 0, rotations: 0, firstUsedAt: nowIso(), lastUsedAt: null,
  };
  entry.requests += 1;
  if (ok) entry.ok += 1; else entry.errors += 1;
  if (usage) {
    entry.promptTokens += usage.prompt;
    entry.completionTokens += usage.completion;
  }
  entry.totalLatencyMs += latencyMs;
  if (outcome.rateLimited) entry.rateLimits += 1;
  if (outcome.rotations) entry.rotations += outcome.rotations;
  entry.lastUsedAt = nowIso();
  state.byModel[model] = entry;

  // ---- per API key ----
  if (ctx.keyId) {
    const keyEntry = state.byKey[ctx.keyId] || {
      name: ctx.keyName, requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, lastUsedAt: null,
    };
    keyEntry.name = ctx.keyName || keyEntry.name;
    keyEntry.requests += 1;
    if (!ok) keyEntry.errors += 1;
    if (usage) {
      keyEntry.promptTokens += usage.prompt;
      keyEntry.completionTokens += usage.completion;
    }
    keyEntry.lastUsedAt = nowIso();
    state.byKey[ctx.keyId] = keyEntry;
  }

  // ---- daily bucket ----
  const day = dayKey();
  const bucket = state.daily[day] || { requests: 0, promptTokens: 0, completionTokens: 0, errors: 0, rotations: 0 };
  bucket.requests += 1;
  if (!ok) bucket.errors += 1;
  if (usage) {
    bucket.promptTokens += usage.prompt;
    bucket.completionTokens += usage.completion;
  }
  if (outcome.rotations) bucket.rotations += outcome.rotations;
  state.daily[day] = bucket;

  // ---- event feed ----
  const event = pushEvent({
    type: ok ? 'request' : 'error',
    model,
    stream: ctx.stream,
    status: outcome.status || (ok ? 200 : 502),
    latencyMs,
    promptTokens: usage ? usage.prompt : 0,
    completionTokens: usage ? usage.completion : 0,
    egress: outcome.egress || null,
    rotations: outcome.rotations || 0,
    rateLimited: outcome.rateLimited === true,
    upstream: rejection,
    aborted: outcome.aborted === true,
    key: ctx.keyName || null,
    message: outcome.error || null,
  });

  scheduleFlush();
  return event;
}

/** Per-model view shaped for the UI (avg latency computed). */
function modelRows() {
  return Object.entries(state.byModel)
    .map(([model, entry]) => ({
      model,
      requests: entry.requests,
      ok: entry.ok,
      errors: entry.errors,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      avgLatencyMs: entry.requests > 0 ? Math.round(entry.totalLatencyMs / entry.requests) : 0,
      rateLimits: entry.rateLimits || 0,
      rotations: entry.rotations || 0,
      firstUsedAt: entry.firstUsedAt || null,
      lastUsedAt: entry.lastUsedAt,
    }))
    .sort((a, b) => b.requests - a.requests);
}

/** Full snapshot for /admin/stats and the desktop UI. */
function snapshot() {
  return {
    bootedAt: state.bootedAt,
    uptimeMs: Math.round(process.uptime() * 1000),
    totals: { ...state.totals },
    byModel: modelRows(),
    byKey: Object.entries(state.byKey).map(([id, entry]) => ({ id, ...entry })),
    daily: Object.entries(state.daily)
      .map(([day, bucket]) => ({ day, ...bucket }))
      .sort((a, b) => (a.day < b.day ? -1 : 1)),
    lastRejection: state.lastRejection || null,
    events: state.events.slice(),
    nextEventId: state.nextEventId,
  };
}

/** Events newer than `afterId` (ring-buffer aware). */
function eventsAfter(afterId, limit = 100) {
  const after = Number.isInteger(afterId) ? afterId : 0;
  return state.events.filter((event) => event.id > after).slice(0, limit);
}

/** Wipe counters (physical file too). */
function reset() {
  state.totals = emptyTotals();
  state.byModel = {};
  state.byKey = {};
  state.daily = {};
  state.events = [];
  state.nextEventId = 1;
  state.lastRejection = null;
  state.bootedAt = nowIso();
  dirty = true;
  flush();
  return snapshot();
}

load();

module.exports = {
  beginRequest,
  endRequest,
  recordEvent,
  snapshot,
  eventsAfter,
  normalizeUsage,
  reset,
  flush,
  state,
};
