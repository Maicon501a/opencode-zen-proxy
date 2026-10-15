'use strict';

const { config } = require('../config/constants');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const threshold = LEVELS[config.logLevel] !== undefined ? LEVELS[config.logLevel] : LEVELS.info;

function emit(level, message, fields) {
  if (LEVELS[level] < threshold) return;

  const line = fields && Object.keys(fields).length
    ? `${message} ${JSON.stringify(fields)}`
    : message;

  const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  target(`[${level}] ${line}`);
}

function createLogger(scope) {
  const prefix = scope ? `${scope}: ` : '';
  return {
    level: config.logLevel,
    debug: (message, fields) => emit('debug', `${prefix}${message}`, fields),
    info: (message, fields) => emit('info', `${prefix}${message}`, fields),
    warn: (message, fields) => emit('warn', `${prefix}${message}`, fields),
    error: (message, fields) => emit('error', `${prefix}${message}`, fields),
  };
}

module.exports = { createLogger };
