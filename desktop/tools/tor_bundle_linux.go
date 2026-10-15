//go:build linux

package tools

import (
	"embed"
	"io/fs"
)

//go:embed all:torlinux
var torFS embed.FS

func torBundle() (fs.FS, string, string, error) {
	return torFS, "torlinux", "tor", nil
}
