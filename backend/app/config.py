"""Application settings. All values come from the environment; nothing secret lives in code."""

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PCMS_", extra="ignore")

    env: Literal["dev", "test", "prod"] = "dev"
    database_url: str = "postgresql+asyncpg://pcms:pcms_dev@db:5432/pcms"
    secret_key: str = Field(default="dev-only-change-me", min_length=16)

    # College code used as the token prefix (DB26C0123).
    college_code: str = "DB"
    timezone: str = "Asia/Kolkata"

    # Sessions
    session_cookie: str = "pcms_session"
    csrf_cookie: str = "pcms_csrf"
    session_hours: int = 12
    cookie_secure: bool = False

    # Sign-in throttling: attempts per window per employee ID and per client IP.
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

    # Public base URL that Twilio can reach (cloudflared tunnel hostname).
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

    # Workflow timing
    accept_timeout_minutes: int = 30
    dispute_window_days: int = 7
    verify_reminder_days: int = 2
    auto_close_days: int = 5

    def check_production(self) -> list[str]:
        """Problems that must block a production start."""
        problems = []
        if self.env != "prod":
            return problems
        if self.secret_key.startswith("dev-") or len(self.secret_key) < 32:
            problems.append("PCMS_SECRET_KEY must be a random value of at least 32 characters")
        if not self.cookie_secure:
            problems.append("PCMS_COOKIE_SECURE must be true (HTTPS only)")
        if "pcms_dev" in self.database_url:
            problems.append("PCMS_DATABASE_URL uses the development password")
        if not self.clamav_required:
            problems.append("PCMS_CLAMAV_REQUIRED must be true")
        if self.messaging_provider == "fake":
            problems.append("PCMS_MESSAGING_PROVIDER=fake is for tests; use twilio or none")
        if self.messaging_provider == "twilio" and not (self.twilio_account_sid and self.twilio_auth_token):
            problems.append("Twilio credentials are missing")
        return problems


@lru_cache
def get_settings() -> Settings:
    return Settings()
