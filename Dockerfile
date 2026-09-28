# API server (server.py) and voice agent (agent.py) share this image; docker-compose.yml picks the command.
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /uvx /bin/

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1

# Dependencies first so code changes don't reinstall them.
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev

COPY app ./app
COPY agent.py server.py ./

ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
# Shell form so $PORT (set by Railway) expands. --host '' binds IPv4 *and* IPv6: Railway's health check
# uses IPv4, private networking uses IPv6, and "::" alone is IPv6-only under asyncio (IPV6_V6ONLY).
CMD ["sh", "-c", "exec uvicorn server:app --host '' --port ${PORT:-8000}"]
