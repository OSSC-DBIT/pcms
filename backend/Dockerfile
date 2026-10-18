# syntax=docker/dockerfile:1
FROM python:3.13-slim AS base

COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /uvx /bin/

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    TZ=UTC

# libmagic: real file-type detection; ffmpeg: ffprobe for video validation.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libmagic1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --system --uid 10001 --create-home app \
    && mkdir -p /data/media \
    && chown -R app:app /data

WORKDIR /app
COPY pyproject.toml uv.lock ./

FROM base AS dev
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked
COPY . .
USER app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

FROM base AS prod
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev
COPY . .
USER app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
