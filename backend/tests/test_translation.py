"""Typed text is translated between English, Kannada and Hindi (DBIT, 2026-11-01).

The tests use the fake provider ("[kn] text"). The real provider is MyMemory, called only by the worker.
"""

import httpx
import pytest
from sqlalchemy import func, select

from app.config import get_settings
from app.db import sessionmaker
from app.models import TextTranslation
from app.services import translate
from tests.factories import API, make_user, new_client, sign_in, ticket_body


def test_language_is_detected_from_the_script():
    assert translate.detect_lang("Fan not working in room 204") == "en"
    assert translate.detect_lang("ಫ್ಯಾನ್ ಕೆಲಸ ಮಾಡುತ್ತಿಲ್ಲ") == "kn"
    assert translate.detect_lang("पंखा काम नहीं कर रहा") == "hi"
    assert translate.detect_lang("Room 204: ಫ್ಯಾನ್ ಕೆಲಸ ಮಾಡುತ್ತಿಲ್ಲ") == "kn"


def test_long_text_is_split_under_the_query_limit():
    text = ("ಫ್ಯಾನ್ ಕೆಲಸ ಮಾಡುತ್ತಿಲ್ಲ. " * 40).strip()
    parts = translate._chunks(text)
    assert len(parts) > 1 and all(len(p.encode()) <= translate.MAX_QUERY_BYTES for p in parts)
    assert "".join(parts).replace(" ", "") == text.replace(" ", "")


async def test_ticket_text_is_translated_for_the_facility_manager_only(client):
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    await make_user("manager@dbit.edu", "facility_manager", "Manager")
    fac = await sign_in(client, "faculty@dbit.edu")
    body = ticket_body()
    body.update(title="ಫ್ಯಾನ್ ಕೆಲಸ ಮಾಡುತ್ತಿಲ್ಲ", description="Room 204 fan stopped this morning")
    tid = (await fac.post(f"{API}/tickets", json=body)).json()["id"]

    async with new_client() as mc:
        mgr = await sign_in(mc, "manager@dbit.edu")
        first = (await mgr.get(f"{API}/tickets/{tid}")).json()
        assert first["translations"] == {}  # queued, not yet translated
        assert await translate.run_once(limit=50) > 0
        r = await mgr.post(f"{API}/tickets/{tid}/comments", json={"body": "ನಾಳೆ ಎಲೆಕ್ಟ್ರಿಷಿಯನ್ ಬರುತ್ತಾರೆ"})
        await translate.run_once(limit=50)
        t = (await mgr.get(f"{API}/tickets/{tid}")).json()
        tr = t["translations"]
        assert tr["ಫ್ಯಾನ್ ಕೆಲಸ ಮಾಡುತ್ತಿಲ್ಲ"] == {"en": "[en] ಫ್ಯಾನ್ ಕೆಲಸ ಮಾಡುತ್ತಿಲ್ಲ", "hi": "[hi] ಫ್ಯಾನ್ ಕೆಲಸ ಮಾಡುತ್ತಿಲ್ಲ"}
        assert set(tr["Room 204 fan stopped this morning"]) == {"kn", "hi"}
        assert set(tr["ನಾಳೆ ಎಲೆಕ್ಟ್ರಿಷಿಯನ್ ಬರುತ್ತಾರೆ"]) == {"en", "hi"}
        # The original text is never replaced.
        assert t["title"] == "ಫ್ಯಾನ್ ಕೆಲಸ ಮಾಡುತ್ತಿಲ್ಲ" and r.status_code == 200

        queue = (await mgr.get(f"{API}/tickets", params={"scope": "queue"})).json()["items"]
        assert set(queue[0]["translations"]["ಫ್ಯಾನ್ ಕೆಲಸ ಮಾಡುತ್ತಿಲ್ಲ"]) == {"en", "hi"}

    # Translations are for the facility manager only; everyone else reads the text as written.
    assert (await fac.get(f"{API}/tickets/{tid}")).json()["translations"] == {}
    assert all(i["translations"] == {} for i in (await fac.get(f"{API}/tickets")).json()["items"])
    await make_user("principal@dbit.edu", "principal", "Principal")
    async with new_client() as pc:
        prin = await sign_in(pc, "principal@dbit.edu")
        assert (await prin.get(f"{API}/tickets/{tid}")).json()["translations"] == {}
        assert all(i["translations"] == {} for i in (await prin.get(f"{API}/tickets", params={"scope": "queue"})).json()["items"])


async def test_the_same_text_is_translated_once(client):
    await translate.enqueue(["Broken chair near the window"] * 3)
    await translate.enqueue(["Broken chair near the window"])
    async with sessionmaker()() as db:
        assert await db.scalar(select(func.count()).select_from(TextTranslation)) == 2  # kn and hi


async def test_provider_failures_retry_then_give_up(client, monkeypatch):
    await translate.enqueue(["Projector lamp is flickering"])

    async def broken(text, src, tgt):
        raise RuntimeError("network down")

    monkeypatch.setattr(translate, "translate", broken)
    await translate.run_once()
    async with sessionmaker()() as db:
        rows = (await db.scalars(select(TextTranslation))).all()
    assert all(r.state == "pending" and r.attempts == 1 and r.translated is None for r in rows)


async def test_mymemory_request_and_quota(monkeypatch):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url)
        if "quota" in request.url.params["q"]:
            return httpx.Response(200, json={"responseStatus": 429, "quotaFinished": True, "responseData": {}})
        return httpx.Response(200, json={"responseStatus": 200, "responseData": {"translatedText": "ಫ್ಯಾನ್"}})

    monkeypatch.setattr(get_settings(), "translation_email", "facilities@dbit.edu")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        assert await translate._mymemory(c, "Fan", "en", "kn") == "ಫ್ಯಾನ್"
        with pytest.raises(translate.QuotaExceeded):
            await translate._mymemory(c, "quota", "en", "kn")
    assert seen[0].params["langpair"] == "en-GB|kn-IN" and seen[0].params["de"] == "facilities@dbit.edu"


async def test_no_translation_when_turned_off(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "translation_provider", "none")
    await translate.enqueue(["Water leak on the terrace"])
    async with sessionmaker()() as db:
        assert await db.scalar(select(func.count()).select_from(TextTranslation)) == 0


async def test_translate_endpoint_for_text_being_typed(client):
    await make_user("manager@dbit.edu", "facility_manager", "Manager")
    fac = await sign_in(client, "manager@dbit.edu")
    body = {"text": "ಫ್ಯಾನ್ ಕೆಲಸ ಮಾಡುತ್ತಿಲ್ಲ", "target": "en"}
    assert (await fac.post(f"{API}/translate", json=body)).json() == {"state": "pending", "text": None}
    await translate.run_once()
    assert (await fac.post(f"{API}/translate", json=body)).json() == {"state": "done", "text": "[en] ಫ್ಯಾನ್ ಕೆಲಸ ಮಾಡುತ್ತಿಲ್ಲ"}
    same = await fac.post(f"{API}/translate", json={"text": "ಫ್ಯಾನ್ ಕೆಲಸ ಮಾಡುತ್ತಿಲ್ಲ", "target": "kn"})
    assert same.json()["state"] == "same"
    assert (await fac.post(f"{API}/translate", json={"text": "x" * 2001, "target": "en"})).status_code == 400
    async with new_client() as anon:
        assert (await anon.post(f"{API}/translate", json=body)).status_code == 401
    # Facility manager only: everyone else writes as they like and gets 403.
    for email, role in (("faculty@dbit.edu", "faculty"), ("principal@dbit.edu", "principal"),
                        ("management@dbit.edu", "management")):
        await make_user(email, role)
        async with new_client() as other:
            s = await sign_in(other, email)
            assert (await s.post(f"{API}/translate", json=body)).status_code == 403, role


async def test_translate_endpoint_is_throttled(client, monkeypatch):
    from app.routers import translate as route

    monkeypatch.setattr(route, "LIMIT", 2)
    await make_user("manager@dbit.edu", "facility_manager", "Manager")
    fac = await sign_in(client, "manager@dbit.edu")
    codes = [(await fac.post(f"{API}/translate", json={"text": f"Broken chair number {i}", "target": "kn"})).status_code
             for i in range(3)]
    assert codes == [200, 200, 429]

async def test_google_is_the_backup_when_mymemory_fails(monkeypatch):
    monkeypatch.setattr(get_settings(), "translation_provider", "mymemory")
    calls = []

    async def mymemory_out(text, src, tgt):
        calls.append("mymemory")
        raise translate.QuotaExceeded()

    async def google_ok(text, src, tgt):
        calls.append("google")
        return "ಫ್ಯಾನ್"

    monkeypatch.setattr(translate, "_primary", mymemory_out)
    monkeypatch.setattr(translate, "_google", google_ok)
    assert await translate.translate("Fan", "en", "kn") == "ಫ್ಯಾನ್"
    assert calls == ["mymemory", "google"]

    # Backup turned off: the MyMemory error stands.
    monkeypatch.setattr(get_settings(), "translation_fallback", "none")
    with pytest.raises(translate.QuotaExceeded):
        await translate.translate("Fan", "en", "kn")

    # Both fail: the original MyMemory error is raised, so the quota back-off still applies.
    monkeypatch.setattr(get_settings(), "translation_fallback", "google")

    async def google_down(text, src, tgt):
        raise RuntimeError("blocked")

    monkeypatch.setattr(translate, "_google", google_down)
    with pytest.raises(translate.QuotaExceeded):
        await translate.translate("Fan", "en", "kn")