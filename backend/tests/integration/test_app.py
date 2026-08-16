from __future__ import annotations

import json

import httpx
import pytest
from conftest import FakeProvider, successful_events

from src.config import Settings
from src.main import create_app


@pytest.mark.asyncio
async def test_application_streams_the_phase_one_contract() -> None:
    provider = FakeProvider(successful_events("integrated"))
    app = create_app(
        Settings(gemini_api_key="test-key"),
        provider_factory=lambda _: provider,
    )

    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
        ) as client,
    ):
        response = await client.post(
            "/chat",
            json={"messages": [{"role": "user", "content": "Hello"}]},
        )

    payloads = [
        json.loads(frame.removeprefix("data: "))
        for frame in response.text.strip().split("\n\n")
    ]
    assert payloads[0] == {"type": "token", "text": "integrated"}
    assert payloads[-1]["type"] == "done"
    assert provider.requests[0][0].content == "Hello"
