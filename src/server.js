'use strict';

const express = require('express');
const cors = require('cors');
const { config } = require('./config/constants');

const { authMiddleware } = require('./middleware/auth');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const adminRoutes = require('./routes/admin');
const healthRoutes = require('./routes/health');
const modelsRoutes = require('./routes/models');
const chatRoutes = require('./routes/chatCompletions');
const responsesRoutes = require('./routes/responses');

/**
 * Create and configure the Express application.
 */
function createApp() {
  const app = express();

  // ----- Global middleware -----
  app.use(cors());
  // Base64 data URIs are ~33% larger than the source file. Keep this
  // configurable and generous enough for screenshots from coding clients.
  app.use(express.json({ limit: config.maxRequestSize }));

  // ----- Admin API (desktop app / local tooling) -----
  // Guarded by ADMIN_TOKEN (or loopback-only when unset); never public.
  app.use('/', adminRoutes);

  // ----- Open routes (no auth) -----
  app.use('/', healthRoutes);

  // ----- Authenticated routes -----
  app.use('/v1', authMiddleware);

  // Model listing endpoints
  app.use('/v1', modelsRoutes);

  // OpenAI-compatible surfaces. Both are backed by the same Zen free tier:
  // chat models answer on /chat/completions, Muse models on /responses, and
  // the proxy translates between the two dialects in either direction.
  app.use('/v1', chatRoutes);
  app.use('/v1', responsesRoutes);

  // ----- Error handling -----
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
