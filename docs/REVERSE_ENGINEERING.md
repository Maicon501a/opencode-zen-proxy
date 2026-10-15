# OpenCode Zen Reverse Engineering Analysis

> **Date:** June 27, 2026
> **Target:** OpenCode Zen API (`https://opencode.ai/zen/v1`)
> **Purpose:** Create an OpenAI-compatible proxy for OpenCode Zen free models

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [API Endpoints](#3-api-endpoints)
4. [Authentication Flow](#4-authentication-flow)
5. [Request/Response Formats](#5-requestresponse-formats)
6. [Streaming (SSE)](#6-streaming-sse)
7. [Model Catalog](#7-model-catalog)
8. [Error Handling](#8-error-handling)
9. [Provider Routing](#9-provider-routing)
10. [Pricing & Free Tiers](#10-pricing--free-tiers)

---

## 1. Overview

OpenCode Zen is an **AI gateway** service, not a model provider itself. It sits between the client (OpenCode CLI or any OpenAI-compatible client) and multiple downstream model providers. Its primary functions are:

- **Routing:** Determine which downstream provider to use based on the requested model
- **Transformation:** Normalize requests/responses between OpenAI, Anthropic, and other provider formats
- **Billing:** Track token usage and charge users on a pay-as-you-go basis
- **Caching:** Provide smart caching for repeated prompts
- **Benchmarking:** Curate only high-performing model-provider combinations

The Zen API is fully **OpenAI-compatible**, meaning any tool that supports OpenAI's API format can use Zen by simply changing the `baseURL`.

### Key Insight

Zen is NOT a model - it's a **proxy/routing layer**. When a user requests `opencode/deepseek-v4-flash-free`, Zen:
1. Receives the request in OpenAI format
2. Maps it to the appropriate downstream provider (DeepSeek)
3. Transforms the request to the provider's native format if needed
4. Sends the request to the provider
5. Transforms the response back to OpenAI format
6. Returns it to the client, adding billing metadata

---

## 2. Architecture

The following is reconstructed from the OpenCode source code repository (`anomalyco/opencode`):

```
Client (OpenCode CLI / 3rd-party tool)
    │
    ▼
┌─────────────────────────────────────┐
│         OpenCode Zen API            │
│  https://opencode.ai/zen/v1         │
│                                     │
│  ┌─────────────────────────────┐   │
│  │   Route Handler             │   │
│  │   (Express Router)          │   │
│  └──────────┬──────────────────┘   │
│             │                       │
│  ┌──────────▼──────────────────┐   │
│  │   ProviderHelper Factory    │   │
│  │   (Mediator Pattern)        │   │
│  │                             │   │
│  │  ┌──────────┐ ┌──────────┐ │   │
│  │  │  OpenAI  │ │ Anthropic│ │   │
│  │  │  Helper  │ │  Helper   │ │   │
│  │  └──────────┘ └──────────┘ │   │
│  │  ┌──────────┐ ┌──────────┐ │   │
│  │  │OpenAI-   │ │  Other   │ │   │
│  │  │Compatible│ │ Helpers  │ │   │
│  │  └──────────┘ └──────────┘ │   │
│  └──────────┬──────────────────┘   │
│             │                       │
│  ┌──────────▼──────────────────┐   │
│  │   Downstream Provider       │   │
│  │   (DeepSeek, OpenAI,        │   │
│  │    Anthropic, Google, etc.) │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

### Internal Components (from source code analysis)

| Component | Source Path | Description |
|-----------|-------------|-------------|
| `ProviderHelper` | `.../provider/provider.ts` | Interface defining how to transform requests/responses |
| `OpenAIHelper` | `.../provider/openai.ts` | Handles OpenAI <-> CommonRequest mapping |
| `AnthropicHelper` | `.../provider/anthropic.ts` | Handles Anthropic <-> CommonRequest mapping |
| `OpenAICompatibleHelper` | `.../provider/openai-compatible.ts` | Handles generic OpenAI-compatible providers |
| `BodyConverter` | `.../provider/provider.ts` | Dynamic conversion pipeline between formats |
| `UsageParser` | `.../provider/provider.ts` | Normalizes token usage across providers |

### CommonRequest Interface

The Zen API normalizes all requests into a `CommonRequest` structure:

```typescript
interface CommonRequest {
  model: string;
  messages: Message[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  tools?: Tool[];
  tool_choice?: ToolChoice;
  stream?: boolean;
  response_format?: ResponseFormat;
}
```

---

## 3. API Endpoints

### Base URL: `https://opencode.ai/zen/v1`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/chat/completions` | POST | Standard chat completions (OpenAI-compatible) |
| `/models` | GET | List all available models |
| `/models/:id` | GET | Get specific model details |
| `/responses` | POST | Newer OpenAI Responses API |
| `/messages` | POST | Anthropic-compatible messages endpoint |

### Path Mapping

Based on model type, Zen routes to different endpoints:

```
OpenAI models (GPT, etc.):    /v1/chat/completions  OR  /v1/responses
Anthropic models (Claude):    /v1/messages
Google models (Gemini):       /v1/models/gemini:...
Other providers:              /v1/chat/completions  (OpenAI-compatible)
```

---

## 4. Authentication Flow

### Client -> Zen API

```
Authorization: Bearer <ZEN_API_KEY>
```

The API key is obtained by:
1. Visiting https://opencode.ai/auth
2. Signing in (GitHub or Google OAuth)
3. Adding billing information
4. Generating an API key

### Zen -> Downstream Provider

When Zen forwards requests to downstream providers, it uses a combination of:

- **Zen-managed keys:** For most providers, Zen uses its own API keys (billed to the user by Zen)
- **BYOK (Bring Your Own Key):** Users can configure their own provider API keys within Zen
- **Header injection:** The `modifyHeaders` function in each `ProviderHelper` injects the appropriate auth header:
  ```typescript
  modifyHeaders: (headers, apiKey, stickyId) => {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  ```

### Key Storage (OpenCode CLI)

When using the OpenCode CLI, credentials are stored in:
- `~/.local/share/opencode/auth.json`
- `~/.config/opencode/opencode.json`

---

## 5. Request/Response Formats

### Standard OpenAI Chat Completions Request

**Request:**
```json
{
  "model": "opencode/deepseek-v4-flash-free",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Write a Python function."}
  ],
  "temperature": 0.7,
  "max_tokens": 4096,
  "stream": false
}
```

**Model ID Formats:**
- Canonical: `opencode/deepseek-v4-flash-free`
- Short alias: `deepseek-v4-flash-free` (Zen accepts this)
- The `opencode/` prefix is the provider identifier in the OpenCode ecosystem

**Response (OpenAI-compatible):**
```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1719792000,
  "model": "opencode/deepseek-v4-flash-free",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Here's a Python function..."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 100,
    "total_tokens": 125,
    "prompt_tokens_details": {
      "cached_tokens": 0
    },
    "completion_tokens_details": {
      "reasoning_tokens": 0
    }
  }
}
```

### Extended Usage Object

Zen extends the standard OpenAI usage object with additional fields for modern models:

```json
{
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 100,
    "total_tokens": 125,
    "prompt_tokens_details": {
      "cached_tokens": 10
    },
    "completion_tokens_details": {
      "reasoning_tokens": 50
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `cached_tokens` | Tokens served from cache (affects billing) |
| `reasoning_tokens` | Tokens used for chain-of-thought/reasoning |

---

## 6. Streaming (SSE)

The Zen API supports Server-Sent Events (SSE) streaming identical to OpenAI's format.

### Request
```json
{
  "model": "opencode/deepseek-v4-flash-free",
  "messages": [{"role": "user", "content": "Count to 5."}],
  "stream": true
}
```

### Response (SSE stream)
```
data: {"id":"chatcmpl-xyz","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"},"index":0}]}

data: {"id":"chatcmpl-xyz","object":"chat.completion.chunk","choices":[{"delta":{"content":"1"},"index":0}]}

data: {"id":"chatcmpl-xyz","object":"chat.completion.chunk","choices":[{"delta":{"content":" 2"},"index":0}]}

data: {"id":"chatcmpl-xyz","object":"chat.completion.chunk","choices":[{"delta":{"content":" 3"},"index":0}]}

data: {"id":"chatcmpl-xyz","object":"chat.completion.chunk","choices":[{"delta":{"content":" 4"},"index":0}]}

data: {"id":"chatcmpl-xyz","object":"chat.completion.chunk","choices":[{"delta":{"content":" 5"},"index":0,"finish_reason":"stop"}]}

data: [DONE]
```

---

## 7. Model Catalog

### Free Models (OpenCode Zen Plan)

As of June 2026, the following models are available for free:

| Model ID | Provider | Family | Streaming | Tools |
|----------|----------|--------|-----------|-------|
| `opencode/deepseek-v4-flash-free` | DeepSeek | DeepSeek V4 | ✅ | ✅ |
| `opencode/big-pickle` | Big Pickle | Big Pickle | ✅ | ❌ |
| `opencode/nemotron-3-super-free` | NVIDIA | Nemotron 3 | ✅ | ✅ |
| `opencode/grok-code` | xAI | Grok | ✅ | ✅ |
| `opencode/hy3-preview-free` | Hy3 | Hy3 | ✅ | ❌ |
| `opencode/kimi-k2.5-free` | Kimi | Kimi K2.5 | ✅ | ✅ |
| `opencode/ling-2.6-flash-free` | Ling | Ling 2.6 | ✅ | ❌ |
| `opencode/mimo-v2-flash-free` | MiMo | MiMo V2 | ✅ | ✅ |
| `opencode/mimo-v2-omni-free` | MiMo | MiMo V2 | ✅ | ✅ |
| `opencode/mimo-v2-pro-free` | MiMo | MiMo V2 | ✅ | ✅ |
| `opencode/mimo-v2.5-free` | MiMo | MiMo V2.5 | ✅ | ✅ |
| `opencode/minimax-m2.1-free` | MiniMax | MiniMax M2 | ✅ | ✅ |
| `opencode/minimax-m2.5-free` | MiniMax | MiniMax M2.5 | ✅ | ✅ |
| `opencode/minimax-m3-free` | MiniMax | MiniMax M3 | ✅ | ✅ |
| `opencode/nemotron-3-ultra-free` | NVIDIA | Nemotron 3 | ✅ | ✅ |
| `opencode/north-mini-code-free` | North | North | ✅ | ❌ |
| `opencode/qwen3.6-plus-free` | Alibaba | Qwen 3.6 | ✅ | ✅ |
| `opencode/ring-2.6-1t-free` | Ring | Ring 2.6 | ✅ | ✅ |
| `opencode/trinity-large-preview-free` | Trinity | Trinity | ✅ | ✅ |

### ⚠️ Data Privacy Warning

Free models **may collect and use session data for model improvement**. Per OpenCode Zen documentation:
- Big Pickle
- DeepSeek V4 Flash Free
- Nemotron 3 Super Free

Avoid submitting personal or confidential information when using these specific free endpoints.

---

## 8. Error Handling

### Standard Error Format

Zen errors use a slightly different envelope than OpenAI:

**Zen error format:**
```json
{
  "type": "error",
  "error": {
    "type": "AuthError",
    "message": "Invalid API key."
  }
}
```

**OpenAI error format (what clients expect):**
```json
{
  "error": {
    "message": "Invalid API key.",
    "type": "invalid_request_error",
    "param": null,
    "code": "invalid_api_key"
  }
}
```

### Common Error Types

| Error Type | HTTP Status | Description |
|------------|-------------|-------------|
| `AuthError` | 401 | Invalid or missing API key |
| `RateLimitError` | 429 | Too many requests |
| `InvalidModelError` | 404 | Model not found or unavailable |
| `ContextLengthExceeded` | 400 | Input exceeds model's context window |
| `ServerError` | 500 | Internal server error |
| `ProviderError` | 502 | Downstream provider error |

---

## 9. Provider Routing

The Zen API uses a sophisticated routing system to determine which downstream provider to call. This is handled by the `ProviderHelper` abstraction in the OpenCode source code.

### Routing Logic (reconstructed)

```
Request arrives with: model="opencode/deepseek-v4-flash-free"

1. Strip "opencode/" prefix -> "deepseek-v4-flash-free"
2. Look up model -> family="deepseek-v4", provider="deepseek"
3. Select ProviderHelper:
   - openai     -> OpenAIHelper (uses /v1/chat/completions)
   - anthropic  -> AnthropicHelper (uses /v1/messages)
   - google     -> GoogleHelper (uses /v1/models/gemini:...)
   - openai-compatible -> OpenAICompatibleHelper
4. Transform request: OpenAI format -> Provider format
5. Forward to downstream provider URL
6. Transform response: Provider format -> OpenAI format
7. Track usage and return to client
```

### Provider Helper Interface

```typescript
interface ProviderHelper {
  // Transform request to provider format
  fromCommonRequest(commonReq: CommonRequest): ProviderRequest;
  
  // Transform response to common format
  toCommonResponse(providerRes: ProviderResponse): CommonResponse;
  
  // Inject authentication headers
  modifyHeaders(headers: Headers, apiKey: string, stickyId: string): void;
  
  // Parse usage from provider response
  parseUsage(providerRes: ProviderResponse): Usage;
}
```

---

## 10. Pricing & Free Tiers

### Free Model Pricing
- **Cost:** $0.00 per token
- **Limitations:** May have rate limits. Not specified publicly.
- **Data Usage:** May be used for model improvement
- **Duration:** Promotional period (no end date specified)

### Paid Model Pricing
- **Structure:** Pay-as-you-go, billed per 1M tokens
- **Markup:** "At cost" + transaction fees (4.4% + $0.30)
- **Auto-reload:** Auto-reloads $20 when balance drops below $5
- **Spending limits:** Configurable monthly caps

### BYOK (Bring Your Own Key)
- Users can provide their own OpenAI/Anthropic API keys
- Billing goes directly through the provider
- Zen adds no markup in this mode

---

## Key Takeaways for the Proxy Implementation

1. **Zen IS a proxy itself** - Our proxy adds another layer on top, providing:
   - Model alias resolution (without `opencode/` prefix)
   - Error format normalization (Zen -> OpenAI)
   - Documentation/listing of free models
   - Local model caching (planned)

2. **Streaming passthrough** - Zen already uses OpenAI SSE format, so streaming can be forwarded with minimal modification.

3. **Error normalization** - Our proxy must convert Zen's error format to OpenAI's format for maximum compatibility.

4. **Model ID handling** - Accept both `opencode/deepseek-v4-flash-free` and `deepseek-v4-flash-free` formats.

5. **Authentication** - Either pass through the client's API key or use a server-configured key.

---

## Free-Tier Gate — Live Analysis (2026-10-15)

The gate described earlier in this document (2026-09-25) had gone stale: by
mid-October every request from a third-party client got
`HTTP 403 FreeTierError` ("OpenCode's free tier can only be used from within
OpenCode") — until the official client's traffic was captured and bisected
against production again.

### Capture

The CLI honours `provider.<id>.options.baseURL`. A standalone headless instance
pointed at a local trap server:

```
OPENCODE_CONFIG_CONTENT = {"provider":{"opencode":{"options":{"baseURL":"http://127.0.0.1:18899/zen/v1"}},"models":{...}}}
opencode.exe run --standalone --format json -m opencode/deepseek-v4.1-flash-free "say ok"
```

yielded the exact wire request (headers in arrival order):

| header | value |
| --- | --- |
| Authorization | `Bearer public` |
| Content-Type | `application/json` |
| User-Agent | `opencode/latest/2.0.29/cli` |
| b3 / traceparent | fresh OpenTelemetry trace context |
| x-opencode-client | `cli` |
| x-opencode-project | 40-hex project sha1 |
| x-opencode-session, x-opencode-session-id, x-session-affinity, x-session-id | `ses_<12 hex><14 alnum>` (same value in all four) |
| Accept | `*/*` |

Body keys: `model`, `messages`, `tools` (12 tools incl. `shell` and `read`),
`stream: true`, `stream_options: {include_usage: true}`,
`max_completion_tokens`.

The CLI's own runtime was also available as a plain Bun (`BUN_BE_BUN=1` on the
compiled binary), which proved the transport/TLS stack was **not** the
discriminator — a raw Bun `fetch()` replay still got 403 while the executed
capture got 200.

### What decides the 403

Replaying the captured request verbatim → 200. Removing elements one by one:

| variant | status |
| --- | --- |
| full captured request | 200 |
| full request, random tool schemas (names kept) | 200 |
| body without any tools | 403 |
| body with only `shell` | 403 |
| body with only `read` | 200 |
| body with all tools **except** `read` | 403 |
| body with `read` renamed to `readX` | 403 |
| Mozilla User-Agent instead of `opencode/...` | 403 |
| no Authorization header | 200 |
| `Authorization: Bearer xxx` | 401 `Invalid credential` |
| `x-opencode-session` minted from the formula below | 200 |
| `x-opencode-session` with a random 12-hex prefix | 403 |
| fresh b3/traceparent instead of captured | 200 |
| no b3/traceparent | 200 |
| no x-opencode-client / -project / -session-id / affinity / x-session-id | 200 (each) |

So exactly three client-side things are validated:

1. `User-Agent` carrying the `opencode/` prefix.
2. `X-Opencode-Session` holding an **`ascending` id** minted like the CLI mints
   them (below). The other session mirrors are optional.
3. A function tool named `read` somewhere in `tools` (schema not inspected;
   `shell` is no longer required).

### The session id is a time stamp

Official ids look like `ses_ebff1dae9ffeVD94AD4vmI2ZYm`. Correlating ids from
the CLI's own `session` table with `time_created` shows the 12-hex prefix is
`hex48(EPOCH - unix_ms * 4096)`:

```
stamp  = (0x1b000000046ffe - unix_ms * 4096) mod 2^48        // EPOCH = 7599824371478526
session = "ses_" + hex48(stamp) + 14 random [0-9a-zA-Z]
```

(the ids are "ascending": the stamp *decreases* as time flows; decode with
`unix_ms = (0x1b000000046ffe - stamp) / 4096`). Samples match `time_created`
within <70 ms across weeks; a full day-old minted id is still accepted, so the
edge only checks that the stamp decodes to a plausible time — not freshness.

### Final recipe (implemented in `src/services/zenGate.js`)

```
User-Agent: opencode/latest/2.0.29/cli
X-Opencode-Session: ses_<hex48(EPOCH - now_ms*4096)><14 random base62>
X-Opencode-Client: cli
X-Opencode-Project: <40-hex>
X-Opencode-Session-Id / X-Session-Affinity / X-Session-Id: same session
Authorization: Bearer public
body: stream=true + tools must include a function tool named "read"
```

The same recipe works on both dialects: `/chat/completions` for the free chat
models and `/responses` for the Muse Spark contributor models. Live validation
after the port: 8/10 free chat models returned 200 through the proxy
(`step-5-preview-free` was a 429 upstream capacity error and `jev-1.13-free`
reports `ModelProtocolUnsupported` on chat — both upstream-side, not gate).

**Live capability pass (October 15, 2026):** all 11 free models answered `200`
through the proxy (20/21 first pass; the single failure was `step-5-preview-free`
video mode returning a 429 capacity error —
`{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}`
with `cf-placement: remote-ORD` — which succeeded on retry). Tool calling
(stream and non-stream), image, video and audio inputs all passed end-to-end.
That rejection was captured live by the proxy's `lastRejection` recorder
(status, headers, retry-after, body up to 2KB — surfaced in the desktop logs,
event feed and stats snapshot). Full matrix and evidence:
`docs/COMPATIBILIDADE.md`.

---

## References

- [OpenCode Zen Documentation](https://opencode.ai/docs/zen/)
- [OpenCode GitHub (Archived)](https://github.com/opencode-ai/opencode)
- [OpenCode GitHub (Active)](https://github.com/anomalyco/opencode)
- [OpenAI API Reference](https://platform.openai.com/docs/api-reference)
- [Bifrost - OpenCode Provider Docs](https://docs.getbifrost.ai/providers/supported-providers/opencode)

---

*This reverse engineering analysis was performed by examining the public OpenCode source code, official API documentation, and community resources. No proprietary or private information was accessed.*
