'use strict';

const { config } = require('../config/constants');
const keys = require('../services/keys');

/**
 * Authentication middleware.
 *
 * Three modes, in priority order:
 *
 *   1. DESKTOP-MANAGED KEYS — keys created through the admin API (desktop
 *      app). When `requireKeys` is on, every client must present one:
 *      `Authorization: Bearer sk-zen-…`. When it is off the proxy stays open,
 *      but a presented key is still verified and attributed in the stats.
 *   2. LEGACY SINGLE KEY — `CLIENT_API_KEY`, kept for standalone deployments.
 *   3. OPEN — no keys configured: the proxy is keyless (local default).
 */

function bearerToken(req) {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
}

function unauthorized(res) {
  return res.status(401).json({
    error: {
      message: 'Invalid or missing API key.',
      type: 'auth_error',
      param: null,
      code: 'invalid_api_key',
    },
  });
}

function authMiddleware(req, res, next) {
  const provided = bearerToken(req);

  if (keys.count() > 0) {
    const key = provided ? keys.verify(provided) : null;
    if (!key && keys.requiresKeys()) {
      return unauthorized(res);
    }
    if (key) {
      req.zenKey = key;
      keys.touch(key.id);
    }
    return next();
  }

  if (config.clientApiKey && provided !== config.clientApiKey) {
    return unauthorized(res);
  }

  return next();
}

module.exports = { authMiddleware };
