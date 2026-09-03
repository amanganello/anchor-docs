from collections.abc import AsyncIterator, Sequence
from typing import Protocol

from src.models import ChatMessage, DoneEvent, TokenEvent


class ProviderError(Exception):
    """Sanitized internal boundary for chat-provider failures."""


class LLMProvider(Protocol):
    def stream_chat(
        self,
        messages: Sequence[ChatMessage],
    ) -> AsyncIterator[TokenEvent | DoneEvent]: ...

    async def close(self) -> None: ...
