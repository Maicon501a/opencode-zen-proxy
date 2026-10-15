# OpenCode Zen — Desktop

App desktop (Wails) que embute e supervisiona o **OpenCode Zen Proxy** + **Tor**, com painel de estatísticas, gerenciador de API keys, rotação de IP e documentação integrada.

> A documentação completa do projeto (proxy, gate, modelos e limites) está no [README da raiz](../README.md).

## O que ele faz

- Sobe o proxy Node automaticamente (`node src/index.js`) e captura os logs em tempo real
- Extrai e roda um **Tor Expert Bundle** embutido (sem Tor Browser) — `torwin/` no Windows, `torlinux/` no Linux (libs `.so` carregadas via `LD_LIBRARY_PATH`)
- Roteia o tráfego do proxy para o Zen via SOCKS5 isolado (`127.0.0.1:19050`), com **rotação automática de IP em rate-limit (429)**
- **Captura de rejeições do upstream**: a última resposta de erro (429/cota) fica gravada com status, headers (`retry-after`) e corpo — `lastRejection` em `/api/stats`, visível nos Logs e no feed de Eventos
- Dashboard: contadores de tokens por modelo, latência, eventos, histórico de IP
- **Chat integrado**: interface estilo ChatGPT (texto, imagem, vídeo e áudio), seletor de modelos, raciocínio do modelo visível e streaming com parada — Ctrl+1 na janela
- API keys opcionais (aplicadas em runtime), exit-nodes por país, logs ao vivo, docs PT-BR

O binário de release já traz uma cópia do proxy embutida (`tools/proxy-src`) — extraída no primeiro run. **Pré-requisito:** Node.js 18+ no PATH.

## Rodar

Baixe o build pronto em [Releases](https://github.com/Maicon501a/opencode-zen-proxy/releases):

- `OpenCodeZenDesktop-windows-amd64.exe` → baixe e execute direto (sem extrair)
- `OpenCodeZenDesktop-windows-amd64.zip` → alternativa compactada (20 MB vs 54 MB)
- `OpenCodeZenDesktop-linux-amd64.tar.gz` → extraia e rode `./OpenCodeZenDesktop` (requer `libwebkit2gtk-4.1`)

O painel também abre no navegador em `http://127.0.0.1:46998/`.

## Compilar

Requer Go 1.25+ e [Wails v2.13](https://wails.io):

```bash
cd desktop
wails build -clean                   # Windows
wails build -clean -tags webkit2_41  # Linux (libgtk-3-dev + libwebkit2gtk-4.1-dev)
```

O CI (`.github/workflows/build.yml`) faz esses dois builds a cada push e publica os artefatos em tags `v*`.
