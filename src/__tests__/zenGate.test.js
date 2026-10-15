'use strict';

const {
  newZenSessionId,
  isZenSessionId,
  zenGateHeaders,
  applyZenGate,
  toolNames,
  zenSessionMintTime,
  zenSessionStamp,
} = require('../services/zenGate');
const { config } = require('../config/constants');

// Official session format: "ses_" + 12 lowercase hex + 14 alphanumeric chars.
const SESSION_FORMAT = /^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/;

describe('OpenCode Zen free-tier gate', () => {
  describe('session id', () => {
    it('matches the official OpenCode client format', () => {
      for (let i = 0; i < 64; i += 1) {
        expect(newZenSessionId()).toMatch(SESSION_FORMAT);
      }
    });

    it('validates ids it generates', () => {
      expect(isZenSessionId(newZenSessionId())).toBe(true);
      expect(isZenSessionId('ses_short')).toBe(false);
      expect(isZenSessionId('nope_0123456789abABCDEFGHIJKLMN')).toBe(false);
    });

    it('generates a distinct id per call', () => {
      expect(newZenSessionId()).not.toBe(newZenSessionId());
    });

    it('encodes the mint time in the 12-hex stamp', () => {
      // Exact formula check against ids captured from the live client.
      expect(zenSessionStamp(1792076031325)).toBe('ebff1dae9ffe');
      expect(zenSessionStamp(1792075930284)).toBe('ebff3659affe');

      // Round trip: the gateway decodes this stamp back into a mint time.
      const now = Date.now();
      const id = newZenSessionId(now);
      expect(zenSessionMintTime(id)).toBe(now);

      // And it stays decodable a day later (the edge accepts old ids).
      const old = newZenSessionId(now - 86400000);
      expect(zenSessionMintTime(old)).toBe(now - 86400000);

      expect(zenSessionMintTime('ses_short')).toBeNull();
    });
  });

  describe('gate headers', () => {
    it('presents the official CLI surface', () => {
      const headers = zenGateHeaders();
      expect(headers['User-Agent']).toBe('opencode/latest/2.0.29/cli');
      expect(headers['X-Opencode-Client']).toBe('cli');
      expect(headers['X-Opencode-Project']).toMatch(/^[0-9a-f]{40}$/);
    });

    it('mirrors the session id across every affinity header', () => {
      const headers = zenGateHeaders();
      const session = headers['X-Opencode-Session'];
      expect(session).toMatch(SESSION_FORMAT);
      expect(headers['X-Opencode-Session-Id']).toBe(session);
      expect(headers['X-Session-Affinity']).toBe(session);
      expect(headers['X-Session-Id']).toBe(session);
    });

    it('mints a fresh session per request', () => {
      expect(zenGateHeaders()['X-Opencode-Session']).not.toBe(
        zenGateHeaders()['X-Opencode-Session']
      );
    });
  });

  describe('applyZenGate (chat shape)', () => {
    it('forces streaming and adds the read tool', () => {
      const body = applyZenGate({ model: 'mimo', messages: [] }, { chat: true });
      expect(body.stream).toBe(true);
      const names = toolNames(body, true);
      expect(names.has('read')).toBe(true);
    });

    it('keeps the client tools and only appends what is missing', () => {
      const body = applyZenGate({
        model: 'big-pickle',
        messages: [],
        stream: true,
        tools: [
          { type: 'function', function: { name: 'read', description: 'custom' } },
          { type: 'function', function: { name: 'my_tool', description: 'x' } },
        ],
      }, { chat: true });

      expect(body.tools).toHaveLength(2);
      const names = toolNames(body, true);
      expect(names.has('read')).toBe(true);
      expect(names.has('my_tool')).toBe(true);
      // Never duplicates a gate tool the client already sent itself.
      expect(body.tools.filter((t) => t.function.name === 'read')).toHaveLength(1);
    });

    it('requests usage on the folded stream', () => {
      const body = applyZenGate({ model: 'mimo', messages: [] }, { chat: true });
      expect(body.stream_options).toEqual({ include_usage: true });
    });

    it('adds the flat tool shape for the Responses endpoint', () => {
      const body = applyZenGate({ model: 'muse-spark-1.3-contributor-free', input: 'hi' }, { chat: false });
      expect(body.stream).toBe(true);
      const names = toolNames(body, false);
      expect(names.has('read')).toBe(true);
      for (const tool of body.tools) {
        expect(tool.function).toBeUndefined();
      }
      // stream_options is a chat-only knob.
      expect(body.stream_options).toBeUndefined();
    });

    it('returns non-object input untouched', () => {
      expect(applyZenGate('not a body', { chat: true })).toBe('not a body');
      expect(applyZenGate(null, { chat: true })).toBeNull();
    });
  });

  describe('configuration', () => {
    it('exposes the gate tool names', () => {
      expect(config.zenGate.toolNames).toEqual(['read']);
    });
  });
});
