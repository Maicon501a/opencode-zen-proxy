//go:build windows

package tormgr

import (
	"os/exec"
	"strconv"
	"syscall"
)

// CREATE_NO_WINDOW keeps every child (tor.exe, taskkill) invisible.
const createNoWindow = 0x08000000

func prepareProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
}

// killProcessTree kills a pid and its children via taskkill, falling back to
// nothing (the caller's Process.Kill covers the root).
func killProcessTree(pid int) {
	if pid <= 0 {
		return
	}
	kill := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F")
	prepareProcess(kill)
	_ = kill.Run()
}
