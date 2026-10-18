"""Outbound channels behind one interface.

Provider calls are made outside database transactions (plan 17). Each returns
a SendResult that tells the outbox worker whether to mark the job sent, retry
it, or stop and ask a person (permanent failure).
"""

import asyncio
import json
import logging
from dataclasses import dataclass, field
from email.message import EmailMessage

from app.config import get_settings

log = logging.getLogger("pcms.providers")


@dataclass
class SendResult:
    ok: bool
    provider_id: str | None = None
    retryable: bool = False
    error: str | None = None
    status_code: int | None = None


@dataclass
class Job:
    """What a provider needs; built by the outbox worker from an outbox row."""

    channel: str
    to: str
    template: str
    payload: dict
    media_url: str | None = None


# ---------- test double ----------

@dataclass
class FakeProvider:
    sent: list[Job] = field(default_factory=list)
    fail_next: list[SendResult] = field(default_factory=list)

    async def send(self, job: Job) -> SendResult:
        if self.fail_next:
            return self.fail_next.pop(0)
        self.sent.append(job)
        return SendResult(ok=True, provider_id=f"SMfake{len(self.sent):026d}")


FAKE = FakeProvider()


# ---------- Twilio (WhatsApp and SMS) ----------

# Twilio error codes that will not succeed on retry (invalid number, not on WhatsApp, opted out...).
PERMANENT_TWILIO = {21211, 21408, 21610, 21612, 21614, 63003, 63024, 63032}


def sms_text(p: dict) -> str:
    s = get_settings()
    desk = f" Call facilities {s.facilities_desk_phone} to accept." if s.facilities_desk_phone else " Call facilities to accept."
    urgency = "Urgent." if p.get("priority") in ("P1", "P2") else "Normal."
    # ASCII only keeps it to one GSM-7 segment where possible (plan 13 cost note).
    text = f"PCMS {p['token']}: {p['plan']}, {p['location']}. Flag {p['flag']}. {urgency}{desk}"
    return text.encode("ascii", "replace").decode()[:300]


class TwilioProvider:
    def __init__(self):
        from twilio.rest import Client

        s = get_settings()
        self.s = s
        self.client = Client(s.twilio_account_sid, s.twilio_auth_token)

    def _callback(self) -> str:
        return self.s.public_base_url.rstrip("/") + "/webhooks/twilio/status"

    def _create(self, job: Job):
        s = self.s
        if job.channel == "whatsapp":
            p = job.payload
            variables = {"1": p["token"], "2": p["plan_type"], "3": p["plan"][:60], "4": p["location"][:80], "5": p["flag"]}
            kwargs = {"from_": s.twilio_whatsapp_from, "to": f"whatsapp:{job.to}", "status_callback": self._callback()}
            if job.template == "job_dispatch" and job.media_url and s.twilio_job_media_content_sid:
                variables["6"] = job.media_url.rsplit("/", 1)[-1]
                kwargs.update(content_sid=s.twilio_job_media_content_sid)
            elif job.template == "job_dispatch" and s.twilio_job_content_sid:
                kwargs.update(content_sid=s.twilio_job_content_sid)
            else:
                raise ValueError("No WhatsApp content template configured for job dispatch")
            kwargs["content_variables"] = json.dumps(variables)
            return self.client.messages.create(**kwargs)
        if job.channel == "sms":
            kwargs = {"to": job.to, "body": sms_text(job.payload), "status_callback": self._callback()}
            if s.twilio_sms_from and s.twilio_sms_from.startswith("MG"):
                kwargs["messaging_service_sid"] = s.twilio_sms_from
            else:
                kwargs["from_"] = s.twilio_sms_from
            return self.client.messages.create(**kwargs)
        raise ValueError(f"unsupported channel {job.channel}")

    async def send(self, job: Job) -> SendResult:
        from twilio.base.exceptions import TwilioRestException

        try:
            msg = await asyncio.to_thread(self._create, job)
            return SendResult(ok=True, provider_id=msg.sid)
        except TwilioRestException as exc:
            permanent = exc.code in PERMANENT_TWILIO or exc.status in (400, 401, 403, 404)
            return SendResult(ok=False, retryable=not permanent, status_code=exc.status,
                              error=f"Twilio {exc.code}: {exc.msg}"[:300])
        except ValueError as exc:
            return SendResult(ok=False, retryable=False, error=str(exc))
        except Exception as exc:  # network, timeout: outcome may be ambiguous
            return SendResult(ok=False, retryable=True, error=f"{type(exc).__name__}: {exc}"[:300])


_twilio: TwilioProvider | None = None


def messaging():
    """The configured provider for WhatsApp/SMS, or None when messaging is off."""
    global _twilio
    mode = get_settings().messaging_provider
    if mode == "fake":
        return FAKE
    if mode == "twilio":
        _twilio = _twilio or TwilioProvider()
        return _twilio
    return None


# ---------- email ----------

async def send_email(to: str, subject: str, body: str) -> SendResult:
    import aiosmtplib

    s = get_settings()
    if s.messaging_provider == "fake":
        FAKE.sent.append(Job("email", to, "email", {"subject": subject, "body": body}))
        return SendResult(ok=True)
    msg = EmailMessage()
    msg["From"] = s.smtp_from
    msg["To"] = to
    msg["Subject"] = subject.replace("\n", " ")[:150]
    msg.set_content(body)
    try:
        await aiosmtplib.send(msg, hostname=s.smtp_host, port=s.smtp_port, start_tls=s.smtp_starttls,
                              username=s.smtp_username, password=s.smtp_password, timeout=20)
        return SendResult(ok=True)
    except aiosmtplib.SMTPRecipientsRefused as exc:
        return SendResult(ok=False, retryable=False, error=str(exc)[:300])
    except Exception as exc:
        return SendResult(ok=False, retryable=True, error=f"{type(exc).__name__}: {exc}"[:300])
