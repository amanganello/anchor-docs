from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_MESSAGES = 50
MAX_CONTENT_CHARS = 8_000


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    content: str = Field(max_length=MAX_CONTENT_CHARS)

    @field_validator("content")
    @classmethod
    def normalize_content(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("content must not be blank")
        return normalized


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messages: list[ChatMessage] = Field(min_length=1, max_length=MAX_MESSAGES)

    @model_validator(mode="after")
    def validate_turn_order(self) -> Self:
        for previous, current in zip(self.messages, self.messages[1:], strict=False):
            if previous.role == current.role:
                raise ValueError("messages must alternate user and assistant roles")

        if self.messages[-1].role != "user":
            raise ValueError("last message must have role user")

        return self


class TokenEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["token"] = "token"
    text: str


class UsageStats(BaseModel):
    model_config = ConfigDict(extra="forbid")

    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    latency_ms: int = Field(ge=0)


class DoneEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["done"] = "done"
    usage: UsageStats


class ErrorEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["error"] = "error"
    message: str


ChatEvent = Annotated[
    TokenEvent | DoneEvent | ErrorEvent,
    Field(discriminator="type"),
]
