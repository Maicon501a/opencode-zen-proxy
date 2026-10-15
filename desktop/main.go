package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"

	"desktop/internal/settings"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	store, _ := settings.Load()
	app := NewApp(store, assets)

	err := wails.Run(&options.App{
		Title:     "OpenCode Zen · Desktop",
		Width:     1380,
		Height:    860,
		MinWidth:  1024,
		MinHeight: 640,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 9, G: 11, B: 17, A: 1},
		OnStartup:        app.Startup,
		OnShutdown:       app.Shutdown,
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               "opencode-zen-desktop",
			OnSecondInstanceLaunch: func(options.SecondInstanceData) {},
		},
		Bind: []interface{}{
			app,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
