//go:build !windows && !linux

package tools

import (
	"errors"
	"io/fs"
)

func torBundle() (fs.FS, string, string, error) {
	return nil, "", "", errors.New("bundle tor indisponivel para este sistema")
}
