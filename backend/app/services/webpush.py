"""Web Push (VAPID) delivery to the PWA service worker.

Payloads carry only a short title, body and in-app URL. Never put private
ticket details (internal notes, costs, phone numbers) in a push payload: it
passes through the browser vendor's push service.
"""

import asyncio
import base64
import json
from dataclasses import dataclass

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app.config import get_settings


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def generate_vapid_keys() -> tuple[str, str]:
    """Return (public, private) as base64url strings: uncompressed P-256 point and raw scalar."""
    key = ec.generate_private_key(ec.SECP256R1())
    pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    priv = key.private_numbers().private_value.to_bytes(32, "big")
    return _b64url(pub), _b64url(priv)


def is_configured() -> bool:
    s = get_settings()
    return bool(s.vapid_public_key and s.vapid_private_key)


@dataclass
class PushResult:
    ok: bool
    # True when the push service says the subscription is gone (404/410): delete it.
    gone: bool = False
    retryable: bool = False
    status: int | None = None
    error: str | None = None


def _send_sync(endpoint: str, p256dh: str, auth: str, payload: dict, ttl: int) -> PushResult:
    from pywebpush import WebPushException, webpush

    s = get_settings()
    try:
        resp = webpush(
            subscription_info={"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}},
            data=json.dumps(payload, separators=(",", ":")),
            vapid_private_key=s.vapid_private_key,
            vapid_claims={"sub": s.vapid_subject},
            ttl=ttl,
            timeout=10,
        )
        return PushResult(ok=True, status=getattr(resp, "status_code", None))
    except WebPushException as exc:
        status = exc.response.status_code if exc.response is not None else None
        return PushResult(ok=False, gone=status in (404, 410), retryable=status in (None, 429, 500, 502, 503, 504),
                          status=status, error=str(exc)[:300])
    except Exception as exc:  # network errors
        return PushResult(ok=False, retryable=True, error=f"{type(exc).__name__}: {exc}"[:300])


async def send(endpoint: str, p256dh: str, auth: str, payload: dict, ttl: int = 3600) -> PushResult:
    # pywebpush is synchronous (requests); keep it off the event loop.
    return await asyncio.to_thread(_send_sync, endpoint, p256dh, auth, payload, ttl)
