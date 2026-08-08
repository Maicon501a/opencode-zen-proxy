# OpenCode Zen Proxy 🔌

**Proxy OpenAI-compatível sem chave (keyless) para os modelos gratuitos do OpenCode Zen** — Acesse `deepseek-v4-flash-free`, `mimo-v2.5-free`, `nemotron-3-ultra-free` e mais através de um endpoint OpenAI padrão. **Sem chave de API, sem login, sem precisar instalar o opencode.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
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

Este proxy elimina todas essas barreiras. Ele descobriu (analisando o binário do próprio opencode) que o gateway Zen aceita o token **`public`** como autenticação para liberar os modelos do tier gratuito — exatamente o que a CLI faz internamente quando nenhuma chave está configurada:

```js
// código real extraído do binário do opencode
options: hasKey ? {} : { apiKey: "public" }
```

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
- ✅ **Drop-in compatível** — Qualquer cliente OpenAI funciona apenas mudando a `baseURL`
- ✅ **Aliases de modelo** — `deepseek-v4-flash`, `mimo-v2.5` ou `opencode/deepseek-v4-flash-free` — todos funcionam e são resolvidos para o ID canônico no wire
- ✅ **Failover WARP** — em falhas de rede/gateway (429, 502, 503, 504 e 500 de gateway), a requisição é automaticamente repetida via proxy SOCKS5 local (WARP)
- ✅ **Contexto temporal** — injeta a data/ano atual num system message, para o modelo saber o presente em vez de assumir o corte de treino (2023–2024)
- ✅ **Uso em streaming** — força `stream_options.include_usage` em streams SSE para o `usage` sempre vir na resposta
- ✅ **Compatível com Codex/Responses** — sufixos `-responses`, `@responses` e `/responses` nos IDs de modelo são removidos automaticamente
- ✅ **Guard multimodal** — requisições com imagens/áudio para um modelo só-texto retornam erro claro e acionável (ou roteiam automaticamente p/ `mimo-v2.5-free` com `AUTO_ROUTE_MULTIMODAL=true`)
- ✅ **Leve** — Um único processo Node, apenas o Express como dependência

---

## 🚀 Como Funciona

O gateway OpenCode Zen já é uma API OpenAI-compatível completa. Seus modelos gratuitos podem ser liberados com o bearer token **`public`** — o mesmo comportamento da CLI opencode quando não há chave configurada.

Este proxy reproduz esse comportamento sem exigir o binário do opencode, login ou uma instância local `opencode serve`. Ele simplesmente:

1. Encaminha a requisição para o Zen com `Authorization: Bearer public`
2. Resolve o ID do modelo: remove o prefixo `opencode/`, remove sufixos `-responses`/`@responses`/`/responses` e mapeia aliases curtos para o ID canônico (`mimo-v2.5` → `mimo-v2.5-free`)
3. Injeta um system message com a **data/ano atual** e aplica o `reasoning_effort` padrão (e `include_usage` em streams)
4. Passa todo o resto (mensagens, tools, streaming) **exatamente como recebido**

Como o corpo da requisição é repassado sem alterações, o **function calling nativo funciona de ponta a ponta** — agentes recebem deltas reais de `tool_calls` em vez de texto puro. Em caso de falha de rede/gateway, o proxy re-tenta automaticamente via SOCKS5 (WARP).

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

## 🔧 Como Usar

> **Nota:** Nenhum cabeçalho `Authorization` é obrigatório dos clientes por padrão. Se quiser exigir, veja a seção [Configuração](#️-configuração).

### 1. Chat Completion básico (não-streaming)

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/deepseek-v4-flash-free",
    "messages": [
      {"role": "user", "content": "Escreva uma função Python para inverter uma string."}
    ],
    "max_tokens": 500
  }'
```

### 2. Tool Calling (chamadas de função)

Esta é a funcionalidade que faz agentes de IA funcionarem. O modelo recebe as ferramentas disponíveis e decide quando chamá-las:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/deepseek-v4-flash-free",
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

Modelos de raciocínio (como o `deepseek-v4-flash-free`) "pensam" antes de responder. Você controla **quanto** eles pensam com o campo `reasoning_effort`:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "messages": [{"role": "user", "content": "Resolva passo a passo: 15 * 17"}],
    "reasoning_effort": "high",
    "max_tokens": 800
  }'
```

**Por padrão, o proxy usa `xhigh` (o máximo)** — ou seja, o modelo sempre pensa o máximo possível. Você pode mudar isso por requisição.

Valores aceitos (confirmados diretamente no gateway Zen/DeepSeek):

| Valor      | Comportamento                                   |
|------------|-------------------------------------------------|
| `low`      | Raciocínio curto, respostas mais rápidas        |
| `medium`   | Equilíbrio entre profundidade e velocidade      |
| `high`     | Raciocínio aprofundado                          |
| `max`      | Quase o máximo                                  |
| `xhigh`    | **Máximo** (padrão do proxy)                    |

> Valores inválidos ou omitidos caem automaticamente no padrão configurado (`xhigh`). Valores como `none`/`minimal` são **rejeitados** pelo gateway (o DeepSeek exige algum raciocínio).

Para mudar o padrão global, defina a variável de ambiente `DEFAULT_REASONING_EFFORT` (ex: `medium`).

### 4. Streaming (SSE)

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "messages": [{"role": "user", "content": "Conte até 10."}],
    "stream": true
  }'
```

> O proxy força `stream_options.include_usage: true` em streams SSE (a menos que o cliente especifique outro valor), garantindo que o objeto `usage` venha no último chunk.

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
    model="deepseek-v4-flash-free",
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
  model: 'deepseek-v4-flash-free',
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
| **Model**     | `deepseek-v4-flash-free` (ou outro da lista `/v1/models`) |

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

Os modelos do tier gratuito, acessíveis com o token `public`:

| ID do Modelo                    | Nome                   | Tools | Reasoning |
|---------------------------------|------------------------|:-----:|:---------:|
| `opencode/deepseek-v4-flash-free` | DeepSeek V4 Flash Free |  ✅   |    ✅     |
| `opencode/big-pickle`           | Big Pickle             |  ✅   |    —      |
| `opencode/mimo-v2.5-free`       | MiMo V2.5 Free         |  ✅   |    —      |
| `opencode/nemotron-3-ultra-free`| Nemotron 3 Ultra Free  |  ✅   |    —      |
| `opencode/north-mini-code-free` | North Mini Code        |  ✅   |    —      |
| `opencode/ling-3.0-flash-free`  | Ling 3.0 Flash Free    |  ✅   |    —      |
| `opencode/laguna-s-2.1-free`    | Laguna S 2.1 Free      |  ✅   |    —      |

### Resolução de modelos (aliases)

O proxy resolve qualquer um destes formatos para o ID canônico antes de enviar ao Zen:

| Cliente envia                        | Wire (vai ao Zen)            |
|--------------------------------------|------------------------------|
| `opencode/deepseek-v4-flash-free`    | `deepseek-v4-flash-free`     |
| `deepseek-v4-flash-free`             | `deepseek-v4-flash-free`     |
| `deepseek-v4-flash`                  | `deepseek-v4-flash-free`     |
| `mimo-v2.5`                          | `mimo-v2.5-free`             |
| `nemotron-3-ultra`                   | `nemotron-3-ultra-free`      |
| `north-mini-code`                    | `north-mini-code-free`       |
| `ling-3.0-flash`                     | `ling-3.0-flash-free`        |
| `laguna-s-2.1`                       | `laguna-s-2.1-free`          |
| `opencode/deepseek-v4-flash-free-responses` | `deepseek-v4-flash-free` (sufixo `-responses` removido) |

> O conjunto exato de modelos depende do que o Zen expõe no momento. Rode `curl http://localhost:3000/v1/models` para ver a lista atualizada (vinda direto do Zen — atualmente 50 modelos).

> **Atenção ao reasoning:** O `deepseek-v4-flash-free` é um modelo de raciocínio. Ele emite o chain-of-thought (raciocínio) através do campo `reasoning_content` (estilo DeepSeek). Use um `max_tokens` generoso (ex: 500+) para que ele tenha espaço tanto para pensar quanto para responder.

---

## ⚙️ Configuração

Todas as configurações são feitas via variáveis de ambiente (arquivo `.env` ou ambiente do sistema):

| Variável                     | Padrão                          | Descrição |
|------------------------------|---------------------------------|-----------|
| `PORT`                       | `3000`                          | Porta do servidor proxy |
| `HOST`                       | `0.0.0.0`                       | Host do servidor proxy |
| `ZEN_API_BASE_URL`           | `https://opencode.ai/zen/v1`    | URL base da API Zen |
| `ZEN_API_KEY` / `OPENCODE_API_KEY` | `public`                  | Token bearer enviado ao Zen. `public` libera os modelos gratuitos; defina uma chave real para acessar também modelos pagos |
| `CLIENT_API_KEY`             | _(vazio)_                       | Se definido, os clientes devem enviar esta chave. Quando vazio, o proxy fica aberto (uso local) |
| `DEFAULT_REASONING_EFFORT`   | `xhigh`                         | Esforço de raciocínio padrão para modelos reasoning: `low`, `medium`, `high`, `max` ou `xhigh` |
| `INJECT_TEMPORAL_CONTEXT`    | `true`                          | Injeta um system message com a data/ano atual em cada requisição. Defina `false` para desativar |
| `AUTO_ROUTE_MULTIMODAL`      | `false`                         | Se `true`, requisições com imagens/áudio direcionadas a um modelo só-texto são roteadas automaticamente para `mimo-v2.5-free` (multimodal). Se `false`, retorna erro 400 claro |
| `WARP_AUTO_FAILOVER`         | `true`                          | Em falhas elegíveis (rede, 429/502/503/504, 500 de gateway), o proxy **ativa o WARP sob demanda** via `warp-cli` e re-tenta pelo proxy SOCKS5 local |
| `WARP_SOCKS_HOST`            | `127.0.0.1`                     | Host do proxy SOCKS5 usado no failover WARP |
| `WARP_SOCKS_PORT`            | `40000`                         | Porta do proxy SOCKS5 usado no failover WARP |
| `WARP_BIN_PATH`              | _(vazio)_                       | Caminho do binário `warp-cli` (vazio = do PATH; no Windows é auto-detectado em Program Files) |
| `WARP_COMMAND_TIMEOUT`       | `30000`                         | Timeout (ms) de cada comando `warp-cli` |
| `WARP_STARTUP_WAIT`          | `1500`                          | Espera (ms) após `warp-cli connect` antes de verificar o status |
| `WARP_COOLDOWN`              | `60000`                         | Cooldown (ms) após falha de ativação para evitar tempestade de `warp-cli` |
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
│   ├── index.js              # Ponto de entrada
│   ├── server.js             # Configuração do Express
│   ├── config/
│   │   ├── models.js         # Definições e aliases dos modelos
│   │   └── constants.js      # Constantes de configuração
│   ├── middleware/
│   │   ├── auth.js           # Verificação opcional de chave do cliente
│   │   └── errorHandler.js   # Tratamento de erros
│   ├── routes/
│   │   ├── chatCompletions.js # /v1/chat/completions (pass-through)
│   │   ├── models.js         # /v1/models (proxy do Zen)
│   │   └── health.js         # /health, /, /docs
│   ├── services/
│   │   └── zenClient.js      # Cliente HTTP para a API Zen
│   └── __tests__/
│       ├── models.test.js    # Testes unitários
│       └── reasoning.test.js # Testes do reasoning_effort
├── tests/
│   └── integration/
│       └── api.test.js       # Testes de integração
├── docs/
│   └── REVERSE_ENGINEERING.md  # Análise técnica detalhada
├── eslint.config.js          # Configuração do linter
├── package.json
├── .env.example
└── README.md
```

---

## ⚠️ Privacidade dos Dados

**Modelos gratuitos no OpenCode Zen podem coletar dados de sessão para melhoria dos modelos.** Evite enviar informações confidenciais ou pessoais ao usar os endpoints gratuitos, em particular:

- `opencode/deepseek-v4-flash-free`
- `opencode/big-pickle`
- `opencode/nemotron-3-ultra-free`

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
Use o campo `reasoning_effort` na requisição: `low`, `medium`, `high`, `max` ou `xhigh`. Por padrão o proxy usa `xhigh` (máximo). Mude o padrão global com a variável `DEFAULT_REASONING_EFFORT`. Veja a seção [Controlando o Esforço de Raciocínio](#3-controlando-o-esforço-de-raciocínio-reasoning_effort).

---

## 📚 Documentação Adicional

- [Análise Técnica de Engenharia Reversa](docs/REVERSE_ENGINEERING.md) — Documento completo sobre como a API Zen funciona internamente
- [Documentação do OpenCode Zen](https://opencode.ai/docs/zen/)
- [Referência da API OpenAI](https://platform.openai.com/docs/api-reference)

---

## 📄 Licença

MIT
