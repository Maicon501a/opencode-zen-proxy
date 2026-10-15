'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * API key store tests — fresh registry per case, own data dir.
 */

let root;
let caseId = 0;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-proxy-keys-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function loadKeys() {
  caseId += 1;
  const dir = path.join(root, `case-${caseId}`);
  jest.resetModules();
  process.env.PROXY_DATA_DIR = dir;
  delete process.env.CLIENT_API_KEY;
  delete process.env.ADMIN_TOKEN;
  return { keys: require('../services/keys'), dir };
}

describe('key lifecycle', () => {
  it('creates, verifies and attributes a key', () => {
    const { keys } = loadKeys();
    const record = keys.create('laptop');
    expect(record.id).toMatch(/^key_/);
    expect(record.key).toMatch(/^sk-zen-/);
    expect(record.name).toBe('laptop');

    expect(keys.verify(record.key)).toBeTruthy();
    expect(keys.verify('sk-zen-wrong')).toBeNull();
    expect(keys.verify('')).toBeNull();
    expect(keys.count()).toBe(1);
  });

  it('rotates the value in place', () => {
    const { keys } = loadKeys();
    const record = keys.create('desktop');
    const original = record.key;
    const rotated = keys.rotateValue(record.id);
    expect(rotated.id).toBe(record.id);
    expect(rotated.key).not.toBe(original);
    expect(keys.verify(original)).toBeNull();
    expect(keys.verify(rotated.key)).toBeTruthy();
  });

  it('removes a key', () => {
    const { keys } = loadKeys();
    const record = keys.create('temp');
    expect(keys.remove(record.id)).toBeTruthy();
    expect(keys.verify(record.key)).toBeNull();
    expect(keys.count()).toBe(0);
    expect(keys.remove('missing')).toBeNull();
  });

  it('toggles requireKeys and keeps a masked summary', () => {
    const { keys } = loadKeys();
    const record = keys.create('phone');
    expect(keys.requiresKeys()).toBe(false);
    keys.setRequire(true);
    expect(keys.requiresKeys()).toBe(true);

    const summary = keys.summary();
    expect(summary.requireKeys).toBe(true);
    expect(summary.count).toBe(1);
    expect(summary.keys[0].masked).toContain('…');
    expect(summary.keys[0].masked).not.toBe(record.key);

    const list = keys.list();
    expect(list[0].key).toBe(record.key);
  });

  it('persists across registry reloads', () => {
    caseId += 1;
    const dir = path.join(root, `persist-${caseId}`);

    jest.resetModules();
    process.env.PROXY_DATA_DIR = dir;
    const keys1 = require('../services/keys');
    const record = keys1.create('persistent');
    keys1.setRequire(true);
    keys1.flush();

    jest.resetModules();
    const keys2 = require('../services/keys');
    expect(keys2.requiresKeys()).toBe(true);
    expect(keys2.count()).toBe(1);
    expect(keys2.verify(record.key)).toBeTruthy();

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'api-keys.json'), 'utf8'));
    expect(onDisk.keys).toHaveLength(1);
  });
});
