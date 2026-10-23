import base64

import pytest

from app.config import Settings, get_settings
from app.errors import ApiError
from app.security.credentials import decrypt_password, encrypt_password


def _tamper(token: str) -> str:
    raw = bytearray(base64.b64decode(token.removeprefix("v1:"), validate=True))
    raw[-1] ^= 1
    return "v1:" + base64.b64encode(raw).decode("ascii")


def test_temporary_password_round_trip():
    token = encrypt_password("Temp-Person-2345", aad="user-id")
    assert token.startswith("v1:")
    assert "Temp-Person-2345" not in token
    assert decrypt_password(token, aad="user-id") == "Temp-Person-2345"
    assert encrypt_password("Temp-Person-2345", aad="user-id") != token  # fresh nonce


def test_temporary_password_needs_the_right_account():
    token = encrypt_password("Temp-Person-2345", aad="user-id")
    with pytest.raises(ApiError, match="cannot be read") as exc:
        decrypt_password(token, aad="another-user")
    assert exc.value.status == 500 and exc.value.code == "credential_key_error"


def test_tampered_temporary_password_is_rejected():
    token = encrypt_password("Temp-Person-2345", aad="user-id")
    with pytest.raises(ApiError) as exc:
        decrypt_password(_tamper(token), aad="user-id")
    assert exc.value.status == 500 and exc.value.code == "credential_key_error"


def test_wrong_credential_key_is_rejected(monkeypatch):
    token = encrypt_password("Temp-Person-2345", aad="user-id")
    monkeypatch.setattr(get_settings(), "credential_key", "a-different-long-credential-key")
    with pytest.raises(ApiError) as exc:
        decrypt_password(token, aad="user-id")
    assert exc.value.status == 500 and exc.value.code == "credential_key_error"


def test_production_requires_a_strong_credential_key():
    common = dict(
        env="prod", secret_key="x" * 40, cookie_secure=True,
        database_url="postgresql+asyncpg://pcms:real@db:5432/pcms",
        clamav_required=True, messaging_provider="none",
    )
    weak = Settings(**common, credential_key="dev-only-credential-key-change-me")
    assert "PCMS_CREDENTIAL_KEY must be a random value of at least 32 characters" in weak.check_production()

    strong = Settings(**common, credential_key="y" * 40)
    assert strong.check_production() == []
