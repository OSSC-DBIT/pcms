"""Evidence handling (plan 18.1, OWASP file upload guidance).

  - Real type from the bytes (libmagic), never the filename or browser MIME type.
  - Photos are decoded with Pillow and re-encoded, which drops EXIF/GPS and any
    trailing payload. Videos are probed with ffprobe and remuxed without metadata.
  - Files get random storage keys on a private volume, outside any web root.
  - New files wait in quarantine until ClamAV reports them clean.
  - Downloads are authorised per request; signed public links exist only for
    Twilio to fetch a job photo and expire within minutes.
"""

import asyncio
import base64
import hashlib
import hmac
import io
import json
import os
import secrets
import struct
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import magic
from PIL import Image, ImageOps, UnidentifiedImageError

from app.config import get_settings

PHOTO_TYPES = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}
VIDEO_TYPES = {"video/mp4", "video/webm"}
MAX_PHOTO = 5 * 1024 * 1024
MAX_VIDEO = 20 * 1024 * 1024
MAX_TOTAL = 35 * 1024 * 1024
MAX_PHOTOS = 3
MAX_VIDEOS = 1
MAX_VIDEO_SECONDS = 30
MAX_PIXELS = 40_000_000

Image.MAX_IMAGE_PIXELS = MAX_PIXELS  # decompression-bomb guard


class MediaRejected(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


@dataclass
class Processed:
    kind: str
    content_type: str
    data: bytes
    width: int | None = None
    height: int | None = None
    duration_ms: int | None = None


def root() -> Path:
    return Path(get_settings().media_root)


def quarantine_path(key: str) -> Path:
    return root() / "quarantine" / key


def store_path(key: str) -> Path:
    return root() / "store" / key


def new_key() -> str:
    return secrets.token_hex(20)


def sniff(head: bytes) -> str:
    return magic.from_buffer(head, mime=True)


def _photo(data: bytes, mime: str) -> Processed:
    try:
        with Image.open(io.BytesIO(data)) as probe:
            probe.verify()
        with Image.open(io.BytesIO(data)) as im:
            if im.format != PHOTO_TYPES[mime]:
                raise MediaRejected("The photo content does not match its type.")
            if im.width * im.height > MAX_PIXELS:
                raise MediaRejected("The photo dimensions are too large.")
            im = ImageOps.exif_transpose(im)
            fmt = PHOTO_TYPES[mime]
            if fmt == "JPEG" and im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            out = io.BytesIO()
            # Saving without exif= drops all metadata, including GPS location.
            im.save(out, format=fmt, **({"quality": 88, "optimize": True} if fmt == "JPEG" else {}))
            return Processed("photo", mime, out.getvalue(), im.width, im.height)
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError) as exc:
        raise MediaRejected("This photo could not be read. Take it again or choose another file.") from exc


async def _run(*cmd: str, stdin: bytes | None = None, timeout: int = 30) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(*cmd, stdin=asyncio.subprocess.PIPE if stdin is not None else None,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(stdin), timeout)
    except TimeoutError:
        proc.kill()
        raise MediaRejected("The video took too long to check. Try a shorter clip.")
    return proc.returncode, out, err


async def _video(path: Path, mime: str) -> Processed:
    code, out, _ = await _run("ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path))
    if code != 0:
        raise MediaRejected("This video could not be read. Record it again as MP4.")
    info = json.loads(out or b"{}")
    try:
        duration = float(info["format"]["duration"])
    except (KeyError, ValueError):
        raise MediaRejected("This video could not be read. Record it again as MP4.")
    if duration > MAX_VIDEO_SECONDS + 1:
        raise MediaRejected(f"Videos can be at most {MAX_VIDEO_SECONDS} seconds.")
    video = [s for s in info.get("streams", []) if s.get("codec_type") == "video"]
    if not video:
        raise MediaRejected("The file has no video track.")
    fmt = "mp4" if mime == "video/mp4" else "webm"
    clean = path.with_suffix(".clean")
    # Remux without metadata (drops location tags); no re-encode, bounded time.
    code, _, _ = await _run("ffmpeg", "-v", "error", "-y", "-i", str(path), "-map", "0:v:0", "-map", "0:a:0?",
                            "-map_metadata", "-1", "-c", "copy", "-f", fmt, str(clean), timeout=60)
    if code != 0 or not clean.exists():
        clean.unlink(missing_ok=True)
        raise MediaRejected("This video could not be processed. Record it again as MP4.")
    data = clean.read_bytes()
    clean.unlink(missing_ok=True)
    return Processed("video", mime, data, int(video[0].get("width") or 0) or None,
                     int(video[0].get("height") or 0) or None, int(duration * 1000))


async def process(raw: bytes, tmp_dir: Path) -> Processed:
    mime = sniff(raw[:4096])
    if mime in PHOTO_TYPES:
        if len(raw) > MAX_PHOTO:
            raise MediaRejected("Photos can be at most 5 MB.", 413)
        return await asyncio.to_thread(_photo, raw, mime)
    if mime in VIDEO_TYPES:
        if len(raw) > MAX_VIDEO:
            raise MediaRejected("Videos can be at most 20 MB.", 413)
        tmp = tmp_dir / f"upload-{secrets.token_hex(8)}"
        tmp.write_bytes(raw)
        try:
            return await _video(tmp, mime)
        finally:
            tmp.unlink(missing_ok=True)
    if mime == "video/quicktime":
        raise MediaRejected("iPhone .MOV videos are not supported yet. In Camera settings choose 'Most Compatible', or send a photo.")
    raise MediaRejected("Only JPEG, PNG or WebP photos and MP4 or WebM videos are accepted.")


def write_private(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


async def clamav_scan(path: Path) -> tuple[bool, str]:
    """clamd INSTREAM protocol. Returns (clean, detail). Raises OSError when clamd is unreachable."""
    s = get_settings()
    reader, writer = await asyncio.wait_for(asyncio.open_connection(s.clamav_host, s.clamav_port), 10)
    try:
        writer.write(b"zINSTREAM\0")
        with path.open("rb") as f:
            while chunk := f.read(64 * 1024):
                writer.write(struct.pack("!L", len(chunk)) + chunk)
                await writer.drain()
        writer.write(struct.pack("!L", 0))
        await writer.drain()
        reply = (await asyncio.wait_for(reader.read(4096), 120)).rstrip(b"\0").decode(errors="replace").strip()
    finally:
        writer.close()
    if reply.endswith("OK"):
        return True, reply
    return False, reply


# ---------- signed public links (Twilio fetches job photos) ----------

def _sig(payload: bytes) -> str:
    key = hashlib.sha256(b"pcms-media:" + get_settings().secret_key.encode()).digest()
    return base64.urlsafe_b64encode(hmac.new(key, payload, hashlib.sha256).digest()[:20]).rstrip(b"=").decode()


def public_token(attachment_id: uuid.UUID, ttl: int | None = None) -> str:
    exp = int(time.time()) + (ttl or get_settings().public_media_ttl_seconds)
    payload = attachment_id.bytes + struct.pack("!Q", exp)
    return base64.urlsafe_b64encode(payload).rstrip(b"=").decode() + "." + _sig(payload)


def verify_public_token(token: str) -> uuid.UUID | None:
    try:
        body, sig = token.split(".", 1)
        payload = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
    except (ValueError, TypeError):
        return None
    if len(payload) != 24 or not hmac.compare_digest(sig, _sig(payload)):
        return None
    (exp,) = struct.unpack("!Q", payload[16:])
    if exp < time.time():
        return None
    return uuid.UUID(bytes=payload[:16])
