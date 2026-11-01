"""Translate typed text between English, Kannada and Hindi.

  detect_lang()  the script tells the language: Kannada letters, Devanagari (Hindi), else English
  enqueue()      ask for the other two languages of each text (idempotent; own short transaction)
  lookup()       finished translations for a set of texts, for the API responses
  run_once()     worker: translate due rows with the provider, outside any database transaction

Provider (PCMS_TRANSLATION_PROVIDER):
  mymemory  the free public MyMemory API (https://mymemory.translated.net/doc/spec.php).
            Free use is 5000 characters a day, or 50000 with PCMS_TRANSLATION_EMAIL set
            (MyMemory's "de" parameter); queries are at most 500 bytes, so longer text is
            split by sentence. Text is sent to MyMemory, a third party.
  fake      tests: "[kn] original"
  none      no translation; the screens show the original text

Backup (PCMS_TRANSLATION_FALLBACK=google, the default): when MyMemory fails or its daily
limit is used up, the worker tries Google Translate through googletrans-curl. That library
uses Google's unofficial web endpoint (no key, no published limits); Google may change or
block it at any time, so it is only a backup. Text is sent to Google, a third party.
"""

import hashlib
import logging
import re
from datetime import timedelta

import httpx
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import sessionmaker
from app.models.translation import LANGS, TextTranslation
from app.security.sessions import now

log = logging.getLogger("pcms.translate")

MYMEMORY_URL = "https://api.mymemory.translated.net/get"
# MyMemory language codes for its langpair parameter.
MYMEMORY_CODE = {"en": "en-GB", "kn": "kn-IN", "hi": "hi-IN"}
MAX_QUERY_BYTES = 500
MAX_TEXT = 2000
BACKOFF_MINUTES = (1, 10, 60, 360)
BATCH = 10

_KANNADA = re.compile(r"[\u0C80-\u0CFF]")
_DEVANAGARI = re.compile(r"[\u0900-\u097F]")
_LETTER = re.compile(r"[A-Za-z\u0C80-\u0CFF\u0900-\u097F]")


class QuotaExceeded(Exception):
    pass


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def detect_lang(text: str) -> str:
    kn = len(_KANNADA.findall(text))
    hi = len(_DEVANAGARI.findall(text))
    if kn or hi:
        return "kn" if kn >= hi else "hi"
    return "en"


def _worth_translating(text: str | None) -> bool:
    # Tokens, numbers and single words such as "OK" are the same in every language.
    return bool(text) and len(_LETTER.findall(text)) >= 3


def enabled() -> bool:
    return get_settings().translation_provider != "none"


async def enqueue(texts: list[str | None]) -> None:
    """Queue translations for every text into the two languages it is not written in."""
    if not enabled():
        return
    rows = []
    for text in {t.strip() for t in texts if _worth_translating(t)}:
        text = text[:MAX_TEXT]
        src = detect_lang(text)
        rows += [{"source_sha256": sha(text), "source_lang": src, "target": tgt, "source_text": text}
                 for tgt in LANGS if tgt != src]
    if not rows:
        return
    async with sessionmaker()() as db:
        await db.execute(insert(TextTranslation).values(rows).on_conflict_do_nothing(
            constraint="uq_text_translation_source_target"))
        await db.commit()


async def lookup(db: AsyncSession, texts: list[str | None]) -> dict[str, dict[str, str]]:
    """{original text: {language: translation}} for the finished translations of these texts.
    Texts never seen before are queued for the worker, so the next load shows them translated."""
    by_hash = {sha(t.strip()[:MAX_TEXT]): t for t in texts if _worth_translating(t)}
    if not by_hash or not enabled():
        return {}
    out: dict[str, dict[str, str]] = {}
    known: set[str] = set()
    rows = await db.execute(select(TextTranslation.source_sha256, TextTranslation.target, TextTranslation.state,
                                   TextTranslation.translated).where(TextTranslation.source_sha256.in_(by_hash)))
    for h, target, state, translated in rows:
        known.add(h)
        if state == "done":
            out.setdefault(by_hash[h], {})[target] = translated
    if missing := [t for h, t in by_hash.items() if h not in known]:
        await enqueue(missing)
    return out


# ---------- worker side ----------

def _chunks(text: str) -> list[str]:
    """Split on sentence and line ends so every query stays under MyMemory's 500 bytes."""
    parts, cur = [], ""
    for piece in re.split(r"(?<=[.!?\u0964\n])\s*", text):
        while len(piece.encode()) > MAX_QUERY_BYTES:
            cut = MAX_QUERY_BYTES // 4  # 4 bytes is the most a character takes in UTF-8
            parts.append(piece[:cut])
            piece = piece[cut:]
        if len((cur + " " + piece).encode()) > MAX_QUERY_BYTES and cur:
            parts.append(cur)
            cur = piece
        else:
            cur = (cur + " " + piece).strip()
    if cur:
        parts.append(cur)
    return [p for p in parts if p.strip()]


async def _mymemory(client: httpx.AsyncClient, text: str, src: str, tgt: str) -> str:
    params = {"q": text, "langpair": f"{MYMEMORY_CODE[src]}|{MYMEMORY_CODE[tgt]}"}
    if email := get_settings().translation_email:
        params["de"] = email
    r = await client.get(MYMEMORY_URL, params=params)
    r.raise_for_status()
    data = r.json()
    if data.get("quotaFinished") or int(data.get("responseStatus") or 0) == 429:
        raise QuotaExceeded()
    if int(data.get("responseStatus") or 0) != 200:
        raise RuntimeError(f"MyMemory status {data.get('responseStatus')}: {data.get('responseDetails')}")
    out = (data.get("responseData") or {}).get("translatedText") or ""
    if not out.strip():
        raise RuntimeError("empty translation")
    return out


async def _google(text: str, src: str, tgt: str) -> str:
    """Backup provider: Google Translate's unofficial endpoint through googletrans-curl."""
    from googletrans import Translator

    async with Translator(raise_exception=True, timeout=httpx.Timeout(15)) as t:
        out = (await t.translate(text, src=src, dest=tgt)).text
    if not (out or "").strip():
        raise RuntimeError("empty translation")
    return out


async def _primary(text: str, src: str, tgt: str) -> str:
    async with httpx.AsyncClient(timeout=15, headers={"User-Agent": "PCMS"}) as client:
        return " ".join([await _mymemory(client, part, src, tgt) for part in _chunks(text)])


async def translate(text: str, src: str, tgt: str) -> str:
    s = get_settings()
    if s.translation_provider == "fake":
        return f"[{tgt}] {text}"
    try:
        return await _primary(text, src, tgt)
    except Exception as exc:  # noqa: BLE001 - any MyMemory failure, including the daily limit
        if s.translation_fallback != "google":
            raise
        log.info("MyMemory failed (%s); trying the Google backup", type(exc).__name__)
        try:
            return await _google(text, src, tgt)
        except Exception as backup_exc:  # noqa: BLE001
            log.warning("Google backup failed too: %s", backup_exc)
            raise exc from backup_exc


async def run_once(limit: int = BATCH) -> int:
    """Translate due rows. Claims rows by pushing next_attempt_at forward, then calls the provider
    with no transaction open, then stores each result. Returns the number of rows handled."""
    if not enabled():
        return 0
    async with sessionmaker()() as db:
        due = (await db.scalars(select(TextTranslation).where(
            TextTranslation.state == "pending", TextTranslation.next_attempt_at <= now())
            .order_by(TextTranslation.id).limit(limit).with_for_update(skip_locked=True))).all()
        jobs = [(r.id, r.source_text, r.source_lang, r.target, r.attempts) for r in due]
        for r in due:
            r.next_attempt_at = now() + timedelta(minutes=5)  # lease while the provider works
        await db.commit()
    for row_id, text, src, tgt, attempts in jobs:
        values: dict
        try:
            values = {"translated": await translate(text, src, tgt), "state": "done"}
        except QuotaExceeded:
            log.warning("translation quota used up; retrying in an hour")
            async with sessionmaker()() as db:
                await db.execute(update(TextTranslation).where(TextTranslation.id.in_([j[0] for j in jobs]),
                                                               TextTranslation.state == "pending")
                                 .values(next_attempt_at=now() + timedelta(hours=1)))
                await db.commit()
            return len(jobs)
        except Exception as exc:  # noqa: BLE001 - any provider failure is retried, then given up
            log.warning("translation %s failed: %s", row_id, exc)
            n = attempts + 1
            values = ({"state": "failed", "attempts": n} if n > len(BACKOFF_MINUTES)
                      else {"attempts": n, "next_attempt_at": now() + timedelta(minutes=BACKOFF_MINUTES[n - 1])})
        async with sessionmaker()() as db:
            await db.execute(update(TextTranslation).where(TextTranslation.id == row_id)
                             .values(**values, updated_at=now()))
            await db.commit()
    return len(jobs)
