//go:build windows

package tormgr

import "os/exec"

// configureTorEnv is a no-op on Windows (the bundle ships DLLs next to the
// binary and the loader finds them automatically).
func configureTorEnv(_ *exec.Cmd, _ string) {}
