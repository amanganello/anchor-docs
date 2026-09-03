from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Sequence

import httpx
import pytest
from conftest import FakeProvider, successful_events

from src.config import Settings
from src.main import create_app, stream_chat_events
from src.models import ChatMessage, DoneEvent, TokenEvent, UsageStats
from src.providers import ProviderError


def parse_sse(body: str) -> list[dict[str, object]]:
    return [
        json.loads(block.removeprefix("data: ")) for block in body.strip().split("\n\n")
    ]


def test_stream_serializes_tokens_then_one_done() -> None:
    async def collect() -> list[str]:
        provider = FakeProvider(successful_events())
        return [
            event
            async for event in stream_chat_events(
                provider, [ChatMessage(role="user", content="Hello")]
            )
        ]

    events = [
        json.loads(item.removeprefix("data: ")) for item in asyncio.run(collect())
    ]

    assert [event["type"] for event in events] == ["token", "done"]
    assert sum(event["type"] == "done" for event in events) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("emit_token", [False, True])
async def test_provider_error_is_sanitized_and_terminal(emit_token: bool) -> None:
    events = [TokenEvent(text="partial")] if emit_token else []
    provider = FakeProvider(events, error=ProviderError("private detail"))

    frames = [
        frame
        async for frame in stream_chat_events(
            provider, [ChatMessage(role="user", content="Hello")]
        )
    ]
    payloads = [json.loads(frame.removeprefix("data: ")) for frame in frames]

    assert payloads[-1] == {
        "type": "error",
        "message": "Unable to generate a response right now.",
    }
    assert sum(payload["type"] == "error" for payload in payloads) == 1
    assert not any(payload["type"] == "done" for payload in payloads)


@pytest.mark.asyncio
async def test_missing_provider_terminal_event_becomes_sanitized_error() -> None:
    frames = [
        frame
        async for frame in stream_chat_events(
            FakeProvider([TokenEvent(text="partial")]),
            [ChatMessage(role="user", content="Hello")],
        )
    ]
    payloads = list(map(parse_single_frame, frames))

    assert [payload["type"] for payload in payloads] == ["token", "error"]


class ReusableProvider:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.request_closed = asyncio.Event()
        self.close_calls = 0
        self.request_count = 0

    async def stream_chat(
        self, messages: Sequence[ChatMessage]
    ) -> AsyncIterator[TokenEvent | DoneEvent]:
        self.request_count += 1
        if self.request_count == 1:
            self.started.set()
            try:
                await asyncio.Event().wait()
                yield TokenEvent(text="unreachable")
            finally:
                self.request_closed.set()
            return

        yield TokenEvent(text=messages[-1].content)
        yield DoneEvent(usage=UsageStats(input_tokens=1, output_tokens=1, latency_ms=1))

    async def close(self) -> None:
        self.close_calls += 1


@pytest.mark.asyncio
async def test_cancellation_closes_only_the_request_stream() -> None:
    provider = ReusableProvider()

    async def consume() -> None:
        async for _ in stream_chat_events(
            provider, [ChatMessage(role="user", content="Hello")]
        ):
            pass

    task = asyncio.create_task(consume())
    await asyncio.wait_for(provider.started.wait(), timeout=1)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert provider.request_closed.is_set()
    assert provider.close_calls == 0


@pytest.mark.asyncio
async def test_stop_then_new_request_succeeds() -> None:
    provider = ReusableProvider()

    async def consume_blocked() -> None:
        async for _ in stream_chat_events(
            provider, [ChatMessage(role="user", content="first")]
        ):
            pass

    task = asyncio.create_task(consume_blocked())
    await asyncio.wait_for(provider.started.wait(), timeout=1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    next_frames = [
        frame
        async for frame in stream_chat_events(
            provider,
            [ChatMessage(role="user", content="second")],
        )
    ]

    assert [payload["type"] for payload in map(parse_single_frame, next_frames)] == [
        "token",
        "done",
    ]
    assert provider.request_closed.is_set()
    assert provider.request_count == 2
    assert provider.close_calls == 0


def parse_single_frame(frame: str) -> dict[str, object]:
    return json.loads(frame.removeprefix("data: "))


class ConcurrentProvider:
    def __init__(self) -> None:
        self.active_requests = 0
        self.max_active_requests = 0
        self.both_started = asyncio.Event()

    async def stream_chat(
        self, messages: Sequence[ChatMessage]
    ) -> AsyncIterator[TokenEvent | DoneEvent]:
        self.active_requests += 1
        self.max_active_requests = max(
            self.max_active_requests,
            self.active_requests,
        )
        if self.active_requests == 2:
            self.both_started.set()

        try:
            await self.both_started.wait()
            yield TokenEvent(text=messages[-1].content)
            yield DoneEvent(
                usage=UsageStats(input_tokens=1, output_tokens=1, latency_ms=1)
            )
        finally:
            self.active_requests -= 1

    async def close(self) -> None:
        pass


@pytest.mark.asyncio
async def test_concurrent_streams_are_isolated() -> None:
    provider = ConcurrentProvider()

    async def collect(text: str) -> list[dict[str, object]]:
        frames = [
            frame
            async for frame in stream_chat_events(
                provider,
                [ChatMessage(role="user", content=text)],
            )
        ]
        return list(map(parse_single_frame, frames))

    async with asyncio.timeout(1):
        first, second = await asyncio.gather(collect("first"), collect("second"))

    assert first[0]["text"] == "first"
    assert second[0]["text"] == "second"
    assert provider.max_active_requests == 2


@pytest.mark.asyncio
async def test_http_contract_lifespan_health_and_cors() -> None:
    provider = FakeProvider(successful_events())
    settings = Settings(
        gemini_api_key="test-key",
        cors_origins=["https://allowed.example"],
    )
    app = create_app(settings, provider_factory=lambda _: provider)
    transport = httpx.ASGITransport(app=app)

    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=transport, base_url="http://test") as client,
    ):
        health = await client.get("/health")
        response = await client.post(
            "/chat",
            json={"messages": [{"role": "user", "content": "Hello"}]},
            headers={"Origin": "https://allowed.example"},
        )
        disallowed = await client.post(
            "/chat",
            json={"messages": [{"role": "user", "content": "Hello"}]},
            headers={"Origin": "https://blocked.example"},
        )
        preflight = await client.options(
            "/chat",
            headers={
                "Origin": "https://allowed.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )

    assert health.json() == {"status": "ok"}
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["access-control-allow-origin"] == (
        "https://allowed.example"
    )
    assert [event["type"] for event in parse_sse(response.text)] == [
        "token",
        "done",
    ]
    assert "access-control-allow-origin" not in disallowed.headers
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == (
        "https://allowed.example"
    )
    assert provider.close_calls == 1
