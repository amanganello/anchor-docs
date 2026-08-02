# Backend Phase 1 Design — FastAPI Streaming Service

**Goal:** Build the FastAPI backend that streams Gemini 2.0 Flash responses to the Next.js chat UI via SSE, with no RAG yet. Completes the walking skeleton and unblocks Vercel deployment.

**Architecture:** Single FastAPI service in `backend/`, deployed to Cloud Run. Receives `POST /chat` from the Next.js proxy, calls Gemini via the `google-genai` SDK, and streams SSE events back. No retrieval, no agent loop — direct LLM pass-through for Phase 1.

**Tech Stack:** Python 3.14, FastAPI, uvicorn, google-genai, pydantic-settings, uv, pytest + httpx, Docker, Cloud Run (GCP).

---

## System Architecture

```
Next.js proxy (/api/chat)
      │  POST {messages: [{role, content}]}
      ▼
FastAPI /chat
      │
      ├─► Pydantic validation (ChatRequest)
      │
      ├─► GeminiProvider.stream_chat(messages)
      │         │
      │   google-genai SDK
      │   GenerativeModel.generate_content_async(stream=True)
      │         │
      ◄─── SSE events ────
       token* → done | error
```

Phase 1 emits only `token`, `done`, and `error` events. `sources` (Phase 3) and `tool_call` (Phase 4) are absent — the frontend handles their absence gracefully.

---

## Project Structure

```
backend/
├── pyproject.toml              # uv-managed, Python 3.14+
├── Dockerfile                  # Cloud Run container, port 8080
├── .env.example                # GEMINI_API_KEY=, CORS_ORIGINS=
├── tests/
│   ├── conftest.py             # pytest fixtures, mocked GeminiProvider
│   └── test_chat.py            # streaming + validation tests
└── src/
    ├── main.py                 # FastAPI app, lifespan, CORS, /chat route
    ├── config.py               # pydantic-settings Settings(BaseSettings)
    ├── models.py               # Pydantic schemas: request + SSE events
    └── providers/
        ├── __init__.py
        ├── base.py             # LLMProvider Protocol
        └── gemini.py           # GeminiProvider — google-genai adapter
```

---

## SSE Event Vocabulary

Mirrors `web/lib/types.ts` exactly. Phase 1 emits a subset:

| Event | Phase | Shape |
|---|---|---|
| `token` | 1 | `{ type: "token", text: str }` |
| `done` | 1 | `{ type: "done", usage: { input_tokens, output_tokens, latency_ms } }` |
| `error` | 1 | `{ type: "error", message: str }` |
| `sources` | 3 | `{ type: "sources", items: [{ title, url, heading }] }` |
| `tool_call` | 4 | `{ type: "tool_call", name: str, args: dict }` |

---

## Pydantic Models (`src/models.py`)

```python
from __future__ import annotations
from typing import Literal, Annotated
from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]


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

---

## Settings (`src/config.py`)

```python
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    gemini_api_key: str
    gemini_model: str = "gemini-2.0-flash"
    cors_origins: list[str] = ["http://localhost:3000"]

    model_config = {"env_file": ".env"}


settings = Settings()
```

`cors_origins` is a comma-separated list in the env var. In production it includes the Vercel deployment URL.

---

## LLMProvider Protocol (`src/providers/base.py`)

```python
from typing import Protocol, Any, AsyncIterator
from src.models import ChatMessage, ChatEvent


class LLMProvider(Protocol):
    async def stream_chat(
        self,
        messages: list[ChatMessage],
        tools: list[Any] = [],
    ) -> AsyncIterator[ChatEvent]: ...
```

`tools` is in the signature from day one so the interface is stable through Phase 4. The Gemini adapter ignores it in Phase 1.

---

## GeminiProvider (`src/providers/gemini.py`)

- Initialised with `api_key` and `model` from `Settings`
- Converts `list[ChatMessage]` to Gemini's `contents` format (role mapping: `assistant` → `model`)
- Calls `client.aio.models.generate_content_stream(model, contents)`
- Yields `TokenEvent` for each text chunk
- Yields `DoneEvent` with token counts from `response.usage_metadata` and elapsed `latency_ms`
- On any exception: yields `ErrorEvent(message=str(e))` and returns

---

## FastAPI App (`src/main.py`)

- `lifespan` context manager initialises `GeminiProvider` once at startup; stores on `app.state`
- `CORSMiddleware` with `settings.cors_origins`, `allow_methods=["POST"]`, `allow_headers=["Content-Type"]`
- `POST /chat` — validates `ChatRequest`, calls `app.state.provider.stream_chat(request.messages)`, returns `StreamingResponse` with `media_type="text/event-stream"`
- Each event serialised as `data: {json}\n\n`
- `GET /health` — returns `{"status": "ok"}` (Cloud Run health check)

---

## Error Handling

| Layer | What | Response |
|---|---|---|
| Pydantic | Missing/malformed `messages` | 422 Unprocessable Entity |
| Provider | Gemini API error | `ErrorEvent` in SSE stream, 200 status |
| Provider | Network timeout | `ErrorEvent` in SSE stream, 200 status |
| CORS | Disallowed origin | 403 before request reaches route |

SSE errors use 200 status with an `error` event so the frontend's stream parser handles them uniformly — a non-200 from the proxy is already handled separately in `web/lib/api.ts`.

---

## Testing (`tests/`)

**`conftest.py`**
- `app_client` fixture: `httpx.AsyncClient` against the FastAPI `app` with `ASGITransport`
- `mock_provider` fixture: replaces `app.state.provider` with a stub that yields a fixed sequence of `TokenEvent`s + `DoneEvent`

**`tests/test_chat.py`**
- `test_streams_tokens` — POST `/chat`, assert `Content-Type: text/event-stream`, collect events, verify ≥1 `token` and exactly 1 `done`
- `test_invalid_request_returns_422` — POST `/chat` with `{}`, assert 422
- `test_health` — GET `/health`, assert 200 + `{"status": "ok"}`
- `test_gemini_error_yields_error_event` — stub raises exception, assert stream contains `ErrorEvent`

---

## Dockerfile

```dockerfile
FROM python:3.14-slim

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml .
RUN uv pip install --system -e .

COPY src/ ./src/

EXPOSE 8080
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8080"]
```

---

## Cloud Run Deployment

```bash
# Enable APIs (one-time)
gcloud services enable run.googleapis.com artifactregistry.googleapis.com

# Build and push
gcloud builds submit --tag gcr.io/PROJECT_ID/anchor-docs-backend

# Deploy
gcloud run deploy anchor-docs-backend \
  --image gcr.io/PROJECT_ID/anchor-docs-backend \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=your-key,CORS_ORIGINS=https://your-app.vercel.app
```

The deployed URL (`https://anchor-docs-backend-xyz-uc.a.run.app`) becomes `FASTAPI_URL` in the Vercel environment, completing the end-to-end path and unblocking Task 9.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | ✅ | — | Google AI Studio API key |
| `GEMINI_MODEL` | ❌ | `gemini-2.0-flash` | Model name |
| `CORS_ORIGINS` | ❌ | `http://localhost:3000` | Comma-separated allowed origins |

---

## What This Phase Does NOT Include

- RAG / Pinecone retrieval (Phase 3)
- Agent loop / tool calling (Phase 4)
- `/search` debug endpoint (Phase 3)
- Request logging / `/stats` (Phase 6)
- Second LLM provider (Phase 5)
