package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"desktop/internal/docs"
	"desktop/internal/logbuf"
	"desktop/internal/proxyproc"
	"desktop/internal/settings"
	"desktop/internal/tormgr"
	"desktop/tools"
)

// AppVersion is shown in the UI and the logs.
const AppVersion = "1.0.0"

// App is the Wails-bound service: it supervises the embedded Tor daemon, the
// node proxy process and the local HTTP control surface, and mirrors the
// node proxy's admin API for the frontend.
type App struct {
	ctx context.Context

	store *settings.Store
	logs  *logbuf.Buffer
	tor   *tormgr.Manager
	proc  *proxyproc.Proc

	assets embed.FS

	adminToken   string
	rotateToken  string
	localAPI     *http.Server
	localAPIPort int
}

// NewApp wires the app graph.
func NewApp(store *settings.Store, assets embed.FS) *App {
	logs := logbuf.New(1500)
	logf := func(scope, level, format string, args ...any) {
		logs.Add(scope, level, fmt.Sprintf(format, args...))
	}
	app := &App{
		store:  store,
		logs:   logs,
		tor:    tormgr.New(filepath.Join(settings.DataDir(), "tor"), logf),
		proc:   proxyproc.New(logs),
		assets: assets,
	}
	app.adminToken = randHex(24)
	app.rotateToken = randHex(24)
	return app
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Startup runs once the webview exists.
func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
	a.logs.Add("app", "info", fmt.Sprintf("OpenCode Zen Desktop v%s iniciando", AppVersion))

	s := a.store.Get()

	if path, err := tools.EnsureTor(settings.DataDir()); err != nil {
		a.logs.Add("tor", "error", "bundle tor indisponivel: "+err.Error())
	} else {
		a.tor.Configure(s.TorSocksPort, s.TorControlPort, s.TorExitNodes, path)
		a.logs.Add("tor", "info", "bundle tor embutido pronto")
	}

	// Released builds carry their own copy of the proxy; fall back to it when
	// the configured checkout is gone (fresh machine, downloaded release).
	if extracted, err := tools.EnsureProxySource(settings.DataDir()); err != nil {
		a.logs.Add("app", "error", "copia embutida do proxy: "+err.Error())
	} else if extracted != "" {
		if _, statErr := os.Stat(filepath.Join(s.ProxyDir, "src", "index.js")); statErr != nil {
			s.ProxyDir = extracted
			if saved, saveErr := a.store.Set(s); saveErr == nil {
				s = saved
			}
			a.logs.Add("app", "info", "usando copia embutida do proxy em "+extracted)
		}
	}

	a.startLocalAPI()
	a.applyRuntime(s)

	if s.AutoStartProxy {
		if err := a.proc.Start(); err != nil {
			a.logs.Add("app", "error", "proxy: "+err.Error())
		}
	}

	go a.bringUpEgress()
}

// Shutdown tears everything down (child processes first).
func (a *App) Shutdown(_ context.Context) {
	a.logs.Add("app", "info", "encerrando (proxy + tor)…")
	_ = a.proc.Stop()
	a.tor.Stop()
	if a.localAPI != nil {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = a.localAPI.Shutdown(shutdownCtx)
	}
}

// bringUpEgress starts Tor (when enabled), reads the exit IP and pushes the
// runtime transport into the proxy once it answers.
func (a *App) bringUpEgress() {
	s := a.store.Get()
	if s.TorEnabled {
		ctx, cancel := context.WithTimeout(context.Background(), tormgr.BootstrapTimeout+30*time.Second)
		defer cancel()
		if err := a.tor.EnsureStarted(ctx); err != nil {
			a.logs.Add("tor", "error", "tor nao subiu: "+err.Error())
		} else if ip, err := a.tor.FetchIP(ctx); err != nil {
			a.logs.Add("tor", "warn", "nao consegui ler o IP de saida: "+err.Error())
		} else {
			a.logs.Add("tor", "info", "IP de saida Tor: "+ip)
		}
	}
	a.syncTransportToProxy(s)
}

func (a *App) applyRuntime(s settings.Settings) {
	a.tor.Configure(s.TorSocksPort, s.TorControlPort, s.TorExitNodes, "")
	a.tor.SetEnabled(s.TorEnabled)
	a.proc.Configure(proxyproc.Config{
		Port:     s.ProxyPort,
		Dir:      s.ProxyDir,
		NodeBin:  s.NodeBin,
		LogLevel: s.LogLevel,
		Env:      a.proxyEnv(s),
	})
}

// proxyEnv builds the environment for the node proxy process.
func (a *App) proxyEnv(s settings.Settings) []string {
	socks := "socks5://127.0.0.1:" + strconv.Itoa(s.TorSocksPort)
	env := []string{
		"PORT=" + strconv.Itoa(s.ProxyPort),
		"HOST=127.0.0.1",
		"ADMIN_TOKEN=" + a.adminToken,
		"PROXY_DATA_DIR=" + filepath.Join(settings.DataDir(), "proxy-data"),
		"LOG_LEVEL=" + s.LogLevel,
		"IP_ROTATE_URL=http://127.0.0.1:" + strconv.Itoa(a.localAPIPort) + "/ip/rotate",
		"IP_ROTATE_TOKEN=" + a.rotateToken,
		"IP_ROTATE_ON_RATE_LIMIT=" + strconv.FormatBool(s.RotateOnRateLimit),
	}
	if s.TorEnabled {
		env = append(env, "TOR_SOCKS="+socks, "UPSTREAM_SOCKS5="+socks)
	}
	return env
}

// syncTransportToProxy PUTs the transport state, retrying while the proxy
// boots.
func (a *App) syncTransportToProxy(s settings.Settings) {
	payload := map[string]any{
		"rotateOnRateLimit": s.RotateOnRateLimit,
	}
	if s.TorEnabled {
		payload["socks5"] = "127.0.0.1:" + strconv.Itoa(s.TorSocksPort)
	} else {
		payload["socks5"] = nil
	}
	deadline := time.Now().Add(20 * time.Second)
	for {
		if _, err := a.adminRequest("PUT", "/admin/transport", payload, 5*time.Second); err == nil {
			a.logs.Add("app", "info", fmt.Sprintf("transporte sincronizado (tor=%v, rotate=%v)", s.TorEnabled, s.RotateOnRateLimit))
			return
		}
		if time.Now().After(deadline) {
			a.logs.Add("app", "warn", "nao consegui sincronizar o transporte com o proxy")
			return
		}
		time.Sleep(700 * time.Millisecond)
	}
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

func (a *App) proxyBase() string {
	return "http://127.0.0.1:" + strconv.Itoa(a.store.Get().ProxyPort)
}

// adminRequest talks to the node proxy's /admin API with the per-run token.
func (a *App) adminRequest(method, path string, body any, timeout time.Duration) (any, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, a.proxyBase()+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Admin-Token", a.adminToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("proxy offline (%v)", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	var payload any
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &payload)
	}
	if resp.StatusCode >= 400 {
		if m, ok := payload.(map[string]any); ok {
			if e, ok := m["error"].(map[string]any); ok {
				if msg, ok := e["message"].(string); ok {
					return payload, fmt.Errorf("%s", msg)
				}
			}
		}
		return payload, fmt.Errorf("admin HTTP %d", resp.StatusCode)
	}
	return payload, nil
}

// publicRequest talks to the open (non-admin) surface of the proxy.
func (a *App) publicRequest(path string, timeout time.Duration) (any, error) {
	client := &http.Client{Timeout: timeout}
	resp, err := client.Get(a.proxyBase() + path)
	if err != nil {
		return nil, fmt.Errorf("proxy offline (%v)", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	var payload any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("resposta invalida do proxy (HTTP %d)", resp.StatusCode)
	}
	if resp.StatusCode >= 400 {
		return payload, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return payload, nil
}

func randHex(bytesLen int) string {
	raw := make([]byte, bytesLen)
	if _, err := rand.Read(raw); err != nil {
		return fmt.Sprintf("fallback%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(raw)
}

// ---------------------------------------------------------------------------
// Bindings — state
// ---------------------------------------------------------------------------

// GetState is the UI's main poll: processes + tor + settings + admin overview.
func (a *App) GetState() map[string]any {
	s := a.store.Get()
	state := map[string]any{
		"appVersion":   AppVersion,
		"dataDir":      settings.DataDir(),
		"localApiPort": a.localAPIPort,
		"settings":     s,
		"proxy":        a.proc.Status(),
		"tor":          a.tor.Status(),
		"proxyUrl":     a.proxyBase(),
	}
	if overview, err := a.adminRequest("GET", "/admin/overview", nil, 5*time.Second); err == nil {
		state["admin"] = overview
	} else {
		state["admin"] = nil
		state["adminError"] = err.Error()
	}
	return state
}

// GetStats returns the proxy's stats snapshot.
func (a *App) GetStats() map[string]any {
	data, err := a.adminRequest("GET", "/admin/stats", nil, 10*time.Second)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true, "stats": data}
}

// ResetStats zeroes the counters.
func (a *App) ResetStats() map[string]any {
	data, err := a.adminRequest("POST", "/admin/stats/reset", map[string]any{}, 10*time.Second)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true, "stats": data}
}

// GetEvents returns the incremental event feed.
func (a *App) GetEvents(after int, limit int) map[string]any {
	if limit <= 0 || limit > 250 {
		limit = 120
	}
	path := fmt.Sprintf("/admin/events?after=%d&limit=%d", after, limit)
	data, err := a.adminRequest("GET", path, nil, 10*time.Second)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true, "events": data}
}

// ListModels returns the live catalog plus the curated free list.
func (a *App) ListModels() map[string]any {
	out := map[string]any{"ok": true}
	if live, err := a.publicRequest("/v1/models", 40*time.Second); err == nil {
		out["live"] = live
	} else {
		out["liveError"] = err.Error()
	}
	if free, err := a.publicRequest("/v1/models/free", 10*time.Second); err == nil {
		out["free"] = free
	} else {
		out["freeError"] = err.Error()
	}
	return out
}

// ---------------------------------------------------------------------------
// Bindings — keys
// ---------------------------------------------------------------------------

// ListKeys returns the key store with per-key usage.
func (a *App) ListKeys() map[string]any {
	data, err := a.adminRequest("GET", "/admin/keys", nil, 10*time.Second)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true, "keys": data}
}

// CreateKey creates one optional bearer key.
func (a *App) CreateKey(name string) map[string]any {
	data, err := a.adminRequest("POST", "/admin/keys", map[string]any{"name": name}, 10*time.Second)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true, "key": data}
}

// DeleteKey removes a key by id.
func (a *App) DeleteKey(id string) map[string]any {
	data, err := a.adminRequest("DELETE", "/admin/keys/"+id, nil, 10*time.Second)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true, "result": data}
}

// RotateKey swaps the secret of an existing key.
func (a *App) RotateKey(id string) map[string]any {
	data, err := a.adminRequest("POST", "/admin/keys/"+id+"/rotate", map[string]any{}, 10*time.Second)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true, "key": data}
}

// SetRequireKeys toggles mandatory key validation.
func (a *App) SetRequireKeys(require bool) map[string]any {
	data, err := a.adminRequest("PATCH", "/admin/keys/settings", map[string]any{"requireKeys": require}, 10*time.Second)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true, "result": data}
}

// ---------------------------------------------------------------------------
// Bindings — transport / egress
// ---------------------------------------------------------------------------

// GetTransport reads the proxy's live transport state.
func (a *App) GetTransport() map[string]any {
	data, err := a.adminRequest("GET", "/admin/transport", nil, 8*time.Second)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true, "transport": data}
}

// SetTransport flips Tor isolation / rotate-on-rate-limit at runtime and
// persists the choice.
func (a *App) SetTransport(torEnabled bool, rotateOnRateLimit bool) map[string]any {
	s := a.store.Get()
	s.TorEnabled = torEnabled
	s.RotateOnRateLimit = rotateOnRateLimit
	saved, err := a.store.Set(s)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	a.tor.SetEnabled(torEnabled)
	if torEnabled && !a.tor.Status().Started {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), tormgr.BootstrapTimeout+30*time.Second)
			defer cancel()
			if err := a.tor.EnsureStarted(ctx); err != nil {
				a.logs.Add("tor", "error", "tor nao subiu: "+err.Error())
				return
			}
			_, _ = a.tor.FetchIP(ctx)
			a.syncTransportToProxy(saved)
		}()
	} else {
		a.syncTransportToProxy(saved)
	}
	return map[string]any{"ok": true, "settings": saved}
}

// RotateExit asks for a fresh circuit through the proxy admin API (which
// routes to the IP manager and records the rotation in the stats feed).
func (a *App) RotateExit() map[string]any {
	if !a.tor.Enabled() {
		return map[string]any{"ok": false, "error": "isolamento Tor desligado — ligue na aba Rede & IP"}
	}
	result, err := a.adminRequest("POST", "/admin/rotate", map[string]any{"reason": "manual (app)"}, 100*time.Second)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error(), "result": result}
	}
	return map[string]any{"ok": true, "result": result}
}

// RefreshTorIP reads the current exit IP through the SOCKS port.
func (a *App) RefreshTorIP() map[string]any {
	if !a.tor.Enabled() {
		return map[string]any{"ok": false, "error": "tor desligado"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	ip, err := a.tor.FetchIP(ctx)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true, "ip": ip}
}

// RestartTor restarts the daemon so torrc changes (exit-node filter) apply.
func (a *App) RestartTor() map[string]any {
	if !a.tor.Enabled() {
		return map[string]any{"ok": false, "error": "tor desligado — ligue o isolamento primeiro"}
	}
	a.tor.Stop()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), tormgr.BootstrapTimeout+30*time.Second)
		defer cancel()
		if err := a.tor.EnsureStarted(ctx); err != nil {
			a.logs.Add("tor", "error", "reiniciar tor: "+err.Error())
			return
		}
		if ip, err := a.tor.FetchIP(ctx); err == nil {
			a.logs.Add("tor", "info", "IP de saida Tor (apos reinicio): "+ip)
		}
	}()
	return map[string]any{"ok": true}
}

// ---------------------------------------------------------------------------
// Bindings — test / settings / process / logs / docs
// ---------------------------------------------------------------------------

// TestRequest runs one tiny completion through the full pipeline.
func (a *App) TestRequest(model string, prompt string) map[string]any {
	if strings.TrimSpace(model) == "" {
		model = "opencode/deepseek-v4.1-flash-free"
	}
	data, err := a.adminRequest("POST", "/admin/test", map[string]any{"model": model, "prompt": prompt}, 240*time.Second)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error(), "result": data}
	}
	return map[string]any{"ok": true, "result": data}
}

// GetSettings returns the persisted settings.
func (a *App) GetSettings() settings.Settings {
	return a.store.Get()
}

// SaveSettings persists settings and applies side effects (tor toggle,
// proxy restart when spawn-affecting fields changed, transport sync).
func (a *App) SaveSettings(next settings.Settings) map[string]any {
	prev := a.store.Get()
	saved, err := a.store.Set(next)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	a.applyRuntime(saved)

	if saved.TorEnabled && !a.tor.Status().Started {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), tormgr.BootstrapTimeout+30*time.Second)
			defer cancel()
			if err := a.tor.EnsureStarted(ctx); err != nil {
				a.logs.Add("tor", "error", "tor nao subiu: "+err.Error())
				return
			}
			_, _ = a.tor.FetchIP(ctx)
			a.syncTransportToProxy(saved)
		}()
	} else {
		a.syncTransportToProxy(saved)
	}

	spawnChanged := prev.ProxyPort != saved.ProxyPort || prev.ProxyDir != saved.ProxyDir || prev.NodeBin != saved.NodeBin
	if spawnChanged && a.proc.Status().Running {
		go func() {
			if err := a.proc.Restart(); err != nil {
				a.logs.Add("app", "error", "reiniciar proxy: "+err.Error())
			}
		}()
	}

	// torrc-only changes (exit filter) need a daemon restart to apply.
	if prev.TorExitNodes != saved.TorExitNodes &&
		prev.TorSocksPort == saved.TorSocksPort && prev.TorControlPort == saved.TorControlPort &&
		saved.TorEnabled {
		go func() {
			a.tor.Stop()
			ctx, cancel := context.WithTimeout(context.Background(), tormgr.BootstrapTimeout+30*time.Second)
			defer cancel()
			if err := a.tor.EnsureStarted(ctx); err != nil {
				a.logs.Add("tor", "error", "reiniciar tor (exit nodes): "+err.Error())
				return
			}
			_, _ = a.tor.FetchIP(ctx)
		}()
	}
	return map[string]any{"ok": true, "settings": saved}
}

// StartProxy spawns the node proxy.
func (a *App) StartProxy() map[string]any {
	if err := a.proc.Start(); err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true}
}

// StopProxy kills the node proxy.
func (a *App) StopProxy() map[string]any {
	if err := a.proc.Stop(); err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true}
}

// RestartProxy restarts the node proxy.
func (a *App) RestartProxy() map[string]any {
	if err := a.proc.Restart(); err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true}
}

// GetLogs returns the log ring after a cursor.
func (a *App) GetLogs(after int, limit int) map[string]any {
	entries, next := a.logs.After(uint64(after), limit)
	return map[string]any{"ok": true, "entries": entries, "next": next}
}

// GetDocs returns the embedded documentation.
func (a *App) GetDocs() map[string]any {
	return map[string]any{"ok": true, "markdown": docs.Markdown, "version": AppVersion}
}

// OpenPath reveals a folder in the system explorer.
func (a *App) OpenPath(path string) map[string]any {
	path = strings.TrimSpace(path)
	if path == "" {
		return map[string]any{"ok": false, "error": "caminho vazio"}
	}
	if _, err := os.Stat(path); err != nil {
		path = filepath.Dir(path)
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", path)
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	_ = cmd.Start()
	return map[string]any{"ok": true}
}

// GetLocalAPI exposes the preview URL for the footer.
func (a *App) GetLocalAPI() map[string]any {
	return map[string]any{
		"ok":  true,
		"url": fmt.Sprintf("http://127.0.0.1:%d", a.localAPIPort),
	}
}

// ---------------------------------------------------------------------------
// Local HTTP API (browser preview + IP manager for the node proxy)
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func jsonHandler(fn func(*http.Request) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		payload, err := fn(r)
		if err != nil {
			writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, 200, payload)
	}
}

func readJSON(r *http.Request, target any) error {
	return json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(target)
}

func queryInt(r *http.Request, key string, fallback int) int {
	if raw := r.URL.Query().Get(key); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil {
			return value
		}
	}
	return fallback
}

// guardRotate protects the IP manager endpoints with the per-run rotate token
// (the only consumer is the node proxy).
func (a *App) guardRotate(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Admin-Token") != a.rotateToken {
			writeJSON(w, 401, map[string]any{"error": "invalid rotate token"})
			return
		}
		next(w, r)
	}
}

func (a *App) handleIPStatus(w http.ResponseWriter, _ *http.Request) {
	status := a.tor.Status()
	writeJSON(w, 200, map[string]any{
		"ok":                  true,
		"enabled":             status.Enabled,
		"started":             status.Started,
		"busy":                status.Busy,
		"ip":                  status.CurrentIP,
		"cooldownRemainingMs": status.CooldownRemainingMs,
		"lastError":           status.LastError,
	})
}

func (a *App) handleIPRotate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Reason string `json:"reason"`
	}
	_ = readJSON(r, &body)
	reason := strings.TrimSpace(body.Reason)
	if reason == "" {
		reason = "rate limit"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 95*time.Second)
	defer cancel()

	result, err := a.tor.Rotate(ctx, reason)
	if err != nil {
		writeJSON(w, 503, map[string]any{
			"ok":      false,
			"error":   err.Error(),
			"ip":      result.IP,
			"changed": result.Changed,
			"message": result.Message,
		})
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok":      true,
		"ip":      result.IP,
		"changed": result.Changed,
		"message": result.Message,
	})
}

// spaHandler serves the embedded frontend with an index fallback.
func spaHandler(fsys fs.FS) http.Handler {
	files := http.FileServer(http.FS(fsys))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if _, err := fs.Stat(fsys, path); err != nil {
			clone := r.Clone(r.Context())
			clone.URL.Path = "/"
			files.ServeHTTP(w, clone)
			return
		}
		files.ServeHTTP(w, r)
	})
}

func (a *App) startLocalAPI() {
	mux := http.NewServeMux()

	// Node-proxy facing (IP manager).
	mux.HandleFunc("/ip/status", a.guardRotate(a.handleIPStatus))
	mux.HandleFunc("/ip/rotate", a.guardRotate(a.handleIPRotate))

	// UI mirrors (used when the frontend runs in a plain browser).
	mux.HandleFunc("/api/state", jsonHandler(func(*http.Request) (any, error) { return a.GetState(), nil }))
	mux.HandleFunc("/api/stats", jsonHandler(func(*http.Request) (any, error) { return a.GetStats(), nil }))
	mux.HandleFunc("/api/stats/reset", jsonHandler(func(*http.Request) (any, error) { return a.ResetStats(), nil }))
	mux.HandleFunc("/api/events", jsonHandler(func(r *http.Request) (any, error) {
		return a.GetEvents(queryInt(r, "after", 0), queryInt(r, "limit", 120)), nil
	}))
	mux.HandleFunc("/api/models", jsonHandler(func(*http.Request) (any, error) { return a.ListModels(), nil }))
	mux.HandleFunc("/api/keys", jsonHandler(func(r *http.Request) (any, error) {
		switch r.Method {
		case http.MethodPost:
			var body struct {
				Name string `json:"name"`
			}
			_ = readJSON(r, &body)
			return a.CreateKey(body.Name), nil
		case http.MethodDelete:
			return a.DeleteKey(r.URL.Query().Get("id")), nil
		default:
			return a.ListKeys(), nil
		}
	}))
	mux.HandleFunc("/api/keys/rotate", jsonHandler(func(r *http.Request) (any, error) {
		return a.RotateKey(r.URL.Query().Get("id")), nil
	}))
	mux.HandleFunc("/api/keys/require", jsonHandler(func(r *http.Request) (any, error) {
		var body struct {
			RequireKeys bool `json:"requireKeys"`
		}
		_ = readJSON(r, &body)
		return a.SetRequireKeys(body.RequireKeys), nil
	}))
	mux.HandleFunc("/api/transport", jsonHandler(func(r *http.Request) (any, error) {
		if r.Method == http.MethodPut || r.Method == http.MethodPost {
			var body struct {
				TorEnabled        *bool `json:"torEnabled"`
				RotateOnRateLimit *bool `json:"rotateOnRateLimit"`
			}
			_ = readJSON(r, &body)
			s := a.store.Get()
			torEnabled := s.TorEnabled
			rotate := s.RotateOnRateLimit
			if body.TorEnabled != nil {
				torEnabled = *body.TorEnabled
			}
			if body.RotateOnRateLimit != nil {
				rotate = *body.RotateOnRateLimit
			}
			return a.SetTransport(torEnabled, rotate), nil
		}
		return a.GetTransport(), nil
	}))
	mux.HandleFunc("/api/rotate", jsonHandler(func(*http.Request) (any, error) { return a.RotateExit(), nil }))
	mux.HandleFunc("/api/tor/ip", jsonHandler(func(*http.Request) (any, error) { return a.RefreshTorIP(), nil }))
	mux.HandleFunc("/api/tor/restart", jsonHandler(func(*http.Request) (any, error) { return a.RestartTor(), nil }))
	mux.HandleFunc("/api/test", jsonHandler(func(r *http.Request) (any, error) {
		var body struct {
			Model  string `json:"model"`
			Prompt string `json:"prompt"`
		}
		_ = readJSON(r, &body)
		return a.TestRequest(body.Model, body.Prompt), nil
	}))
	mux.HandleFunc("/api/settings", jsonHandler(func(r *http.Request) (any, error) {
		if r.Method == http.MethodPut || r.Method == http.MethodPost {
			var body settings.Settings
			if err := readJSON(r, &body); err != nil {
				return map[string]any{"ok": false, "error": err.Error()}, nil
			}
			return a.SaveSettings(body), nil
		}
		return map[string]any{"ok": true, "settings": a.GetSettings()}, nil
	}))
	mux.HandleFunc("/api/proxy/start", jsonHandler(func(*http.Request) (any, error) { return a.StartProxy(), nil }))
	mux.HandleFunc("/api/proxy/stop", jsonHandler(func(*http.Request) (any, error) { return a.StopProxy(), nil }))
	mux.HandleFunc("/api/proxy/restart", jsonHandler(func(*http.Request) (any, error) { return a.RestartProxy(), nil }))
	mux.HandleFunc("/api/logs", jsonHandler(func(r *http.Request) (any, error) {
		return a.GetLogs(queryInt(r, "after", 0), queryInt(r, "limit", 400)), nil
	}))
	mux.HandleFunc("/api/docs", jsonHandler(func(*http.Request) (any, error) { return a.GetDocs(), nil }))
	mux.HandleFunc("/api/openpath", jsonHandler(func(r *http.Request) (any, error) {
		var body struct {
			Path string `json:"path"`
		}
		_ = readJSON(r, &body)
		return a.OpenPath(body.Path), nil
	}))

	// Static frontend (browser preview).
	if sub, err := fs.Sub(a.assets, "frontend/dist"); err == nil {
		mux.Handle("/", spaHandler(sub))
	}

	addr := "127.0.0.1:" + strconv.Itoa(a.store.Get().LocalAPIPort)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		listener, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			a.logs.Add("api", "error", "servidor local nao subiu: "+err.Error())
			return
		}
		a.logs.Add("api", "warn", "porta local ocupada — usando porta aleatoria")
	}
	a.localAPIPort = listener.Addr().(*net.TCPAddr).Port
	a.localAPI = &http.Server{Handler: mux}
	go func() {
		a.logs.Add("api", "info", fmt.Sprintf("API local + preview em http://127.0.0.1:%d", a.localAPIPort))
		if err := a.localAPI.Serve(listener); err != nil && err != http.ErrServerClosed {
			a.logs.Add("api", "error", "servidor local: "+err.Error())
		}
	}()
}
