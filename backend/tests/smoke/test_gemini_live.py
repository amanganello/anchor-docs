from __future__ import annotations

import asyncio
import os

import pytest

from src.models import ChatMessage, DoneEvent, TokenEvent
from src.providers import GeminiProvider


@pytest.mark.live
@pytest.mark.asyncio
async def test_gemini_live_stream() -> None:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key or api_key == "test-api-key":
        pytest.skip("GEMINI_API_KEY is not configured")

    provider = GeminiProvider(
        api_key=api_key,
        model="gemini-3.6-flash",
    )
    try:
        async with asyncio.timeout(30):
            events = [
                event
                async for event in provider.stream_chat(
                    [ChatMessage(role="user", content="Reply with hello.")]
                )
            ]
    finally:
        await provider.close()

    assert any(isinstance(event, TokenEvent) and event.text for event in events)
    assert isinstance(events[-1], DoneEvent)
