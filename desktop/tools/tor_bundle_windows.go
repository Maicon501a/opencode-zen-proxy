//go:build windows

package tools

import (
	"embed"
	"io/fs"
)

//go:embed all:torwin
var torFS embed.FS

func torBundle() (fs.FS, string, string, error) {
	return torFS, "torwin", "tor.exe", nil
}
