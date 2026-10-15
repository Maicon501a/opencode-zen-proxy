//go:build !windows

package tormgr

import (
	"os/exec"
	"syscall"
)

func prepareProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killProcessTree(pid int) {
	if pid <= 0 {
		return
	}
	// Best effort: negative pid signals the whole process group.
	_ = syscall.Kill(-pid, syscall.SIGKILL)
}
