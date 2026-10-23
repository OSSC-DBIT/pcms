import io
import time
import uuid

from PIL import Image
from sqlalchemy import select

from app.config import get_settings
from app.db import sessionmaker
from app.models import Attachment
from app.services import media, scheduler
from tests.factories import API, make_user, new_client, sign_in, ticket_body


def jpeg_with_gps() -> bytes:
    im = Image.new("RGB", (64, 48), (200, 30, 30))
    exif = Image.Exif()
    exif[0x010F] = "PhoneMaker"
    exif[0x8825] = {1: "N", 2: (12.0, 52.0, 32.0)}  # GPS IFD
    buf = io.BytesIO()
    im.save(buf, format="JPEG", exif=exif)
    return buf.getvalue()


async def _ticket(client, emp="faculty@dbit.edu"):
    await make_user(emp, "faculty")
    s = await sign_in(client, emp)
    t = (await s.post(f"{API}/tickets", json=ticket_body())).json()
    return s, t["id"]


async def test_photo_upload_strips_metadata_and_downloads_for_owner_only(client):
    s, tid = await _ticket(client)
    raw = jpeg_with_gps()
    assert b"PhoneMaker" in raw
    r = await s.post(f"{API}/tickets/{tid}/attachments", files={"file": ("../../etc/passwd.jpg", raw, "image/jpeg")})
    assert r.status_code == 202, r.text
    att = r.json()
    assert att["state"] == "available" and att["name"] == ".._.._etc_passwd.jpg"[-len(att["name"]):] or "/" not in att["name"]
    got = await s.get(att["url"])
    assert got.status_code == 200 and got.headers["content-type"] == "image/jpeg"
    assert got.headers["x-content-type-options"] == "nosniff"
    assert b"PhoneMaker" not in got.content and Image.open(io.BytesIO(got.content)).getexif().get(0x8825) is None

    async with new_client() as other:
        await make_user("faculty2@dbit.edu", "faculty")
        o = await sign_in(other, "faculty2@dbit.edu")
        assert (await o.get(att["url"])).status_code == 404
        assert (await o.post(f"{API}/tickets/{tid}/attachments", files={"file": ("a.jpg", raw, "image/jpeg")})).status_code == 404
    assert (await new_client().get(att["url"])).status_code == 401


async def test_rejects_disguised_svg_html_and_archives(client):
    s, tid = await _ticket(client)
    cases = [
        ("photo.jpg", b"MZ\x90\x00" + b"\x00" * 200, "image/jpeg"),  # Windows executable
        ("logo.svg", b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "image/svg+xml"),
        ("page.png", b"<html><script>alert(1)</script></html>", "image/png"),
        ("files.jpg", b"PK\x03\x04" + b"\x00" * 100, "image/jpeg"),
    ]
    for name, data, ctype in cases:
        r = await s.post(f"{API}/tickets/{tid}/attachments", files={"file": (name, data, ctype)})
        assert r.status_code == 400 and r.json()["code"] == "media_rejected", name
    # The text ticket survives every failed upload.
    assert (await s.get(f"{API}/tickets/{tid}")).json()["attachments"] == []


async def test_size_and_count_limits(client):
    s, tid = await _ticket(client)
    big = b"\xff\xd8\xff\xe0" + b"\x00" * (5 * 1024 * 1024 + 10)
    r = await s.post(f"{API}/tickets/{tid}/attachments", files={"file": ("big.jpg", big, "image/jpeg")})
    assert r.status_code == 413
    for i in range(3):
        assert (await s.post(f"{API}/tickets/{tid}/attachments", files={"file": (f"{i}.jpg", jpeg_with_gps(), "image/jpeg")})).status_code == 202
    r = await s.post(f"{API}/tickets/{tid}/attachments", files={"file": ("4.jpg", jpeg_with_gps(), "image/jpeg")})
    assert r.status_code == 409 and r.json()["code"] == "media_limit"


async def test_quarantine_until_scanned_clean(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "clamav_required", True)
    s, tid = await _ticket(client)
    r = await s.post(f"{API}/tickets/{tid}/attachments", files={"file": ("a.jpg", jpeg_with_gps(), "image/jpeg")})
    att = r.json()
    assert att["state"] == "scanning" and att["url"] is None
    assert (await s.get(f"/api/v1/attachments/{att['id']}/content")).status_code == 404

    async def infected(path):
        return False, "stream: Eicar-Signature FOUND"

    monkeypatch.setattr(media, "clamav_scan", infected)
    assert await scheduler.scan_quarantine() == 1
    async with sessionmaker()() as db:
        row = await db.get(Attachment, uuid.UUID(att["id"]))
    assert row.state == "failed" and not media.quarantine_path(row.storage_key).exists()


async def test_scanner_down_keeps_files_quarantined(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "clamav_required", True)
    s, tid = await _ticket(client)
    att = (await s.post(f"{API}/tickets/{tid}/attachments", files={"file": ("a.jpg", jpeg_with_gps(), "image/jpeg")})).json()

    async def down(path):
        raise OSError("connection refused")

    monkeypatch.setattr(media, "clamav_scan", down)
    await scheduler.scan_quarantine()
    async with sessionmaker()() as db:
        assert (await db.get(Attachment, uuid.UUID(att["id"]))).state == "scanning"


def test_signed_public_link_expires_and_rejects_tampering():
    aid = uuid.uuid4()
    tok = media.public_token(aid, ttl=60)
    assert media.verify_public_token(tok) == aid
    body, sig = tok.split(".")
    assert media.verify_public_token(body + "." + sig[:-2] + "AA") is None
    assert media.verify_public_token(media.public_token(aid, ttl=-1)) is None
    assert media.verify_public_token("garbage") is None
    assert time.time() > 0


async def test_public_media_route_serves_only_signed_available_photos(client):
    s, tid = await _ticket(client)
    att = (await s.post(f"{API}/tickets/{tid}/attachments", files={"file": ("a.jpg", jpeg_with_gps(), "image/jpeg")})).json()
    async with new_client() as anon:
        assert (await anon.get(f"/media/public/{media.public_token(uuid.UUID(att['id']))}")).status_code == 200
        assert (await anon.get(f"/media/public/{media.public_token(uuid.uuid4())}")).status_code == 404
        assert (await anon.get(f"/media/public/{att['id']}")).status_code == 404
    async with sessionmaker()() as db:
        assert (await db.scalars(select(Attachment))).first() is not None



async def test_faculty_video_is_stored_and_visible_to_staff(client, tmp_path):
    import subprocess

    out = tmp_path / "clip.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15",
                    "-pix_fmt", "yuv420p", "-metadata", "location=+12.87+077.44/", str(out)], check=True)
    s, tid = await _ticket(client)
    r = await s.post(f"{API}/tickets/{tid}/attachments", files={"file": ("clip.mp4", out.read_bytes(), "video/mp4")})
    assert r.status_code == 202, r.text
    att = r.json()
    assert att["kind"] == "video" and att["state"] == "available"
    async with new_client() as staff:
        await make_user("manager@dbit.edu", "facility_manager")
        m = await sign_in(staff, "manager@dbit.edu")
        t = (await m.get(f"{API}/tickets/{tid}")).json()
        assert [a["kind"] for a in t["attachments"]] == ["video"]
        got = await m.get(t["attachments"][0]["url"])
        assert got.status_code == 200 and got.headers["content-type"] == "video/mp4"
        assert b"+12.87+077.44" not in got.content  # location metadata removed
