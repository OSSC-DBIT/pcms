"""Same-origin enforcement for the API (DBIT, 2026-11-04: reject every request from outside our domain).

The API sends no CORS headers, so a browser on another site can never read a response.
This middleware also stops another site from *sending* requests that would act on a
signed-in person's cookies, and refuses Host headers that are not ours:

  - Origin, when present, must be one of our origins (PCMS_PUBLIC_APP_URL, plus
    PCMS_ALLOWED_ORIGINS). "null" (sandboxed frames, file pages) is refused.
  - Sec-Fetch-Site, when present, must be "same-origin" or "none".
  - A state-changing request without Origin or Sec-Fetch-Site must not carry a
    foreign Referer.
  - In production the Host header must be one of our hosts (from PCMS_PUBLIC_APP_URL,
    PCMS_ALLOWED_HOSTS, and the container's own name for health checks).

Exempt: health checks only. Outside production, http://localhost and http://127.0.0.1 on any
port are also accepted for development.

This is a pure ASGI middleware so it runs before routing and before any database work.
"""

import json
from urllib.parse import urlsplit

from app.config import Settings, get_settings

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
EXEMPT_PREFIXES = ("/api/v1/health",)
OK_FETCH_SITES = {"same-origin", "none"}
DEV_HOSTS = {"localhost", "127.0.0.1", "[::1]"}


def origin_of(url: str) -> str | None:
    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    default = {"http": 80, "https": 443}[parts.scheme]
    port = parts.port or default
    host = parts.hostname.lower()
    return f"{parts.scheme}://{host}" + ("" if port == default else f":{port}")


def _split(raw: str) -> list[str]:
    return [x.strip() for x in raw.split(",") if x.strip()]


def allowed_origins(s: Settings) -> set[str]:
    found = {origin_of(u) for u in [s.public_app_url, *_split(s.allowed_origins)]}
    return {o for o in found if o}


def allowed_hosts(s: Settings) -> set[str]:
    hosts = {"api", "localhost", "127.0.0.1"}
    h = urlsplit(s.public_app_url).hostname
    if h:
        hosts.add(h.lower())
    hosts.update(h.lower() for h in _split(s.allowed_hosts))
    return hosts


def _is_dev_origin(origin: str) -> bool:
    parts = urlsplit(origin)
    return parts.scheme == "http" and (parts.hostname or "") in {"localhost", "127.0.0.1", "::1"}


class SameOriginMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path: str = scope.get("path", "")
        if path.startswith(EXEMPT_PREFIXES):
            await self.app(scope, receive, send)
            return
        problem = self.check(scope, get_settings())
        if problem:
            await _refuse(send, problem)
            return
        await self.app(scope, receive, send)

    @staticmethod
    def check(scope, s: Settings) -> str | None:
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        method = scope.get("method", "GET").upper()
        prod = s.env == "prod"

        if prod:
            host = (headers.get("host") or "").rsplit(":", 1)[0].strip("[]").lower()
            if host not in allowed_hosts(s):
                return "Unknown host."

        ours = allowed_origins(s)

        def acceptable(origin: str | None) -> bool:
            return origin is not None and (origin in ours or (not prod and _is_dev_origin(origin)))

        raw_origin = headers.get("origin")
        if raw_origin is not None:
            if raw_origin.strip().lower() == "null" or not acceptable(origin_of(raw_origin)):
                return "Requests from other sites are not accepted."

        site = headers.get("sec-fetch-site")
        if site is not None and site.lower() not in OK_FETCH_SITES:
            return "Requests from other sites are not accepted."

        if method not in SAFE_METHODS and raw_origin is None and site is None:
            referer = headers.get("referer")
            if referer and not acceptable(origin_of(referer)):
                return "Requests from other sites are not accepted."
        return None


async def _refuse(send, message: str) -> None:
    body = json.dumps({"code": "cross_origin", "message": message, "field_errors": None, "request_id": None}).encode()
    await send({"type": "http.response.start", "status": 403, "headers": [
        (b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
        (b"cache-control", b"no-store"), (b"vary", b"Origin"),
    ]})
    await send({"type": "http.response.body", "body": body})
