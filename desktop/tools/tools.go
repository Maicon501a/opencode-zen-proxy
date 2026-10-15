// Package tools embeds the per-platform Tor Expert Bundle and the packaged
// proxy copy, so released builds are single self-contained binaries.
package tools

import (
	"embed"
	"io/fs"
	"os"
	"path/filepath"
)

//go:embed all:proxy-src
var proxySrcFS embed.FS

// EnsureProxySource extracts the proxy copy staged at build time
// (desktop/proxy-src, filled by CI: src + node_modules + package.json) into
// dataDir/proxy and returns that directory.
//
// Development builds embed only the placeholder README, so this returns ""
// and the app keeps using the checkout configured in the settings.
func EnsureProxySource(dataDir string) (string, error) {
	if _, err := fs.Stat(proxySrcFS, "proxy-src/src/index.js"); err != nil {
		return "", nil // placeholder-only build (local dev)
	}
	dest := filepath.Join(dataDir, "proxy")
	entry := filepath.Join(dest, "src", "index.js")
	if info, err := os.Stat(entry); err == nil && info.Size() > 0 {
		return dest, nil
	}
	if err := extractFS(proxySrcFS, "proxy-src", dest); err != nil {
		return "", err
	}
	return dest, nil
}

// EnsureTor extracts the embedded Tor bundle for this platform into
// dataDir/tor and returns the path of the daemon binary.
func EnsureTor(dataDir string) (string, error) {
	fsys, root, exeName, err := torBundle()
	if err != nil {
		return "", err
	}
	dest := filepath.Join(dataDir, "tor")
	exe := filepath.Join(dest, exeName)
	if embedded, statErr := fs.Stat(fsys, root+"/"+exeName); statErr == nil {
		if info, statErr2 := os.Stat(exe); statErr2 == nil && info.Size() == embedded.Size() {
			return exe, nil
		}
	}
	if err := extractFS(fsys, root, dest); err != nil {
		return "", err
	}
	return exe, nil
}

// extractFS mirrors an embedded tree onto disk (0755 so extracted binaries
// can execute on unix).
func extractFS(embedded fs.FS, root, dest string) error {
	return fs.WalkDir(embedded, root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, relErr := filepath.Rel(root, filepath.FromSlash(path))
		if relErr != nil {
			return relErr
		}
		if rel == "." {
			return os.MkdirAll(dest, 0o755)
		}
		target := filepath.Join(dest, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, readErr := fs.ReadFile(embedded, path)
		if readErr != nil {
			return readErr
		}
		if mkErr := os.MkdirAll(filepath.Dir(target), 0o755); mkErr != nil {
			return mkErr
		}
		return os.WriteFile(target, data, 0o755)
	})
}
