"""Reversible encryption for Team OSSC temporary passwords.

Only the password Team OSSC hands to a person is stored here. It is deleted as
soon as the person chooses their own password. Argon2id remains the only
verification hash; a chosen password is never stored reversibly.
"""

import base64
import binascii
import hashlib
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import get_settings
from app.errors import ApiError

_PREFIX = "v1:"
_NONCE_BYTES = 12


def _key() -> bytes:
    # Any configured string is stretched to the 32 bytes AES-256 needs. The
    # production check still requires a long random value.
    return hashlib.sha256(get_settings().credential_key.encode("utf-8")).digest()


def credential_key_ok() -> bool:
    key = get_settings().credential_key
    return bool(key and len(key) >= 32 and not key.startswith("dev-"))


def encrypt_password(plaintext: str, *, aad: str) -> str:
    nonce = os.urandom(_NONCE_BYTES)
    sealed = AESGCM(_key()).encrypt(nonce, plaintext.encode("utf-8"), aad.encode("utf-8"))
    return _PREFIX + base64.b64encode(nonce + sealed).decode("ascii")


def decrypt_password(token: str, *, aad: str) -> str:
    if not token.startswith(_PREFIX):
        raise _unreadable()
    try:
        raw = base64.b64decode(token[len(_PREFIX):], validate=True)
    except (binascii.Error, ValueError):
        raise _unreadable()
    if len(raw) <= _NONCE_BYTES:
        raise _unreadable()
    try:
        plain = AESGCM(_key()).decrypt(raw[:_NONCE_BYTES], raw[_NONCE_BYTES:], aad.encode("utf-8"))
    except InvalidTag:
        raise _unreadable()
    try:
        return plain.decode("utf-8")
    except UnicodeDecodeError:
        raise _unreadable()


def _unreadable() -> ApiError:
    return ApiError(500, "credential_key_error",
                    "Stored temporary passwords cannot be read. Check PCMS_CREDENTIAL_KEY.")
