# Compatibilidade & Capacidades Verificadas

> **Data da verificação:** 15 de outubro de 2026
> **Ambiente:** proxy local (`http://127.0.0.1:3000`) com egress via **Tor isolado** → OpenCode Zen
> **Escopo:** tool calling, visão (imagem), vídeo e áudio nos modelos gratuitos

**Resultado geral: 20/21 respostas `200` na primeira passada. A única falha foi um `429` de capacidade no vídeo do `step-5-preview-free` — que passou no retry imediato.**

---

## 1. Matriz de capacidades

Capacidades declaradas pelo catálogo oficial (mescladas em `GET /v1/models`) + o que foi **verificado ao vivo** em 15/10/2026:

| Modelo | Tools | Visão | Vídeo | Áudio | Verificado ao vivo |
|---|:--:|:--:|:--:|:--:|---|
| `deepseek-v4.1-flash-free` | ✅ | ✅ | — | — | tools (não-stream + stream), visão |
| `mimo-v2.6-flash-free` | ✅ | ✅ | ✅ | ✅ | visão, vídeo, áudio |
| `nemotron-3.5-super-vl-free` | ✅ | ✅ | — | — | visão |
| `space-bunny-free` | ✅ | ✅ | ✅ | — | visão, vídeo |
| `step-5-preview-free` | ✅ | ✅ | ✅ | — | vídeo (1º tentativa 429 de capacidade → retry 200) |
| `longcat-2.5-preview-free` | ✅ | ✅ | — | — | matriz |
| `cat-jam-free` | ✅ | — | — | — | matriz |
| `nemotron-3.5-lightning-free` | ✅ | — | — | — | matriz |
| `big-pickle` | ✅ | — | — | — | matriz |
| `muse-spark-1.3-contributor-free` | ✅ | ✅ | ✅ | ✅ | matriz |
| `muse-spark-1.2-contributor-free` | ✅ | ✅ | ✅ | ✅ | matriz |

> Muse Spark 1.2/1.3 também aceitam **PDF** como entrada. Os demais modelos sem ✅ são text-only e rejeitam mídia.

---

## 2. Como foi testado

Todos os testes passaram pelo proxy completo (gate → egress Tor → Zen), **sem API key** (tier gratuito), com os assets gerados na hora:

| Asset | Geração | Conteúdo |
|---|---|---|
| Imagem PNG 96×96 | PowerShell `System.Drawing` | círculo vermelho sobre fundo branco |
| Vídeo MP4 1s | `ffmpeg -f lavfi -i "color=c=blue:s=96x96:d=1" -pix_fmt yuv420p` | tela azul |
| Áudio WAV 1s | `ffmpeg -f lavfi -i "sine=frequency=440:duration=1"` | tom senoidal 440 Hz |

Os assets foram enviados como **data URI base64** dentro das partes de conteúdo (`image_url`, `video_url`, `input_audio`). Critério de aprovação: resposta `200` com o modelo descrevendo corretamente o conteúdo do asset.

---

## 3. Tool calling — funcionando

Ferramenta enviada: `get_weather` (JSON Schema com `location` obrigatória). Pergunta: clima em Tóquio / Rio.

| Teste | Status | Latência | `finish_reason` | Resultado |
|---|--:|--:|---|---|
| Não-stream | `200` | 3,5s | `tool_calls` | `get_weather({"location": "Toquio"})` |
| **Stream** | `200` | 3,1s | `tool_calls` | `get_weather({"location": "Rio de Janeiro"})` |

O stream chegou com os deltas `tool_calls` montados corretamente (nome + argumentos fragmentados ao longo dos chunks SSE), exatamente como um cliente de agente espera.

---

## 4. Visão (imagem) — funcionando

Mesmo asset (círculo vermelho) para 4 modelos:

| Modelo | Status | Latência | Resposta do modelo |
|---|--:|--:|---|
| `mimo-v2.6-flash-free` | `200` | 8,0s | "A imagem mostra um círculo de cor vermelha." |
| `deepseek-v4.1-flash-free` | `200` | 3,0s | "A imagem mostra um círculo vermelho." |
| `nemotron-3.5-super-vl-free` | `200` | 2,4s | "A imagem mostra um círculo vermelho." |
| `space-bunny-free` | `200` | 3,1s | "A imagem mostra um círculo sólido de cor vermelha, centralizado sobre um fundo branco." |

---

## 5. Vídeo — funcionando

Asset: MP4 de 1s, tela azul. Parte usada: `{"type": "video_url", "video_url": {"url": "data:video/mp4;base64,..."}}`.

| Modelo | Status | Latência | Resposta do modelo |
|---|--:|--:|---|
| `space-bunny-free` | `200` | 3,8s | "tela inteiramente preenchida por azul royal (azul profundo uniforme)" |
| `mimo-v2.6-flash-free` | `200` | 5,6s | "A cor predominante no vídeo é o azul escuro." |
| `step-5-preview-free` | `429` → retry `200` | 13,5s → 7,6s | retry: "tela praticamente toda preenchida por um campo de cor azul" |

O `429` do step-5 foi um erro de **capacidade** do upstream (não cota) — a evidência completa ficou capturada; veja a seção 7.

---

## 6. Áudio — funcionando

Asset: WAV de 1s, tom senoidal 440 Hz. Parte usada: `{"type": "input_audio", "input_audio": {"data": "<base64>", "format": "wav"}}`.

| Modelo | Status | Latência | Resposta do modelo |
|---|--:|--:|---|
| `mimo-v2.6-flash-free` | `200` | 6,9s | "É um tom senoidal puro (uma onda sonora contínua e monofônica), comum em testes de áudio..." |

---

## 7. Captura de rejeições do upstream (`lastRejection`)

Qualquer resposta de erro do Zen (≥ 400) que passe pelo proxy é **capturada automaticamente** antes do retry/rotação:

- **status** + statusMessage
- **todos os headers** da resposta (com `retry-after` destacado)
- **mensagem parseada** do JSON de erro
- **corpo cru** (até 2KB)

A captura fica visível em três lugares:

1. **Logs** do app — linha `warn` no momento exato: `rate limit / quota response captured { status, retryAfter, message }`
2. **Dashboard → Eventos** — mensagem no feed, chip `retry-after` e corpo completo no hover
3. **`GET /api/stats` / `/admin/stats`** — campo `lastRejection` (persistido em `stats.json`, sobrevive a reinícios)

### Evidência ao vivo (o 429 do step-5 vídeo, capturado em 15/10/2026)

```json
{
  "status": 429,
  "statusMessage": "Too Many Requests",
  "at": "2026-10-15T17:14:53.231Z",
  "model": "step-5-preview-free",
  "rateLimited": true,
  "retryAfter": null,
  "message": "Upstream request failed: Endpoint is unavailable.",
  "headers": {
    "cf-placement": "remote-ORD",
    "cf-ray": "a4b07671df256c87-MIA",
    "server": "cloudflare",
    "content-type": "application/json",
    "x-opencode-log-id": "b133c341-fec3-4572-af3b-00d2345a5aac"
  },
  "body": "{\"error\":{\"type\":\"server_error\",\"message\":\"Upstream request failed: Endpoint is unavailable.\"}}"
}
```

Leitura da evidência:

- `"type": "server_error"` + `"Endpoint is unavailable"` → **capacidade de rota**, não cota de tier
- `cf-placement: remote-ORD` → Cloudflare roteou para o PoP de Chicago (enquanto o `cf-ray` mostra a entrada pelo edge de Miami) — indício de falta de slot na região escolhida
- `x-opencode-log-id` → ID de correlação do gateway Zen (útil para reportar)

### Dois tipos de 429

| Tipo | Assinatura | Comportamento do proxy |
|---|---|---|
| **Rate-limit por IP** | `429` com mensagem de rate limit | Rotação de circuito Tor + retry automático |
| **Capacidade** | `429` com `type: server_error` / "Endpoint is unavailable" | Também entra no ciclo de rotação + retry; evidência capturada |

> **Cota diária do tier gratuito:** quando estourar, a mensagem exata do Zen ficará registrada automaticamente em `lastRejection` — mesmo que o retry em outro circuito tenha sucesso. É para isso que o capturador existe: parar de teorizar sobre o formato do erro e ler o recibo.

---

## 8. Exemplos de payload (copiar e colar)

**Visão:**
```json
{
  "model": "mimo-v2.6-flash-free",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "Descreva a imagem."},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,<...>"}}
    ]
  }]
}
```

**Vídeo:**
```json
{
  "model": "space-bunny-free",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "Descreva o vídeo."},
      {"type": "video_url", "video_url": {"url": "data:video/mp4;base64,<...>"}}
    ]
  }]
}
```

**Áudio:**
```json
{
  "model": "mimo-v2.6-flash-free",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "Que som é este?"},
      {"type": "input_audio", "input_audio": {"data": "<base64>", "format": "wav"}}
    ]
  }]
}
```

URLs HTTP(S) também funcionam no lugar de data URIs (para imagem; vídeo/áudio foram verificados com data URI).

---

## 9. Notas e limitações

- **`max_tokens` em modelos de reasoning**: o raciocínio consome tokens primeiro. Use ≥ 500–800 em testes com resposta curta.
- **Latências altas não são travamento**: `mimo-v2.6` (23s) e `big-pickle` (27s) podem levar dezenas de segundos em modo reasoning.
- **Tamanho de payload**: data URIs inflam ~33% em base64. O limite padrão do proxy é `MAX_REQUEST_SIZE=50mb` — aumente se enviar vídeos grandes.
- **Catálogo é vivo**: o conjunto de modelos depende do que o Zen expõe no momento (`GET /v1/models`).
- **Matriz completa dos 11 gratuitos**: todos responderam `200` no teste de matriz (prompt mínimo "responda apenas: ok"), incluindo os dois Muse Spark (via tradução automática para clientes chat).
