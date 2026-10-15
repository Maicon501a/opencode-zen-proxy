// Package docs embeds the user-facing documentation shown in the app's
// Documentação tab (and served at /api/docs for the browser preview).
package docs

import _ "embed"

//go:embed guide.md
var Markdown string
