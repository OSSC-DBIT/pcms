"""PCMS API entry point."""

import logging

from fastapi import FastAPI

from app.config import get_settings
from app.errors import RequestIdMiddleware, install_error_handlers
from app.routers import admin_ops, admin_users, attachments, catalogs, directory, health, push, session, tickets, webhooks

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

API_PREFIX = "/api/v1"


def create_app() -> FastAPI:
    s = get_settings()
    problems = s.check_production()
    if problems:
        raise RuntimeError("unsafe production configuration: " + "; ".join(problems))
    app = FastAPI(
        title="PCMS API",
        version="1.0.0",
        description="Campus maintenance ticketing API for DBIT Bengaluru (plan v1.2, FastAPI implementation).",
        # No interactive docs on any server. The contract lives in openapi/openapi.json
        # (python -m app.cli export-openapi); the JSON route exists only outside production.
        docs_url=None,
        redoc_url=None,
        swagger_ui_oauth2_redirect_url=None,
        openapi_url=None if s.env == "prod" else f"{API_PREFIX}/openapi.json",
    )
    install_error_handlers(app)
    app.add_middleware(RequestIdMiddleware)
    app.include_router(health.router, prefix=API_PREFIX)
    app.include_router(catalogs.router, prefix=API_PREFIX)
    app.include_router(session.router, prefix=API_PREFIX)
    app.include_router(push.router, prefix=API_PREFIX)
    app.include_router(admin_users.router, prefix=API_PREFIX)
    app.include_router(admin_ops.router, prefix=API_PREFIX)
    app.include_router(tickets.router, prefix=API_PREFIX)
    app.include_router(directory.proposals, prefix=API_PREFIX)
    app.include_router(attachments.api, prefix=API_PREFIX)
    app.include_router(attachments.public)
    app.include_router(webhooks.router)
    return app


app = create_app()
