from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from time import perf_counter
from typing import cast

import httpx
import pytest

FIRST_EVENT_TIMEOUT_SECONDS = 15
STREAM_TIMEOUT_SECONDS = 60
MIN_INCREMENTAL_STREAM_SECONDS = 0.1
TERMINAL_EVENT_TYPES = {"done", "error"}


def extract_event_types(buffer: bytes) -> tuple[list[str], bytes]:
    frames = buffer.split(b"\n\n")
    remaining = frames.pop()
    event_types: list[str] = []

    for frame in frames:
        data_lines = [
            line.removeprefix(b"data: ")
            for line in frame.splitlines()
            if line.startswith(b"data: ")
        ]
        if not data_lines:
            continue

        payload: object = json.loads(b"\n".join(data_lines))
        assert isinstance(payload, dict)
        event_type = cast(dict[str, object], payload).get("type")
        assert isinstance(event_type, str)
        event_types.append(event_type)

    return event_types, remaining


async def read_next_event_batch(
    chunks: AsyncIterator[bytes],
    buffer: bytes,
) -> tuple[list[str], bytes]:
    while True:
        buffer += await anext(chunks)
        event_types, buffer = extract_event_types(buffer)
        if event_types:
            return event_types, buffer


def test_extract_event_types_preserves_partial_frames() -> None:
    event_types, remaining = extract_event_types(
        b': keep-alive\n\ndata: {"type":"token","text":"Hi"}\n\ndata: {"type":"done"'
    )

    assert event_types == ["token"]
    assert remaining == b'data: {"type":"done"'


@pytest.mark.deployed
@pytest.mark.asyncio
async def test_deployed_endpoint_streams_before_terminal_event() -> None:
    base_url = os.getenv("DEPLOYED_BACKEND_URL")
    if not base_url:
        pytest.skip("DEPLOYED_BACKEND_URL is not configured")

    async with (
        httpx.AsyncClient(timeout=STREAM_TIMEOUT_SECONDS) as client,
        client.stream(
            "POST",
            f"{base_url.rstrip('/')}/chat",
            json={
                "messages": [
                    {
                        "role": "user",
                        "content": (
                            "Write 200 short numbered lines about web development."
                        ),
                    }
                ]
            },
        ) as response,
    ):
        response.raise_for_status()
        chunks = response.aiter_bytes()
        buffer = b""

        async with asyncio.timeout(FIRST_EVENT_TIMEOUT_SECONDS):
            first_batch, buffer = await read_next_event_batch(chunks, buffer)

        assert first_batch[0] == "token"
        assert not TERMINAL_EVENT_TYPES.intersection(first_batch), (
            "The first network batch contained the terminal event; the deployed "
            "stream may be buffered by an intermediary."
        )

        first_event_at = perf_counter()
        terminal_event_at = first_event_at
        event_types = list(first_batch)
        async with asyncio.timeout(STREAM_TIMEOUT_SECONDS):
            while not TERMINAL_EVENT_TYPES.intersection(event_types):
                batch, buffer = await read_next_event_batch(chunks, buffer)
                event_types.extend(batch)
                terminal_event_at = perf_counter()

    assert event_types[-1] == "done"
    assert terminal_event_at - first_event_at >= MIN_INCREMENTAL_STREAM_SECONDS, (
        "The terminal event arrived immediately after the first token; the deployed "
        "response may have been buffered before transmission."
    )
