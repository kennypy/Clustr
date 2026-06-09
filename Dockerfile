# ---------------------------------------------------------------------------
# Clustr — Proxmox MCP Server
# Multi-stage build: builder installs locked deps with uv, runtime is minimal.
# Dependencies come from uv.lock via `uv sync --frozen`, so image builds are
# reproducible (no surprise upstream version drift).
# ---------------------------------------------------------------------------

# Stage 1: builder
FROM python:3.11-slim AS builder

# Pinned uv binary (matches the uv version that generated uv.lock)
COPY --from=ghcr.io/astral-sh/uv:0.8.17 /uv /uvx /bin/

WORKDIR /app

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0

# Install runtime deps from the lockfile first (cached layer; project not yet
# copied so changing source doesn't bust the dependency cache).
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-editable

# Install the project itself (README is referenced by pyproject metadata).
COPY src/ ./src/
COPY README.md ./
RUN uv sync --frozen --no-editable

# ---------------------------------------------------------------------------
# Stage 2: runtime
FROM python:3.11-slim AS runtime

WORKDIR /app

# Copy the resolved virtualenv (project + locked deps) from the builder.
COPY --from=builder /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH"

# Non-root user
RUN useradd --create-home --shell /bin/bash clustr
USER clustr

# Default environment (override via docker run -e or docker-compose env_file).
# MCP_HOST=0.0.0.0 binds all interfaces *inside the container* — required so a
# published port can reach it. The container is the isolation boundary: do NOT
# publish this port to a public/LAN address without auth in front. The provided
# docker-compose.yml publishes to 127.0.0.1 only; put a reverse proxy / tunnel
# in front for remote access.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8080 \
    MCP_LOG_LEVEL=INFO \
    OAUTH_ENABLED=false

EXPOSE 8080

# Respects MCP_PORT so an overridden port doesn't silently fail health checks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://localhost:%s/health' % os.environ.get('MCP_PORT', '8080'))"

CMD ["clustr"]
