"""FastAPI application factory."""

from __future__ import annotations

from fastapi import FastAPI

from edgereco.api.routes import catalog, health, recommend, search


def create_app(container: object | None = None) -> FastAPI:
    app = FastAPI(title="EdgeReco", version="0.1.0")

    if container is not None:
        app.state.container = container

    app.include_router(health.router)
    app.include_router(search.router)
    app.include_router(recommend.router)
    app.include_router(catalog.router)

    return app
