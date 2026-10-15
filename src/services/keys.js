'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { config } = require('../config/constants');
const { createLogger } = require('./logger');

const log = createLogger('keys');

/**
 * Optional API keys for the proxy.
 *
 * The proxy is keyless by default — this store only matters when the operator
 * (the desktop UI) turns on "require keys". A key is a local bearer token:
 *
 *   Authorization: Bearer sk-zen-…
 *
 * Keys are generated here, stored at `<dataDir>/api-keys.json` and compared
 * in constant time. Usage is attributed per key in the stats store.
 *
 * Shape of the file:
 *   { "requireKeys": false, "keys": [ { id, name, key, createdAt, lastUsedAt } ] }
 */

const state = {
  requireKeys: false,
  keys: [],
};

let flushTimer = null;
let dirty = false;

function keysFile() {
  return path.join(config.dataDir, 'api-keys.json');
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(keysFile(), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      state.requireKeys = parsed.requireKeys === true;
      if (Array.isArray(parsed.keys)) {
        state.keys = parsed.keys.filter((entry) => entry && typeof entry.key === 'string');
      }
      log.info('keys loaded', { count: state.keys.length, requireKeys: state.requireKeys });
    }
  } catch {
    // First boot: keyless.
  }
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 1500);
  if (flushTimer.unref) flushTimer.unref();
}

function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = `${keysFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ requireKeys: state.requireKeys, keys: state.keys }, null, 2));
    fs.renameSync(tmp, keysFile());
  } catch (err) {
    log.warn('keys flush failed', { message: err.message });
  }
}

function generateKeyValue() {
  return `sk-zen-${crypto.randomBytes(24).toString('base64url')}`;
}

/** Constant-time comparison on hashed values (length-independent). */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Create a key. Returns the record including the plaintext value. */
function create(name) {
  const record = {
    id: `key_${crypto.randomBytes(6).toString('hex')}`,
    name: (typeof name === 'string' && name.trim() !== '') ? name.trim().slice(0, 64) : 'unnamed',
    key: generateKeyValue(),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  state.keys.push(record);
  scheduleFlush();
  log.info('key created', { id: record.id, name: record.name });
  return record;
}

/** Remove a key by id. Returns the removed record or null. */
function remove(id) {
  const index = state.keys.findIndex((entry) => entry.id === id);
  if (index === -1) return null;
  const [removed] = state.keys.splice(index, 1);
  scheduleFlush();
  log.info('key removed', { id: removed.id, name: removed.name });
  return removed;
}

/** Replace the key value in place (same id/name, fresh secret). */
function rotateValue(id) {
  const record = state.keys.find((entry) => entry.id === id);
  if (!record) return null;
  record.key = generateKeyValue();
  record.rotatedAt = new Date().toISOString();
  scheduleFlush();
  log.info('key value rotated', { id: record.id, name: record.name });
  return record;
}

/** Resolve a presented bearer token to a key record (or null). */
function verify(provided) {
  if (typeof provided !== 'string' || provided === '') return null;
  for (const record of state.keys) {
    if (safeEqual(record.key, provided)) return record;
  }
  return null;
}

/** Mark a key as used (called by the auth middleware). */
function touch(id) {
  const record = state.keys.find((entry) => entry.id === id);
  if (!record) return;
  record.lastUsedAt = new Date().toISOString();
  scheduleFlush();
}

function setRequire(value) {
  state.requireKeys = value === true;
  scheduleFlush();
  log.info('requireKeys updated', { requireKeys: state.requireKeys });
  return state.requireKeys;
}

function count() {
  return state.keys.length;
}

function requiresKeys() {
  return state.requireKeys;
}

/** Admin view with full values (admin-gated) + short usage summary. */
function list() {
  return state.keys.map((entry) => ({
    id: entry.id,
    name: entry.name,
    key: entry.key,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
    rotatedAt: entry.rotatedAt || null,
  }));
}

/** Compact summary for overview payloads (no secrets). */
function summary() {
  return {
    requireKeys: state.requireKeys,
    count: state.keys.length,
    keys: state.keys.map((entry) => ({
      id: entry.id,
      name: entry.name,
      masked: `${entry.key.slice(0, 11)}…${entry.key.slice(-4)}`,
      createdAt: entry.createdAt,
      lastUsedAt: entry.lastUsedAt,
    })),
  };
}

/** Test seam. */
function resetForTests() {
  state.requireKeys = false;
  state.keys = [];
  dirty = true;
  flush();
}

load();

module.exports = {
  create,
  remove,
  rotateValue,
  verify,
  touch,
  setRequire,
  count,
  requiresKeys,
  list,
  summary,
  resetForTests,
  flush,
  state,
};
