# OpenCode Zen Proxy — Documentação

Proxy local que dá acesso ao **tier gratuito do OpenCode Zen** para qualquer cliente compatível com a API da OpenAI — sem login, sem chave paga, com contador de tokens, API keys opcionais e isolamento de IP via Tor com rotação automática em rate-limit.

## Base URL

```
http://127.0.0.1:3000/v1
```

A porta é configurável na aba **Configurações** (padrão `3000`). O host fica em `127.0.0.1` (somente a sua máquina).

## Compatibilidade

Qualquer cliente que aceite uma **base URL OpenAI-compatible** funciona:

- OpenCode (provider custom)
- Cursor / Cline / Roo / Continue / outros editores
- SDKs oficiais (`openai` python/js) apontando `base_url` para cá
- `curl`, Postman, scripts

## Chat integrado (aba Chat)

O app traz um chat completo estilo ChatGPT — sem depender de cliente externo:

- **Texto, imagem, vídeo e áudio** — anexe pelo botão `+`, arraste e solte ou cole da área de transferência (PNG/JPG, MP4/WebM, WAV/MP3…; até 20 MB por arquivo, 30 MB por envio)
- **Seletor de modelos** — todos os gratuitos na lista, com contexto e capacidades (imagem · vídeo · áudio) em cada item; troque a qualquer momento
- **Raciocínio do modelo ao vivo** — quem pensa (DeepSeek, Space Bunny etc.) mostra o bloco *✦ pensando…*; ao terminar ele colapsa em *raciocinou por Ns* e reabre com um clique
- **Streaming com botão de parar** — a resposta é escrita conforme chega; o botão de enviar vira ■ para interromper
- **Histórico local** — a conversa fica salva na sua máquina; *＋ nova conversa* limpa e recomeça
- **Markdown renderizado** — código com botão copiar, listas, tabelas e citações direto na tela

Atalhos: **Enter** envia, **Shift+Enter** quebra linha, **Ctrl+1** abre o chat.

Tudo passa pelo mesmo proxy local (Tor incluso) — mesmos contadores e feed de eventos do Dashboard.

## Autenticação (opcional)

Por padrão o proxy é **aberto na sua máquina** — qualquer valor de API key funciona (o client costuma exigir um valor; use `public`).

Se você criar **API Keys** na aba *API Keys*, elas passam a ser validadas quando a exigência estiver ligada:

```
Authorization: Bearer sk-zen-…
```

## Endpoints

| Método | Caminho | Descrição |
|---|---|---|
| GET | `/v1/models` | Catálogo completo (live direto da Zen, com limites mesclados) |
| GET | `/v1/models/free` | Lista curada dos gratuitos com capacidades e limites |
| GET | `/v1/models/{id}` | Detalhe de um modelo (aceita aliases e sufixos de esforço) |
| POST | `/v1/chat/completions` | Chat (API clássica da OpenAI) |
| POST | `/v1/responses` | Responses API (modelos Muse Spark são nativos) |
| GET | `/health` | Status do proxy (versão, transporte, warp) |
| GET | `/docs` | Esta documentação em JSON |
| GET | `/admin/*` | API administrativa (usada por este app; exige `X-Admin-Token`) |

## Modelos e limites de contexto

Valores oficiais da catalogação **models.dev** (a mesma fonte que o cliente oficial usa). Use-os para configurar `limit.context` / `limit.output` no seu cliente.

| Modelo | Contexto | Saída máx. | Entradas | API |
|---|---|---|---|---|
| `opencode/deepseek-v4.1-flash-free` | **200.000** | 32.000 | texto, imagem | chat |
| `opencode/big-pickle` | **200.000** | 32.000 | texto | chat |
| `opencode/mimo-v2.6-flash-free` | **200.000** | 32.000 | texto, imagem, áudio, vídeo | chat |
| `opencode/cat-jam-free` | 262.144 | 131.072 | texto | chat |
| `opencode/nemotron-3.5-lightning-free` | 262.144 | 262.144 | texto | chat |
| `opencode/nemotron-3.5-super-vl-free` | 1.048.576 | 131.072 | texto, imagem | chat |
| `opencode/step-5-preview-free` | 1.000.000 | 65.536 | texto, imagem, vídeo | chat |
| `opencode/longcat-2.5-preview-free` | 1.000.000 | 131.072 | texto, imagem | chat |
| `opencode/space-bunny-free` | 1.048.576 | 524.288 | texto, imagem, vídeo | chat |
| `opencode/muse-spark-1.3-contributor-free` | 1.048.576 | 131.072 | texto, imagem, vídeo, pdf, áudio | responses |
| `opencode/muse-spark-1.2-contributor-free` | 1.048.576 | 131.072 | texto, imagem, vídeo, pdf, áudio | responses |

O prefixo `opencode/` é opcional em todos: `deepseek-v4.1-flash-free` funciona igual. Aliases curtos também funcionam (`deepseek-v4.1`, `cat-jam`, `step-5`, ...), inclusive com sufixo de esforço (`-low`, `-high`, `-max`).

> **Capacidades verificadas ao vivo (15/10/2026):** tool calling (não-stream e stream), visão, vídeo e áudio — todos passaram pelo proxy via Tor (20/21 de primeira, +1 retry após 429 de capacidade). Detalhes e exemplos: `docs/COMPATIBILIDADE.md` no repositório.

## Configurar no OpenCode (provider custom)

Adicione no seu `opencode.json`:

```json
{
  "provider": {
    "opencode-zen-proxy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenCode Zen Proxy",
      "options": {
        "baseURL": "http://127.0.0.1:3000/v1",
        "apiKey": "public"
      },
      "models": {
        "opencode/deepseek-v4.1-flash-free": {
          "name": "DeepSeek V4.1 Flash Free",
          "limit": { "context": 200000, "output": 32000 }
        },
        "opencode/cat-jam-free": {
          "name": "Cat Jam Free",
          "limit": { "context": 262144, "output": 131072 }
        },
        "opencode/space-bunny-free": {
          "name": "Space Bunny Free",
          "limit": { "context": 1048576, "output": 524288 }
        },
        "opencode/mimo-v2.6-flash-free": {
          "name": "MiMo V2.6 Flash Free",
          "limit": { "context": 200000, "output": 32000 }
        }
      }
    }
  }
}
```

> Dica: o `limit.context` diz ao cliente quanto de histórico ele pode mandar; o `limit.output` define o teto de `max_tokens`. Valores maiores que os oficiais causam erro 400 do upstream ("context length exceeded").

## Configurar em outros clientes (OpenAI-compatible)

- **Base URL:** `http://127.0.0.1:3000/v1`
- **API key:** qualquer coisa (`public`) — ou uma `sk-zen-…` se você ativou keys
- **Model:** qualquer id da tabela acima

## Exemplos rápidos

Chat simples:

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/deepseek-v4.1-flash-free",
    "messages": [{"role": "user", "content": "Resuma o teorema de Bayes em 3 linhas."}]
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "stream": true,
    "messages": [{"role": "user", "content": "Conte uma piada curta."}]
  }'
```

Responses API:

```bash
curl http://127.0.0.1:3000/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/muse-spark-1.3-contributor-free",
    "input": "Explique o que é um circuito Tor."
  }'
```

Visão (imagem base64):

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/mimo-v2.6-flash-free",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "Descreva a imagem."},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,<...>"}}
      ]
    }]
  }'
```

Vídeo e áudio (partes adicionais, modelos compatíveis):

```json
{"type": "video_url", "video_url": {"url": "data:video/mp4;base64,<...>"}}
{"type": "input_audio", "input_audio": {"data": "<base64>", "format": "wav"}}
```

## Reasoning effort

Os modelos gratuitos **sempre pensam**. O proxy aceita e traduz o vocabulário:

- Modelos **chat**: `low` | `high` | `max` (padrão do upstream: `high`)
- Modelos **responses** (Muse): `none` | `minimal` | `low` | `medium` | `high` | `xhigh`

Três formas de escolher: campo `reasoning_effort` no corpo, sufixo no id (`opencode/space-bunny-free-low`), ou alias curto (`deepseek-v4.1-max`).

## Rede & IP — isolamento via Tor

Com o isolamento **ligado** (padrão), todo o tráfego do proxy para o Zen sai por um **circuito Tor embutido** — sua máquina nunca fala diretamente com o upstream. O IP de saída aparece na aba *Rede & IP*.

Quando o Zen responde **rate-limit** (429) para esse IP:

1. O proxy pede um circuito novo para o app (`SIGNAL NEWNYM` no Tor)
2. Confirma que o IP de saída mudou (consulta via SOCKS)
3. **Repete a requisição** no circuito novo — automaticamente, sem você ver o erro

O botão **Novo IP** força o mesmo ciclo manualmente. O toggle desliga o isolamento (o tráfego sai direto) sem parar o proxy. Se você desligar também o *Rotacionar em rate-limit*, um 429 chega ao cliente.

Quando um 429 acontece, a resposta de erro **não é descartada**: o proxy grava status, headers (incluindo `retry-after`) e o corpo da resposta. A captura aparece na hora nos *Logs* (`rate limit / quota response captured`) e o último fica em `lastRejection` (visível no Dashboard e em `/admin/stats`) — é assim que você lê a mensagem exata do Zen quando a cota diária do tier gratuito estoura.

## API Keys (opcional)

Na aba *API Keys* você pode:

- Criar keys `sk-zen-…` nomeadas (usadas para atribuir consumo a cada cliente)
- Rotacionar ou remover qualquer uma
- Ligar **"Exigir API key"** — aí sim o proxy rejeita quem não apresentar uma key válida

Sem exigir keys, o proxy atribui o consumo a uma key **se** ela for apresentada; senão conta como anônimo.

## Estatísticas

A aba *Dashboard* mostra em tempo real:

- Requisições, tokens de entrada/saída, latência média, rate-limits e rotações
- Consumo por modelo e por key
- Feed de eventos (requisição, erro, rotação, key)

Os dados ficam em `stats.json` na pasta de dados do app e sobrevivem a reinícios.

## Solução de problemas

- **429 persistente**: o circuito novo pode cair no mesmo exit. Clique *Novo IP* ou aguarde o cooldown (~10s). A mensagem exata do último 429 fica capturada (Logs + `lastRejection`) — ajuda a distinguir **cota diária** de **capacidade** ("Endpoint is unavailable").
- **Tor não sobe**: primeira subida baixa o consenso da rede (~30-90s). Veja os *Logs*.
- **Modelo indisponível**: alguns modelos são aposentados sem aviso. Use `/v1/models` para ver o que está vivo.
- **Sobre dados**: os modelos gratuitos do Zen podem coletar uso para melhoria. Evite enviar dados sensíveis.

## Admin API (avançado)

Todas as rotas `/admin/*` exigem `X-Admin-Token` (gerado por execução do app e passado ao proxy; sem ele, só loopback é aceito):

- `GET /admin/overview` — proxy + transporte + keys + totais
- `GET /admin/stats` — snapshot completo (`?` nada; use POST `/admin/stats/reset` para zerar)
- `GET /admin/events?after=&limit=` — feed incremental
- `GET/POST /admin/keys`, `DELETE /admin/keys/:id`, `POST /admin/keys/:id/rotate`, `PATCH /admin/keys/settings`
- `GET/PUT /admin/transport` — ligar/desligar isolamento a quente
- `POST /admin/rotate` — pedir IP novo
- `POST /admin/test` — requisição de teste ponta-a-ponta
