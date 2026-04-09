# Builder stage: install dependencies via uv into a venv
FROM python:3.12-slim AS builder

# Copy uv binary from official image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Copy dependency files first to maximise layer cache reuse
COPY pyproject.toml uv.lock ./

# Install production dependencies only into .venv
RUN uv sync --frozen --no-dev

# Runtime stage: lean image with only what's needed to run
FROM python:3.12-slim AS runtime

# Create non-root user before copying anything
RUN groupadd --gid 1000 appuser && \
    useradd --uid 1000 --gid appuser --shell /bin/bash --create-home appuser

WORKDIR /app

# Copy the pre-built venv from builder
COPY --from=builder /app/.venv /app/.venv

# Copy application source
COPY app/ ./app/

# Activate venv by prepending its bin dir to PATH
ENV PATH="/app/.venv/bin:$PATH"
# Disable Python output buffering for structured logs to reach stdout immediately
ENV PYTHONUNBUFFERED=1

# Create writable data directory for SQLite database file
RUN mkdir -p /app/data && chown -R appuser:appuser /app/data

USER appuser

EXPOSE 8000

# Health check using stdlib urllib — no curl dependency required
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/ping')" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
