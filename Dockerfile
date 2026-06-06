# ---------------------------------------------------------------------------
# Clustr — Proxmox MCP Server
# Multi-stage build: builder installs deps, runtime is minimal
# ---------------------------------------------------------------------------

# Stage 1: builder
FROM python:3.11-slim AS builder

WORKDIR /build

# Install build deps
RUN pip install --no-cache-dir hatchling

# Copy only what's needed for dependency resolution first (layer caching)
COPY pyproject.toml ./
COPY src/ ./src/

# Install into a prefix we can copy cleanly
RUN pip install --no-cache-dir --prefix=/install .

# ---------------------------------------------------------------------------
# Stage 2: runtime
FROM python:3.11-slim AS runtime

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Copy source
COPY --from=builder /build/src /app/src

# Proxmox config directory (mount your config.json here)
RUN mkdir -p /app/proxmox-config

# Non-root user
RUN useradd --create-home --shell /bin/bash clustr
USER clustr

# Default environment (override via docker run -e or docker-compose env_file)
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8080 \
    MCP_LOG_LEVEL=INFO \
    OAUTH_ENABLED=false

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')"

CMD ["python", "-m", "clustr.server"]
