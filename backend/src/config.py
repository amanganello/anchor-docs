from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    gemini_api_key: str = Field(min_length=1, repr=False)
    gemini_model: str = "gemini-3.6-flash"
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()  # pyright: ignore[reportCallIssue]
