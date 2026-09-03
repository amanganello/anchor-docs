# Backend Phase 1 Design — FastAPI Streaming Service

**Goal:** Build the FastAPI backend that streams Gemini responses to the Next.js chat UI via SSE, with no RAG yet. This completes the walking skeleton and unblocks the end-to-end deployment.

**Architecture:** A single FastAPI service in `backend/`, deployed to Cloud Run, receives `POST /chat` from the Next.js proxy, calls Gemini through the `google-genai` SDK, and streams SSE events back. Phase 1 is a direct LLM pass-through: retrieval starts in Phase 3 and tools start in Phase 4.

**Chat provider decision:** Gemini is the Phase 1 chat-generation provider. The model is `gemini-3.6-flash`, documented by Google as a stable, generally available model since July 21, 2026. This decision relies on the public [Gemini 3.6 Flash model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash) and [Gemini API release notes](https://ai.google.dev/gemini-api/docs/changelog), not private SDK constants. Pin `google-genai==2.16.0`; confirm the pinned SDK, Python runtime, and streaming method together by resolving the lockfile and running the live smoke test.

**Dense embedding decision:** Retrieval phases use `gemini-embedding-2` through the separate `EmbeddingProvider` boundary, with `output_dimensionality=768`. Documents use `title: {title} | text: {content}` and queries use `task: question answering | query: {content}`. The provider must reject input above 8,192 tokens before inference and record `max_input_tokens=8192` plus `truncation_policy="error"` in the corpus manifest. This selection does not add embedding work to Phase 1; it fixes the later index dimension and corpus encoding contract. Changing the model, dimension, task format, or encoding version requires full dense-vector regeneration, corpus upsert, and a before/after retrieval evaluation.

`gemini-embedding-2` may aggregate multiple plain inputs supplied directly through `contents=[...]`. Dense ingestion must instead wrap each chunk in a separate Gemini `Content` object or use the Batch API, preserve an explicit chunk-ID mapping, and require exactly one valid 768-value vector per input chunk. Missing, malformed, reordered, or count-mismatched results fail the whole batch rather than risking vectors being attached to the wrong records.

**Tech stack:** Python 3.14, FastAPI, uvicorn, `google-genai`, pydantic-settings, uv, pytest + httpx, Docker, and Cloud Run. `pyproject.toml` must declare `requires-python = ">=3.14,<3.15"`. If dependency resolution or a runtime smoke test demonstrates an incompatibility, stop and document the evidence before changing the repository-wide Python standard.

---

## System Architecture

```text
Next.js proxy (/api/chat)
      │  POST {messages: [{role, content}]}
      │  signal: req.signal forwarded upstream
      ▼
FastAPI /chat
      │
      ├─► Pydantic validation (extra=forbid)
      │
      ├─► GeminiProvider.stream_chat(messages)
      │         │
      │   google-genai request-scoped stream
      │         │
      ◄─── SSE events ────
       token* → done | error
```

Phase 1 emits only `token`, `done`, and `error`. `sources` arrives in Phase 3 and `tool_call` in Phase 4. The Next.js proxy must pass `signal: req.signal` to the upstream `fetch()` so browser cancellation reaches the request-scoped Gemini stream.

---

## Project Structure

```text
backend/
├── pyproject.toml              # sole direct-dependency manifest; Python 3.14
├── uv.lock                     # authoritative, committed lockfile
├── Dockerfile                  # Cloud Run container, port 8080
├── .dockerignore
├── .env.example
├── src/
│   ├── main.py                 # create_app, lifespan, CORS, routes
│   ├── config.py               # Settings + get_settings
│   ├── models.py               # request and SSE schemas
│   └── providers/
│       ├── __init__.py
│       ├── base.py             # LLMProvider and ProviderError
│       └── gemini.py           # provider-specific adapter
└── tests/
    ├── unit/
    │   ├── test_models.py
    │   ├── test_settings.py
    │   ├── test_chat.py
    │   └── providers/test_gemini.py
    ├── integration/test_app.py
    └── smoke/
        ├── test_gemini_live.py
        └── test_deployed_stream.py
```

Do not create or maintain `requirements.txt`. `pyproject.toml` and `uv.lock` are the only dependency sources once the backend is scaffolded.

---

## SSE Event Vocabulary

The event shapes mirror `web/lib/types.ts`. Every opened stream ends with exactly one terminal event, `done` or `error`, unless the client cancels it. Cancellation emits no terminal event because the consumer is gone. No event may follow a terminal event.

Each event uses `data: <JSON>\n\n` framing.

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

from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator

MAX_MESSAGES = 50
MAX_CONTENT_CHARS = 8_000


class ChatMessage(BaseModel):
    model_config = {"extra": "forbid"}

    role: Literal["user", "assistant"]
    content: str = Field(max_length=MAX_CONTENT_CHARS)

    @field_validator("content")
    @classmethod
    def normalize_content(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("content must not be blank")
        return normalized


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

Pydantic enforces the 8,000-character maximum before the validator strips surrounding whitespace. Empty or whitespace-only content, invalid roles, unknown fields, an empty message list, and more than 50 messages all return 422 before SSE begins. The endpoint always streams and the request body has no `stream` field.

---

## Settings and App Construction

`CORS_ORIGINS` has one representation: a JSON array such as `CORS_ORIGINS='["http://localhost:3000"]'`. CSV input is invalid. Keep the field typed as `list[str]` and use pydantic-settings JSON decoding; do not add a CSV parser.

```python
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    gemini_api_key: str
    gemini_model: str = "gemini-3.6-flash"
    cors_origins: list[str] = Field(
        default_factory=lambda: ["http://localhost:3000"]
    )

    model_config = SettingsConfigDict(env_file=".env")


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

Middleware is configured when the application is constructed, not through a request dependency:

```python
def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or get_settings()
    app = FastAPI(lifespan=create_lifespan(resolved_settings))
    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_settings.cors_origins,
        allow_methods=["POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )
    register_routes(app)
    return app


app = create_app()
```

Tests construct `create_app(test_settings)` directly. They do not use `dependency_overrides` to replace settings after middleware exists and do not share cached settings across cases.

CORS is browser response policy, not authentication. A disallowed browser origin receives no `Access-Control-Allow-Origin` header, but curl and server-to-server callers are not blocked by CORS.

---

## Provider Contract (`src/providers/base.py`)

Tools are deliberately absent from Phase 1. A typed tool contract will be introduced with the Phase 4 agent loop.

```python
from collections.abc import AsyncIterator
from typing import Protocol

from src.models import ChatMessage, DoneEvent, TokenEvent


class ProviderError(Exception):
    """Sanitized internal boundary for chat-provider failures."""


class LLMProvider(Protocol):
    def stream_chat(
        self,
        messages: list[ChatMessage],
    ) -> AsyncIterator[TokenEvent | DoneEvent]: ...

    async def close(self) -> None: ...
```

`ProviderError` is internal. It is not serialized directly and its message is never sent to the client.

### Deferred Phase 4 provider extension

Phase 1 keeps the smaller protocol above. When the Phase 4 agent loop is
introduced, extend the provider boundary without moving dispatch into an
adapter:

```python
from collections.abc import AsyncIterator, Sequence

from pydantic import BaseModel, ConfigDict


class ToolDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str
    description: str
    parameters_json_schema: dict[str, object]


class ToolCallRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    call_id: str
    name: str
    arguments: dict[str, object]


class LLMProvider(Protocol):
    def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        *,
        tools: Sequence[ToolDefinition] = (),
    ) -> AsyncIterator[TokenEvent | DoneEvent | ToolCallRequest]: ...

    async def close(self) -> None: ...
```

The empty tuple preserves existing caller behavior without a mutable default;
every provider implementation must still adopt the extended signature in Phase
4. A registered tool owns its Pydantic input model and handler. Derive
`parameters_json_schema` from `input_model.model_json_schema()` so validation
and model guidance cannot drift. Provider adapters receive only neutral
definitions, not handlers, registries, authorization policies, or execution
callbacks, and must reject schema features their SDK cannot represent rather
than silently dropping them.

The Gemini adapter translates `ToolDefinition` to native
`FunctionDeclaration` values and uses native function calling in `AUTO` mode.
Set `automatic_function_calling=AutomaticFunctionCallingConfig(disable=True)`
explicitly and do not pass executable Python functions as tools; the SDK must
never run the application loop. JSON mode is not used for tool routing. Phase 5
adapters perform their own translation from the same neutral contract.

Gemini function-call output is normalized to `ToolCallRequest`. Preserve the
provider call ID when one exists and otherwise assign a stable request-scoped
ID. This internal type is not the public SSE `ToolCallEvent`: the agent loop
emits the UI event only after accepting the registered tool, its arguments, and
applicable policy checks. The initial Phase 4 loop handles one call per model
turn; multiple calls use the same bounded repair path rather than being
executed partially.

Native function schemas are model guidance only. Pydantic revalidates required
fields, types, `extra="forbid"`, normalized non-empty strings, bounds, and
cross-field invariants. The dispatcher and tool implementation separately
enforce dynamic authorization, enabled-tool policy, host and redirect
allowlists, rate limits, and remaining request budgets.

One repair attempt is allowed for repairable model-output failures: an unknown
tool name, malformed call envelope, invalid Pydantic arguments, or an
unsupported parallel-call response. Send a sanitized structured list of field
paths and error codes back to the model, without raw `ValidationError` text or
rejected inputs, and count the retry against the normal iteration and token
caps. Revalidate the repaired call from scratch; a second invalid call ends
gracefully and executes nothing.

Tool execution failures never consume this model-output repair attempt. After
any bounded transient retry inside the tool/client adapter, cancellation,
authorization failures, exhausted budgets or quotas, and operational failures
terminate the loop with exactly one sanitized error.

Phase 4 verification must cover provider-neutral schema translation, rejection
of unsupported schema keywords, explicit disabling of SDK automatic execution,
stable call IDs, and the rule that no handler or public `tool_call` event occurs
before argument and policy acceptance. Agent-loop tests must exercise every
repairable failure category, successful repair, second-invalid-call
termination, sanitized repair feedback, operational failures bypassing model
repair, and iteration/token-cap accounting.

---

## GeminiProvider (`src/providers/gemini.py`)

Design rules:

- Initialize the provider with `api_key` and `model` from `Settings`.
- Map `assistant` messages to Gemini's `model` role inside the adapter.
- Use the pinned SDK's async streaming API. Start with `client.aio.models.generate_content_stream(model=self.model, contents=contents)` and prove it with the live smoke test.
- Do not use private SDK constants to validate model availability.
- Do not send deprecated Gemini 3.6 sampling parameters (`temperature`, `top_p`, or `top_k`).
- Yield `TokenEvent` for non-empty text chunks.
- Yield one `DoneEvent`, defaulting missing usage counters to `0` and measuring latency through terminal emission.
- Translate SDK failures into `ProviderError` using `raise ProviderError(...) from exc`; do not log or emit `ErrorEvent` here.
- In a request generator's `finally`, close only that request's Gemini stream or iterator.
- `close()` releases the shared SDK client and is called only by application shutdown.

The provider iterator type contains only `TokenEvent | DoneEvent`. The SSE route owns public error events.

---

## FastAPI Route and Error Ownership

The lifespan creates one shared `GeminiProvider`, stores it on `app.state`, and calls `provider.close()` exactly once during shutdown. `GET /health` returns `{"status": "ok"}`.

`POST /chat` validates `ChatRequest`, consumes `provider.stream_chat(request.messages)`, and serializes each event. The route is the sole exception-to-SSE boundary:

| Trigger | Response |
|---|---|
| Request validation failure | 422 before the SSE stream opens |
| `ProviderError` before tokens | Log full exception, emit exactly one sanitized `error`, stop |
| `ProviderError` after tokens | Stop token relay, log, emit exactly one sanitized `error`, stop |
| Unexpected internal exception | Log, emit the same sanitized `error`, stop |
| Client cancellation | Close request stream; emit neither `done` nor `error` |

Never expose `str(exception)`, credentials, provider payloads, internal URLs, or authorization headers. Adapters raise typed internal errors; they never create `ErrorEvent`.

`StreamingResponse` must include:

```text
Content-Type: text/event-stream
Cache-Control: no-cache
X-Content-Type-Options: nosniff
```

The response must remain incremental and must not buffer the complete model output.

---

## Cancellation Ownership

```text
browser AbortController
  → api.ts passes signal to fetch("/api/chat")
    → Next.js proxy passes req.signal upstream
      → FastAPI detects disconnect
        → SSE generator is cancelled
          → request-scoped Gemini stream closes in finally
```

The SDK client belongs to the application lifespan, not to an individual request. Cancellation must never call `provider.close()` or affect another request. A Stop followed immediately by a new request must complete normally, and two concurrent streams must remain independent.

---

## Test Strategy

### Unit tests

`tests/unit/test_models.py`:

- missing and empty `messages`;
- 50 and 51 messages;
- empty and whitespace-only content;
- exactly 8,000 and 8,001 characters;
- invalid roles and unknown fields;
- unknown request field including `stream`.

`tests/unit/test_settings.py`:

- JSON array parses correctly;
- CSV input fails clearly;
- test settings can construct isolated app instances.

`tests/unit/providers/test_gemini.py`:

- role mapping and streaming method call;
- token normalization;
- missing `usage_metadata` defaults to zero;
- SDK error becomes `ProviderError` with its cause preserved;
- adapter never yields `ErrorEvent`;
- request stream cleanup does not close the shared client.

`tests/unit/test_chat.py`:

- SSE framing and headers;
- tokens followed by exactly one `done`;
- provider errors before and after partial output produce exactly one sanitized `error` and no `done`;
- cancellation emits no terminal event;
- Stop then new request succeeds;
- concurrent requests remain isolated;
- shutdown closes the shared provider once;
- allowed, disallowed, and preflight CORS behavior;
- `/health` response.

### Integration tests

`tests/integration/test_app.py` starts the actual ASGI application with test settings and a fake provider. Docker validation is a separate command, not a unit test.

### Live smoke tests

`tests/smoke/test_gemini_live.py` is marked `live`, skipped without `GEMINI_API_KEY`, uses exactly `gemini-3.6-flash`, has an explicit timeout, consumes at least one non-empty chunk, and reaches completion. It must not log the key or raw provider metadata.

`tests/smoke/test_deployed_stream.py` targets an explicitly supplied deployed URL and verifies that the first token arrives before the terminal event. ASGITransport alone cannot prove streaming through real proxies.

Phase 2 adds dense embedding verification rather than placing it in the Phase 1
chat suite:

- adapter tests for document and query task formatting;
- exactly 768 values in every returned vector;
- at least two inputs with stable chunk-ID mapping;
- missing, malformed, reordered, and count-mismatched results fail the batch;
- inputs at the configured token boundary are accepted and oversized inputs are
  rejected before the provider call;
- transient provider failures use bounded exponential backoff, while quota and
  validation failures are non-retryable;
- a credential-gated live smoke test calls `gemini-embedding-2` and verifies
  cardinality and dimension without logging document content or credentials;
- changes to model, dimension, task format, or encoding version require a
  before/after retrieval evaluation, or focused manual retrieval checks until
  the eval runner exists.

---

## Dependency and Validation Commands

Once the backend is scaffolded:

```bash
cd backend
uv lock --check
uv sync --locked --dev
uv run ruff check .
uv run ruff format --check .
uv run pyright
uv run pytest tests/unit tests/integration
```

The live provider check is opt-in and consumes provider quota:

```bash
GEMINI_API_KEY=... uv run pytest -m live tests/smoke/test_gemini_live.py
```

Frontend validation is required when changing proxy cancellation or the shared SSE contract:

```bash
cd web
pnpm test
pnpm lint
pnpm build
```

---

## Dockerfile

The implementation must pin uv to an exact version or immutable digest. The initial exact version is `0.5.21`; update it deliberately, together with the lockfile/build verification, rather than using a floating minor tag.

```dockerfile
FROM python:3.14-slim

COPY --from=ghcr.io/astral-sh/uv:0.5.21 /uv /usr/local/bin/uv

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

COPY src/ ./src/
RUN uv sync --locked --no-dev --no-editable

ENV PATH="/app/.venv/bin:$PATH"

RUN adduser --system --no-create-home --group appuser
USER appuser

EXPOSE 8080
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8080"]
```

`CMD` invokes the installed virtualenv executable directly so runtime startup cannot resynchronize dependencies. Add this `.dockerignore`:

```text
.env
.env.*
__pycache__/
*.pyc
*.pyo
.pytest_cache/
.ruff_cache/
.venv/
tests/
```

Validate the actual container separately:

```bash
docker build -t anchor-docs-backend:test backend
docker run --rm -p 8080:8080 \
  -e GEMINI_API_KEY=test-placeholder \
  -e 'CORS_ORIGINS=["http://localhost:3000"]' \
  anchor-docs-backend:test
curl --fail http://localhost:8080/health
```

---

## Cloud Run Deployment

The commands below use placeholders only. Choose the real project, region, repository, service account, service, secret, image, instance limit, and allowed origin at deployment time; never commit them.

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com

gcloud artifacts repositories create REPOSITORY \
  --repository-format=docker \
  --location=REGION

gcloud iam service-accounts create RUNTIME_SERVICE_ACCOUNT

gcloud iam service-accounts add-iam-policy-binding \
  RUNTIME_SERVICE_ACCOUNT@PROJECT_ID.iam.gserviceaccount.com \
  --member=DEPLOYER_PRINCIPAL \
  --role=roles/iam.serviceAccountUser

gcloud secrets add-iam-policy-binding GEMINI_SECRET \
  --member=serviceAccount:RUNTIME_SERVICE_ACCOUNT@PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor

# Print the project's resolved default build identity. Substitute the returned
# email for RESOLVED_BUILD_SERVICE_ACCOUNT in the repository-scoped grant below.
gcloud builds get-default-service-account --project=PROJECT_ID

gcloud artifacts repositories add-iam-policy-binding REPOSITORY \
  --location=REGION \
  --member=serviceAccount:RESOLVED_BUILD_SERVICE_ACCOUNT \
  --role=roles/artifactregistry.writer

gcloud builds submit \
  --tag REGION-docker.pkg.dev/PROJECT_ID/REPOSITORY/IMAGE backend

gcloud run deploy SERVICE \
  --image REGION-docker.pkg.dev/PROJECT_ID/REPOSITORY/IMAGE \
  --region REGION \
  --service-account RUNTIME_SERVICE_ACCOUNT@PROJECT_ID.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --max-instances MAX_INSTANCES \
  --set-secrets GEMINI_API_KEY=GEMINI_SECRET:latest \
  --set-env-vars 'GEMINI_MODEL=gemini-3.6-flash,CORS_ORIGINS=["https://APP_ORIGIN"]'
```

The identities remain separate:

- `DEPLOYER_PRINCIPAL` is the user or automation identity running the commands;
  it receives permission to act as the runtime account but is not the runtime;
- `RESOLVED_BUILD_SERVICE_ACCOUNT` is the exact email printed by
  `gcloud builds get-default-service-account`; it receives Artifact Registry
  Writer only on `REPOSITORY`, and `gcloud builds submit` uses the project's
  default selection without a custom `--service-account` override;
- `RUNTIME_SERVICE_ACCOUNT` runs the Cloud Run container and receives only
  Secret Manager access to `GEMINI_SECRET` in this procedure.

Phase 1 explicitly accepts a temporarily public Cloud Run endpoint. This means any HTTP client can invoke it; CORS, Vercel, and an unpublished URL do not authenticate callers. Before deployment, configure a deliberate instance cap, Gemini account quota, and budget alerts. Alerts do not stop spending. Record authenticated Next.js-to-Cloud-Run access as required hardening before meaningful public traffic.

Deployment checks are separate from unit and Docker tests:

```bash
curl --fail https://SERVICE_URL/health
DEPLOYED_BACKEND_URL=https://SERVICE_URL \
  uv run pytest -m deployed tests/smoke/test_deployed_stream.py
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | yes | — | Inject through Secret Manager in production. |
| `GEMINI_MODEL` | no | `gemini-3.6-flash` | Stable Phase 1 chat model. |
| `CORS_ORIGINS` | no | `["http://localhost:3000"]` | JSON array of browser origins; CSV is invalid. |

---

## Phase Boundary

Phase 1 does not implement Pinecone/RAG, dense embedding generation, `/search`, tools, the agent loop, request-log persistence, `/stats`, or a second chat provider. The dense model is selected here only to make the later index contract deterministic.

Before handoff, run all locally applicable checks and report live, Docker, or deployed checks as not run when their required implementation, credentials, daemon, or deployment does not exist. Always finish with:

```bash
git diff --check
git status --short
```
