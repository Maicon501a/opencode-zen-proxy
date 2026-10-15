# proxy-src (placeholder)

This directory is filled **at build time** by CI (`.github/workflows/build.yml`):
it receives a copy of the node proxy (`src/`, `package.json` and a production
`node_modules/`) which gets embedded into the desktop binary.

Released binaries extract this copy on first run, so users do not need the
repository checkout — just Node.js on PATH.

Local development builds embed only this README; the app then uses the proxy
directory configured in *Configurações* (defaults to this repo).
