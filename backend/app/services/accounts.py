"""Account provisioning and the sign-in step sequence.

Team OSSC creates accounts (one at a time or by CSV import). Each new or reset
account gets a random temporary password that is shown once, stored only as an
Argon2 hash, and expires. At first sign-in the person must replace it.
Admin-portal roles then enrol (or present) a TOTP second factor.

Step order for a signed-in session (next_step):
  totp            admin role with TOTP already enrolled, not yet verified
                  (checked before a password change so a leaked temporary
                  password alone cannot take over an admin account)
  change_password temporary password still in use
  enrol_totp      admin role without TOTP yet
  done            full access
"""

import secrets
from datetime import timedelta
from typing import Literal

from app.config import get_settings
from app.errors import validation
from app.models.session import UserSession
from app.models.user import User
from app.security.passwords import hash_password, verify_password
from app.security.roles import requires_second_factor
from app.security.sessions import now

Step = Literal["totp", "change_password", "enrol_totp", "done"]

# No look-alike characters (0/O, 1/l/I), so codes survive being read aloud or printed.
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"

COMMON_PASSWORDS = frozenset({
    "password", "password1", "password123", "1234567890", "qwertyuiop", "welcome123", "admin12345",
    "letmein123", "iloveyou12", "abc1234567", "dbit123456", "pcms123456", "changeme12",
})


def generate_temporary_password() -> str:
    """About 70 bits of entropy, formatted for readability: xxxx-xxxx-xxxx."""
    raw = "".join(secrets.choice(_ALPHABET) for _ in range(12))
    return f"{raw[:4]}-{raw[4:8]}-{raw[8:]}"


def temporary_password_fields(password_hash: str) -> dict:
    """Column values for an account holding a freshly issued temporary password."""
    return {
        "password_hash": password_hash,
        "must_change_password": True,
        "temp_password_expires_at": now() + timedelta(days=get_settings().temp_password_days),
    }


def issue_temporary_password(user: User) -> str:
    pw = generate_temporary_password()
    for k, v in temporary_password_fields(hash_password(pw)).items():
        setattr(user, k, v)
    return pw


def temp_password_expired(user: User) -> bool:
    return bool(user.must_change_password and user.temp_password_expires_at and user.temp_password_expires_at < now())


def validate_new_password(password: str, user: User) -> None:
    s = get_settings()
    msg = None
    if len(password) < s.password_min_length:
        msg = f"Use at least {s.password_min_length} characters."
    elif len(password) > 128:
        msg = "Use at most 128 characters."
    elif user.employee_id in password.upper():
        msg = "Do not use your employee ID in your password."
    elif password.lower() in COMMON_PASSWORDS or len(set(password)) < 5:
        msg = "This password is too easy to guess."
    elif user.password_hash and verify_password(user.password_hash, password):
        msg = "Choose a password different from your current one."
    if msg:
        raise validation("Choose a stronger password.", {"newPassword": msg})


def next_step(user: User, sess: UserSession) -> Step:
    admin = requires_second_factor(user.role)
    if admin and user.totp_enabled and not sess.mfa_ok:
        return "totp"
    if user.must_change_password:
        return "change_password"
    if admin and not sess.mfa_ok:
        return "enrol_totp"
    return "done"
