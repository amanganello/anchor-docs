FROM python:3.14-slim

COPY --from=ghcr.io/astral-sh/uv:0.5.21 /uv /usr/local/bin/uv

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

COPY src/ ./src/
RUN uv sync --locked --no-dev --no-editable

ENV PATH="/app/.venv/bin:$PATH"

RUN adduser --system --no-create-home --group appuser
USER appuser

EXPOSE 8080
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8080"]
