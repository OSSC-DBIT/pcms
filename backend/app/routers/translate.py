"""Translate text the facility manager is typing, before it is sent (the language buttons under a text box).

Facility manager only (DBIT, 2026-11-01): he is not fluent in English. Other roles get 403.

POST /api/v1/translate  {text, target}  ->  {state: "done", text} or {state: "pending"}

The API has no internet access, so the worker does the translation. The browser asks
again every second or two until it is done. Results are cached, so the same sentence is
translated once. Throttled per person.
"""

from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.errors import ApiError, forbidden
from app.models.session import ThrottleEvent
from app.models.translation import TextTranslation
from app.schemas import CamelModel
from app.security.deps import Principal, current_principal
from app.security.sessions import now
from app.services import translate as svc

router = APIRouter(prefix="/translate", tags=["translate"])

# New texts a person may send for translation per window. Polls for a known text are free.
LIMIT = 40
WINDOW = timedelta(minutes=10)


class TranslateIn(CamelModel):
    text: str = Field(min_length=1, max_length=svc.MAX_TEXT)
    target: Literal["en", "kn", "hi"]


class TranslateOut(CamelModel):
    state: Literal["done", "pending", "same", "unavailable", "failed"]
    text: str | None = None


@router.post("", response_model=TranslateOut)
async def translate_text(body: TranslateIn, p: Principal = Depends(current_principal),
                         db: AsyncSession = Depends(get_session)) -> TranslateOut:
    if p.user.role != "facility_manager":
        raise forbidden("Translation is available to the facility manager.")
    text = body.text.strip()
    if not svc.enabled():
        return TranslateOut(state="unavailable")
    if not svc._worth_translating(text) or svc.detect_lang(text) == body.target:
        return TranslateOut(state="same", text=text)
    row = await db.scalar(select(TextTranslation).where(TextTranslation.source_sha256 == svc.sha(text),
                                                        TextTranslation.target == body.target))
    if row is None:
        key = f"translate:{p.user.id}"
        await db.execute(delete(ThrottleEvent).where(ThrottleEvent.key == key, ThrottleEvent.at < now() - WINDOW))
        if (await db.scalar(select(func.count()).select_from(ThrottleEvent).where(ThrottleEvent.key == key)) or 0) >= LIMIT:
            raise ApiError(429, "throttled", "Too many translations for now. Wait a few minutes and try again.")
        db.add(ThrottleEvent(key=key))
        await db.commit()
        await svc.enqueue([text])
        return TranslateOut(state="pending")
    if row.state == "done":
        return TranslateOut(state="done", text=row.translated)
    return TranslateOut(state="failed" if row.state == "failed" else "pending")
