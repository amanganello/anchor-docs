from __future__ import annotations

import pytest
from pydantic_settings import SettingsError

from src.config import Settings
from src.main import create_app


def test_cors_origins_parse_from_json(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("CORS_ORIGINS", '["https://one.example","https://two.example"]')

    settings = Settings()  # pyright: ignore[reportCallIssue]

    assert settings.cors_origins == [
        "https://one.example",
        "https://two.example",
    ]


def test_cors_origins_reject_csv(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("CORS_ORIGINS", "https://one.example,https://two.example")

    with pytest.raises(SettingsError):
        Settings()  # pyright: ignore[reportCallIssue]


def test_explicit_settings_construct_isolated_apps() -> None:
    first = create_app(
        Settings(gemini_api_key="first", cors_origins=["https://one.example"])
    )
    second = create_app(
        Settings(gemini_api_key="second", cors_origins=["https://two.example"])
    )

    assert first is not second
