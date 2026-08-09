'use strict';

jest.mock('../services/warp');

const warp = require('../services/warp');
const zen = require('../services/zenClient');

describe('requestWithWarpFailover()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    warp.enabled.mockReturnValue(true);
    warp.isActive.mockReturnValue(false);
    // Successful activation flips the manager into the active state.
    warp.activate.mockImplementation(async () => {
      warp.isActive.mockReturnValue(true);
    });
    warp.markInactive.mockImplementation(() => {
      warp.isActive.mockReturnValue(false);
    });
  });

  it('should route through WARP when already active (no activation)', async () => {
    warp.isActive.mockReturnValue(true);
    const fn = jest.fn().mockResolvedValue({ ok: 1 });
    const res = await zen.requestWithWarpFailover(fn);
    expect(res).toEqual({ ok: 1 });
    expect(fn).toHaveBeenCalledWith(true);
    expect(warp.activate).not.toHaveBeenCalled();
  });

  it('should activate WARP on a failover-eligible error and retry via SOCKS', async () => {
    const netErr = new Error('connect failed');
    netErr.code = 'upstream_connection_error';
    netErr.statusCode = 502;
    const fn = jest
      .fn()
      .mockRejectedValueOnce(netErr)
      .mockResolvedValueOnce({ ok: 1 });

    const res = await zen.requestWithWarpFailover(fn);

    expect(res).toEqual({ ok: 1 });
    expect(warp.activate).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenNthCalledWith(1, false);
    expect(fn).toHaveBeenNthCalledWith(2, true);
  });

  it('should fail over on an upstream gateway 500 envelope', async () => {
    const err = new Error('internal server error');
    err.statusCode = 500;
    const fn = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ ok: 1 });

    await zen.requestWithWarpFailover(fn);
    expect(warp.activate).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenNthCalledWith(2, true);
  });

  it('should NOT fail over non-eligible errors (e.g. 400 validation)', async () => {
    const err = new Error('Model only supports text input');
    err.statusCode = 400;
    const fn = jest.fn().mockRejectedValue(err);

    await expect(zen.requestWithWarpFailover(fn)).rejects.toBe(err);
    expect(warp.activate).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should throw the original error when WARP activation fails', async () => {
    warp.activate.mockRejectedValue(new Error('warp-cli not found'));
    const netErr = new Error('connect failed');
    netErr.code = 'ECONNREFUSED';
    const fn = jest.fn().mockRejectedValue(netErr);

    await expect(zen.requestWithWarpFailover(fn)).rejects.toBe(netErr);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should invalidate stale WARP state and retry direct', async () => {
    warp.isActive.mockReturnValue(true);
    const netErr = new Error('connection reset');
    netErr.code = 'ECONNRESET';
    const fn = jest
      .fn()
      .mockRejectedValueOnce(netErr)
      .mockResolvedValueOnce({ ok: 1 });

    const res = await zen.requestWithWarpFailover(fn);

    expect(res).toEqual({ ok: 1 });
    expect(warp.markInactive).toHaveBeenCalled();
    expect(fn).toHaveBeenNthCalledWith(1, true);
    expect(fn).toHaveBeenNthCalledWith(2, false);
  });

  it('should not reactivate WARP indefinitely after a stale retry fails', async () => {
    const directFailure = new Error('direct gateway unavailable');
    directFailure.statusCode = 503;
    const warpFailure = new Error('warp connection reset');
    warpFailure.code = 'ECONNRESET';
    const finalDirectFailure = new Error('direct still unavailable');
    finalDirectFailure.statusCode = 503;
    const fn = jest
      .fn()
      .mockRejectedValueOnce(directFailure)
      .mockRejectedValueOnce(warpFailure)
      .mockRejectedValueOnce(finalDirectFailure);

    await expect(zen.requestWithWarpFailover(fn)).rejects.toBe(finalDirectFailure);
    expect(warp.activate).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenNthCalledWith(1, false);
    expect(fn).toHaveBeenNthCalledWith(2, true);
    expect(fn).toHaveBeenNthCalledWith(3, false);
  });

  it('should be a no-op when WARP failover is disabled', async () => {
    warp.enabled.mockReturnValue(false);
    const err = new Error('connect failed');
    err.code = 'upstream_connection_error';
    const fn = jest.fn().mockRejectedValue(err);

    await expect(zen.requestWithWarpFailover(fn)).rejects.toBe(err);
    expect(warp.activate).not.toHaveBeenCalled();
  });
});
