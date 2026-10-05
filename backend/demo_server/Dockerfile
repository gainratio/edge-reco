# Optional demo API server (search / recommend / products). Build with backend/ as the context; never expose
# the parent OSS workspace (or sibling repositories) to the Docker daemon.

FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_CACHE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH

WORKDIR /app

# Resolve the release-tagged edge-proc/edgeproc-core sources before copying
# application code, preserving Docker's dependency cache without local siblings.
COPY pyproject.toml uv.lock ./
RUN uv sync --no-dev --frozen --no-install-project

COPY src/ src/
COPY demo_server/ demo_server/
COPY examples/keys/public.key examples/keys/public.key
RUN uv sync --no-dev --frozen

# avow (through 0.4.1) ships its own older `assay/` package, and both it and
# assay-engine write site-packages/assay/, so the sync above can leave avow's copy on
# top and `edgereco.reco.formula` fails to import. Reinstall ONLY assay-engine, from
# the lock (hash-checked), as the last sync. Mirrors the Dagger ASSAY_INSTALL step.
RUN uv sync --no-dev --frozen --reinstall-package assay-engine

ENV DEMO_HOST=0.0.0.0 \
    DEMO_PORT=8000 \
    DEMO_CORS_ORIGINS=http://localhost:5174

# The API server builds a query encoder at boot. edge-proc >=0.4.0 never downloads
# the model implicitly, so this demo server opts in to its one-time fetch. That fetch
# is NOT pinned to a model commit; see
# docs/DEPLOY.md#the-server-images-and-the-embedding-model for why and for running
# with a pinned local model (EDGEPROC_MODEL_PATH + EDGEPROC_MODEL_DIGEST) instead.
ENV EDGEPROC_ALLOW_MODEL_DOWNLOAD=1

EXPOSE 8000

CMD ["python", "-m", "demo_server.serve"]
