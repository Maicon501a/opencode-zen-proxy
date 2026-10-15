/**
 * ZenBridge — talks to the Go backend two ways:
 *
 *  1. Wails IPC (desktop app): window.go.main.App.<Method>(...args)
 *  2. HTTP mirror (plain browser preview): /api/* served by the same binary
 *
 * The frontend never cares which one is live.
 */
window.ZenBridge = (() => {
  let mode = 'pending';
  let readyPromise = null;

  async function detect() {
    // Wails injects window.go once the runtime boots; give it a moment.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (window.go && window.go.main && window.go.main.App) {
        mode = 'wails';
        document.documentElement.setAttribute('data-bridge', 'wails');
        return mode;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    mode = 'http';
    document.documentElement.setAttribute('data-bridge', 'http');
    return mode;
  }

  function ready() {
    if (!readyPromise) readyPromise = detect();
    return readyPromise;
  }

  async function httpCall(name, args) {
    const query = (params) => {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) qs.set(key, value);
      });
      const text = qs.toString();
      return text ? `?${text}` : '';
    };
    const jsonPost = async (url, body, method = 'POST') => {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return response.json();
    };

    switch (name) {
      case 'GetState': return (await fetch('/api/state')).json();
      case 'GetStats': return (await fetch('/api/stats')).json();
      case 'ResetStats': return jsonPost('/api/stats/reset', {});
      case 'GetEvents': return (await fetch(`/api/events${query({ after: args[0], limit: args[1] })}`)).json();
      case 'ListModels': return (await fetch('/api/models')).json();
      case 'ListKeys': return (await fetch('/api/keys')).json();
      case 'CreateKey': return jsonPost('/api/keys', { name: args[0] });
      case 'DeleteKey': return (await fetch(`/api/keys${query({ id: args[0] })}`, { method: 'DELETE' })).json();
      case 'RotateKey': return jsonPost(`/api/keys/rotate${query({ id: args[0] })}`, {});
      case 'SetRequireKeys': return jsonPost('/api/keys/require', { requireKeys: args[0] });
      case 'GetTransport': return (await fetch('/api/transport')).json();
      case 'SetTransport': return jsonPost('/api/transport', { torEnabled: args[0], rotateOnRateLimit: args[1] }, 'PUT');
      case 'RotateExit': return jsonPost('/api/rotate', {});
      case 'RefreshTorIP': return jsonPost('/api/tor/ip', {});
      case 'TestRequest': return jsonPost('/api/test', { model: args[0], prompt: args[1] });
      case 'GetSettings': return (await fetch('/api/settings')).json().then((payload) => payload.settings);
      case 'SaveSettings': return jsonPost('/api/settings', args[0], 'PUT');
      case 'StartProxy': return jsonPost('/api/proxy/start', {});
      case 'StopProxy': return jsonPost('/api/proxy/stop', {});
      case 'RestartProxy': return jsonPost('/api/proxy/restart', {});
      case 'RestartTor': return jsonPost('/api/tor/restart', {});
      case 'GetLogs': return (await fetch(`/api/logs${query({ after: args[0], limit: args[1] })}`)).json();
      case 'GetDocs': return (await fetch('/api/docs')).json();
      case 'OpenPath': return jsonPost('/api/openpath', { path: args[0] });
      case 'GetLocalAPI': return (await fetch('/api/state')).json();
      default:
        throw new Error(`bridge: método desconhecido ${name}`);
    }
  }

  /**
   * call('GetState') or call('GetEvents', 0, 120) — args positional, same as
   * the Go method signature.
   */
  async function call(name, ...args) {
    await ready();
    if (mode === 'wails') {
      const fn = window.go.main.App[name];
      if (typeof fn !== 'function') throw new Error(`bridge: ${name} não existe na build`);
      return fn(...args);
    }
    return httpCall(name, args);
  }

  return {
    ready,
    call,
    currentMode: () => mode,
  };
})();
