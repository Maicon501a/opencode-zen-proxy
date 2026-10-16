# OpenCode Zen Proxy 🔌

**Proxy OpenAI-compatível sem chave (keyless) para os modelos gratuitos do OpenCode Zen** — Acesse `deepseek-v4.1-flash-free`, `space-bunny-free`, `big-pickle`, `mimo-v2.6-flash-free` e mais através de um endpoint OpenAI padrão. **Sem chave de API, sem login, sem precisar instalar o opencode.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Build](https://github.com/Maicon501a/opencode-zen-proxy/actions/workflows/build.yml/badge.svg)](https://github.com/Maicon501a/opencode-zen-proxy/actions/workflows/build.yml)
[![Node](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Desktop App](https://img.shields.io/badge/Desktop-Windows%20%7C%20Linux-blueviolet.svg)](https://github.com/Maicon501a/opencode-zen-proxy/releases)
[![OpenAI Compatible](https://img.shields.io/badge/OpenAI-Compatible-blue.svg)](https://platform.openai.com/docs/api-reference)

---

## 📖 Sobre o Projeto

### O que é?

O **OpenCode Zen Proxy** é um servidor local que age como uma ponte entre qualquer cliente compatível com a API da OpenAI (SDKs, agentes de IA, ferramentas de automação) e o **gateway OpenCode Zen** — um serviço que oferece acesso gratuito a diversos modelos de IA de ponta, como o DeepSeek V4 Flash, MiMo, Nemotron e outros.

### O problema que ele resolve

O gateway OpenCode Zen (`https://opencode.ai/zen/v1`) já é, por si só, uma API compatível com a OpenAI. No entanto, para usar os modelos gratuitos oficialmente, você precisaria:

1. Instalar a CLI do opencode
2. Manter um servidor local `opencode serve` rodando em segundo plano
3. Passar por uma camada de agente stateful que **intercepta e descarta os tool calls** (chamadas de função) que clientes como o Kilo Code, Cline e outros agentes dependem

Isso quebra a funcionalidade de **function calling nativo**, fazendo com que agentes de IA fiquem "só pensando" sem nunca conseguir executar ferramentas (ler arquivos, rodar comandos, etc.).

### A solução

Este proxy elimina todas essas barreiras. Analisando o binário **e o tráfego real** do opencode, ele descobriu como o gateway Zen libera o tier gratuito:

- O gateway aceita o token **`public`** como autenticação — exatamente o que a CLI faz internamente quando nenhuma chave está configurada:

```js
// código real extraído do binário do opencode
options: hasKey ? {} : { apiKey: "public" }
```

- Desde 23/09/2026 o edge também exige uma "assinatura" de cliente oficial (403 `FreeTierError` sem ela): `User-Agent: opencode/...`, um **session id cunhado exatamente como a CLI cunha** — o prefixo de 12 hex codifica o instante de criação (`(0x1b000000046ffe - unix_ms * 4096) mod 2^48`); ids aleatórios ou "de forma parecida" são recusados — e uma function tool chamada **`read`** no corpo. O proxy cunha esses ids e monta esse shape sozinho, a cada requisição (fórmula e evidências em `docs/REVERSE_ENGINEERING.md`).

Com isso, o proxy:

- ✅ Fala **diretamente** com o Zen (sem precisar do binário do opencode)
- ✅ Repassa os `tools`/`tool_choice`/`stream` **intactos**, preservando o function calling nativo
- ✅ Não exige login, chave ou qualquer configuração de conta
- ✅ Funciona com qualquer cliente OpenAI-compatível mudando apenas a `baseURL`

---

## ✨ Funcionalidades

- ✅ **Verdadeiramente keyless** — Conversa direto com o gateway Zen; sem backend `opencode serve`, sem login, sem chave de API
- ✅ **Tool calling nativo (function calling)** — `tools`, `tool_choice` e streaming de `tool_calls` passam intactos (o que agentes como Kilo Code / Cline precisam)
- ✅ **Streaming SSE** — Suporte completo a streaming, incluindo o `reasoning_content` estilo DeepSeek (chain-of-thought)
- ✅ **Imagens / Vision** — Aceita `image_url` por URL ou data URI no formato OpenAI (inclusive variações de SDKs)
- ✅ **Drop-in compatível** — Qualquer cliente OpenAI funciona apenas mudando a `baseURL`
- ✅ **Aliases de modelo** — `deepseek-v4.1-flash-free` ou `opencode/deepseek-v4.1-flash-free` ambos funcionam
- ✅ **Leve** — Um único processo Node com dependências mínimas (express, cors, dotenv)
- 🖥️ **App desktop (Windows/Linux)** — painel com Tor embutido, estatísticas, chaves e documentação integrada (veja a seção **App Desktop** abaixo)
- 💬 **Chat integrado no app** — interface limpa estilo ChatGPT: texto, imagem, vídeo e áudio, seletor de modelos com capacidades e raciocínio do modelo visível ao vivo
- 📊 **Painel & admin API** — contadores de tokens por modelo, feed de eventos e rotação de IP (protegidos por tokens locais gerados a cada execução)
- 🌐 **Egress opcional via Tor/WARP** — roteia as requisições por SOCKS5 com rotação automática de IP em rate-limit

---

## 🚀 Como Funciona

O gateway OpenCode Zen já é uma API OpenAI-compatível completa. Seus modelos gratuitos são liberados com o bearer token **`public`** — o mesmo comportamento da CLI opencode quando não há chave configurada — **mais** o carimbo de cliente oficial que o edge passou a exigir em 23/09/2026 (User-Agent `opencode/...`, session id cunhado no formato ascendente da CLI e a tool `read` no corpo).

Este proxy reproduz esse comportamento sem exigir o binário do opencode, login ou uma instância local `opencode serve`. Ele simplesmente:

1. Encaminha a requisição para o Zen com `Authorization: Bearer public`
2. Minta um session id igual ao da CLI (`ses_` + timestamp codificado + sufixo aleatório) e apresenta os headers oficiais (`User-Agent`, `X-Opencode-Session`, `X-Session-Affinity`, ...)
3. Garante `stream: true` e a tool `read` (injetada quando o cliente não manda nenhuma) — o gateway só responde em SSE, e o proxy dobra o stream de volta quando o cliente pediu JSON
4. Remove o prefixo opcional `opencode/` do ID do modelo
5. Normaliza pequenas variações de entrada de imagens para o formato OpenAI padrão
6. Passa todo o resto (mensagens, tools, streaming) **exatamente como recebido**

Como o corpo da requisição é repassado sem alterações, o **function calling nativo funciona de ponta a ponta** — agentes recebem deltas reais de `tool_calls` em vez de texto puro.

### Arquitetura

```
┌─────────────────────────────┐
│     Sua Aplicação            │
│  (SDK OpenAI, agente, CURL) │
└─────────────┬───────────────┘
              │ API compatível com OpenAI
              ▼
┌─────────────────────────────┐
│    OpenCode Zen Proxy        │
│  • injeta Bearer "public"    │
│  • remove prefixo opencode/  │
│  • repassa tools/stream      │
└─────────────┬───────────────┘
              │ HTTPS (direto)
              ▼
┌─────────────────────────────┐
│   OpenCode Zen API           │
│  https://opencode.ai/zen/v1 │
└─────────────┬───────────────┘
              │ Rota para o provedor
              ▼
┌─────────────────────────────┐
│   Provedores de Modelo       │
│  (DeepSeek, NVIDIA, MiMo,   │
│   North, Big Pickle)         │
└─────────────────────────────┘
```

Sem binário local, sem estado de sessão, sem processo backend. O proxy é um pass-through sem estado (stateless).

---

## 📦 Instalação

### Pré-requisitos

- [Node.js](https://nodejs.org/) versão 18 ou superior
- [pnpm](https://pnpm.io/) (gerenciador de pacotes recomendado)

> O pnpm pode ser instalado com `npm install -g pnpm` ou habilitado via `corepack enable`. Ele é usado por padrão neste projeto por ser mais rápido e seguro (links simbólicos, melhor isolamento de dependências).

### Passo a passo

```bash
# Clone o repositório
git clone https://github.com/Maicon501a/opencode-zen-proxy.git
cd opencode-zen-proxy

# Instale as dependências
pnpm install
```

### Iniciando o servidor

```bash
# Modo produção
pnpm start

# Modo desenvolvimento (com auto-reload)
pnpm dev
```

O proxy iniciará em `http://localhost:3000`. Pronto — não há backend para iniciar nem credenciais para buscar.

---

## 🖥️ App Desktop (Windows / Linux)

Além da CLI, o projeto tem um app desktop completo (Wails) que embute o proxy + Tor, com painel de estatísticas, gerenciador de chaves, rotação de IP e documentação integrada.

**Download:** o GitHub Actions compila e publica os binários em [Releases](https://github.com/Maicon501a/opencode-zen-proxy/releases):

- `OpenCodeZenDesktop-windows-amd64.exe` — baixe e execute **direto**, sem extrair (ou o `.zip`, se preferir)
- `OpenCodeZenDesktop-linux-amd64.tar.gz` — extraia e rode `./OpenCodeZenDesktop` (requer `libwebkit2gtk-4.1` instalado)

**Pré-requisito:** [Node.js](https://nodejs.org/) 18+ no PATH — o app supervisiona o processo Node, e a cópia do proxy já vem embutida no binário.

Recursos do app:

- 🧅 **Tor embutido** (Tor Expert Bundle) — liga/desliga com um clique, escolha de exit node e rotação manual/automática de IP em rate-limit
- 💬 **Chat integrado** — interface limpa estilo ChatGPT no painel: texto, imagem, vídeo e áudio; troque de modelo no compositor e acompanhe o raciocínio do modelo ao vivo
- 📊 **Painel** — contadores de tokens por modelo, feed de eventos e logs ao vivo
- 🔑 **Chaves de API opcionais** — gere chaves para exigir autenticação dos clientes, aplicadas em runtime
- 📖 **Documentação PT-BR integrada** + snippets prontos por modelo (curl, opencode, SDKs)

O mesmo painel também abre no navegador em `http://127.0.0.1:46998/`.

Para compilar localmente (Go 1.25+ e [Wails v2.13](https://wails.io)):

```bash
cd desktop
wails build -clean                   # Windows
wails build -clean -tags webkit2_41  # Linux
```

---

## 🔧 Como Usar

> **Nota:** Nenhum cabeçalho `Authorization` é obrigatório dos clientes por padrão. Se quiser exigir, veja a seção [Configuração](#️-configuração).

### 1. Chat Completion básico (não-streaming)

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/deepseek-v4.1-flash-free",
    "messages": [
      {"role": "user", "content": "Escreva uma função Python para inverter uma string."}
    ],
    "max_tokens": 500
  }'
```

### Entrada de imagens (Vision)

Use um modelo multimodal, como o **`mimo-v2.6-flash-free`**, e envie partes `text` + `image_url` no conteúdo da mensagem. URLs HTTP(S) e data URIs base64 são aceitas:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo-v2.6-flash-free",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "Descreva esta imagem."},
        {
          "type": "image_url",
          "image_url": {"url": "https://httpbin.org/image/png", "detail": "high"}
        }
      ]
    }]
  }'
```

Para base64, use `"url": "data:image/png;base64,..."`. O proxy também normaliza `image_url` enviado como string e partes `input_image` usadas por clientes compatíveis com a Responses API. Modelos somente texto rejeitam imagens; consulte `supportsVision` em `GET /v1/models/free`.

**Vídeo e áudio** seguem o mesmo padrão, com as partes `video_url` (`{"type":"video_url","video_url":{"url":"data:video/mp4;base64,..."}}`) e `input_audio` (`{"type":"input_audio","input_audio":{"data":"<base64>","format":"wav"}}`). Verificados ao vivo em `mimo-v2.6` (imagem + vídeo + áudio), `space-bunny` e `step-5` (vídeo) — tabela completa por modelo em [docs/COMPATIBILIDADE.md](docs/COMPATIBILIDADE.md).

### 2. Tool Calling (chamadas de função)

Esta é a funcionalidade que faz agentes de IA funcionarem. O modelo recebe as ferramentas disponíveis e decide quando chamá-las:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/deepseek-v4.1-flash-free",
    "messages": [{"role": "user", "content": "Qual é o clima em Tóquio?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Pega o clima atual de uma localização",
        "parameters": {
          "type": "object",
          "properties": {"location": {"type": "string"}},
          "required": ["location"]
        }
      }
    }],
    "max_tokens": 300
  }'
```

A resposta contém `tool_calls` no formato OpenAI padrão, com `finish_reason: "tool_calls"`:

```json
{
  "choices": [{
    "finish_reason": "tool_calls",
    "message": {
      "role": "assistant",
      "tool_calls": [{
        "function": {
          "name": "get_weather",
          "arguments": "{\"location\": \"Tóquio\"}"
        }
      }]
    }
  }]
}
```

### 3. Controlando o Esforço de Raciocínio (reasoning_effort)

Modelos de raciocínio (como o `deepseek-v4.1-flash-free`) "pensam" antes de responder. Você controla **quanto** eles pensam com o campo `reasoning_effort`:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4.1-flash-free",
    "messages": [{"role": "user", "content": "Resolva passo a passo: 15 * 17"}],
    "reasoning_effort": "high",
    "max_tokens": 800
  }'
```

**Por padrão, o proxy usa `high`** — o modelo pensa de forma aprofundada, mas com espaço garantido para a resposta. Ajuste por requisição ou mude o padrão global com `DEFAULT_REASONING_EFFORT`.

Efetivamente os modelos de chat aceitam três níveis (o proxy mapeia o resto):

| Valor      | Comportamento                                   |
|------------|-------------------------------------------------|
| `low`      | Raciocínio curto, respostas mais rápidas        |
| `high`     | Raciocínio aprofundado (**padrão do proxy**)    |
| `max`      | Quase o máximo                                  |

> `medium` → `high`, `xhigh` → `max`, `none`/`minimal` → `low` nos modelos de chat. Os modelos **Muse Spark** (Responses API) aceitam o vocabulário completo da OpenAI (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`).

### 4. Streaming (SSE)

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4.1-flash-free",
    "messages": [{"role": "user", "content": "Conte até 10."}],
    "stream": true
  }'
```

### 5. Listar Modelos Disponíveis

```bash
curl http://localhost:3000/v1/models
```

### 6. Usando com SDKs da OpenAI

**Python:**
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="none",  # qualquer valor funciona
)

response = client.chat.completions.create(
    model="deepseek-v4.1-flash-free",
    messages=[{"role": "user", "content": "Olá!"}],
)
print(response.choices[0].message.content)
```

**Node.js:**
```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'none',
});

const response = await client.chat.completions.create({
  model: 'deepseek-v4.1-flash-free',
  messages: [{ role: 'user', content: 'Olá!' }],
});
console.log(response.choices[0].message.content);
```

---

## 🤖 Usando com Agentes de IA (Kilo Code, Cline, etc.)

Esta é uma das principais aplicações do proxy. Clientes agentic como o **Kilo Code**, **Cline** e outros suportam provedores OpenAI-compatíveis. Basta configurar:

| Campo         | Valor                                  |
|---------------|----------------------------------------|
| **Base URL**  | `http://localhost:3000/v1`             |
| **API Key**   | qualquer valor (ex: `none`)            |
| **Model**     | `deepseek-v4.1-flash-free` (ou outro da lista `/v1/models`) |

Como o tool calling e o streaming funcionam nativamente, o agente consegue ler/escrever arquivos, rodar ferramentas e executar tarefas — tudo de graça.

### Por que isso não funcionava antes?

No fluxo antigo (via `opencode serve`), a requisição passava por um agente stateful do próprio opencode que:

1. Recebia os tools do seu cliente
2. **Descartava eles**
3. Usava as ferramentas internas do opencode
4. Devolvia apenas texto puro

Resultado: o agente (ex: Kilo Code) nunca recebia os `tool_calls`, ficando travado "só pensando". Com o pass-through direto deste proxy, os tools do seu cliente chegam intactos ao modelo.

---

## 📋 Modelos Gratuitos

Os modelos do tier gratuito, acessíveis com o token `public` (limites oficiais do catálogo Zen):

| ID do Modelo | Nome | Contexto | Saída máx. | Tools | Vision | Vídeo | Áudio |
|---|---|--:|--:|:--:|:--:|:--:|:--:|
| `opencode/deepseek-v4.1-flash-free` | DeepSeek V4.1 Flash Free | 1.048.576 | 32.000 | ✅ | ✅ | — | — |
| `opencode/glm-5.3-flash-free` | GLM 5.3 Flash Free | 900.000 | 32.000 | ✅ | ✅ | ✅ | — |
| `opencode/space-bunny-free` | Space Bunny Free | 1.048.576 | 524.288 | ✅ | ✅ | ✅ | — |
| `opencode/cat-jam-free` | Cat Jam Free | 262.144 | 131.072 | ✅ | — | — | — |
| `opencode/mimo-v2.6-flash-free` | MiMo V2.6 Flash Free | 200.000 | 32.000 | ✅ | ✅ | ✅ | ✅ |
| `opencode/nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning Free | 262.144 | 262.144 | ✅ | — | — | — |
| `opencode/nemotron-3.5-super-vl-free` | Nemotron 3.5 Super VL Free | 1.048.576 | 131.072 | ✅ | ✅ | — | — |
| `opencode/step-5-preview-free` | Step 5 Preview Free | 1.000.000 | 65.536 | ✅ | ✅ | ✅ | — |
| `opencode/longcat-2.5-preview-free` | LongCat 2.5 Preview Free | 1.000.000 | 131.072 | ✅ | ✅ | — | — |
| `opencode/big-pickle` | Big Pickle | 200.000 | 32.000 | ✅ | — | — | — |
| `opencode/muse-spark-1.3-contributor-free` | Muse Spark 1.3 Free | 1.048.576 | 131.072 | ✅ | ✅ | ✅ | ✅ |
| `opencode/muse-spark-1.2-contributor-free` | Muse Spark 1.2 Free | 1.048.576 | 131.072 | ✅ | ✅ | ✅ | ✅ |

Você pode usar **aliases curtos** omitindo o prefixo `opencode/` (ex: `deepseek-v4.1-flash-free`, `space-bunny`, `muse-spark-1.3`).

> O conjunto exato de modelos depende do que o Zen expõe no momento. Rode `curl http://localhost:3000/v1/models` para ver a lista atualizada (vinda direto do Zen — 87 modelos no catálogo, 11 gratuitos).

> **Capacidades verificadas ao vivo (15/10/2026):** tool calling (não-stream e stream), visão, **vídeo** e **áudio** testados ponta-a-ponta pelo proxy via Tor — 20/21 respostas OK de primeira (+1 retry após 429 de capacidade). Matriz por modelo, exemplos de payload e a captura de rejeições: [docs/COMPATIBILIDADE.md](docs/COMPATIBILIDADE.md).

> **Contexto real vs. oficial:** os catálogos anunciam 200.000 tokens para `deepseek-v4.1-flash-free` e `glm-5.3-flash-free`, mas isso é metadado do cliente — não limite de serviço. Verificado ao vivo via proxy: deepseek aceitou **395.297** e **919.735 tokens** (`200`, 15/10/2026; janela real **1.048.576** = 2²⁰, igual à variante paga); glm 5.3 flash aceitou **512.613 / 899.857 / 919.293 / 922.038 tokens** (`200`, 16/10/2026) e rejeitou ~926k com `context_length_exceeded` — maior entrada verificada ~922k. O catálogo deste proxy já expõe os valores reais (deepseek 1.048.576; glm 900.000, valor redondo verificado); eleve `limit.context` no seu cliente para acompanhar. Evidência e como reproduzir: [docs/COMPATIBILIDADE.md](docs/COMPATIBILIDADE.md).

> **Atenção ao reasoning:** O `deepseek-v4.1-flash-free` é um modelo de raciocínio. Ele emite o chain-of-thought (raciocínio) através do campo `reasoning_content` (estilo DeepSeek). Use um `max_tokens` generoso (ex: 500+) para que ele tenha espaço tanto para pensar quanto para responder.

---

## ⚙️ Configuração

Todas as configurações são feitas via variáveis de ambiente (arquivo `.env` ou ambiente do sistema):

| Variável                     | Padrão                          | Descrição |
|------------------------------|---------------------------------|-----------|
| `PORT`                       | `3000`                          | Porta do servidor proxy |
| `HOST`                       | `0.0.0.0`                       | Host do servidor proxy |
| `MAX_REQUEST_SIZE`           | `50mb`                          | Limite do JSON; aumente se enviar imagens base64 grandes |
| `ZEN_API_BASE_URL`           | `https://opencode.ai/zen/v1`    | URL base da API Zen |
| `ZEN_API_KEY` / `OPENCODE_API_KEY` | `public`                  | Token bearer enviado ao Zen. `public` libera os modelos gratuitos; defina uma chave real para acessar também modelos pagos |
| `CLIENT_API_KEY`             | _(vazio)_                       | Se definido, os clientes devem enviar esta chave. Quando vazio, o proxy fica aberto (uso local) |
| `DEFAULT_REASONING_EFFORT`   | `high`                          | Esforço padrão para modelos reasoning (chat: `low`/`high`/`max`; Muse: `none`…`xhigh`) |
| `PROXY_DATA_DIR`             | `./data`                        | Diretório de dados persistidos (estatísticas, chaves, logs) |
| `UPSTREAM_SOCKS5`            | _(vazio)_                       | Roteia as requisições ao Zen via SOCKS5 (ex: Tor `socks5://127.0.0.1:9050`) |
| `LOG_LEVEL`                  | `info`                          | Nível de log: debug, info, warn, error |

### Exemplo de `.env`

```bash
# Copie .env.example para .env e ajuste conforme necessário
PORT=3000
ZEN_API_BASE_URL=https://opencode.ai/zen/v1
ZEN_API_KEY=public
LOG_LEVEL=info
```

---

## 🐳 Docker

Para rodar em container:

```bash
# Construir a imagem
docker build -t opencode-zen-proxy .

# Rodar o container
docker run -p 3000:3000 opencode-zen-proxy
```

---

## 🧪 Testes

O projeto inclui testes unitários e de integração:

```bash
# Rodar todos os testes
pnpm test

# Rodar com watch (desenvolvimento)
pnpm test:watch

# Verificar estilo de código (lint)
pnpm lint
```

---

## 📁 Estrutura do Projeto

```
opencode-zen-proxy/
├── src/
│   ├── index.js                # Ponto de entrada
│   ├── server.js               # Configuração do Express
│   ├── config/
│   │   ├── models.js           # Catálogo free-tier + limites oficiais
│   │   └── constants.js        # Constantes de configuração
│   ├── middleware/
│   │   ├── auth.js             # Verificação opcional de chave do cliente
│   │   └── errorHandler.js     # Tratamento de erros
│   ├── routes/
│   │   ├── chatCompletions.js  # /v1/chat/completions
│   │   ├── responses.js        # /v1/responses (Muse Spark, traduzido p/ chat)
│   │   ├── models.js           # /v1/models (+ limites, fusão com catálogo live)
│   │   ├── admin.js            # API administrativa (stats, chaves, rotação de IP)
│   │   └── health.js           # /health, /, /docs
│   ├── services/               # zenGate, transport (Tor/WARP), SSE, conversores,
│   │   ...                     # stats, chaves, logging
│   └── __tests__/              # Testes unitários
├── tests/integration/          # Testes de integração
├── desktop/                    # App desktop (Wails)
│   ├── app.go                  # Bindings, API local (:46998), supervisor tor/node
│   ├── internal/               # tormgr, proxyproc, settings, logbuf, docs
│   └── frontend/dist/          # UI estática (HTML/CSS/JS)
├── .github/workflows/build.yml # CI: testes do proxy + build Windows/Linux
├── docs/
│   └── REVERSE_ENGINEERING.md  # Análise técnica detalhada
├── eslint.config.js            # Configuração do linter
├── package.json
├── .env.example
└── README.md
```

---

## ⚠️ Privacidade dos Dados

**Modelos gratuitos no OpenCode Zen podem coletar dados de sessão para melhoria dos modelos.** Evite enviar informações confidenciais ou pessoais ao usar os endpoints gratuitos, em particular:

- `opencode/deepseek-v4.1-flash-free`
- `opencode/big-pickle`
- `opencode/space-bunny-free`

---

## ❓ Perguntas Frequentes

**Preciso instalar o opencode?**
Não. Nenhuma parte do opencode é necessária. O proxy fala direto com o gateway Zen via HTTP.

**Preciso de uma chave de API?**
Não para os modelos gratuitos. O token `public` é usado automaticamente. Se quiser usar modelos pagos (ex: `gpt-5.5`, `claude-sonnet-4-6`), defina `ZEN_API_KEY` com uma chave real obtida em opencode.ai.

**Funciona offline?**
Não. O proxy precisa de conexão com a internet para alcançar o gateway Zen.

**É legal usar o token "public"?**
Sim. É o comportamento documentado dentro do próprio código do opencode CLI. Quando não há chave configurada, ele usa `apiKey: "public"` para liberar os modelos do tier gratuito.

**Qual a diferença deste proxy para usar o opencode diretamente?**
Este proxy preserva o **function calling nativo**. O `opencode serve` intercepta e descarta os tools do seu cliente, quebrando agentes de IA. Este proxy repassa tudo intacto.

**Como controlo o quanto o modelo "pensa"?**
Use o campo `reasoning_effort` na requisição: `low`, `high` ou `max` (valores como `medium`/`xhigh` são mapeados automaticamente). Por padrão o proxy usa `high`. Mude o padrão global com a variável `DEFAULT_REASONING_EFFORT`. Veja a seção [Controlando o Esforço de Raciocínio](#3-controlando-o-esforço-de-raciocínio-reasoning_effort).

**Os modelos aceitam imagem, vídeo e áudio?**
Sim — conforme o modelo. Verificado ao vivo em 15/10/2026: visão em `mimo-v2.6`, `deepseek-v4.1`, `nemotron-3.5-super-vl` e `space-bunny`; vídeo em `space-bunny`, `step-5` e `mimo-v2.6`; áudio em `mimo-v2.6`. Envie as partes `image_url`, `video_url` e `input_audio` (data URI base64 funciona). Matriz completa por modelo: [docs/COMPATIBILIDADE.md](docs/COMPATIBILIDADE.md).

**O contexto do `deepseek-v4.1-flash-free` (e do `glm-5.3-flash-free`) é mesmo 200k?**
Não — os 200.000 tokens são metadado conservador do catálogo (orçamento do cliente, não intensidade do serviço). Verificado ao vivo em 15/10/2026: deepseek com **395.297 tokens** (1,07M de caracteres; `200 OK` em 11,5s) e **919.735 tokens** (2,49M de caracteres; `200 OK` em 17,0s, com 395k servidos pelo prompt cache) — tudo via Tor, sem rate-limit. O teto real do deepseek é **1.048.576 tokens** (2²⁰) — o mesmo da variante paga. Em 16/10/2026, o mesmo teste no **glm-5.3-flash-free**: **512.613 / 899.857 / 919.293 / 922.038 tokens** todos aceitos com `200` (o de 922k em 48s) e ~926k rejeitado com `context_length_exceeded` — maior entrada verificada ~922k, então o catálogo adota **900.000** como valor redondo seguro. Em clientes, eleve `limit.context` (deepseek `1048576`; glm `900000`) para evitar compactação prematura de histórico; a sobrescrita não muda o serviço, só para de subestimar o cliente. Detalhes: [docs/COMPATIBILIDADE.md](docs/COMPATIBILIDADE.md).

**O que é o `lastRejection` no `/api/stats`?**
É a captura da última rejeição do upstream (ex.: 429): status, headers completos, `retry-after`, mensagem parseada e corpo (até 2KB). Também aparece nos Logs e no feed de Eventos do app desktop, no momento em que acontece. Serve para ler a mensagem exata do Zen quando a cota diária do tier gratuito estourar.

---

## 📚 Documentação Adicional

- [Compatibilidade & Capacidades Verificadas](docs/COMPATIBILIDADE.md) — Matriz de tools/visão/vídeo/áudio testados ao vivo, exemplos de payload e a captura de rejeições 429
- [Análise Técnica de Engenharia Reversa](docs/REVERSE_ENGINEERING.md) — Documento completo sobre como a API Zen funciona internamente
- [Documentação do OpenCode Zen](https://opencode.ai/docs/zen/)
- [Referência da API OpenAI](https://platform.openai.com/docs/api-reference)

---

## 📄 Licença

MIT
