from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncGenerator, AsyncIterator, Callable, Sequence
from contextlib import asynccontextmanager
from typing import cast

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from src.config import Settings, get_settings
from src.models import ChatMessage, ChatRequest, DoneEvent, ErrorEvent, TokenEvent
from src.providers import GeminiProvider, LLMProvider, ProviderError

logger = logging.getLogger(__name__)

PUBLIC_PROVIDER_ERROR = "Unable to generate a response right now."

ProviderFactory = Callable[[Settings], LLMProvider]


def _default_provider_factory(settings: Settings) -> LLMProvider:
    return GeminiProvider(
        api_key=settings.gemini_api_key,
        model=settings.gemini_model,
    )


def _serialize_sse(event: TokenEvent | DoneEvent | ErrorEvent) -> str:
    return f"data: {event.model_dump_json()}\n\n"


async def _close_iterator(iterator: AsyncIterator[object]) -> None:
    close = getattr(iterator, "aclose", None)
    if close is not None:
        try:
            await close()
        except Exception:
            logger.exception("Failed to close the request-scoped chat stream")


async def stream_chat_events(
    provider: LLMProvider,
    messages: Sequence[ChatMessage],
) -> AsyncIterator[str]:
    iterator = provider.stream_chat(messages)
    terminal_emitted = False

    try:
        async for event in iterator:
            if isinstance(event, DoneEvent):
                terminal_emitted = True
                yield _serialize_sse(event)
                return
            yield _serialize_sse(event)

        if not terminal_emitted:
            logger.error("Chat provider stream ended without a terminal event")
            yield _serialize_sse(ErrorEvent(message=PUBLIC_PROVIDER_ERROR))
    except asyncio.CancelledError:
        raise
    except ProviderError:
        logger.exception("Chat provider stream failed")
        yield _serialize_sse(ErrorEvent(message=PUBLIC_PROVIDER_ERROR))
    except Exception:
        logger.exception("Unexpected chat stream failure")
        yield _serialize_sse(ErrorEvent(message=PUBLIC_PROVIDER_ERROR))
    finally:
        await _close_iterator(cast(AsyncIterator[object], iterator))


def create_app(
    settings: Settings | None = None,
    *,
    provider_factory: ProviderFactory = _default_provider_factory,
) -> FastAPI:
    resolved_settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
        provider = provider_factory(resolved_settings)
        app.state.provider = provider
        try:
            yield
        finally:
            await provider.close()

    app = FastAPI(lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_settings.cors_origins,
        allow_methods=["POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

    async def health() -> dict[str, str]:
        return {"status": "ok"}

    async def chat(payload: ChatRequest) -> StreamingResponse:
        provider = cast(LLMProvider, app.state.provider)
        return StreamingResponse(
            stream_chat_events(provider, payload.messages),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Content-Type-Options": "nosniff",
            },
        )

    app.add_api_route("/health", health, methods=["GET"])
    app.add_api_route(
        "/chat",
        chat,
        methods=["POST"],
        response_class=StreamingResponse,
    )

    return app


app = create_app()
