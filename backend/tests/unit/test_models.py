from __future__ import annotations

import pytest
from pydantic import ValidationError

from src.models import ChatMessage, ChatRequest


@pytest.mark.parametrize("messages", [None, []])
def test_request_requires_messages(messages: object) -> None:
    with pytest.raises(ValidationError):
        ChatRequest.model_validate({"messages": messages})


def test_request_accepts_fifty_messages() -> None:
    request = ChatRequest(
        messages=[
            ChatMessage(
                role="assistant" if index % 2 == 0 else "user",
                content="x",
            )
            for index in range(50)
        ]
    )

    assert len(request.messages) == 50


def test_request_rejects_fifty_one_messages() -> None:
    with pytest.raises(ValidationError):
        ChatRequest(messages=[ChatMessage(role="user", content="x") for _ in range(51)])


@pytest.mark.parametrize(
    "messages",
    [
        [
            {"role": "user", "content": "first"},
            {"role": "user", "content": "second"},
        ],
        [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "second"},
        ],
    ],
)
def test_request_rejects_invalid_turn_order(
    messages: list[dict[str, str]],
) -> None:
    with pytest.raises(ValidationError):
        ChatRequest.model_validate({"messages": messages})


@pytest.mark.parametrize("content", ["", " \n\t "])
def test_message_rejects_blank_content(content: str) -> None:
    with pytest.raises(ValidationError):
        ChatMessage(role="user", content=content)


def test_message_content_boundary_is_checked_before_normalization() -> None:
    assert len(ChatMessage(role="user", content="x" * 8_000).content) == 8_000

    with pytest.raises(ValidationError):
        ChatMessage(role="user", content="x" * 8_001)


@pytest.mark.parametrize(
    "payload",
    [
        {"messages": [{"role": "system", "content": "x"}]},
        {"messages": [{"role": "user", "content": "x", "extra": True}]},
        {"messages": [{"role": "user", "content": "x"}], "stream": True},
    ],
)
def test_request_rejects_invalid_roles_and_unknown_fields(
    payload: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        ChatRequest.model_validate(payload)
