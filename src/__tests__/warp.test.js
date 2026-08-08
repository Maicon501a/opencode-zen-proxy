'use strict';

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

const { execFile } = require('child_process');
const { WarpManager } = require('../services/warp');

function makeManager(overrides = {}) {
  return new WarpManager({
    enabled: true,
    host: '127.0.0.1',
    port: 40000,
    binary: 'warp-cli',
    commandTimeout: 1000,
    startupWait: 0,
    cooldown: 60000,
    ...overrides,
  });
}

function mockCli(success = true, statusOutput = 'Status: Connected') {
  execFile.mockImplementation((bin, args, _opts, cb) => {
    if (!success) {
      return cb(new Error('exit 1'), '', 'boom');
    }
    // args = ['--accept-tos', <subcommand>, ...] or [<subcommand>, ...]
    if (args.includes('status')) cb(null, statusOutput, '');
    else cb(null, 'ok\n', '');
  });
}

describe('WarpManager', () => {
  beforeEach(() => {
    execFile.mockReset();
  });

  it('should activate WARP by driving warp-cli and reach Connected', async () => {
    mockCli(true);
    const m = makeManager();
    await m.activate();

    const calls = execFile.mock.calls.map((c) => c[0] + ' ' + c[1].join(' '));
    expect(calls).toEqual([
      'warp-cli --accept-tos proxy port 40000',
      'warp-cli --accept-tos mode proxy',
      'warp-cli --accept-tos connect',
      'warp-cli --accept-tos status',
    ]);
    expect(m.isActive()).toBe(true);
    expect(m.status().activated_at).toBeTruthy();
    expect(m.status().accept_tos).toBe(true);
  });

  it('should omit --accept-tos when disabled via config', async () => {
    mockCli(true);
    const m = makeManager({ acceptTos: false });
    await m.activate();
    const calls = execFile.mock.calls.map((c) => c[1].join(' '));
    expect(calls[0]).toBe('proxy port 40000');
    expect(m.status().accept_tos).toBe(false);
  });

  it('should reject when warp-cli status is not Connected', async () => {
    mockCli(true, 'Status: Disconnected');
    const m = makeManager();
    await expect(m.activate()).rejects.toThrow(/Connected/);
    expect(m.isActive()).toBe(false);
    expect(m.status().last_error).toContain('Connected');
  });

  it('should reject when a warp-cli command fails', async () => {
    mockCli(false);
    const m = makeManager();
    await expect(m.activate()).rejects.toThrow(/warp-cli .* failed/);
    expect(m.isActive()).toBe(false);
  });

  it('should be disabled when enabled=false', async () => {
    const m = makeManager({ enabled: false });
    await expect(m.activate()).rejects.toThrow(/disabled/);
  });

  it('should coalesce concurrent activations into a single warp-cli run', async () => {
    mockCli(true);
    const m = makeManager({ startupWait: 10 });
    const [a, b] = await Promise.all([m.activate(), m.activate()]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    // connect/status only once each
    const statusCalls = execFile.mock.calls.filter((c) => c[1][1] === 'status');
    expect(statusCalls).toHaveLength(1);
  });

  it('should enforce a cooldown after a failed activation', async () => {
    mockCli(false);
    const m = makeManager({ cooldown: 60000 });
    await expect(m.activate()).rejects.toThrow(/warp-cli/);
    // Second attempt within the cooldown fails fast (reports the previous
    // error, like the Go manager) without re-running warp-cli.
    const runsBefore = execFile.mock.calls.length;
    await expect(m.activate()).rejects.toThrow(/warp-cli .* failed/);
    expect(execFile.mock.calls.length).toBe(runsBefore);
  });

  it('should allow activation again after the cooldown elapses', async () => {
    mockCli(false);
    const m = makeManager({ cooldown: 0 });
    await expect(m.activate()).rejects.toThrow(/warp-cli/);
    mockCli(true);
    await expect(m.activate()).resolves.toBeUndefined();
    expect(m.isActive()).toBe(true);
  });

  it('should invalidate the cached state via markInactive', async () => {
    mockCli(true);
    const m = makeManager();
    await m.activate();
    expect(m.isActive()).toBe(true);
    m.markInactive('connection reset');
    expect(m.isActive()).toBe(false);
    expect(m.status().last_error).toBe('connection reset');
  });
});
