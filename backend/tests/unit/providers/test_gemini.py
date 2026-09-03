from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import cast

import pytest
from google.genai import types
from google.genai.client import Client

from src.models import ChatMessage, DoneEvent, ErrorEvent, TokenEvent
from src.providers import GeminiProvider, ProviderError


class FakeResponseStream:
    def __init__(self, responses: list[types.GenerateContentResponse]) -> None:
        self._responses = responses
        self.closed = False

    def __aiter__(self) -> AsyncIterator[types.GenerateContentResponse]:
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[types.GenerateContentResponse]:
        for response in self._responses:
            yield response

    async def aclose(self) -> None:
        self.closed = True


class BlockingResponseStream(FakeResponseStream):
    def __init__(self) -> None:
        super().__init__([])
        self.started = asyncio.Event()

    async def _iterate(self) -> AsyncIterator[types.GenerateContentResponse]:
        self.started.set()
        await asyncio.Event().wait()
        yield types.GenerateContentResponse()


class FakeModels:
    def __init__(
        self,
        stream: FakeResponseStream | None = None,
        error: Exception | None = None,
    ) -> None:
        self.stream = stream
        self.error = error
        self.calls: list[dict[str, object]] = []

    async def generate_content_stream(self, **kwargs: object) -> FakeResponseStream:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        assert self.stream is not None
        return self.stream


class FakeAsyncClient:
    def __init__(self, models: FakeModels) -> None:
        self.models = models
        self.close_calls = 0

    async def aclose(self) -> None:
        self.close_calls += 1


class FakeClient:
    def __init__(self, async_client: FakeAsyncClient) -> None:
        self.aio = async_client


def make_provider(models: FakeModels) -> tuple[GeminiProvider, FakeAsyncClient]:
    async_client = FakeAsyncClient(models)
    provider = GeminiProvider(
        api_key="test-key",
        model="test-model",
        client=cast(Client, FakeClient(async_client)),
    )
    return provider, async_client


@pytest.mark.asyncio
async def test_maps_roles_streams_tokens_and_defaults_missing_usage() -> None:
    stream = FakeResponseStream(
        [
            types.GenerateContentResponse(
                candidates=[
                    types.Candidate(
                        content=types.Content(parts=[types.Part(text="Hi")])
                    )
                ]
            )
        ]
    )
    models = FakeModels(stream)
    provider, async_client = make_provider(models)

    events = [
        event
        async for event in provider.stream_chat(
            [
                ChatMessage(role="user", content="Question"),
                ChatMessage(role="assistant", content="Earlier answer"),
            ]
        )
    ]

    assert isinstance(events[0], TokenEvent)
    assert events[0].text == "Hi"
    assert isinstance(events[-1], DoneEvent)
    assert events[-1].usage.input_tokens == 0
    assert events[-1].usage.output_tokens == 0
    contents = cast(list[types.Content], models.calls[0]["contents"])
    assert [content.role for content in contents] == ["user", "model"]
    assert stream.closed is True
    assert async_client.close_calls == 0
    assert not any(isinstance(event, ErrorEvent) for event in events)


@pytest.mark.asyncio
async def test_sdk_error_is_wrapped_with_cause() -> None:
    cause = RuntimeError("secret upstream detail")
    provider, _ = make_provider(FakeModels(error=cause))

    with pytest.raises(ProviderError) as error_info:
        async for _ in provider.stream_chat(
            [ChatMessage(role="user", content="Question")]
        ):
            pass

    assert error_info.value.__cause__ is cause


@pytest.mark.asyncio
async def test_cancellation_closes_request_stream_not_shared_client() -> None:
    stream = BlockingResponseStream()
    provider, async_client = make_provider(FakeModels(stream))
    events: list[TokenEvent | DoneEvent] = []

    async def consume() -> None:
        async for event in provider.stream_chat(
            [ChatMessage(role="user", content="Question")]
        ):
            events.append(event)

    task = asyncio.create_task(consume())
    await asyncio.wait_for(stream.started.wait(), timeout=1)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert events == []
    assert stream.closed is True
    assert async_client.close_calls == 0


@pytest.mark.asyncio
async def test_stream_timeout_is_wrapped_and_closes_request_stream() -> None:
    stream = BlockingResponseStream()
    provider = GeminiProvider(
        api_key="test-key",
        model="test-model",
        stream_timeout_seconds=0.01,
        client=cast(Client, FakeClient(FakeAsyncClient(FakeModels(stream)))),
    )

    with pytest.raises(ProviderError) as error_info:
        async for _ in provider.stream_chat(
            [ChatMessage(role="user", content="Question")]
        ):
            pass

    assert isinstance(error_info.value.__cause__, TimeoutError)
    assert stream.closed is True


@pytest.mark.asyncio
async def test_skips_empty_chunks_and_preserves_usage_metadata() -> None:
    usage = types.GenerateContentResponseUsageMetadata(
        prompt_token_count=5,
        candidates_token_count=3,
    )
    stream = FakeResponseStream(
        [
            types.GenerateContentResponse(
                candidates=[
                    types.Candidate(content=types.Content(parts=[types.Part(text="")]))
                ],
                usage_metadata=usage,
            )
        ]
    )
    provider, _ = make_provider(FakeModels(stream))

    events = [
        event
        async for event in provider.stream_chat(
            [ChatMessage(role="user", content="Question")]
        )
    ]

    assert len(events) == 1
    assert isinstance(events[0], DoneEvent)
    assert events[0].usage.input_tokens == 5
    assert events[0].usage.output_tokens == 3
    assert stream.closed is True


@pytest.mark.asyncio
async def test_close_is_idempotent() -> None:
    provider, async_client = make_provider(FakeModels(FakeResponseStream([])))

    await provider.close()
    await provider.close()

    assert async_client.close_calls == 1
