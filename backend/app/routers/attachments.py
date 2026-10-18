"""Evidence upload and download.

POST /api/v1/tickets/{id}/attachments    multipart upload -> 202 (quarantined until scanned)
GET  /api/v1/attachments/{id}/content    authorised download (same visibility as the ticket)
GET  /media/public/{token}               signed, expiring link used only by Twilio for job photos
"""

import re
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.responses import FileResponse, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.errors import ApiError, forbidden, not_found
from app.models.attachment import Attachment
from app.models.ticket import TERMINAL, Ticket
from app.schemas.ticket import AttachmentOut
from app.security.deps import Principal, current_principal
from app.security.sessions import now
from app.services import audit, media
from app.services.tickets import add_event, get_visible, is_staff

api = APIRouter(tags=["attachments"])
public = APIRouter(tags=["media"], include_in_schema=False)

SAFE_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
}


def _safe_name(name: str | None) -> str:
    base = re.sub(r"[^\w.\- ]", "_", (name or "evidence").rsplit("/", 1)[-1].rsplit("\\", 1)[-1])[:100]
    return base or "evidence"


@api.post("/tickets/{ticket_id}/attachments", response_model=AttachmentOut, status_code=202)
async def upload(ticket_id: uuid.UUID, request: Request, file: UploadFile = File(...),
                 p: Principal = Depends(current_principal), db: AsyncSession = Depends(get_session)) -> AttachmentOut:
    t = await get_visible(db, p, ticket_id, lock=True)
    if not is_staff(p) and t.reporter_id != p.user.id:
        raise forbidden()
    if t.status in TERMINAL:
        raise ApiError(409, "ticket_closed", "Evidence cannot be added to a closed ticket.")

    raw = await file.read(media.MAX_VIDEO + 1)
    if len(raw) > media.MAX_VIDEO:
        raise ApiError(413, "too_large", "Files can be at most 20 MB.")
    if not raw:
        raise ApiError(400, "validation", "The file is empty.")

    counts = dict((await db.execute(select(Attachment.kind, func.count()).where(
        Attachment.ticket_id == t.id, Attachment.state != "failed").group_by(Attachment.kind))).all())
    used = await db.scalar(select(func.coalesce(func.sum(Attachment.size_bytes), 0)).where(
        Attachment.ticket_id == t.id, Attachment.state != "failed")) or 0

    tmp = media.root() / "tmp"
    tmp.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        out = await media.process(raw, tmp)
    except media.MediaRejected as exc:
        audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="attachment.rejected", entity_type="ticket",
                     entity_id=t.id, reason=exc.message)
        await db.commit()
        raise ApiError(exc.status, "too_large" if exc.status == 413 else "media_rejected", exc.message)

    if out.kind == "photo" and counts.get("photo", 0) >= media.MAX_PHOTOS:
        raise ApiError(409, "media_limit", "A ticket can have up to 3 photos.")
    if out.kind == "video" and counts.get("video", 0) >= media.MAX_VIDEOS:
        raise ApiError(409, "media_limit", "A ticket can have 1 video.")
    if used + len(out.data) > media.MAX_TOTAL:
        raise ApiError(413, "too_large", "Evidence for one ticket is limited to 35 MB.")

    key = media.new_key()
    scan = get_settings().clamav_required
    target = media.quarantine_path(key) if scan else media.store_path(key)
    media.write_private(target, out.data)
    att = Attachment(ticket_id=t.id, uploaded_by=p.user.id, kind=out.kind, original_name=_safe_name(file.filename),
                     content_type=out.content_type, size_bytes=len(out.data), sha256=media.sha256(out.data),
                     storage_key=key, state="scanning" if scan else "available", width=out.width, height=out.height,
                     duration_ms=out.duration_ms)
    db.add(att)
    await db.flush()
    add_event(db, t, p.user, "Evidence added", detail=att.original_name, public=True)
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="attachment.uploaded", entity_type="attachment",
                 entity_id=att.id, after={"ticket": t.token, "kind": att.kind, "bytes": att.size_bytes, "sha256": att.sha256})
    await db.commit()
    return AttachmentOut(id=att.id, kind=att.kind, name=att.original_name, size_bytes=att.size_bytes, state=att.state,
                         url=f"/api/v1/attachments/{att.id}/content" if att.state == "available" else None)


@api.get("/attachments/{attachment_id}/content")
async def download(attachment_id: uuid.UUID, p: Principal = Depends(current_principal),
                   db: AsyncSession = Depends(get_session)) -> Response:
    att = await db.get(Attachment, attachment_id)
    if att is None:
        raise not_found()
    await get_visible(db, p, att.ticket_id)  # 404 if the ticket is not visible
    if att.state != "available":
        raise not_found()
    path = media.store_path(att.storage_key)
    if not path.exists():
        raise not_found()
    ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm"}[att.content_type]
    return FileResponse(path, media_type=att.content_type, headers=SAFE_HEADERS,
                        content_disposition_type="inline", filename=f"evidence-{att.id.hex[:8]}.{ext}")


@public.get("/media/public/{token}")
async def public_media(token: str, db: AsyncSession = Depends(get_session)) -> Response:
    att_id = media.verify_public_token(token)
    att = await db.get(Attachment, att_id) if att_id else None
    if att is None or att.state != "available" or att.kind != "photo":
        return Response(status_code=404)
    ticket = await db.get(Ticket, att.ticket_id)
    # Links stop working once the job is finished, even before they expire.
    if ticket is None or ticket.status in TERMINAL or ticket.created_at < now() - timedelta(days=60):
        return Response(status_code=404)
    path = media.store_path(att.storage_key)
    if not path.exists():
        return Response(status_code=404)
    return FileResponse(path, media_type=att.content_type,
                        headers={**SAFE_HEADERS, "Cross-Origin-Resource-Policy": "cross-origin", "Cache-Control": "no-store"})
