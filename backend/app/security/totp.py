"""TOTP second factor for admin-portal roles, plus single-use recovery codes."""

import hashlib
import hmac
import secrets
import time

import pyotp

from app.config import get_settings

ISSUER = "DBIT PCMS"
STEP = 30


def new_secret() -> str:
    return pyotp.random_base32()


def provisioning_uri(secret: str, employee_id: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=employee_id, issuer_name=ISSUER)


def match_step(secret: str, code: str, *, now: float | None = None, window: int = 1) -> int | None:
    """Return the time-step counter the code matches (allowing +/- window), else None."""
    code = code.strip().replace(" ", "")
    if not code.isdigit() or len(code) != 6:
        return None
    t = pyotp.TOTP(secret)
    now = time.time() if now is None else now
    current = int(now // STEP)
    for counter in range(current - window, current + window + 1):
        if hmac.compare_digest(t.generate_otp(counter), code):
            return counter
    return None


def _code_hash(code: str) -> str:
    key = get_settings().secret_key.encode()
    return hmac.new(key, code.strip().lower().encode(), hashlib.sha256).hexdigest()


def new_recovery_codes(n: int = 10) -> tuple[list[str], list[str]]:
    codes = [f"{secrets.token_hex(2)}-{secrets.token_hex(2)}-{secrets.token_hex(2)}" for _ in range(n)]
    return codes, [_code_hash(c) for c in codes]


def consume_recovery_code(hashes: list[str], code: str) -> list[str] | None:
    """Return the remaining hashes if the code matched, else None."""
    h = _code_hash(code)
    for stored in hashes:
        if hmac.compare_digest(stored, h):
            return [x for x in hashes if x != stored]
    return None
