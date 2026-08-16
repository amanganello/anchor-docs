from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from contextlib import suppress
from time import perf_counter

from google import genai
from google.genai import types
from google.genai.client import AsyncClient, Client

from src.models import ChatMessage, DoneEvent, TokenEvent, UsageStats
from src.providers.base import ProviderError

DEFAULT_STREAM_TIMEOUT_SECONDS = 60.0


class GeminiProvider:
    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        stream_timeout_seconds: float = DEFAULT_STREAM_TIMEOUT_SECONDS,
        client: Client | None = None,
    ) -> None:
        self.model = model
        self.stream_timeout_seconds = stream_timeout_seconds
        self._client = client or genai.Client(api_key=api_key)
        self._async_client: AsyncClient = self._client.aio
        self._closed = False

    def stream_chat(
        self,
        messages: Sequence[ChatMessage],
    ) -> AsyncIterator[TokenEvent | DoneEvent]:
        return self._stream_chat(messages)

    async def _stream_chat(
        self,
        messages: Sequence[ChatMessage],
    ) -> AsyncIterator[TokenEvent | DoneEvent]:
        started_at = perf_counter()
        stream: AsyncIterator[types.GenerateContentResponse] | None = None
        input_tokens = 0
        output_tokens = 0

        contents = [
            types.Content(
                role="model" if message.role == "assistant" else "user",
                parts=[types.Part(text=message.content)],
            )
            for message in messages
        ]

        try:
            async with asyncio.timeout(self.stream_timeout_seconds):
                stream = await self._async_client.models.generate_content_stream(  # pyright: ignore[reportUnknownMemberType]
                    model=self.model,
                    contents=contents,
                )
                async for chunk in stream:
                    usage = getattr(chunk, "usage_metadata", None)
                    if usage is not None:
                        input_tokens = getattr(usage, "prompt_token_count", None) or 0
                        output_tokens = (
                            getattr(usage, "candidates_token_count", None) or 0
                        )

                    text = getattr(chunk, "text", None)
                    if text:
                        yield TokenEvent(text=text)

                yield DoneEvent(
                    usage=UsageStats(
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        latency_ms=max(
                            0,
                            round((perf_counter() - started_at) * 1_000),
                        ),
                    )
                )
        except asyncio.CancelledError:
            raise
        except TimeoutError as exc:
            raise ProviderError("Gemini streaming request timed out") from exc
        except Exception as exc:
            raise ProviderError("Gemini streaming request failed") from exc
        finally:
            await self._close_request_stream(stream)

    @staticmethod
    async def _close_request_stream(
        stream: AsyncIterator[types.GenerateContentResponse] | None,
    ) -> None:
        if stream is None:
            return
        close = getattr(stream, "aclose", None)
        if close is not None:
            with suppress(Exception):
                await close()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._async_client.aclose()
