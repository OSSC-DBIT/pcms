"""Error envelope {code, message, field_errors, request_id} and request IDs.

The frontend toErr() reads exactly these snake_case keys.
"""

import logging
import uuid
from contextvars import ContextVar

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

log = logging.getLogger("pcms")

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, field_errors: dict[str, str] | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.field_errors = field_errors


def not_found(what: str = "Not found.") -> ApiError:
    return ApiError(404, "not_found", what)


def forbidden(message: str = "You do not have permission for this action.") -> ApiError:
    return ApiError(403, "forbidden", message)


def conflict(code: str, message: str) -> ApiError:
    return ApiError(409, code, message)


def validation(message: str, field_errors: dict[str, str] | None = None) -> ApiError:
    return ApiError(400, "validation", message, field_errors)


def envelope(status: int, code: str, message: str, field_errors: dict[str, str] | None = None) -> JSONResponse:
    rid = request_id_var.get()
    return JSONResponse(
        status_code=status,
        content={"code": code, "message": message, "field_errors": field_errors, "request_id": rid},
        headers={"X-Request-ID": rid},
    )


_HTTP_CODES = {400: "bad_request", 401: "unauthenticated", 403: "forbidden", 404: "not_found",
               405: "method_not_allowed", 409: "conflict", 413: "too_large", 429: "throttled"}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api(_: Request, exc: ApiError):
        return envelope(exc.status, exc.code, exc.message, exc.field_errors)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        fields: dict[str, str] = {}
        for err in exc.errors():
            loc = [str(p) for p in err.get("loc", ()) if p not in ("body", "query", "path")]
            fields[".".join(loc) or "request"] = err.get("msg", "Invalid value")
        return envelope(400, "validation", "Some fields need attention.", fields)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException):
        msg = exc.detail if isinstance(exc.detail, str) else "Request failed."
        return envelope(exc.status_code, _HTTP_CODES.get(exc.status_code, "error"), msg)

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception):
        log.exception("unhandled error request_id=%s", request_id_var.get())
        return envelope(500, "server_error", "Something went wrong. Quote the request ID if you report it.")


class RequestIdMiddleware:
    """Pure ASGI middleware: assigns a request ID and echoes it in X-Request-ID."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        incoming = dict(scope.get("headers") or []).get(b"x-request-id", b"").decode()[:64]
        rid = incoming if incoming and incoming.replace("-", "").isalnum() else uuid.uuid4().hex
        token = request_id_var.set(rid)

        async def _send(message: Message):
            if message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"x-request-id"]
                headers.append((b"x-request-id", rid.encode()))
                message["headers"] = headers
            await send(message)

        try:
            await self.app(scope, receive, _send)
        finally:
            request_id_var.reset(token)
