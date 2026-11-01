"""Application settings. All values come from the environment; nothing secret lives in code."""

from functools import lru_cache
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Empty values in the env file mean "not set", so a blank placeholder keeps the default.
    model_config = SettingsConfigDict(env_prefix="PCMS_", extra="ignore", env_ignore_empty=True)

    env: Literal["dev", "test", "prod"] = "dev"
    # Database login (PCMS_DB_*). The connection URL is built from these parts with the
    # password escaped, so any character is safe. PCMS_DATABASE_URL, if set, is used instead.
    database_url: str = ""
    db_host: str = "db"
    db_port: int = 5432
    db_name: str = "pcms"
    db_user: str = "pcms"
    db_password: str = "pcms_dev"
    secret_key: str = Field(default="dev-only-change-me", min_length=16)
    # Encrypts the temporary passwords Team OSSC issues. Keep this separate from
    # secret_key. Chosen passwords are never stored reversibly.
    credential_key: str = Field(default="dev-only-credential-key-change-me", min_length=16)

    # College code used as the token prefix (DB26C0123).
    college_code: str = "DB"
    timezone: str = "Asia/Kolkata"

    # Sessions
    session_cookie: str = "pcms_session"
    csrf_cookie: str = "pcms_csrf"
    session_hours: int = 12
    cookie_secure: bool = False

    # Sign-in throttling: attempts per window per email and per client IP.
    signin_max_attempts: int = 5
    signin_window_seconds: int = 300

    # Password policy and temporary passwords issued by Team OSSC.
    password_min_length: int = 10
    temp_password_days: int = 7
    import_max_rows: int = 1000
    import_max_bytes: int = 1_000_000

    # Web push (VAPID). Generate with: python -m app.cli vapid-keys
    vapid_public_key: str | None = None
    vapid_private_key: str | None = None
    vapid_subject: str = "mailto:facilities@localhost"

    # Media
    media_root: str = "/data/media"
    clamav_host: str = "clamav"
    clamav_port: int = 3310
    clamav_required: bool = True
    public_media_ttl_seconds: int = 600

    # Public URL of the tunnel you run to nginx's public listener (webhooks and signed photos).
    public_base_url: str = "http://localhost:8081"
    # Campus URL people open (used in email links).
    public_app_url: str = "http://localhost:8080"

    # Email
    smtp_host: str = "mailpit"
    smtp_port: int = 1025
    smtp_from: str = "PCMS <pcms@localhost>"
    smtp_starttls: bool = False
    smtp_username: str | None = None
    smtp_password: str | None = None

    # Messaging provider: "twilio" sends for real; "none" disables worker messaging
    # (dispatch by call and job card only); "fake" records sends and is for tests.
    messaging_provider: Literal["fake", "twilio", "none"] = "none"
    twilio_account_sid: str | None = None
    twilio_auth_token: str | None = None
    twilio_whatsapp_from: str | None = None  # e.g. whatsapp:+14155238886
    twilio_sms_from: str | None = None  # E.164 number or a Messaging Service SID (MG...)
    # Content Template Builder SIDs (HX...). Variables: 1 token, 2 type, 3 plan, 4 location, 5 flag.
    twilio_job_content_sid: str | None = None  # twilio/quick-reply: Accept, Done, Need help
    twilio_job_media_content_sid: str | None = None  # twilio/card with media {6} = signed photo token
    twilio_validate_signature: bool = True
    facilities_desk_phone: str | None = None  # shown in SMS fallback

    # Translation of typed text (titles, descriptions, messages, reasons) between English,
    # Kannada and Hindi, done by the worker. "mymemory" is the free public MyMemory API and
    # sends that text to MyMemory; "none" shows only the original; "fake" is for tests.
    translation_provider: Literal["mymemory", "none", "fake"] = "none"
    # Optional contact email for MyMemory: raises its free limit from 5000 to 50000 characters a day.
    translation_email: str | None = None
    # Backup when MyMemory fails or its daily limit is used up: Google Translate through the
    # googletrans-curl library (unofficial endpoint; may stop working). "none" disables the backup.
    translation_fallback: Literal["google", "none"] = "google"

    # Workflow timing

    accept_timeout_minutes: int = 30
    dispute_window_days: int = 7
    verify_reminder_days: int = 2
    auto_close_days: int = 5

    @model_validator(mode="after")
    def _database_url_from_parts(self) -> "Settings":
        if not self.database_url:
            from sqlalchemy.engine import URL

            self.database_url = URL.create(
                "postgresql+asyncpg", username=self.db_user, password=self.db_password,
                host=self.db_host, port=self.db_port, database=self.db_name,
            ).render_as_string(hide_password=False)
        return self

    def check_production(self) -> list[str]:
        """Problems that must block a production start."""
        problems = []
        if self.env != "prod":
            return problems
        if self.secret_key.startswith("dev-") or len(self.secret_key) < 32:
            problems.append("PCMS_SECRET_KEY must be a random value of at least 32 characters")
        if self.credential_key.startswith("dev-") or len(self.credential_key) < 32:
            problems.append("PCMS_CREDENTIAL_KEY must be a random value of at least 32 characters")
        if not self.cookie_secure:
            problems.append("PCMS_COOKIE_SECURE must be true (HTTPS only)")
        from sqlalchemy.engine import make_url

        try:
            db_password = make_url(self.database_url).password
        except Exception:  # noqa: BLE001 - any parse failure is a configuration error
            db_password = None
            problems.append("PCMS_DATABASE_URL is not a valid database URL")
        if not db_password:
            problems.append("PCMS_DB_PASSWORD is not set")
        elif db_password in ("pcms_dev", "CHANGE_ME"):
            problems.append("PCMS_DB_PASSWORD is still the development or placeholder value")
        if not self.clamav_required:
            problems.append("PCMS_CLAMAV_REQUIRED must be true")
        if self.translation_provider == "fake":
            problems.append("PCMS_TRANSLATION_PROVIDER=fake is for tests; use mymemory or none")
        if self.messaging_provider == "fake":
            problems.append("PCMS_MESSAGING_PROVIDER=fake is for tests; use twilio or none")
        if self.messaging_provider == "twilio" and not (self.twilio_account_sid and self.twilio_auth_token):
            problems.append("Twilio credentials are missing")
        return problems


@lru_cache
def get_settings() -> Settings:
    return Settings()
