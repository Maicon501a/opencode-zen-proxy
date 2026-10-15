// Package tormgr supervises an embedded Tor daemon (Expert Bundle tor.exe)
// as an invisible child process and exposes circuit rotation.
//
// Modeled on the proven WARP-recovery pattern: the daemon listens on a local
// SOCKS5 port (traffic isolation) and a cookie-authenticated control port
// (SIGNAL NEWNYM → fresh exit → fresh public IP). Rotation is confirmed by
// observing the public IP **through the SOCKS port** — never the machine's
// real address — and is protected by a cooldown with exponential backoff.
package tormgr

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// BootstrapTimeout bounds the initial consensus download / circuit build.
	BootstrapTimeout = 120 * time.Second
	// Tor itself drops NEWNYM requests fired less than ~10s apart.
	minRotateInterval = 10 * time.Second
	// How long to wait for the public IP to actually change after NEWNYM.
	rotateConfirmWait = 25 * time.Second
)

// IPEvent is one observation of the exit IP.
type IPEvent struct {
	Timestamp string `json:"timestamp"`
	IP        string `json:"ip,omitempty"`
	Reason    string `json:"reason,omitempty"`
	Error     string `json:"error,omitempty"`
}

// RotationResult is the answer handed to the node proxy's rotate client.
type RotationResult struct {
	Ok      bool   `json:"ok"`
	IP      string `json:"ip,omitempty"`
	Changed bool   `json:"changed"`
	Message string `json:"message,omitempty"`
	Error   string `json:"error,omitempty"`
	Ms      int64  `json:"ms"`
}

// Status is the serializable view consumed by the UI.
type Status struct {
	Enabled             bool            `json:"enabled"`
	Started             bool            `json:"started"`
	Busy                bool            `json:"busy"`
	Degraded            bool            `json:"degraded"`
	Bootstrapping       bool            `json:"bootstrapping"`
	BootstrapProgress   int             `json:"bootstrapProgress"`
	CooldownRemainingMs int64           `json:"cooldownRemainingMs"`
	SocksAddr           string          `json:"socksAddr"`
	ControlAddr         string          `json:"controlAddr"`
	CurrentIP           string          `json:"currentIp,omitempty"`
	LastError           string          `json:"lastError,omitempty"`
	LastRotateAt        string          `json:"lastRotateAt,omitempty"`
	LastRotateMessage   string          `json:"lastRotateMessage,omitempty"`
	TorPath             string          `json:"torPath,omitempty"`
	DataDir             string          `json:"dataDir"`
	History             []IPEvent       `json:"history"`
	LastResult          *RotationResult `json:"lastResult,omitempty"`
}

// Manager owns the tor child process and its state machine.
type Manager struct {
	mu                sync.Mutex
	enabled           bool
	socksPort         int
	controlPort       int
	dataDir           string
	torPath           string
	ipURL             string
	exitNodes         string
	bootstrapping     bool
	bootstrapProgress int
	started           bool
	degraded          bool
	busy              bool
	cooldownUntil     time.Time
	failures          int
	history           []IPEvent
	lastError         string
	lastRotateAt      time.Time
	lastRotateMessage string
	currentIP         string
	lastResult        *RotationResult

	procMu sync.Mutex
	cmd    *exec.Cmd
	exited chan error

	logf func(scope, level, format string, args ...any)
}

// New creates a manager. logf may be nil.
func New(dataDir string, logf func(scope, level, format string, args ...any)) *Manager {
	if logf == nil {
		logf = func(string, string, string, ...any) {}
	}
	return &Manager{
		dataDir:     dataDir,
		socksPort:   19050,
		controlPort: 19051,
		ipURL:       "https://api.ipify.org?format=json",
		logf:        logf,
	}
}

// Configure applies ports / exit-node filter / tor path from settings.
func (m *Manager) Configure(socksPort, controlPort int, exitNodes, torPath string) {
	m.mu.Lock()
	if socksPort > 0 {
		m.socksPort = socksPort
	}
	if controlPort > 0 {
		m.controlPort = controlPort
	}
	m.exitNodes = strings.TrimSpace(exitNodes)
	if strings.TrimSpace(torPath) != "" {
		m.torPath = strings.TrimSpace(torPath)
	}
	m.mu.Unlock()
}

// SetEnabled toggles the Tor egress. Disabling stops the daemon immediately.
func (m *Manager) SetEnabled(enabled bool) {
	m.mu.Lock()
	m.enabled = enabled
	m.mu.Unlock()
	if !enabled {
		m.Stop()
	}
}

// Enabled reports the toggle state.
func (m *Manager) Enabled() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.enabled
}

// SocksAddr is the endpoint the proxy routes requests to.
func (m *Manager) SocksAddr() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return fmt.Sprintf("127.0.0.1:%d", m.socksPort)
}

// ControlAddr is the tor control port endpoint.
func (m *Manager) ControlAddr() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return fmt.Sprintf("127.0.0.1:%d", m.controlPort)
}

// Status returns the current view.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	status := Status{
		Enabled:           m.enabled,
		Started:           m.started,
		Busy:              m.busy,
		Degraded:          m.degraded,
		Bootstrapping:     m.bootstrapping,
		BootstrapProgress: m.bootstrapProgress,
		SocksAddr:         fmt.Sprintf("127.0.0.1:%d", m.socksPort),
		ControlAddr:       fmt.Sprintf("127.0.0.1:%d", m.controlPort),
		CurrentIP:         m.currentIP,
		LastError:         m.lastError,
		LastRotateMessage: m.lastRotateMessage,
		TorPath:           m.torPath,
		DataDir:           m.dataDir,
		History:           append([]IPEvent(nil), m.history...),
	}
	if wait := m.cooldownRemainingLocked(); wait > 0 {
		status.CooldownRemainingMs = wait.Milliseconds()
	}
	if !m.lastRotateAt.IsZero() {
		status.LastRotateAt = m.lastRotateAt.UTC().Format(time.RFC3339)
	}
	if m.lastResult != nil {
		copy := *m.lastResult
		status.LastResult = &copy
	}
	return status
}

func (m *Manager) cooldownRemainingLocked() time.Duration {
	if m.cooldownUntil.IsZero() {
		return 0
	}
	wait := time.Until(m.cooldownUntil)
	if wait < 0 {
		return 0
	}
	return wait
}

func (m *Manager) cookiePath() string {
	return filepath.Join(m.dataDir, "control_auth_cookie")
}

func (m *Manager) torrcPath() string {
	return filepath.Join(m.dataDir, "torrc")
}

// alive reports whether the daemon answers on the control port. The started
// flag alone is not proof of life: an externally killed process leaves it
// stale.
func (m *Manager) alive() bool {
	m.procMu.Lock()
	cmd := m.cmd
	m.procMu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return false
	}
	conn, err := net.DialTimeout("tcp", m.ControlAddr(), 2*time.Second)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// EnsureStarted launches tor.exe when needed and waits for bootstrap 100%.
func (m *Manager) EnsureStarted(ctx context.Context) error {
	m.mu.Lock()
	if !m.enabled {
		m.mu.Unlock()
		return errors.New("tor desativado nas configuracoes")
	}
	started := m.started
	torPath := m.torPath
	m.mu.Unlock()

	if torPath == "" {
		return errors.New("tor.exe nao encontrado no bundle embutido")
	}

	if started && m.alive() {
		return nil
	}
	if started {
		m.mu.Lock()
		m.started = false
		m.mu.Unlock()
		m.logf("tor", "warn", "daemon tor morto detectado — relancando")
		m.procMu.Lock()
		_ = m.killLocked()
		m.procMu.Unlock()
	}

	return m.launch(ctx, torPath)
}

func (m *Manager) launch(ctx context.Context, torPath string) error {
	m.procMu.Lock()
	defer m.procMu.Unlock()

	// Already up? (the exited channel tells us if the process died)
	if m.cmd != nil && m.exited != nil {
		select {
		case <-m.exited:
		default:
			return nil
		}
	}

	if err := os.MkdirAll(m.dataDir, 0o700); err != nil {
		return err
	}

	m.mu.Lock()
	socksAddr := fmt.Sprintf("127.0.0.1:%d", m.socksPort)
	controlAddr := fmt.Sprintf("127.0.0.1:%d", m.controlPort)
	exitNodes := m.exitNodes
	m.mu.Unlock()

	lines := []string{
		"SOCKSPort " + socksAddr,
		"ControlPort " + controlAddr,
		"CookieAuthentication 1",
		"DataDirectory " + filepath.ToSlash(m.dataDir),
		"ClientOnly 1",
		"AvoidDiskWrites 1",
		"Log notice file " + filepath.ToSlash(filepath.Join(m.dataDir, "tor.log")),
	}
	if exitNodes != "" {
		lines = append(lines, "ExitNodes {"+exitNodes+"}")
	}
	if err := os.WriteFile(m.torrcPath(), []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		return err
	}

	// Clear any orphan from a previous run before binding the ports.
	m.killResidualPid()
	m.ensurePortsFree()

	cmd := exec.Command(torPath, "-f", m.torrcPath())
	prepareProcess(cmd)
	configureTorEnv(cmd, filepath.Dir(torPath))
	cmd.Dir = filepath.Dir(torPath)
	logFile, err := os.OpenFile(filepath.Join(m.dataDir, "stdout.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err == nil {
		cmd.Stdout = logFile
		cmd.Stderr = logFile
		defer logFile.Close()
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("iniciar tor: %w", err)
	}
	_ = os.WriteFile(filepath.Join(m.dataDir, "tor.pid"), []byte(strconv.Itoa(cmd.Process.Pid)), 0o600)
	m.cmd = cmd
	m.exited = make(chan error, 1)
	go func() {
		m.exited <- cmd.Wait()
	}()

	m.mu.Lock()
	m.bootstrapping = true
	m.bootstrapProgress = 0
	m.lastError = ""
	m.mu.Unlock()
	m.logf("tor", "info", "tor iniciado (pid %d) — aguardando bootstrap", cmd.Process.Pid)

	deadline := time.Now().Add(BootstrapTimeout)
	ticker := time.NewTicker(700 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			_ = m.killLocked()
			return fmt.Errorf("bootstrap cancelado: %v", ctx.Err())
		case waitErr := <-m.exited:
			m.cmd, m.exited = nil, nil
			m.mu.Lock()
			m.bootstrapping = false
			m.mu.Unlock()
			return fmt.Errorf("tor morreu no bootstrap: %v", waitErr)
		case <-ticker.C:
			phase, err := m.bootstrapPhase(2 * time.Second)
			if err == nil {
				m.mu.Lock()
				m.bootstrapProgress = phase
				m.mu.Unlock()
				if phase >= 100 {
					m.mu.Lock()
					m.started = true
					m.degraded = false
					m.bootstrapping = false
					m.mu.Unlock()
					m.logf("tor", "info", "bootstrap 100%% — SOCKS5 %s | control %s", socksAddr, controlAddr)
					return nil
				}
			}
			if time.Now().After(deadline) {
				_ = m.killLocked()
				m.mu.Lock()
				m.bootstrapping = false
				m.lastError = "bootstrap tor nao completou a tempo"
				m.mu.Unlock()
				return errors.New("bootstrap tor nao completou em 2 minutos (veja tor.log)")
			}
		}
	}
}

// Stop kills the daemon (app shutdown / toggle off).
func (m *Manager) Stop() {
	m.procMu.Lock()
	_ = m.killLocked()
	m.procMu.Unlock()
	m.mu.Lock()
	m.started = false
	m.bootstrapping = false
	m.bootstrapProgress = 0
	m.mu.Unlock()
}

func (m *Manager) killLocked() error {
	cmd := m.cmd
	m.cmd, m.exited = nil, nil
	if cmd != nil && cmd.Process != nil {
		killProcessTree(cmd.Process.Pid)
		_ = cmd.Process.Kill()
	}
	m.killResidualPid()
	return nil
}

func (m *Manager) killResidualPid() {
	raw, err := os.ReadFile(filepath.Join(m.dataDir, "tor.pid"))
	if err != nil {
		return
	}
	_ = os.Remove(filepath.Join(m.dataDir, "tor.pid"))
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		return
	}
	killProcessTree(pid)
}

func (m *Manager) ensurePortsFree() {
	for _, addr := range []string{m.SocksAddr(), m.ControlAddr()} {
		if conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond); err == nil {
			_ = conn.Close()
			m.killResidualPid()
			time.Sleep(300 * time.Millisecond)
		}
	}
}

// Rotate pushes SIGNAL NEWNYM, waits for the exit IP to change and records
// the result with cooldown/backoff.
func (m *Manager) Rotate(ctx context.Context, reason string) (RotationResult, error) {
	started := time.Now()
	m.mu.Lock()
	if !m.enabled {
		m.mu.Unlock()
		return RotationResult{Ok: false, Error: "tor desativado"}, errors.New("tor desativado nas configuracoes")
	}
	if m.busy {
		m.mu.Unlock()
		return RotationResult{Ok: false, Error: "rotacao ja em andamento"}, errors.New("rotacao de circuito ja em andamento")
	}
	if wait := m.cooldownRemainingLocked(); wait > 0 {
		m.mu.Unlock()
		return RotationResult{Ok: false, Error: fmt.Sprintf("aguarde %s antes de rotacionar novamente", wait.Round(time.Second))},
			errors.New("cooldown de rotacao ativo")
	}
	m.busy = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.busy = false
		m.mu.Unlock()
	}()

	if err := m.EnsureStarted(ctx); err != nil {
		return RotationResult{Ok: false, Error: err.Error(), Ms: time.Since(started).Milliseconds()}, err
	}

	before, beforeErr := m.RecordIP(ctx, "before_rotation")
	result := RotationResult{Ok: true}

	if err := m.sendNewNym(); err != nil {
		result.Ok = false
		result.Error = err.Error()
		result.Message = "falha ao enviar SIGNAL NEWNYM"
		m.storeResult(result, before.IP, false)
		result.Ms = time.Since(started).Milliseconds()
		return result, err
	}

	// NEWNYM closes current circuits; the next stream uses a fresh one.
	if err := m.waitForIPChange(ctx, before.IP, rotateConfirmWait); err != nil {
		m.logf("tor", "warn", "timeout aguardando IP novo: %v", err)
	}
	after, afterErr := m.RecordIP(ctx, "after_rotation")
	result.IP = after.IP
	result.Changed = before.IP != "" && after.IP != "" && before.IP != after.IP
	switch {
	case result.Changed:
		result.Message = "circuito trocado — novo IP de saida"
	case beforeErr != nil || afterErr != nil:
		result.Message = "NEWNYM enviado, mas nao foi possivel confirmar o IP"
	default:
		result.Message = "NEWNYM enviado, mas o IP saiu igual (exit repetido)"
	}
	result.Ms = time.Since(started).Milliseconds()
	m.storeResult(result, before.IP, result.Changed)
	return result, nil
}

func (m *Manager) storeResult(result RotationResult, beforeIP string, changed bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lastResult = &result
	m.lastRotateAt = time.Now()
	m.lastRotateMessage = result.Message
	m.degraded = !changed && result.Ok
	if changed {
		m.failures = 0
	} else if result.Ok {
		m.failures++
	}
	backoff := minRotateInterval
	for i := 0; i < m.failures && i < 5; i++ {
		backoff *= 2
	}
	if backoff > 5*time.Minute {
		backoff = 5 * time.Minute
	}
	m.cooldownUntil = time.Now().Add(backoff)
	if result.Error != "" {
		m.lastError = result.Error
	} else if !changed && result.Ok {
		m.lastError = result.Message
	} else {
		m.lastError = ""
	}
	if result.IP != "" {
		m.currentIP = result.IP
	}
}

// RecordIP discovers the current exit IP through the SOCKS port (the
// machine's GETINFO address would report the real IP — not useful here).
func (m *Manager) RecordIP(ctx context.Context, reason string) (IPEvent, error) {
	event := IPEvent{Timestamp: time.Now().UTC().Format(time.RFC3339), Reason: strings.TrimSpace(reason)}
	var ip string
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		ip, err = m.fetchPublicIP(ctx)
		if err == nil {
			break
		}
		if attempt < 2 {
			select {
			case <-ctx.Done():
				attempt = 3
			case <-time.After(2 * time.Second):
			}
		}
	}
	if err != nil {
		event.Error = err.Error()
		m.saveEvent(event)
		return event, err
	}
	event.IP = ip
	m.saveEvent(event)
	return event, nil
}

func (m *Manager) fetchPublicIP(ctx context.Context) (string, error) {
	transport := &http.Transport{
		DialContext:           m.proxyDialContext,
		TLSHandshakeTimeout:   20 * time.Second,
		ResponseHeaderTimeout: 20 * time.Second,
		DisableKeepAlives:     true,
	}
	client := &http.Client{Transport: transport, Timeout: 30 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.ipURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("servico de IP retornou HTTP %d", resp.StatusCode)
	}
	return parseIP(raw), nil
}

// FetchIP is a convenience wrapper for the UI ("atualizar IP agora").
func (m *Manager) FetchIP(ctx context.Context) (string, error) {
	ip, err := m.fetchPublicIP(ctx)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	m.currentIP = ip
	m.mu.Unlock()
	m.saveEvent(IPEvent{Timestamp: time.Now().UTC().Format(time.RFC3339), IP: ip, Reason: "manual_refresh"})
	return ip, nil
}

func (m *Manager) waitForIPChange(ctx context.Context, beforeIP string, maxWait time.Duration) error {
	ticker := time.NewTicker(900 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.After(maxWait)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline:
			return errors.New("timeout aguardando mudanca de IP")
		case <-ticker.C:
			ip, err := m.fetchPublicIP(ctx)
			if err == nil && ip != "" && ip != beforeIP {
				return nil
			}
		}
	}
}

func (m *Manager) saveEvent(event IPEvent) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.history) >= 60 {
		m.history = append([]IPEvent(nil), m.history[len(m.history)-59:]...)
	}
	m.history = append(m.history, event)
	if event.Error != "" {
		m.lastError = event.Error
	}
}

func parseIP(raw []byte) string {
	text := strings.TrimSpace(string(raw))
	var payload struct {
		IP string `json:"ip"`
	}
	if json.Unmarshal(raw, &payload) == nil && strings.TrimSpace(payload.IP) != "" {
		return strings.TrimSpace(payload.IP)
	}
	if idx := strings.IndexByte(text, '\n'); idx >= 0 {
		text = strings.TrimSpace(text[:idx])
	}
	return text
}

// ---------------------------------------------------------------------------
// Control port (minimal, dependency-free)
// ---------------------------------------------------------------------------

// controlConn wraps the TCP connection with a persistent bufio reader — a
// fresh bufio per read would discard already-buffered lines.
type controlConn struct {
	net.Conn
	r *bufio.Reader
}

func dialControl(addr string, timeout time.Duration) (*controlConn, error) {
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return nil, err
	}
	// Empirical note (tor 0.4.9): there is NO proactive greeting — the server
	// only answers after a command arrives.
	return &controlConn{Conn: conn, r: bufio.NewReader(conn)}, nil
}

func (c *controlConn) auth(cookiePath string) error {
	cookie, err := os.ReadFile(cookiePath)
	if err != nil {
		return fmt.Errorf("ler cookie %s: %w", cookiePath, err)
	}
	if _, err := fmt.Fprintf(c, "AUTHENTICATE %s\r\n", strings.ToUpper(hex.EncodeToString(cookie))); err != nil {
		return err
	}
	code, _, err := c.readReply()
	if err != nil {
		return err
	}
	if code != 250 {
		return fmt.Errorf("AUTHENTICATE rejeitado (codigo %d)", code)
	}
	return nil
}

func (c *controlConn) command(cmd string) ([]string, error) {
	if _, err := fmt.Fprintf(c, "%s\r\n", cmd); err != nil {
		return nil, err
	}
	var lines []string
	for {
		code, line, err := c.readReply()
		if err != nil {
			return lines, err
		}
		lines = append(lines, line)
		if strings.HasPrefix(line, fmt.Sprintf("%d ", code)) {
			if code == 250 {
				return lines, nil
			}
			return lines, fmt.Errorf("comando %q rejeitado (codigo %d): %s", cmd, code, line)
		}
	}
}

func (c *controlConn) readReply() (int, string, error) {
	line, err := c.r.ReadString('\n')
	if err != nil {
		return 0, "", err
	}
	line = strings.TrimRight(line, "\r\n")
	if len(line) < 4 {
		return 0, line, fmt.Errorf("resposta curta do control port: %q", line)
	}
	var code int
	if _, err := fmt.Sscanf(line[:3], "%d", &code); err != nil {
		return 0, line, fmt.Errorf("resposta inesperada do control port: %q", line)
	}
	return code, line, nil
}

// bootstrapPhase queries bootstrap progress (0..100) over the control port.
func (m *Manager) bootstrapPhase(timeout time.Duration) (int, error) {
	conn, err := dialControl(m.ControlAddr(), timeout)
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if err := conn.auth(m.cookiePath()); err != nil {
		return 0, err
	}
	lines, err := conn.command("GETINFO status/bootstrap-phase")
	if err != nil {
		return 0, err
	}
	for _, line := range lines {
		if idx := strings.Index(line, "PROGRESS="); idx >= 0 {
			var progress int
			if _, err := fmt.Sscanf(line[idx+9:], "%d", &progress); err == nil {
				return progress, nil
			}
		}
	}
	return 0, nil
}

func (m *Manager) sendNewNym() error {
	conn, err := dialControl(m.ControlAddr(), 5*time.Second)
	if err != nil {
		return fmt.Errorf("control port: %w", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	if err := conn.auth(m.cookiePath()); err != nil {
		return fmt.Errorf("autenticar control port: %w", err)
	}
	if _, err := conn.command("SIGNAL NEWNYM"); err != nil {
		return fmt.Errorf("SIGNAL NEWNYM: %w", err)
	}
	return nil
}
