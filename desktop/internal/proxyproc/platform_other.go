//go:build !windows

package proxyproc

import (
	"os/exec"
	"syscall"
)

func setHideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}
