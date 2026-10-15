// Package proxyproc supervises the node proxy process (src/index.js) as an
// invisible child, pipes its stdout/stderr into the shared log buffer and
// exposes start/stop/restart to the UI.
package proxyproc

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"desktop/internal/logbuf"
)

// CREATE_NO_WINDOW keeps the child invisible on Windows.
const createNoWindow = 0x08000000

// Status is the serializable process view.
type Status struct {
	Running   bool   `json:"running"`
	PID       int    `json:"pid"`
	ExitCode  *int   `json:"exitCode,omitempty"`
	LastError string `json:"lastError,omitempty"`
	StartedAt string `json:"startedAt,omitempty"`
	StoppedAt string `json:"stoppedAt,omitempty"`
	Dir       string `json:"dir,omitempty"`
	Port      int    `json:"port,omitempty"`
}

// Config is the spawn configuration.
type Config struct {
	Port     int
	Dir      string
	NodeBin  string
	Env      []string // extra environment entries (KEY=VALUE)
	LogLevel string
}

// Proc owns the child process lifecycle.
type Proc struct {
	mu   sync.Mutex
	cfg  Config
	logs *logbuf.Buffer

	cmd       *exec.Cmd
	exited    chan error
	running   bool
	pid       int
	exitCode  *int
	lastError string
	startedAt time.Time
	stoppedAt time.Time
}

// New creates a process supervisor writing into logs.
func New(logs *logbuf.Buffer) *Proc {
	return &Proc{logs: logs}
}

// Configure swaps the spawn configuration (takes effect on next Start).
func (p *Proc) Configure(cfg Config) {
	p.mu.Lock()
	p.cfg = cfg
	p.mu.Unlock()
}

// Start spawns the node proxy. No-op error when already running.
func (p *Proc) Start() error {
	p.mu.Lock()
	if p.running {
		p.mu.Unlock()
		return fmt.Errorf("proxy ja esta rodando (pid %d)", p.pid)
	}
	cfg := p.cfg
	p.mu.Unlock()

	if cfg.Dir == "" {
		return fmt.Errorf("diretorio do proxy nao configurado")
	}
	entry := cfg.Dir + string(os.PathSeparator) + "src" + string(os.PathSeparator) + "index.js"
	if _, err := os.Stat(entry); err != nil {
		p.fail(fmt.Sprintf("src/index.js nao encontrado em %s", cfg.Dir))
		return fmt.Errorf("src/index.js nao encontrado em %s", cfg.Dir)
	}

	nodeBin := cfg.NodeBin
	if nodeBin == "" {
		nodeBin = "node"
	}
	resolved, err := exec.LookPath(nodeBin)
	if err != nil {
		p.fail(fmt.Sprintf("node nao encontrado (%s): instale o Node.js ou ajuste o caminho nas configuracoes", nodeBin))
		return fmt.Errorf("node nao encontrado (%s)", nodeBin)
	}

	cmd := exec.Command(resolved, "src/index.js")
	cmd.Dir = cfg.Dir
	prepareProcess(cmd)
	baseEnv := os.Environ()
	cmd.Env = append(baseEnv, cfg.Env...)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		p.fail(err.Error())
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		p.fail(err.Error())
		return err
	}

	if err := cmd.Start(); err != nil {
		p.fail(fmt.Sprintf("iniciar proxy: %v", err))
		return err
	}

	p.mu.Lock()
	p.cmd = cmd
	p.exited = make(chan error, 1)
	p.running = true
	p.pid = cmd.Process.Pid
	p.exitCode = nil
	p.lastError = ""
	p.startedAt = time.Now()
	p.mu.Unlock()

	p.logs.Add("proxy", "info", fmt.Sprintf("proxy iniciado (pid %d) em %s — porta %d", cmd.Process.Pid, cfg.Dir, cfg.Port))

	go p.pump(stdout, "proxy")
	go p.pump(stderr, "proxy")

	go func() {
		waitErr := cmd.Wait()
		p.mu.Lock()
		p.running = false
		p.stoppedAt = time.Now()
		code := 0
		if cmd.ProcessState != nil {
			code = cmd.ProcessState.ExitCode()
		}
		p.exitCode = &code
		if waitErr != nil && code != 0 {
			p.lastError = waitErr.Error()
		}
		p.mu.Unlock()
		level := "info"
		if code != 0 {
			level = "error"
		}
		p.logs.Add("proxy", level, fmt.Sprintf("proxy encerrado (exit code %d)", code))
	}()

	return nil
}

// pump forwards one pipe, line by line, into the log buffer.
func (p *Proc) pump(pipe interface{ Read([]byte) (int, error) }, scope string) {
	scanner := bufio.NewScanner(pipe)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		p.logs.Add(scope, parseLevel(line), line)
	}
}

// parseLevel extracts the `[level]` prefix the node logger prints.
func parseLevel(line string) string {
	if strings.HasPrefix(line, "[") {
		if idx := strings.IndexByte(line, ']'); idx > 1 && idx <= 8 {
			switch strings.ToLower(line[1:idx]) {
			case "info":
				return "info"
			case "warn":
				return "warn"
			case "error":
				return "error"
			case "debug":
				return "debug"
			}
		}
	}
	return "info"
}

// Stop kills the process tree and waits for the reaper to settle.
func (p *Proc) Stop() error {
	p.mu.Lock()
	cmd := p.cmd
	p.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	killProcessTree(cmd.Process.Pid)
	_ = cmd.Process.Kill()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		p.mu.Lock()
		running := p.running
		p.mu.Unlock()
		if !running {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil
}

// Restart stops (if needed) and starts again.
func (p *Proc) Restart() error {
	_ = p.Stop()
	time.Sleep(300 * time.Millisecond)
	return p.Start()
}

// Status returns the current process view.
func (p *Proc) Status() Status {
	p.mu.Lock()
	defer p.mu.Unlock()
	status := Status{
		Running:   p.running,
		PID:       p.pid,
		ExitCode:  p.exitCode,
		LastError: p.lastError,
		Dir:       p.cfg.Dir,
		Port:      p.cfg.Port,
	}
	if !p.startedAt.IsZero() {
		status.StartedAt = p.startedAt.Format(time.RFC3339)
	}
	if !p.stoppedAt.IsZero() {
		status.StoppedAt = p.stoppedAt.Format(time.RFC3339)
	}
	return status
}

// Port returns the configured port (UI convenience).
func (p *Proc) Port() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.cfg.Port
}

// Dir returns the configured proxy directory.
func (p *Proc) Dir() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.cfg.Dir
}

func (p *Proc) fail(message string) {
	p.mu.Lock()
	p.lastError = message
	p.mu.Unlock()
	p.logs.Add("proxy", "error", message)
}

// ---------------------------------------------------------------------------
// windows/other process helpers
// ---------------------------------------------------------------------------

func prepareProcess(cmd *exec.Cmd) {
	setHideWindow(cmd)
}

func killProcessTree(pid int) {
	if pid <= 0 {
		return
	}
	kill := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F")
	setHideWindow(kill)
	_ = kill.Run()
}
