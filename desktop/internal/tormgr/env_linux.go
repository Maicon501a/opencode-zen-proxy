//go:build linux

package tormgr

import (
	"os"
	"os/exec"
)

// configureTorEnv points LD_LIBRARY_PATH at the extracted bundle so tor finds
// its bundled libevent/libssl/libcrypto no matter where the extraction landed.
func configureTorEnv(cmd *exec.Cmd, torDir string) {
	cmd.Env = append(os.Environ(), "LD_LIBRARY_PATH="+torDir)
}
