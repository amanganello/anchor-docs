from __future__ import annotations

import os
from collections.abc import AsyncIterator, Sequence

os.environ.setdefault("GEMINI_API_KEY", "test-api-key")

from src.models import ChatMessage, DoneEvent, TokenEvent, UsageStats


class FakeProvider:
    def __init__(
        self,
        events: Sequence[TokenEvent | DoneEvent] = (),
        *,
        error: Exception | None = None,
    ) -> None:
        self.events = events
        self.error = error
        self.close_calls = 0
        self.requests: list[list[ChatMessage]] = []

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
    ) -> AsyncIterator[TokenEvent | DoneEvent]:
        self.requests.append(list(messages))
        for event in self.events:
            yield event
        if self.error is not None:
            raise self.error

    async def close(self) -> None:
        self.close_calls += 1


def successful_events(text: str = "Hello") -> list[TokenEvent | DoneEvent]:
    return [
        TokenEvent(text=text),
        DoneEvent(usage=UsageStats(input_tokens=2, output_tokens=1, latency_ms=3)),
    ]
