/**
 * OpenCode Zen Desktop — frontend logic.
 * Plain JS, no bundler: talks to the Go backend through ZenBridge.
 */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const bridge = window.ZenBridge;

  // ============================== helpers ==============================

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const fmtInt = (n) => Number(n || 0).toLocaleString('pt-BR');

  const trimNum = (v) => v.toFixed(2).replace(/\.?0+$/, '').replace('.', ',');

  const shortNum = (n) => {
    n = Number(n || 0);
    if (n >= 1e6) return `${trimNum(n / 1e6)}M`;
    if (n >= 1e3) {
      const rounded = Math.round((n / 1e3) * 10) / 10;
      return `${String(rounded).replace('.', ',')}k`;
    }
    return String(n);
  };

  const fmtMs = (ms) => {
    if (ms == null || Number.isNaN(Number(ms))) return '—';
    ms = Number(ms);
    return ms >= 1000 ? `${(ms / 1000).toFixed(1).replace('.', ',')} s` : `${Math.round(ms)} ms`;
  };

  const fmtTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('pt-BR');
  };

  const fmtAgo = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const diff = Date.now() - d.getTime();
    if (diff < 60e3) return 'agora';
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)} min atrás`;
    if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} h atrás`;
    return d.toLocaleDateString('pt-BR');
  };

  const toast = (message, type = '') => {
    const box = document.createElement('div');
    box.className = `toast ${type}`;
    box.textContent = message;
    $('#toasts').appendChild(box);
    setTimeout(() => box.classList.add('hide'), 4200);
    setTimeout(() => box.remove(), 4700);
  };

  const copyText = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label || 'texto'} copiado`, 'ok');
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); toast(`${label || 'texto'} copiado`, 'ok'); }
      catch { toast('não consegui copiar', 'err'); }
      area.remove();
    }
  };

  const busy = (btn, on) => { if (btn) btn.classList.toggle('busy', !!on); };

  // ============================== state ==============================

  const S = {
    page: 'dashboard',
    state: null,
    stats: null,
    events: [],
    lastEventId: 0,
    models: null,
    keys: null,
    docsLoaded: false,
    logs: [],
    logCursor: 0,
    logLevel: '',
    logAuto: true,
    settingsFilled: false,
  };

  const PAGE_META = {
    dashboard: ['Dashboard', 'visão geral em tempo real'],
    models: ['Modelos', 'catálogo gratuito com limites de contexto'],
    keys: ['API Keys', 'opcional — atribua consumo por cliente'],
    network: ['Rede & IP', 'isolamento Tor com rotação automática'],
    docs: ['Documentação', 'base URL, limites e configuração do cliente'],
    settings: ['Configurações', 'proxy, Tor e processo'],
    logs: ['Logs', 'saída do app, do proxy e do Tor em tempo real'],
  };

  // ============================== chrome ==============================

  function renderChrome() {
    const st = S.state;
    if (!st) return;
    const tor = st.tor || {};
    const proxy = st.proxy || {};
    const admin = st.admin || null;

    $('#brand-version').textContent = `v${st.appVersion || '?'} · ${bridge.currentMode() === 'http' ? 'preview' : 'desktop'}`;

    // LEDs
    const ledProxy = $('#led-proxy');
    ledProxy.className = 'led ' + (proxy.running ? 'on' : 'off');
    $('#led-proxy-detail').textContent = proxy.running ? `:${proxy.port || (st.settings && st.settings.proxyPort)}` : 'off';

    const ledTor = $('#led-tor');
    if (!tor.enabled) ledTor.className = 'led off';
    else if (tor.bootstrapping) ledTor.className = 'led busy';
    else if (tor.started && !tor.degraded) ledTor.className = 'led on';
    else if (tor.started && tor.degraded) ledTor.className = 'led warn';
    else ledTor.className = 'led off';
    $('#led-tor-detail').textContent = tor.enabled
      ? (tor.bootstrapping ? `${tor.bootstrapProgress || 0}%` : (tor.started ? 'on' : 'off'))
      : 'off';

    // Sidebar URL
    const url = `${st.proxyUrl || ''}/v1`;
    $('#sidebar-url').textContent = url;

    // Chips
    const totals = (admin && admin.stats && admin.stats.totals) || {};
    $('#chip-ip').innerHTML = `IP: <strong>${esc(tor.currentIp || '—')}</strong>`;
    $('#chip-tokens').innerHTML = `tok: <strong>${shortNum(totals.totalTokens)}</strong>`;
    $('#chip-req').innerHTML = `req: <strong>${fmtInt(totals.requests)}</strong>`;

    if (S.page === 'network') renderNetwork();
    if (S.page === 'settings') renderSettingsLive();
  }

  // ============================== polls ==============================

  async function pollState() {
    try {
      const st = await bridge.call('GetState');
      S.state = st;
      renderChrome();
    } catch (err) {
      // Backend briefly unavailable — next tick retries.
    }
  }

  async function pollStats() {
    try {
      const r = await bridge.call('GetStats');
      if (r && r.ok && r.stats) {
        S.stats = r.stats;
        if (S.page === 'dashboard') renderDashboard();
      }
    } catch { /* retry next tick */ }
  }

  function eventTag(ev) {
    if (ev.type === 'rotation') return ['rotate', 'IP'];
    if (ev.type === 'key') return ['info', 'KEY'];
    if (ev.type === 'error') return ['err', 'ERR'];
    if (ev.rateLimited) return ['warn', '429'];
    if (ev.status && ev.status >= 400) return ['err', 'ERR'];
    return ['ok', 'OK'];
  }

  function eventText(ev) {
    if (ev.type === 'rotation') {
      const parts = [`novo IP ${ev.ip || '?'}`];
      if (ev.reason) parts.push(`(${ev.reason})`);
      if (ev.message) parts.push(`· ${ev.message}`);
      return parts.join(' ');
    }
    if (ev.type === 'key') return `key ${ev.action || ''} ${ev.key ? `· ${ev.key}` : ''}`;
    const upstreamMsg = ev.upstream && ev.upstream.message ? ` · ${ev.upstream.message}` : '';
    if (ev.type === 'error') return `${ev.message || ev.error || 'erro'}${upstreamMsg}`;
    return `${ev.model || 'requisição'}${upstreamMsg}`;
  }

  function eventSide(ev) {
    if (ev.type === 'rotation') return `changed=${ev.changed ? 'sim' : 'não'}`;
    if (ev.type === 'key') return fmtTime(ev.ts);
    const parts = [];
    if (ev.status) parts.push(esc(String(ev.status)));
    if (ev.latencyMs != null) parts.push(fmtMs(ev.latencyMs));
    if (ev.promptTokens || ev.completionTokens) {
      parts.push(`${shortNum((ev.promptTokens || 0) + (ev.completionTokens || 0))} tok`);
    }
    if (ev.egress) parts.push(esc(ev.egress));
    if (ev.rotations) parts.push(`${ev.rotations} gira`);
    if (ev.upstream && ev.upstream.retryAfter) parts.push(`retry-after ${esc(String(ev.upstream.retryAfter))}`);
    return parts.join(' · ');
  }

  function renderEvents() {
    const feed = $('#feed-events');
    if (!feed) return;
    if (!S.events.length) {
      feed.innerHTML = '<div class="muted pad">nada por aqui ainda — mande uma requisição para o proxy</div>';
      return;
    }
    const rows = S.events.slice(-80).reverse().map((ev) => {
      const [cls, tag] = eventTag(ev);
      const tip = ev.upstream && ev.upstream.body ? `${eventText(ev)}\n\n${ev.upstream.body}` : eventText(ev);
      return `<div class="feed-item">
        <span class="feed-time">${esc(fmtTime(ev.ts))}</span>
        <span class="feed-tag ${cls}">${tag}</span>
        <span class="feed-main" title="${esc(tip)}">${esc(eventText(ev))}</span>
        <span class="feed-side">${eventSide(ev)}</span>
      </div>`;
    });
    feed.innerHTML = rows.join('');
    const count = $('#events-count');
    if (count) count.textContent = `${S.events.length} eventos`;
  }

  async function pollEvents() {
    try {
      const r = await bridge.call('GetEvents', S.lastEventId, 120);
      if (r && r.ok && r.events && Array.isArray(r.events.events) && r.events.events.length) {
        const fresh = r.events.events.filter((ev) => ev.id > S.lastEventId);
        if (fresh.length) {
          S.events.push(...fresh);
          if (S.events.length > 250) S.events = S.events.slice(-250);
          S.lastEventId = Math.max(...fresh.map((ev) => ev.id));
          if (S.page === 'dashboard') renderEvents();
        }
      }
    } catch { /* retry next tick */ }
  }

  // ============================== dashboard ==============================

  function totalsLatency(stats) {
    if (!stats || !Array.isArray(stats.byModel) || !stats.byModel.length) return null;
    let weighted = 0;
    let requests = 0;
    stats.byModel.forEach((row) => {
      const req = Number(row.requests || 0);
      weighted += Number(row.avgLatencyMs || 0) * req;
      requests += req;
    });
    return requests ? Math.round(weighted / requests) : null;
  }

  function renderDashboard() {
    const stats = S.stats;
    if (!stats) return;
    const t = stats.totals || {};

    $('#st-requests').textContent = fmtInt(t.requests);
    $('#st-requests-foot').textContent = `${fmtInt(t.ok)} ok · ${fmtInt(t.errors)} erros`;

    $('#st-tokens').textContent = shortNum(t.totalTokens);
    $('#st-tokens-foot').textContent = `in ${fmtInt(t.promptTokens)} · out ${fmtInt(t.completionTokens)}`;

    const avg = totalsLatency(stats);
    $('#st-latency').textContent = avg == null ? '—' : fmtMs(avg);
    const modelCount = stats.byModel ? stats.byModel.length : 0;
    $('#st-latency-foot').textContent = `${modelCount} ${modelCount === 1 ? 'modelo usado' : 'modelos usados'}`;

    $('#st-ratelimit').textContent = `${fmtInt(t.rateLimits)} / ${fmtInt(t.rotations)}`;
    $('#st-ratelimit-foot').textContent = `${fmtInt(t.aborted)} abortadas`;

    // model table
    const body = $('#table-models-body');
    if (!stats.byModel || !stats.byModel.length) {
      body.innerHTML = '<tr><td colspan="6" class="muted">sem requisições ainda</td></tr>';
    } else {
      const rows = stats.byModel.slice().sort((a, b) => (b.requests || 0) - (a.requests || 0)).map((row) => {
        const name = String(row.model || '').replace('opencode/', '');
        return `<tr>
          <td class="mono" title="${esc(row.model)}">${esc(name)}</td>
          <td class="num">${fmtInt(row.requests)}</td>
          <td class="num">${shortNum(row.promptTokens)}</td>
          <td class="num">${shortNum(row.completionTokens)}</td>
          <td class="num">${fmtMs(row.avgLatencyMs)}</td>
          <td class="num">${fmtInt(row.rateLimits)}</td>
        </tr>`;
      });
      body.innerHTML = rows.join('');
    }

    renderDashIP();
  }

  function renderDashIP() {
    if (!S.state) return;
    const tor = S.state.tor || {};
    const transport = (S.state.admin && S.state.admin.transport) || {};
    const ip = tor.currentIp || transport.lastRotateIp || '—';
    $('#dash-ip').textContent = ip;

    const stateBadge = $('#dash-ip-state');
    if (!tor.enabled) {
      stateBadge.className = 'badge dim';
      stateBadge.textContent = 'tor desligado';
    } else if (tor.busy) {
      stateBadge.className = 'badge warn';
      stateBadge.textContent = 'rotacionando…';
    } else if (tor.started) {
      stateBadge.className = 'badge ok';
      stateBadge.textContent = tor.degraded ? 'online (exit repetido)' : 'isolado';
    } else {
      stateBadge.className = 'badge warn';
      stateBadge.textContent = tor.bootstrapping ? `iniciando ${tor.bootstrapProgress || 0}%` : 'subindo…';
    }

    const meta = [];
    if (transport.rotateCount != null) {
      meta.push(`${transport.rotateCount} ${transport.rotateCount === 1 ? 'rotação' : 'rotações'}`);
    }
    if (tor.lastRotateMessage) meta.push(tor.lastRotateMessage);
    if (tor.lastError) meta.push(`erro: ${tor.lastError}`);
    $('#dash-ip-meta').textContent = meta.join(' · ') || '—';
  }

  // ============================== network ==============================

  function renderNetwork() {
    const st = S.state;
    if (!st) return;
    const tor = st.tor || {};
    const settings = st.settings || {};
    const transport = (st.admin && st.admin.transport) || {};

    const chkTor = $('#chk-tor');
    const chkRotate = $('#chk-rotate');
    if (chkTor && document.activeElement !== chkTor) chkTor.checked = !!settings.torEnabled;
    if (chkRotate && document.activeElement !== chkRotate) chkRotate.checked = !!settings.rotateOnRateLimit;

    // tor kv
    const rows = [];
    const statusText = !tor.enabled
      ? 'desligado'
      : tor.bootstrapping
        ? `iniciando (${tor.bootstrapProgress || 0}%)`
        : tor.started
          ? (tor.degraded ? 'online — último giro repetiu o exit' : 'online')
          : 'parado';
    rows.push(['estado', statusText]);
    rows.push(['SOCKS5', tor.socksAddr || '—']);
    rows.push(['controle', tor.controlAddr || '—']);
    rows.push(['transport no proxy', transport.isolated ? `isolado via ${transport.socks5 || '?'}` : (transport.socks5 ? transport.socks5 : 'direto (sem Tor)')]);
    if (tor.lastRotateAt) rows.push(['último giro', `${fmtTime(tor.lastRotateAt)} — ${tor.lastRotateMessage || ''}`]);
    if (tor.lastError) rows.push(['último erro', tor.lastError]);
    $('#tor-kv').innerHTML = rows.map(([k, v]) =>
      `<div class="kv-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');

    const wrap = $('#tor-progress-wrap');
    if (tor.bootstrapping) {
      wrap.classList.add('show');
      $('#tor-progress').style.width = `${tor.bootstrapProgress || 0}%`;
    } else {
      wrap.classList.remove('show');
    }

    // rotate kv
    const rotateRows = [
      ['rotações no proxy', String(transport.rotateCount ?? 0)],
      ['disponível', transport.rotateAvailable ? 'sim' : 'não configurado'],
      ['último IP do giro', transport.lastRotateIp || '—'],
    ];
    if (transport.busy) rotateRows.push(['agora', 'rotacionando…']);
    if (transport.lastRotateError) rotateRows.push(['último erro', transport.lastRotateError]);
    $('#rotate-kv').innerHTML = rotateRows.map(([k, v]) =>
      `<div class="kv-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');

    // ip card
    $('#net-ip').textContent = tor.currentIp || '—';
    const cooldown = Number(tor.cooldownRemainingMs || 0);
    $('#net-cooldown').textContent = !tor.enabled
      ? 'ligue o isolamento para usar a rotação'
      : cooldown > 0
        ? `aguarde ${Math.ceil(cooldown / 1000)}s para o próximo giro (proteção do Tor)`
        : 'pronto para um novo giro';

    // exit nodes input (only when not focused)
    const exitInput = $('#input-exit-nodes');
    if (exitInput && document.activeElement !== exitInput) exitInput.value = settings.torExitNodes || '';

    // history
    const history = Array.isArray(tor.history) ? tor.history.slice().reverse() : [];
    const feed = $('#feed-ip-history');
    if (!history.length) {
      feed.innerHTML = '<div class="muted pad">ninguém trocou de IP ainda</div>';
    } else {
      feed.innerHTML = history.slice(0, 40).map((ev) => {
        const ok = !ev.error;
        return `<div class="feed-item">
          <span class="feed-time">${esc(fmtTime(ev.timestamp))}</span>
          <span class="feed-tag ${ok ? 'rotate' : 'err'}">${ok ? 'IP' : 'ERR'}</span>
          <span class="feed-main">${esc(ev.ip || ev.error || '—')}</span>
          <span class="feed-side">${esc(ev.reason || '')}</span>
        </div>`;
      }).join('');
    }
    $('#ip-history-count').textContent = history.length ? `${history.length} registros` : '';
  }

  // ============================== models ==============================

  function modelCard(model) {
    const id = model.id || '';
    const isFree = model.free !== false;
    const inputMods = Array.isArray(model.inputModalities)
      ? model.inputModalities
      : (model.supportsVision ? ['text', 'image'] : ['text']);
    const apiMode = model.apiMode || 'chat';
    const context = model.contextWindow || model.context_length || null;
    const output = model.maxOutput || null;

    const badges = [];
    if (isFree) badges.push('<span class="badge ok">grátis</span>');
    badges.push(`<span class="badge ${apiMode === 'responses' ? 'warn' : 'dim'}">${apiMode === 'responses' ? 'responses' : 'chat'}</span>`);
    if (inputMods.some((m) => m === 'image' || m === 'video' || m === 'audio' || m === 'pdf')) {
      badges.push(`<span class="badge dim">visão: ${inputMods.filter((m) => m !== 'text').join(', ')}</span>`);
    }
    if (model.supportsTools) badges.push('<span class="badge dim">tools</span>');
    if (model.reasoning) badges.push('<span class="badge dim">reasoning</span>');

    const limits = [];
    if (context) limits.push(`contexto <b title="${fmtInt(context)} tokens">${shortNum(context)}</b>`);
    if (output) limits.push(`saída <b title="${fmtInt(output)} tokens">${shortNum(output)}</b>`);

    return `<div class="model-card">
      <div class="model-name">${esc(model.name || id)}</div>
      <div class="model-id" data-copy="${esc(id)}" title="clique para copiar o id">${esc(id)}</div>
      <div class="model-badges">${badges.join('')}</div>
      ${model.description ? `<div class="model-desc">${esc(model.description)}</div>` : ''}
      ${limits.length ? `<div class="model-limits">${limits.join('<span>·</span>')}</div>` : ''}
      <div class="model-actions">
        <button class="btn btn-sm" data-curl="${esc(id)}" data-mode="${apiMode}">copiar curl</button>
        <button class="btn btn-sm" data-config="${esc(id)}" data-context="${context || ''}" data-output="${output || ''}">copiar config</button>
        <button class="btn btn-sm btn-primary" data-testmodel="${esc(id)}">testar</button>
      </div>
    </div>`;
  }

  function renderModels() {
    const grid = $('#models-grid');
    if (!S.models) return;
    const freeOnly = $('#models-free-only').checked;
    const filter = ($('#models-filter').value || '').trim().toLowerCase();

    let list = [];
    const live = S.models.live && Array.isArray(S.models.live.data) ? S.models.live.data : null;
    if (live && live.length) list = live;
    else if (S.models.free && Array.isArray(S.models.free.data)) list = S.models.free.data;

    // The live catalog can repeat a model (chat + responses listings) — keep one.
    const seen = new Set();
    list = list.filter((m) => {
      const key = m.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (freeOnly) list = list.filter((m) => m.free !== false);
    if (filter) {
      list = list.filter((m) => `${m.id || ''} ${m.name || ''} ${m.description || ''}`.toLowerCase().includes(filter));
    }

    if (!list.length) {
      const err = S.models.liveError || S.models.freeError || '';
      grid.innerHTML = `<div class="muted pad">nenhum modelo${freeOnly ? ' gratuito' : ''} encontrado${err ? ` — ${esc(err)}` : ''}</div>`;
      $('#models-count').textContent = '';
      return;
    }
    grid.innerHTML = list.map(modelCard).join('');
    $('#models-count').textContent = `${list.length} modelo${list.length > 1 ? 's' : ''}`;
  }

  async function loadModels(force) {
    if (S.models && !force) { renderModels(); return; }
    try {
      const r = await bridge.call('ListModels');
      if (r) {
        S.models = r;
        renderModels();
        fillTestModels();
      }
    } catch { /* leave previous */ }
  }

  function fillTestModels() {
    const select = $('#test-model');
    if (!select || !S.models) return;
    const list = (S.models.free && Array.isArray(S.models.free.data) && S.models.free.data.length)
      ? S.models.free.data
      : (S.models.live && Array.isArray(S.models.live.data) ? S.models.live.data : []);
    const current = select.value;
    select.innerHTML = list
      .filter((m) => m.free !== false)
      .map((m) => `<option value="${esc(m.id)}">${esc((m.name || m.id) + ' — ' + shortNum(m.contextWindow || 0) + ' ctx')}</option>`)
      .join('');
    if (current && list.some((m) => m.id === current)) select.value = current;
    else {
      const preferred = list.find((m) => m.id === 'opencode/deepseek-v4.1-flash-free');
      if (preferred) select.value = preferred.id;
    }
  }

  function curlSnippet(id, mode) {
    if (mode === 'responses') {
      return `curl http://127.0.0.1:3000/v1/responses \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "${id}",\n    "input": "Explique o que é um circuito Tor."\n  }'`;
    }
    return `curl http://127.0.0.1:3000/v1/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "${id}",\n    "messages": [{"role": "user", "content": "Olá! Em uma frase, o que você é?"}]\n  }'`;
  }

  function configSnippet(id, context, output) {
    const limit = {};
    if (context) limit.context = Number(context);
    if (output) limit.output = Number(output);
    const model = { name: id.replace('opencode/', '') };
    if (Object.keys(limit).length) model.limit = limit;
    return JSON.stringify({
      provider: {
        'opencode-zen-proxy': {
          npm: '@ai-sdk/openai-compatible',
          name: 'OpenCode Zen Proxy',
          options: { baseURL: 'http://127.0.0.1:3000/v1', apiKey: 'public' },
          models: { [id.replace('opencode/', '')]: model },
        },
      },
    }, null, 2);
  }

  // ============================== keys ==============================

  function maskKey(key) {
    const text = String(key || '');
    if (text.length <= 14) return text;
    return `${text.slice(0, 10)}…${text.slice(-4)}`;
  }

  function renderKeys() {
    if (!S.keys) return;
    const data = S.keys.keys || S.keys;
    const requireKeys = !!data.requireKeys;
    const list = Array.isArray(data.keys) ? data.keys : [];
    const usage = Array.isArray(data.usage) ? data.usage : [];
    const usageById = {};
    usage.forEach((row) => { usageById[row.id] = row; });

    $('#chk-require-keys').checked = requireKeys;
    $('#keys-count').textContent = list.length ? `${list.length} ${list.length === 1 ? 'key' : 'keys'}` : '';

    const body = $('#table-keys-body');
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="7" class="muted">nenhuma key criada — keys são opcionais</td></tr>';
      return;
    }
    body.innerHTML = list.map((key) => {
      const use = usageById[key.id] || {};
      return `<tr>
        <td>${esc(key.name || '(sem nome)')}</td>
        <td class="mono" data-fullkey="${esc(key.key)}">${esc(maskKey(key.key))}</td>
        <td class="num">${fmtInt(use.requests)}</td>
        <td class="num">${shortNum(use.promptTokens)}</td>
        <td class="num">${shortNum(use.completionTokens)}</td>
        <td>${esc(fmtAgo(key.lastUsedAt))}</td>
        <td class="row-actions">
          <button class="btn btn-sm" data-key-reveal="${esc(key.id)}">ver</button>
          <button class="btn btn-sm" data-key-copy="${esc(key.key)}">copiar</button>
          <button class="btn btn-sm" data-key-rotate="${esc(key.id)}">rotacionar</button>
          <button class="btn btn-sm btn-danger" data-key-delete="${esc(key.id)}" data-key-name="${esc(key.name)}">excluir</button>
        </td>
      </tr>`;
    }).join('');
  }

  async function loadKeys() {
    try {
      const r = await bridge.call('ListKeys');
      if (r) { S.keys = r; renderKeys(); }
    } catch { /* proxy offline */ }
  }

  // ============================== docs ==============================

  function inlineMd(text) {
    return esc(text)
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function mdToHtml(md) {
    const lines = String(md || '').split('\n');
    let html = '';
    let inCode = false;
    let codeBuf = [];
    let inList = false;
    let tableRows = [];

    const flushList = () => { if (inList) { html += '</ul>'; inList = false; } };
    const flushTable = () => {
      if (!tableRows.length) return;
      const header = tableRows[0];
      const bodyRows = tableRows.slice(1);
      html += '<table><thead><tr>'
        + header.map((cell) => `<th>${inlineMd(cell)}</th>`).join('')
        + '</tr></thead><tbody>'
        + bodyRows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMd(cell)}</td>`).join('')}</tr>`).join('')
        + '</tbody></table>';
      tableRows = [];
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      if (line.startsWith('```')) {
        if (!inCode) { inCode = true; codeBuf = []; }
        else {
          inCode = false;
          html += `<pre><button class="copy-code">copiar</button><code>${esc(codeBuf.join('\n'))}</code></pre>`;
        }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }

      if (/^\|/.test(line)) {
        const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
        if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
        tableRows.push(cells);
        continue;
      }
      flushTable();

      if (/^### /.test(line)) { flushList(); html += `<h3>${inlineMd(line.slice(4))}</h3>`; continue; }
      if (/^## /.test(line)) { flushList(); html += `<h2>${inlineMd(line.slice(3))}</h2>`; continue; }
      if (/^# /.test(line)) { flushList(); html += `<h1>${inlineMd(line.slice(2))}</h1>`; continue; }
      if (/^> /.test(line)) { flushList(); html += `<blockquote><p>${inlineMd(line.slice(2))}</p></blockquote>`; continue; }
      if (/^- /.test(line)) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += `<li>${inlineMd(line.slice(2))}</li>`;
        continue;
      }
      if (/^---+\s*$/.test(line)) { flushList(); html += '<hr/>'; continue; }
      if (!line.trim()) { flushList(); continue; }

      html += `<p>${inlineMd(line)}</p>`;
    }
    flushList();
    flushTable();
    if (inCode && codeBuf.length) {
      html += `<pre><button class="copy-code">copiar</button><code>${esc(codeBuf.join('\n'))}</code></pre>`;
    }
    return html;
  }

  async function loadDocs() {
    if (S.docsLoaded) return;
    try {
      const r = await bridge.call('GetDocs');
      if (r && r.ok) {
        $('#docs-body').innerHTML = mdToHtml(r.markdown);
        S.docsLoaded = true;
      }
    } catch { /* retry on next visit */ }
  }

  // ============================== settings ==============================

  function renderSettingsLive() {
    const st = S.state;
    if (!st) return;
    const proxy = st.proxy || {};
    const tor = st.tor || {};

    const procRows = [
      ['estado', proxy.running ? `rodando (pid ${proxy.pid})` : 'parado'],
      ['porta', String((st.settings && st.settings.proxyPort) || proxy.port || '—')],
      ['iniciado em', proxy.startedAt ? fmtTime(proxy.startedAt) : '—'],
      ['último exit', proxy.exitCode != null ? String(proxy.exitCode) : '—'],
    ];
    if (proxy.lastError) procRows.push(['último erro', proxy.lastError]);
    $('#proc-kv').innerHTML = procRows.map(([k, v]) =>
      `<div class="kv-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');

    const pathRows = [
      ['dados do app', st.dataDir || '—'],
      ['bundle tor', tor.torPath || '—'],
      ['API local (preview)', `http://127.0.0.1:${st.localApiPort || '?'}`],
    ];
    $('#paths-kv').innerHTML = pathRows.map(([k, v]) =>
      `<div class="kv-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');

    $('#about-text').textContent = `OpenCode Zen Desktop v${st.appVersion} · proxy v${(st.admin && st.admin.proxy && st.admin.proxy.version) || '?'} · base URL para o cliente: ${st.proxyUrl}/v1`;
  }

  function fillSettingsForm() {
    const st = S.state;
    if (!st) return;
    const s = st.settings || {};
    $('#set-proxy-port').value = s.proxyPort ?? 3000;
    $('#set-proxy-dir').value = s.proxyDir || '';
    $('#set-node-bin').value = s.nodeBin || 'node';
    $('#set-log-level').value = s.logLevel || 'info';
    $('#set-autostart').checked = !!s.autoStartProxy;
    $('#set-tor-socks').value = s.torSocksPort ?? 19050;
    $('#set-tor-control').value = s.torControlPort ?? 19051;
    $('#set-exit-nodes').value = s.torExitNodes || '';
    $('#set-tor-enabled').checked = !!s.torEnabled;
    $('#set-rotate').checked = !!s.rotateOnRateLimit;
    S.settingsFilled = true;
  }

  function collectSettingsForm() {
    const base = (S.state && S.state.settings) || {};
    return {
      ...base,
      proxyPort: parseInt($('#set-proxy-port').value, 10) || base.proxyPort || 3000,
      proxyDir: $('#set-proxy-dir').value.trim(),
      nodeBin: $('#set-node-bin').value.trim() || 'node',
      logLevel: $('#set-log-level').value,
      autoStartProxy: $('#set-autostart').checked,
      torSocksPort: parseInt($('#set-tor-socks').value, 10) || base.torSocksPort || 19050,
      torControlPort: parseInt($('#set-tor-control').value, 10) || base.torControlPort || 19051,
      torExitNodes: $('#set-exit-nodes').value.trim(),
      torEnabled: $('#set-tor-enabled').checked,
      rotateOnRateLimit: $('#set-rotate').checked,
    };
  }

  // ============================== logs ==============================

  async function pollLogs() {
    try {
      const r = await bridge.call('GetLogs', S.logCursor, 400);
      if (r && r.ok && Array.isArray(r.entries)) {
        if (r.entries.length) {
          S.logs.push(...r.entries);
          if (S.logs.length > 3000) S.logs = S.logs.slice(-3000);
          S.logCursor = r.next || S.logCursor;
          if (S.page === 'logs') renderLogs();
        } else if (r.next) {
          S.logCursor = r.next;
        }
      }
    } catch { /* retry */ }
  }

  function renderLogs() {
    const view = $('#log-view');
    const level = S.logLevel;
    const lines = S.logs.filter((entry) => !level || entry.level === level);
    view.innerHTML = lines.map((entry) => {
      const line = esc(entry.line);
      return `<span class="log-line"><span class="t">${esc(entry.time)}</span> <span class="s">[${esc(entry.scope)}]</span> <span class="lv-${esc(entry.level)}">${esc(entry.level.padEnd(5))}</span> ${line}</span>\n`;
    }).join('');
    if (S.logAuto) view.scrollTop = view.scrollHeight;
  }

  // ============================== actions ==============================

  async function doRotate(btn) {
    busy(btn, true);
    try {
      const r = await bridge.call('RotateExit');
      if (r && r.ok) {
        const result = r.result || {};
        const parts = [(result.ip ? `novo IP: ${result.ip}` : 'rotação concluída')];
        if (result.message) parts.push(result.message);
        toast(parts.join(' — '), 'ok');
        await pollState();
      } else {
        toast((r && (r.error || (r.result && r.result.error))) || 'falha na rotação', 'err');
      }
    } catch (err) {
      toast(`rotação falhou: ${err.message || err}`, 'err');
    } finally {
      busy(btn, false);
    }
  }

  async function doRefreshIP(btn) {
    busy(btn, true);
    try {
      const r = await bridge.call('RefreshTorIP');
      if (r && r.ok) { toast(`IP de saída: ${r.ip}`, 'ok'); await pollState(); }
      else toast((r && r.error) || 'não consegui ler o IP', 'err');
    } catch (err) {
      toast(`falha ao ler IP: ${err.message || err}`, 'err');
    } finally {
      busy(btn, false);
    }
  }

  async function doTest(btn) {
    const model = $('#test-model').value || 'opencode/deepseek-v4.1-flash-free';
    const prompt = $('#test-prompt').value.trim() || undefined;
    const out = $('#test-output');
    busy(btn, true);
    out.textContent = `enviando teste para ${model}…`;
    try {
      const r = await bridge.call('TestRequest', model, prompt);
      const result = (r && r.result) || {};
      if (r && r.ok && result.ok) {
        const usage = result.usage || {};
        out.textContent = [
          `ok · ${result.model} · ${fmtMs(result.latencyMs)}`,
          usage.prompt_tokens != null ? `tokens: in ${fmtInt(usage.prompt_tokens)} · out ${fmtInt(usage.completion_tokens || 0)}` : null,
          '',
          result.preview || '(sem conteúdo)',
        ].filter((line) => line !== null).join('\n');
        toast('teste ok — pipeline completo funcionando', 'ok');
      } else {
        out.textContent = `falhou: ${(result.error) || (r && r.error) || 'erro desconhecido'}`;
        toast('teste falhou', 'err');
      }
    } catch (err) {
      out.textContent = `falhou: ${err.message || err}`;
      toast('teste falhou', 'err');
    } finally {
      busy(btn, false);
      pollEvents();
      pollStats();
    }
  }

  // ============================== wiring ==============================

  function setPage(page) {
    S.page = page;
    $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === page));
    $$('.page').forEach((section) => section.classList.toggle('active', section.id === `page-${page}`));
    const [title, sub] = PAGE_META[page] || ['', ''];
    $('#page-title').textContent = title;
    $('#page-sub').textContent = sub;

    if (page === 'dashboard') { pollStats(); pollEvents(); renderEvents(); renderDashboard(); }
    if (page === 'models') loadModels(false);
    if (page === 'keys') loadKeys();
    if (page === 'network') renderNetwork();
    if (page === 'docs') loadDocs();
    if (page === 'settings') { if (!S.settingsFilled) fillSettingsForm(); renderSettingsLive(); }
    if (page === 'logs') pollLogs().then(renderLogs);
  }

  function wire() {
    $$('.nav-item').forEach((item) => item.addEventListener('click', () => setPage(item.dataset.page)));

    $('#sidebar-url').addEventListener('click', () => {
      const url = $('#sidebar-url').textContent;
      if (url && url !== '—') copyText(`${url}`, 'base URL');
    });

    // rotate buttons
    ['btn-quick-rotate', 'btn-dash-rotate', 'btn-net-rotate'].forEach((id) => {
      const btn = $(`#${id}`);
      if (btn) btn.addEventListener('click', () => doRotate(btn));
    });
    ['btn-dash-refresh', 'btn-net-refresh'].forEach((id) => {
      const btn = $(`#${id}`);
      if (btn) btn.addEventListener('click', () => doRefreshIP(btn));
    });

    $('#btn-test').addEventListener('click', (event) => doTest(event.currentTarget));

    $('#btn-stats-reset').addEventListener('click', async () => {
      if (!window.confirm('Zerar todos os contadores de uso?')) return;
      const r = await bridge.call('ResetStats');
      if (r && r.ok) { S.stats = r.stats; S.events = []; S.lastEventId = 0; renderDashboard(); renderEvents(); toast('contadores zerados', 'ok'); }
      else toast((r && r.error) || 'falha ao zerar', 'err');
    });

    // models page
    $('#models-filter').addEventListener('input', renderModels);
    $('#models-free-only').addEventListener('change', renderModels);
    $('#btn-models-refresh').addEventListener('click', (event) => {
      busy(event.currentTarget, true);
      loadModels(true).finally(() => busy(event.currentTarget, false));
    });
    $('#models-grid').addEventListener('click', async (event) => {
      const target = event.target.closest('[data-copy], [data-curl], [data-config], [data-testmodel]');
      if (!target) return;
      if (target.dataset.copy) return copyText(target.dataset.copy, 'id do modelo');
      if (target.dataset.curl) return copyText(curlSnippet(target.dataset.curl, target.dataset.mode), 'curl');
      if (target.dataset.config) return copyText(configSnippet(target.dataset.config, target.dataset.context, target.dataset.output), 'config do opencode');
      if (target.dataset.testmodel) {
        const model = target.dataset.testmodel;
        busy(target, true);
        try {
          const r = await bridge.call('TestRequest', model, '');
          const result = (r && r.result) || {};
          if (r && r.ok && result.ok) {
            toast(`${model.split('/').pop()} ok · ${fmtMs(result.latencyMs)} · ${(result.preview || '').slice(0, 90)}`, 'ok');
          } else {
            toast(`teste falhou: ${(result.error) || (r && r.error) || 'erro'}`, 'err');
          }
        } catch (err) {
          toast(`teste falhou: ${err.message || err}`, 'err');
        } finally {
          busy(target, false);
          pollEvents();
          pollStats();
        }
      }
    });

    // keys page
    $('#chk-require-keys').addEventListener('change', async (event) => {
      const r = await bridge.call('SetRequireKeys', event.target.checked);
      if (r && r.ok) toast(event.target.checked ? 'agora keys são obrigatórias' : 'keys liberadas (modo aberto)', 'ok');
      else { toast((r && r.error) || 'falha', 'err'); loadKeys(); }
    });
    $('#btn-key-create').addEventListener('click', async (event) => {
      const name = $('#key-name').value.trim();
      if (!name) { toast('dê um nome para a key', 'warn'); return; }
      busy(event.currentTarget, true);
      const r = await bridge.call('CreateKey', name);
      busy(event.currentTarget, false);
      if (r && r.ok) {
        $('#key-name').value = '';
        toast(`key criada: ${r.key && r.key.key ? r.key.key : name}`, 'ok');
        loadKeys();
      } else toast((r && r.error) || 'falha ao criar', 'err');
    });
    $('#table-keys-body').addEventListener('click', async (event) => {
      const target = event.target.closest('[data-key-reveal], [data-key-copy], [data-key-rotate], [data-key-delete]');
      if (!target) return;
      if (target.dataset.keyCopy) return copyText(target.dataset.keyCopy, 'key');
      if (target.dataset.keyReveal) {
        const cell = target.closest('tr').querySelector('[data-fullkey]');
        const full = cell.dataset.fullkey;
        const hidden = cell.textContent.includes('…');
        cell.textContent = hidden ? full : maskKey(full);
        target.textContent = hidden ? 'ocultar' : 'ver';
        return;
      }
      if (target.dataset.keyRotate) {
        if (!window.confirm('Gerar um novo valor para esta key? O valor antigo para de funcionar.')) return;
        const r = await bridge.call('RotateKey', target.dataset.keyRotate);
        if (r && r.ok) { toast('key rotacionada', 'ok'); loadKeys(); }
        else toast((r && r.error) || 'falha', 'err');
        return;
      }
      if (target.dataset.keyDelete) {
        if (!window.confirm(`Excluir a key "${target.dataset.keyName}"?`)) return;
        const r = await bridge.call('DeleteKey', target.dataset.keyDelete);
        if (r && r.ok) { toast('key excluída', 'ok'); loadKeys(); }
        else toast((r && r.error) || 'falha', 'err');
      }
    });

    // network page
    $('#chk-tor').addEventListener('change', async (event) => {
      const torEnabled = event.target.checked;
      const rotate = $('#chk-rotate').checked;
      const r = await bridge.call('SetTransport', torEnabled, rotate);
      if (r && r.ok) toast(torEnabled ? 'isolamento Tor ligado' : 'isolamento Tor desligado — tráfego direto', 'ok');
      else { toast((r && r.error) || 'falha', 'err'); }
      pollState();
    });
    $('#chk-rotate').addEventListener('change', async (event) => {
      const torEnabled = $('#chk-tor').checked;
      const r = await bridge.call('SetTransport', torEnabled, event.target.checked);
      if (r && r.ok) toast(event.target.checked ? 'rotação automática ligada' : 'rotação automática desligada', 'ok');
      else toast((r && r.error) || 'falha', 'err');
      pollState();
    });
    $('#btn-exit-save').addEventListener('click', async (event) => {
      if (!S.state) return;
      busy(event.currentTarget, true);
      const next = { ...S.state.settings, torExitNodes: $('#input-exit-nodes').value.trim() };
      const r = await bridge.call('SaveSettings', next);
      busy(event.currentTarget, false);
      if (r && r.ok) { toast('filtro salvo — Tor reiniciando se mudou', 'ok'); await pollState(); }
      else toast((r && r.error) || 'falha', 'err');
    });

    // settings page
    $('#btn-save-settings').addEventListener('click', async (event) => {
      busy(event.currentTarget, true);
      const r = await bridge.call('SaveSettings', collectSettingsForm());
      busy(event.currentTarget, false);
      if (r && r.ok) { toast('configurações salvas', 'ok'); await pollState(); S.settingsFilled = false; fillSettingsForm(); }
      else toast((r && r.error) || 'falha ao salvar', 'err');
    });
    $('#btn-open-proxy-dir').addEventListener('click', () => {
      const dir = $('#set-proxy-dir').value.trim();
      if (dir) bridge.call('OpenPath', dir);
    });
    $('#btn-open-data-dir').addEventListener('click', () => {
      if (S.state && S.state.dataDir) bridge.call('OpenPath', S.state.dataDir);
    });
    $('#btn-restart-tor').addEventListener('click', async (event) => {
      busy(event.currentTarget, true);
      const r = await bridge.call('RestartTor');
      busy(event.currentTarget, false);
      if (r && r.ok) toast('Tor reiniciando…', 'ok'); else toast((r && r.error) || 'falha', 'err');
      pollState();
    });
    $('#btn-proxy-start').addEventListener('click', async () => {
      const r = await bridge.call('StartProxy');
      if (r && r.ok) toast('proxy iniciado', 'ok'); else toast((r && r.error) || 'falha', 'err');
      pollState();
    });
    $('#btn-proxy-stop').addEventListener('click', async () => {
      const r = await bridge.call('StopProxy');
      if (r && r.ok) toast('proxy parado', 'warn'); else toast((r && r.error) || 'falha', 'err');
      pollState();
    });
    $('#btn-proxy-restart').addEventListener('click', async (event) => {
      busy(event.currentTarget, true);
      const r = await bridge.call('RestartProxy');
      busy(event.currentTarget, false);
      if (r && r.ok) toast('proxy reiniciado', 'ok'); else toast((r && r.error) || 'falha', 'err');
      pollState();
    });

    // logs page
    $('#log-levels').addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-level]');
      if (!btn) return;
      $$('#log-levels button').forEach((b) => b.classList.toggle('active', b === btn));
      S.logLevel = btn.dataset.level;
      renderLogs();
    });
    $('#log-autoscroll').addEventListener('change', (event) => { S.logAuto = event.target.checked; });
    $('#btn-logs-clear').addEventListener('click', () => { S.logs = []; renderLogs(); });

    // docs copy buttons
    $('#docs-body').addEventListener('click', (event) => {
      if (event.target.classList.contains('copy-code')) {
        const code = event.target.closest('pre').querySelector('code');
        copyText(code.textContent, 'código');
      }
    });

    // keyboard: ctrl+1..7 switch pages
    document.addEventListener('keydown', (event) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const pages = ['dashboard', 'models', 'keys', 'network', 'docs', 'settings', 'logs'];
      const index = Number(event.key) - 1;
      if (pages[index]) { event.preventDefault(); setPage(pages[index]); }
    });
  }

  // ============================== boot ==============================

  async function boot() {
    wire();
    try {
      await bridge.ready();
    } catch { /* fall through */ }

    await pollState();
    if (S.state && S.state.tor) { /* chrome rendered inside pollState */ }
    fillSettingsForm();
    setPage('dashboard');
    loadModels(false);
    pollStats();
    pollEvents();

    setInterval(pollState, 2000);
    setInterval(() => {
      if (S.page === 'dashboard') { pollEvents(); pollStats(); }
      if (S.page === 'keys') loadKeys();
    }, 3000);
    setInterval(() => { if (S.page === 'logs') pollLogs(); }, 1400);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
