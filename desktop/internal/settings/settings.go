// Package settings persists the desktop app configuration as JSON under
// %LOCALAPPDATA%\opencode-zen\settings.json.
package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// Settings mirrors the persisted configuration.
type Settings struct {
	ProxyPort         int    `json:"proxyPort"`         // node proxy listen port (default 3000)
	LocalAPIPort      int    `json:"localApiPort"`      // app's local HTTP API / preview port (default 46998)
	ProxyDir          string `json:"proxyDir"`          // where the node proxy sources live
	NodeBin           string `json:"nodeBin"`           // node executable (default "node" from PATH)
	AutoStartProxy    bool   `json:"autoStartProxy"`    // spawn the proxy on app start (default true)
	TorEnabled        bool   `json:"torEnabled"`        // exit through embedded Tor (default true)
	RotateOnRateLimit bool   `json:"rotateOnRateLimit"` // auto NEWNYM when the upstream throttles (default true)
	TorExitNodes      string `json:"torExitNodes"`      // optional ExitNodes filter, e.g. "{br},{us}"
	TorSocksPort      int    `json:"torSocksPort"`      // embedded tor SOCKS port (default 19050)
	TorControlPort    int    `json:"torControlPort"`    // embedded tor control port (default 19051)
	LogLevel          string `json:"logLevel"`          // node proxy LOG_LEVEL (default "info")
}

// Store is a mutex-guarded settings file.
type Store struct {
	mu   sync.Mutex
	path string
	data Settings
}

// DataDir is the app's per-user data directory.
func DataDir() string {
	if v := os.Getenv("OPENCODE_ZEN_DATA"); v != "" {
		return v
	}
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		if home, err := os.UserHomeDir(); err == nil {
			base = filepath.Join(home, ".local", "share")
		}
	}
	return filepath.Join(base, "opencode-zen")
}

// Defaults returns the factory configuration.
func Defaults() Settings {
	proxyDir := os.Getenv("ZEN_PROXY_DIR")
	if proxyDir == "" {
		// The sibling checkout is the primary install; otherwise run from the
		// current directory (a standalone proxy copy).
		candidates := []string{
			`D:\proxy opencode`,
			`C:\proxy opencode`,
		}
		for _, candidate := range candidates {
			if info, err := os.Stat(filepath.Join(candidate, "src", "index.js")); err == nil && !info.IsDir() {
				proxyDir = candidate
				break
			}
		}
		if proxyDir == "" {
			if wd, err := os.Getwd(); err == nil {
				proxyDir = wd
			}
		}
	}
	return Settings{
		ProxyPort:         3000,
		LocalAPIPort:      46998,
		ProxyDir:          filepath.Clean(proxyDir),
		NodeBin:           "node",
		AutoStartProxy:    true,
		TorEnabled:        true,
		RotateOnRateLimit: true,
		TorSocksPort:      19050,
		TorControlPort:    19051,
		LogLevel:          "info",
	}
}

// Load reads the store from disk, filling missing fields with defaults.
func Load() (*Store, error) {
	store := &Store{
		path: filepath.Join(DataDir(), "settings.json"),
		data: Defaults(),
	}
	raw, err := os.ReadFile(store.path)
	if err != nil {
		return store, nil // first boot
	}
	merged := Defaults()
	if err := json.Unmarshal(raw, &merged); err == nil {
		store.data = sanitize(merged)
	}
	return store, nil
}

func sanitize(s Settings) Settings {
	if s.ProxyPort <= 0 || s.ProxyPort > 65535 {
		s.ProxyPort = 3000
	}
	if s.LocalAPIPort <= 0 || s.LocalAPIPort > 65535 {
		s.LocalAPIPort = 46998
	}
	if s.TorSocksPort <= 0 || s.TorSocksPort > 65535 {
		s.TorSocksPort = 19050
	}
	if s.TorControlPort <= 0 || s.TorControlPort > 65535 || s.TorControlPort == s.TorSocksPort {
		s.TorControlPort = 19051
	}
	if s.NodeBin == "" {
		s.NodeBin = "node"
	}
	if s.LogLevel == "" {
		s.LogLevel = "info"
	}
	return s
}

// Get returns a copy of the current settings.
func (s *Store) Get() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data
}

// Set persists new settings and returns the sanitized copy.
func (s *Store) Set(next Settings) (Settings, error) {
	clean := sanitize(next)
	s.mu.Lock()
	s.data = clean
	path := s.path
	s.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return clean, err
	}
	raw, err := json.MarshalIndent(clean, "", "  ")
	if err != nil {
		return clean, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return clean, err
	}
	return clean, os.Rename(tmp, path)
}
