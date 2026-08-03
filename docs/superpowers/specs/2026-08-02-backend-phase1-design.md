# Backend Phase 1 Design — FastAPI Streaming Service

**Goal:** Build the FastAPI backend that streams Gemini responses to the Next.js chat UI via SSE, with no RAG yet. Completes the walking skeleton and unblocks Vercel deployment.

**Architecture:** Single FastAPI service in `backend/`, deployed to Cloud Run. Receives `POST /chat` from the Next.js proxy, calls Gemini via the `google-genai` SDK, and streams SSE events back. No retrieval, no agent loop — direct LLM pass-through for Phase 1.

**Chat Provider Decision:** Gemini is the selected chat-generation provider for Phase 1. Model: `gemini-2.5-flash` (verified stable alias in `google-genai` SDK v1.33.0 `_GEMINI_MODELS_TO_TOKENIZER_NAMES`; async streaming example in official README also uses this alias). Note: `gemini-3.6-flash` was the originally preferred name but does not appear in SDK v1.33.0 documentation — `gemini-2.5-flash` is used instead. Update this decision when `gemini-3.6-flash` or equivalent becomes a documented stable alias. The dense-embedding provider remains undecided and is kept separate from this selection.

**Tech Stack:** Python 3.12 (tested baseline; Python 3.14 support not yet confirmed across `google-genai`, `fastapi`, `pydantic-settings`, and `httpx` — validate all dependency wheels before upgrading), FastAPI, uvicorn, google-genai, pydantic-settings, uv, pytest + httpx, Docker, Cloud Run (GCP).

---

## System Architecture

```
Next.js proxy (/api/chat)
      │  POST {messages: [{role, content}]}
      │  signal: req.signal forwarded to upstream fetch
      ▼
FastAPI /chat
      │
      ├─► Pydantic validation (ChatRequest, extra=forbid)
      │
      ├─► GeminiProvider.stream_chat(messages)
      │         │
      │   google-genai SDK
      │   client.aio.models.generate_content_stream(model, contents)
      │         │
      ◄─── SSE events ────
       token* → done | error
```

Phase 1 emits only `token`, `done`, and `error` events. `sources` (Phase 3) and `tool_call` (Phase 4) are absent — the frontend handles their absence gracefully.

The Next.js proxy **must** pass `signal: req.signal` to its upstream `fetch()` call so that a browser `AbortController` cancel propagates all the way through the chain to Gemini stream teardown.

---

## Project Structure

```
backend/
├── pyproject.toml              # uv-managed, Python 3.12+
├── uv.lock                     # lockfile; committed to source control
├── Dockerfile                  # Cloud Run container, port 8080
├── .dockerignore               # excludes .env, __pycache__, tests, .venv
├── .env.example                # GEMINI_API_KEY=, GEMINI_MODEL=, CORS_ORIGINS=
├── tests/
│   ├── conftest.py             # pytest fixtures, settings override, mock provider
│   └── test_chat.py            # streaming + validation + cancellation + CORS tests
└── src/
    ├── main.py                 # FastAPI app, lifespan, CORS, /chat route
    ├── config.py               # pydantic-settings Settings + get_settings factory
    ├── models.py               # Pydantic schemas: request + SSE events
    └── providers/
        ├── __init__.py
        ├── base.py             # LLMProvider Protocol
        └── gemini.py           # GeminiProvider — google-genai adapter
```

---

## SSE Event Vocabulary

Mirrors `web/lib/types.ts` exactly. Phase 1 emits a subset.

The stream must end with **exactly one** terminal event: either `done` or `error`. No events may be emitted after the terminal event.

Each event is serialised as `data: <JSON>\n\n` (standard SSE framing; one JSON payload per `data:` line; double-newline terminator between events).

| Event | Phase | Shape |
|---|---|---|
| `token` | 1 | `{ type: "token", text: str }` |
| `done` | 1 | `{ type: "done", usage: { input_tokens, output_tokens, latency_ms } }` |
| `error` | 1 | `{ type: "error", message: str }` |
| `sources` | 3 | `{ type: "sources", items: [{ title, url, heading }] }` |
| `tool_call` | 4 | `{ type: "tool_call", name: str, args: dict }` |

`sources` and `tool_call` shapes are documented here for interface stability but are **not emitted in Phase 1**. The frontend already handles their absence.

---

## Pydantic Models (`src/models.py`)

```python
from __future__ import annotations
from typing import Literal, Annotated
from pydantic import BaseModel, Field

MAX_MESSAGES = 50
MAX_CONTENT_CHARS = 8_000


class ChatMessage(BaseModel):
    model_config = {"extra": "forbid"}

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=MAX_CONTENT_CHARS)


class ChatRequest(BaseModel):
    model_config = {"extra": "forbid"}

    messages: list[ChatMessage] = Field(min_length=1, max_length=MAX_MESSAGES)


class TokenEvent(BaseModel):
    type: Literal["token"] = "token"
    text: str


class UsageStats(BaseModel):
    input_tokens: int
    output_tokens: int
    latency_ms: int


class DoneEvent(BaseModel):
    type: Literal["done"] = "done"
    usage: UsageStats


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    message: str


ChatEvent = Annotated[
    TokenEvent | DoneEvent | ErrorEvent,
    Field(discriminator="type"),
]
```

Validation enforced automatically by Pydantic before the route handler runs:

- Unknown fields on `ChatRequest` or `ChatMessage` → 422.
- `messages` list empty or exceeds 50 items → 422.
- `content` blank (`min_length=1`) or exceeds 8 000 characters → 422.
- `role` not `"user"` or `"assistant"` → 422.

The `/chat` endpoint always streams. There is no `stream` field in the request body.

---

## Settings (`src/config.py`)

```python
from __future__ import annotations
from functools import lru_cache
import json

from pydantic import field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    gemini_api_key: str
    gemini_model: str = "gemini-2.5-flash"
    cors_origins: list[str] = ["http://localhost:3000"]

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, v: str | list[str]) -> list[str]:
        """Accept a JSON array string ('["a","b"]') or comma-separated string ('a,b')."""
        if isinstance(v, list):
            return v
        stripped = v.strip()
        if stripped.startswith("["):
            return json.loads(stripped)
        return [o.strip() for o in stripped.split(",") if o.strip()]

    model_config = {"env_file": ".env"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

`Settings()` is **never** constructed at module import time. Routes receive it via `Depends(get_settings)`. Tests inject overrides through `app.dependency_overrides[get_settings]` and call `get_settings.cache_clear()` between cases to avoid cross-test contamination.

`CORS_ORIGINS` accepts either a JSON array string (`'["https://example.com"]'`) or a comma-separated list (`"https://a.com,https://b.com"`). Both formats are tested. The `parse_cors_origins` validator is the single source of truth; do not rely on Pydantic's built-in coercion for this.

**CORS vs authentication:** CORS middleware is a browser security mechanism — it prevents a browser from reading a response from a disallowed origin. It does not restrict server-to-server requests or curl. The normal Next.js API route → FastAPI call is server-to-server, carries no `Origin` header, and is unaffected by CORS configuration. A browser request from a disallowed origin receives a response without the `Access-Control-Allow-Origin` header; the *browser* then blocks the response client-side. FastAPI does not return HTTP 403 for disallowed origins.

---

## LLMProvider Protocol (`src/providers/base.py`)

```python
from __future__ import annotations
from typing import Protocol, AsyncIterator, Sequence
from src.models import ChatMessage, ChatEvent


class LLMProvider(Protocol):
    async def stream_chat(
        self,
        messages: list[ChatMessage],
        tools: Sequence[object] | None = None,
    ) -> AsyncIterator[ChatEvent]: ...

    async def close(self) -> None: ...
```

`tools` is `None` in Phase 1 — the Gemini adapter ignores it. Using `Sequence[object] | None` with a default of `None` avoids the mutable-default footgun (`list[Any] = []` is not permitted here). The `close()` method lets the lifespan manager release the underlying SDK client on shutdown.

---

## GeminiProvider (`src/providers/gemini.py`)

Design rules:

- Initialised with `api_key` and `model` from `Settings`.
- Converts `list[ChatMessage]` to Gemini's `contents` format (role mapping: `assistant` → `model`).
- Calls `client.aio.models.generate_content_stream(model=self.model, contents=contents)` — the current `google-genai` async streaming API (SDK ≥ 1.0).
- Yields `TokenEvent` for each text chunk.
- Yields `DoneEvent` with token counts from `response.usage_metadata` and elapsed `latency_ms`:
  - If `usage_metadata` is `None` or any field is absent, default those integer fields to `0`.
  - Latency is measured from when the stream is opened to when the terminal event is emitted.
- On any exception: **log the full exception server-side** (stack trace, provider details) and yield `ErrorEvent(message="Provider error — see server logs")`. Never expose `str(exception)`, credentials, provider error payloads, or internal endpoint URLs to clients.
- After emitting `done` or `error`: return immediately. Do not emit further events.
- On client disconnect / generator cancellation: cancel the Gemini stream and close the SDK connection promptly. Do not yield further events.
- `close()` calls the underlying SDK client's close/cleanup method to release connections on service shutdown.

The obsolete API `GenerativeModel.generate_content_async(stream=True)` must **not** appear anywhere in implementation or tests. The current SDK exposes streaming through `client.aio.models.generate_content_stream(model=..., contents=...)`.

---

## FastAPI App (`src/main.py`)

- `lifespan` context manager calls `get_settings()`, initialises `GeminiProvider` once at startup, stores on `app.state`; on shutdown, awaits `app.state.provider.close()`.
- `CORSMiddleware` configured with `settings.cors_origins`, `allow_methods=["POST", "OPTIONS"]`, `allow_headers=["Content-Type"]`.
- `POST /chat` — validates `ChatRequest`, calls `app.state.provider.stream_chat(request.messages)`, returns `StreamingResponse`.
- Each event serialised as `data: {json}\n\n`.
- `GET /health` — returns `{"status": "ok"}` (Cloud Run health check).

`StreamingResponse` must include these headers:
```
Content-Type: text/event-stream
Cache-Control: no-cache
X-Content-Type-Options: nosniff
```

The response body must not be buffered. Events are flushed incrementally as yielded by the provider. Latency is measured end-to-end through the terminal event.

---

## Error Handling

| Layer | Trigger | Response |
|---|---|---|
| Pydantic | Missing/malformed `messages`, blank content, too many messages, oversized content, unknown fields | 422 Unprocessable Entity (before SSE stream opens) |
| SSE route | Provider raises before first token | Route catches, logs full error server-side, emits one sanitized `error` event, stops |
| SSE route | Provider raises after partial output | Stops token relay, emits one sanitized `error` event, stops |
| Client disconnect | Browser aborts / Next.js proxy cancels | Provider generator cancelled; Gemini stream closed; no further events |

**Error ownership:** Provider adapters raise typed internal exceptions. The SSE route is the single owner that converts exceptions to `error` events. Adapters must not swallow exceptions silently. `str(exception)` must never reach the client.

SSE errors use 200 status with an `error` event so the frontend's stream parser handles them uniformly — non-200 responses from the proxy are handled separately in `web/lib/api.ts`.

---

## Cancellation Chain

```
browser AbortController
  → api.ts passes signal to fetch("/api/chat")
    → Next.js proxy passes req.signal to fetch(fastapiUrl + "/chat")
      → FastAPI detects client disconnect
        → async generator cancelled
          → Gemini stream closed and SDK client released
```

The Next.js proxy (`web/app/api/chat/route.ts`) must pass `signal: req.signal` to its upstream `fetch()` call. Without this link, a browser abort does not propagate to the Gemini stream.

A Stop followed immediately by a new request must not stall the new stream: each request uses an independent generator and AbortController. Cleanup of a cancelled generator must not block or alter the state of any subsequent request's generator.

---

## Testing (`tests/`)

**`conftest.py`**
- `app_client` fixture: `httpx.AsyncClient` against the FastAPI `app` with `ASGITransport`; overrides `get_settings` via `app.dependency_overrides` to inject test settings without requiring a real API key.
- `mock_provider` fixture: replaces `app.state.provider` with a stub that yields a controlled sequence of `TokenEvent`s and `DoneEvent`.

**`tests/test_chat.py`** — required test coverage:

| Test | Assertion |
|---|---|
| `test_streams_tokens` | POST `/chat`; `Content-Type: text/event-stream`; ≥1 `token` event; **exactly 1** `done` event |
| `test_missing_messages_key` | POST `{}` → 422 |
| `test_empty_messages_list` | POST `{"messages": []}` → 422 |
| `test_blank_content` | POST `{"messages": [{"role":"user","content":""}]}` → 422 |
| `test_too_many_messages` | POST with 51 messages → 422 |
| `test_oversized_content` | POST message with 8 001-character content → 422 |
| `test_unknown_field_on_message` | POST `{"messages":[{"role":"user","content":"hi","extra":1}]}` → 422 |
| `test_unknown_field_on_request` | POST `{"messages":[...],"stream":true}` → 422 |
| `test_sse_framing` | Each raw event line starts with `data: ` and ends with `\n\n` |
| `test_provider_error_before_tokens` | Stub raises before yielding any token → stream contains exactly one `error` event; message is the sanitized public string, not `str(exception)` |
| `test_provider_error_after_partial_output` | Stub yields 2 tokens then raises → 2 `token` events followed by exactly one `error` event |
| `test_missing_usage_metadata` | Stub omits usage metadata → `done.usage` has `input_tokens=0, output_tokens=0` |
| `test_client_disconnect_stops_provider` | Cancel generator mid-stream; assert provider iterator advances no further after disconnect |
| `test_stop_then_new_request` | Cancel one request; immediately POST a new one; assert new stream completes normally |
| `test_health` | GET `/health` → 200 + `{"status": "ok"}` |
| `test_cors_allowed_origin` | POST with allowed `Origin` header → `Access-Control-Allow-Origin` present in response |
| `test_cors_disallowed_origin` | POST with disallowed `Origin` header → `Access-Control-Allow-Origin` absent; response still 200 |
| `test_cors_preflight` | OPTIONS with valid `Origin` and `Access-Control-Request-Method` → 200 with CORS headers |
| `test_settings_cors_json_string` | `CORS_ORIGINS='["http://localhost:3000"]'` → parsed as single-item list |
| `test_settings_cors_comma_separated` | `CORS_ORIGINS='http://localhost:3000,http://localhost:4000'` → parsed as two-item list |
| `test_docker_startup` | Build image, run container, GET `/health` → 200 (integration test, not unit) |
| `test_incremental_streaming_through_proxy` | Deploy service; confirm first token arrives before stream completes — `ASGITransport` alone does not prove incremental delivery through real proxies |

---

## Dockerfile

```dockerfile
FROM python:3.12-slim

# Pin the uv version explicitly; update deliberately when upgrading
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /usr/local/bin/uv

WORKDIR /app

# Copy lockfile before source to exploit layer caching
# Installation fails if uv.lock is out of date (--frozen)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

# Copy source after installing dependencies (no editable install in production)
COPY src/ ./src/

# Run as a non-root user
RUN adduser --system --no-create-home --group appuser
USER appuser

EXPOSE 8080
CMD ["uv", "run", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8080"]
```

Add `backend/.dockerignore`:
```
.env
.env.*
__pycache__/
*.pyc
*.pyo
.pytest_cache/
tests/
.venv/
```

**uv version:** The `0.5` tag above pins to a minor version; pin to a specific patch (e.g., `0.5.21`) once the version in use is confirmed. Check the [uv releases page](https://github.com/astral-sh/uv/releases) and update this Dockerfile deliberately.

**Python version:** The image is pinned to `3.12-slim`. Upgrade to `3.14-slim` only after verifying all runtime dependencies (`google-genai`, `fastapi`, `pydantic-settings`, `uvicorn`, `httpx`) publish 3.14-compatible wheels. Align `pyproject.toml` `requires-python` with this image tag.

---

## Cloud Run Deployment

```bash
# Enable APIs (one-time)
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com

# Store the Gemini API key as a secret (one-time)
# Do NOT pass the key value in --set-env-vars
printf '%s' "$GEMINI_API_KEY" | \
  gcloud secrets create gemini-api-key --data-file=-

# Build and push (replace YOUR_PROJECT_ID with your GCP project ID)
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/anchor-docs-backend

# Deploy
gcloud run deploy anchor-docs-backend \
  --image gcr.io/YOUR_PROJECT_ID/anchor-docs-backend \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest \
  --set-env-vars 'CORS_ORIGINS=["https://your-app.vercel.app"]'
```

Replace `YOUR_PROJECT_ID` and `your-app.vercel.app` with actual values at deploy time. Do not commit real project IDs or production URLs to source control.

**`--allow-unauthenticated` security note:** This makes the Cloud Run endpoint publicly reachable without authentication. CORS middleware enforces browser-origin policy only; it does not restrict server-to-server or curl access. For Phase 1 the service is obscured by an unpublished URL only. For production: add Cloud Run IAM authentication and route all traffic through the Next.js proxy, or explicitly accept the public-API risk and document it.

The deployed URL becomes `FASTAPI_URL` in the Vercel environment, completing the end-to-end streaming path.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | ✅ | — | Google AI Studio API key. **In production inject via `--set-secrets`, not `--set-env-vars`.** |
| `GEMINI_MODEL` | ❌ | `gemini-2.5-flash` | Gemini model alias. Verified stable in google-genai SDK v1.33.0. |
| `CORS_ORIGINS` | ❌ | `["http://localhost:3000"]` | Allowed browser origins. Accepts JSON array string or comma-separated list — see `Settings.parse_cors_origins`. |

---

## What This Phase Does NOT Include

- RAG / Pinecone retrieval (Phase 3)
- Agent loop / tool calling (Phase 4)
- `/search` debug endpoint (Phase 3)
- Request logging / `/stats` (Phase 6)
- Second LLM provider (Phase 5)
- Dense-embedding provider selection (deferred; kept separate from chat-generation decision)
