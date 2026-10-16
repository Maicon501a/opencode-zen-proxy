# Compatibilidade & Capacidades Verificadas

> **Data da verificação:** 15 de outubro de 2026
> **Ambiente:** proxy local (`http://127.0.0.1:3000`) com egress via **Tor isolado** → OpenCode Zen
> **Escopo:** tool calling, visão (imagem), vídeo, áudio e mapeamento de contexto real nos modelos gratuitos

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

## 8. Contexto real vs. metadado do catálogo (DeepSeek V4.1 Flash)

O catálogo anuncia **200.000 tokens** de contexto para `deepseek-v4.1-flash-free`. Na prática, isso é **metadado conservador** — o backend de inferência aceita a janela completa do modelo.

**Reproduzido ao vivo via proxy em 15/10/2026 (dois testes independentes):**

| Teste | Prompt enviado | `usage.prompt_tokens` | Status / latência |
|---|---|---|---|
| 1º | 1.069.989 caracteres (~1,08 MB de body) | **395.297** — ~2× o limite anunciado | `200` em 11,5s |
| 2º | 2.490.174 caracteres (~2,5 MB de body) | **919.735** — ~4,6× o limite anunciado | `200` em 17,0s (395k vindos do prompt cache) |

Nos dois testes: modelo `opencode/deepseek-v4.1-flash-free` (tier gratuito, sem key), egress via Tor isolado. Prompts de 2× e 4,6× o limite anunciado foram aceitos de primeira — sem erro, sem 429 e sem degradação na resposta. Os números de `usage` vêm do próprio upstream — não são estimativa do cliente.

**Teto real:** os testes, somados, desenham a borda completa — nossos (via proxy): `200` em 395k e 920k tokens; de terceiros (Reddit, 15/10/2026): `200` em ~982k e ~1,037M, `400` em ~1,107M. A API direta do DeepSeek retorna a mensagem exata nesse `400`: `"O comprimento máximo do contexto deste modelo é de 1.048.576 tokens."` — **2²⁰ tokens**, o mesmo valor que o OpenCode apresenta como "1M" na variante paga (`opencode-go/deepseek-v4.1-flash`).

**Como reproduzir:** monte um texto longo (ex.: ~21.000 linhas numeradas ≈ 2,5M de caracteres) e envie como mensagem única para `/v1/chat/completions` (não-stream). Confira `usage.prompt_tokens` na resposta — é a contagem do upstream.

**Implicações:**

- Em clientes, o `limit.context` do deepseek free pode ser elevado (ex.: `1000000`) para evitar compactação prematura de histórico. O valor do catálogo (200k) limita apenas o orçamento **local** do cliente — não o serviço.
- A sobrescrita não aumenta a janela; ela só para de subestimar o cliente.
- Cuidado: prompts gigantes consomem muita cota do tier gratuito de uma vez (nossos testes consumiram ~395k e ~920k tokens).
- Contextos grandes com **prefixo repetido** pesam menos: no teste de 920k, ~395k tokens vieram do prompt cache do upstream (prefixo idêntico ao teste anterior) — reenvios de histórico com começo comum são mais rápidos e baratos.

> Estes testes medem **capacidade de contexto**, não equivalência de backend: sem logprobs/detalhes internos não dá para afirmar que a variante gratuita usa os mesmos pesos/quantização da paga — apenas que ambas expõem a mesma janela do DeepSeek V4.1 Flash, com saídas determinísticas indistinguíveis nos testes de terceiros.

### 8.1 GLM 5.3 Flash Free — mesma verificação (16/10/2026)

O `glm-5.3-flash-free` repete o padrão (200k anunciado, backend aceitando muito mais), mas com uma borda própria, medida com a mesma técnica:

| Teste | Prompt enviado | `usage.prompt_tokens` | Status / latência |
|---|---|---|---|
| 1º | 1.500.000 caracteres | **512.613** | `200` em 33,7s |
| 2º | 2.624.000 caracteres | **899.857** | `200` em 61,9s |
| 3º | 2.680.000 caracteres | **919.293** | `200` em 73,3s |
| 4º | 2.688.000 caracteres | **922.038** | `200` em 48,4s |
| 5º | 2.694.000 caracteres | **924.124** | `200` em 180,9s (prefill grande fica lento) |
| 6º | 2.700.000+ caracteres | ~926k | `400` — `[context_length_exceeded] The prompt exceeds the context window this endpoint can start from` |

**Borda do glm:** entre **924.124** (aceito) e **~926k** (rejeitado) — o gateway reserva parte da janela para o "start", então a maior entrada verificada é ~924k (≈88% de 1.048.576), abaixo do que o deepseek aceitou (que chega perto da janela cheia). Por isso o catálogo adota **900.000** como valor redondo seguro (verificado a 899.857), replicado em clientes.

**Notas:**

- Rejeição de contexto vem como `400` com `code: context_length_exceeded` — não entra no ciclo de rotação de circuito (nem deve: trocar de exit não resolve prompt grande).
- Lotes grandes oscilam: o mesmo tamanho pode pegar `429` "Endpoint is unavailable" (capacidade) e passar no retry — comportamento do gateway, não da contagem.
- Consumo de cota: os testes somados enviaram ~7,4M de tokens de entrada no tier gratuito (deepseek ~1,3M + glm ~6,1M) — útil saber antes de repetir a brincadeira.

---

## 9. Exemplos de payload (copiar e colar)

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

## 10. Notas e limitações

- **`max_tokens` em modelos de reasoning**: o raciocínio consome tokens primeiro. Use ≥ 500–800 em testes com resposta curta.
- **Latências altas não são travamento**: `mimo-v2.6` (23s) e `big-pickle` (27s) podem levar dezenas de segundos em modo reasoning.
- **Tamanho de payload**: data URIs inflam ~33% em base64. O limite padrão do proxy é `MAX_REQUEST_SIZE=50mb` — aumente se enviar vídeos grandes.
- **Catálogo é vivo**: o conjunto de modelos depende do que o Zen expõe no momento (`GET /v1/models`).
- **Matriz completa dos 11 gratuitos**: todos responderam `200` no teste de matriz (prompt mínimo "responda apenas: ok"), incluindo os dois Muse Spark (via tradução automática para clientes chat).
