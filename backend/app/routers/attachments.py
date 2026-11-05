"""Evidence upload and download.

POST /api/v1/tickets/{id}/attachments    multipart upload -> 202 (quarantined until scanned)
GET  /api/v1/attachments/{id}/content    authorised download (same visibility as the ticket)

There is no public media link: every file is served only after a permission check.
"""

import re
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.errors import ApiError, forbidden, not_found
from app.models.attachment import Attachment
from app.models.ticket import TERMINAL
from app.schemas.ticket import AttachmentOut
from app.security.deps import Principal, current_principal
from app.services import audit, media
from app.models.user import User
from app.services.tickets import DOCUMENT_EVENT, add_event, document_visible, get_visible

api = APIRouter(tags=["attachments"])

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
                 purpose: Literal["evidence", "document"] = Form("evidence"),
                 p: Principal = Depends(current_principal), db: AsyncSession = Depends(get_session)) -> AttachmentOut:
    """evidence: photos and videos, added only by the person who reported the ticket.
    document: staff files (quotes, bills, reports), added by any staff role (ticket.attach).
    Staff view the reporter's photos and videos but do not add to them (DBIT, 2026-11-01)."""
    t = await get_visible(db, p, ticket_id, lock=True)
    if purpose == "evidence" and t.reporter_id != p.user.id:
        raise forbidden("Only the person who reported this can add photos or videos. Add staff files under Documents.")
    if purpose == "document" and not p.can("ticket.attach"):
        raise forbidden("Only facilities staff can add documents.")
    if t.status in TERMINAL:
        raise ApiError(409, "ticket_closed", "Files cannot be added to a closed ticket.")

    raw = await file.read(media.MAX_VIDEO + 1)
    if len(raw) > media.MAX_VIDEO:
        raise ApiError(413, "too_large", "Files can be at most 20 MB.")
    if not raw:
        raise ApiError(400, "validation", "The file is empty.")

    live = (Attachment.ticket_id == t.id, Attachment.state != "failed")
    counts = dict((await db.execute(select(Attachment.kind, func.count()).where(*live)
                                    .group_by(Attachment.kind))).all())
    used = await db.scalar(select(func.coalesce(func.sum(Attachment.size_bytes), 0)).where(
        *live, Attachment.kind != "document")) or 0
    used_docs = await db.scalar(select(func.coalesce(func.sum(Attachment.size_bytes), 0)).where(
        *live, Attachment.kind == "document")) or 0

    tmp = media.root() / "tmp"
    tmp.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        out = await media.process(raw, tmp, purpose=purpose)
    except media.MediaRejected as exc:
        audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="attachment.rejected", entity_type="ticket",
                     entity_id=t.id, reason=exc.message)
        await db.commit()
        raise ApiError(exc.status, "too_large" if exc.status == 413 else "media_rejected", exc.message)

    if out.kind == "photo" and counts.get("photo", 0) >= media.MAX_PHOTOS:
        raise ApiError(409, "media_limit", "A ticket can have up to 3 photos.")
    if out.kind == "video" and counts.get("video", 0) >= media.MAX_VIDEOS:
        raise ApiError(409, "media_limit", "A ticket can have 1 video.")
    if out.kind == "document":
        if counts.get("document", 0) >= media.MAX_DOCUMENTS:
            raise ApiError(409, "media_limit", f"A ticket can have up to {media.MAX_DOCUMENTS} documents.")
        if used_docs + len(out.data) > media.MAX_DOCUMENTS_TOTAL:
            raise ApiError(413, "too_large", "Documents for one ticket are limited to 50 MB.")
    elif used + len(out.data) > media.MAX_TOTAL:
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
    if att.kind == "document":
        add_event(db, t, p.user, DOCUMENT_EVENT, detail=att.original_name, public=False)
    else:
        add_event(db, t, p.user, "Photo or video added", detail=att.original_name, public=True)
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="attachment.uploaded", entity_type="attachment",
                 entity_id=att.id, after={"ticket": t.token, "kind": att.kind, "bytes": att.size_bytes, "sha256": att.sha256})
    await db.commit()
    return AttachmentOut(id=att.id, kind=att.kind, name=att.original_name, size_bytes=att.size_bytes, state=att.state,
                         uploaded_by=p.user.name, url=f"/api/v1/attachments/{att.id}/content" if att.state == "available" else None)


@api.get("/attachments/{attachment_id}/content")
async def download(attachment_id: uuid.UUID, p: Principal = Depends(current_principal),
                   db: AsyncSession = Depends(get_session)) -> Response:
    att = await db.get(Attachment, attachment_id)
    if att is None:
        raise not_found()
    await get_visible(db, p, att.ticket_id)  # 404 if the ticket is not visible
    if att.state != "available":
        raise not_found()
    if att.kind == "document" and not document_visible(p, att, await db.get(User, att.uploaded_by)):
        raise not_found()  # staff documents are internal; the facility manager's are for the approvers
    path = media.store_path(att.storage_key)
    if not path.exists():
        raise not_found()
    if att.kind == "document":
        # Never rendered by the browser: always saved as a file.
        return FileResponse(path, media_type=att.content_type, headers=SAFE_HEADERS,
                            content_disposition_type="attachment",
                            filename=f"document-{att.id.hex[:8]}.{media.DOCUMENT_TYPES[att.content_type]}")
    ext = {**media.PHOTO_EXT, "video/mp4": "mp4", "video/webm": "webm"}[att.content_type]
    return FileResponse(path, media_type=att.content_type, headers=SAFE_HEADERS,
                        content_disposition_type="inline", filename=f"evidence-{att.id.hex[:8]}.{ext}")
