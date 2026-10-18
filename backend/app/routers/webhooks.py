"""Twilio webhooks: the only routes reachable from the internet (via the tunnel).

POST /webhooks/twilio          inbound WhatsApp messages and button taps
POST /webhooks/twilio/status   delivery status callbacks

Every request must carry a valid X-Twilio-Signature computed over the public
URL Twilio called. Events are deduplicated, matched to the assignment through
the message being replied to, and checked against the worker's own number.
A delivered or read status is never treated as acceptance (plan 12.1).
"""

import logging

from fastapi import APIRouter, Request, Response
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from app.config import get_settings
from app.db import sessionmaker
from app.models.outbox import Outbox, ProviderEvent
from app.models.ticket import Ticket
from app.models.worker import Assignment, Worker
from app.security.sessions import now
from app.services import audit, notify, workflow
from app.services.tickets import add_event

log = logging.getLogger("pcms.webhooks")
router = APIRouter(prefix="/webhooks/twilio", include_in_schema=False)

EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
STATUS_TO_DELIVERY = {"queued": "queued", "accepted": "queued", "sending": "queued", "sent": "sent",
                      "delivered": "delivered", "read": "read", "failed": "failed", "undelivered": "failed"}


def _twiml(status: int = 200) -> Response:
    return Response(EMPTY_TWIML, status_code=status, media_type="text/xml")


async def _verified_params(request: Request) -> dict[str, str] | None:
    s = get_settings()
    form = await request.form()
    params = {k: str(v) for k, v in form.multi_items()}
    if not s.twilio_validate_signature:
        return params
    if not s.twilio_auth_token:
        return None
    from twilio.request_validator import RequestValidator

    # Validate against the public URL Twilio used, not the internal one behind the proxy.
    url = s.public_base_url.rstrip("/") + request.url.path + (f"?{request.url.query}" if request.url.query else "")
    sig = request.headers.get("x-twilio-signature", "")
    if not RequestValidator(s.twilio_auth_token).validate(url, params, sig):
        return None
    return params


async def _first_time(db, key: str, kind: str, params: dict) -> bool:
    res = await db.execute(insert(ProviderEvent).values(key=key[:120], kind=kind, payload={
        k: v for k, v in params.items() if k in ("MessageSid", "MessageStatus", "ButtonPayload", "ErrorCode", "OriginalRepliedMessageSid")
    }).on_conflict_do_nothing(index_elements=["key"]))
    return res.rowcount == 1


@router.post("/status")
async def status(request: Request) -> Response:
    params = await _verified_params(request)
    if params is None:
        return _twiml(403)
    sid, st = params.get("MessageSid", ""), params.get("MessageStatus", "").lower()
    if not sid or not st:
        return _twiml()
    async with sessionmaker()() as db:
        if not await _first_time(db, f"status:{sid}:{st}", "status", params):
            await db.commit()
            return _twiml()
        o = await db.scalar(select(Outbox).where(Outbox.provider_id == sid).with_for_update())
        if o is not None:
            o.provider_status = st
            if st in ("failed", "undelivered"):
                o.state = "action_required"
                o.last_error = f"Twilio {st}: error {params.get('ErrorCode', '?')}"
            if o.assignment_id and o.template in ("job_dispatch", "job_fallback") and st in STATUS_TO_DELIVERY:
                a = await db.get(Assignment, o.assignment_id, with_for_update=True)
                # Delivery state only moves forward; it is never acceptance.
                order = ["queued", "sent", "delivered", "read"]
                new = STATUS_TO_DELIVERY[st]
                if a and (new == "failed" or a.delivery not in order or order.index(new) > order.index(a.delivery)):
                    a.delivery = new
                if a and new == "failed":
                    t = await db.get(Ticket, a.ticket_id)
                    w = await db.get(Worker, a.worker_id)
                    add_event(db, t, None, "Message not delivered", detail=f"{w.name}: {o.channel} {st}", public=False)
                    await notify.notify_role(db, "facility_manager", t, template="delivery_failed", key_suffix=f":{sid}",
                                             title=f"{t.token}: message to {w.name} failed", body="Check the number and call the worker.")
        await db.commit()
    return _twiml()


def _intent(params: dict) -> str | None:
    raw = (params.get("ButtonPayload") or params.get("ButtonText") or params.get("Body") or "").strip().lower()
    if raw in ("accept", "accepted", "yes"):
        return "accept"
    if raw in ("done", "completed", "finished"):
        return "done"
    if raw in ("help", "need help", "need_help"):
        return "help"
    return None


@router.post("")
async def inbound(request: Request) -> Response:
    params = await _verified_params(request)
    if params is None:
        return _twiml(403)
    sid = params.get("MessageSid", "")
    intent = _intent(params)
    replied_to = params.get("OriginalRepliedMessageSid", "")
    sender = params.get("From", "").removeprefix("whatsapp:")
    if not sid:
        return _twiml()
    async with sessionmaker()() as db:
        if not await _first_time(db, f"inbound:{sid}", "inbound", params):
            await db.commit()
            return _twiml()
        o = await db.scalar(select(Outbox).where(Outbox.provider_id == replied_to)) if replied_to else None
        a = await db.get(Assignment, o.assignment_id, with_for_update=True) if o and o.assignment_id else None
        w = await db.get(Worker, a.worker_id) if a else None
        if intent is None or a is None or w is None or w.phone_e164 != sender:
            # Unmatched or free text: keep a trace for the manager, change nothing.
            log.info("inbound message not matched to a current assignment (sid=%s)", sid)
            await db.commit()
            return _twiml()
        t = await db.get(Ticket, a.ticket_id, with_for_update=True)
        if a.released_at is not None:
            await db.commit()
            return _twiml()  # stale button from a reassigned job
        if intent == "accept":
            await workflow.accept(db, t, a, via="whatsapp", actor=None, worker=w)
        elif intent == "done" and a.accepted_at is not None and a.done_reported_at is None:
            a.done_reported_at = now()
            add_event(db, t, None, "Worker reported the job done", detail="Done button on WhatsApp; manager to confirm",
                      public=False, delegated_worker=w.name, actor_label=w.name)
            await notify.notify_role(db, "facility_manager", t, template="worker_done", key_suffix=f":{a.id}",
                                     title=f"{t.token}: {w.name} says done", body="Confirm the work and mark it resolved.")
        elif intent == "help":
            add_event(db, t, None, "Worker asked for help", detail="Need help button on WhatsApp", public=False,
                      delegated_worker=w.name, actor_label=w.name)
            await notify.notify_role(db, "facility_manager", t, template="worker_help", key_suffix=f":{sid}",
                                     title=f"{t.token}: {w.name} needs help", body="Call the worker.")
        audit.record(db, actor_id=None, actor_label=f"worker:{w.name}", action=f"whatsapp.{intent}", entity_type="assignment",
                     entity_id=a.id, delegated_worker=w.name)
        await db.commit()
    return _twiml()
