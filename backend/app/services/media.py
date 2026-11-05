"""Evidence handling (plan 18.1, OWASP file upload guidance).

  - Real type from the bytes (libmagic), never the filename or browser MIME type.
  - Photos are decoded with Pillow and re-encoded, which drops EXIF/GPS and any
    trailing payload. Videos are probed with ffprobe and remuxed without metadata.
  - Files get random storage keys on a private volume, outside any web root.
  - New files wait in quarantine until ClamAV reports them clean.
  - Downloads are authorised per request. There are no public links.
"""

import asyncio
import hashlib
import io
import json
import os
import secrets
import struct
from dataclasses import dataclass
from pathlib import Path

import magic
from PIL import Image, ImageOps, UnidentifiedImageError

from app.config import get_settings

PHOTO_TYPES = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}
PHOTO_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
VIDEO_TYPES = {"video/mp4", "video/webm"}
# Staff documents: quotes, bills, approvals, reports, spreadsheets, slides and
# scanned images. Office and PDF files cannot be re-encoded, so they rely on the
# checks in _document, the virus scan, staff-only access and download-only delivery.
# Anything not listed here (executables, scripts, archives, HTML, SVG, macro-enabled
# Office formats) is refused.
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
OLE_TYPES = {"application/msword": "doc", "application/vnd.ms-excel": "xls", "application/vnd.ms-powerpoint": "ppt"}
# The part every genuine Office Open XML file of that type contains.
OOXML_MAIN = {DOCX: "word/document.xml", XLSX: "xl/workbook.xml", PPTX: "ppt/presentation.xml"}
DOCUMENT_TYPES = {"application/pdf": "pdf", DOCX: "docx", XLSX: "xlsx", PPTX: "pptx", **OLE_TYPES,
                  "text/plain": "txt", **PHOTO_EXT}
DOCUMENT_LABEL = "PDF, Word, Excel, PowerPoint, text files or photos"
# Zip-bomb guards for Office Open XML files.
MAX_OOXML_ENTRIES = 2000
MAX_OOXML_UNPACKED = 200 * 1024 * 1024
# Containers whose real type needs the whole file, not just the first 4 KB.
_CONTAINERS = {"application/zip", "application/x-ole-storage", "application/octet-stream", "application/CDFV2"}
MAX_PHOTO = 5 * 1024 * 1024
MAX_VIDEO = 20 * 1024 * 1024
MAX_DOCUMENT = 10 * 1024 * 1024
MAX_TOTAL = 35 * 1024 * 1024
MAX_DOCUMENTS_TOTAL = 50 * 1024 * 1024
MAX_PHOTOS = 3
MAX_VIDEOS = 1
MAX_DOCUMENTS = 10
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


async def _probe(path: Path) -> dict:
    code, out, _ = await _run("ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path))
    if code != 0:
        raise MediaRejected("This video could not be read. Record it again as MP4.")
    return json.loads(out or b"{}")


async def _video(path: Path, mime: str) -> Processed:
    """Remux without metadata, then check the clean copy.

    Browser recordings (MediaRecorder) carry no duration until they are remuxed,
    so the limits are checked on the output. iPhone .MOV files holding H.264 are
    rewritten as MP4; other codecs (HEVC) are refused because many browsers
    cannot play them.
    """
    first = await _probe(path)
    video = [s for s in first.get("streams", []) if s.get("codec_type") == "video"]
    if not video:
        raise MediaRejected("The file has no video track.")
    if mime == "video/quicktime":
        if video[0].get("codec_name") != "h264":
            raise MediaRejected("This iPhone video format is not supported. Use Record video in PCMS, "
                                "or in Camera settings choose 'Most Compatible'.")
        mime = "video/mp4"
    fmt = "mp4" if mime == "video/mp4" else "webm"
    clean = path.with_suffix(".clean")
    # Remux without metadata (drops location tags); no re-encode, bounded time.
    code, _, _ = await _run("ffmpeg", "-v", "error", "-y", "-i", str(path), "-map", "0:v:0", "-map", "0:a:0?",
                            "-map_metadata", "-1", "-c", "copy",
                            *(["-movflags", "+faststart"] if fmt == "mp4" else []), "-f", fmt, str(clean), timeout=60)
    try:
        if code != 0 or not clean.exists():
            raise MediaRejected("This video could not be processed. Record it again as MP4.")
        info = await _probe(clean)
        try:
            duration = float(info["format"]["duration"])
        except (KeyError, ValueError):
            raise MediaRejected("This video could not be read. Record it again as MP4.")
        if duration > MAX_VIDEO_SECONDS + 1:
            raise MediaRejected(f"Videos can be at most {MAX_VIDEO_SECONDS} seconds.")
        data = clean.read_bytes()
    finally:
        clean.unlink(missing_ok=True)
    return Processed("video", mime, data, int(video[0].get("width") or 0) or None,
                     int(video[0].get("height") or 0) or None, int(duration * 1000))


def _ooxml(raw: bytes, mime: str) -> None:
    import zipfile

    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            infos = z.infolist()
    except zipfile.BadZipFile as exc:
        raise MediaRejected("This document could not be read.") from exc
    if len(infos) > MAX_OOXML_ENTRIES or sum(i.file_size for i in infos) > MAX_OOXML_UNPACKED:
        raise MediaRejected("This document is too complex to accept. Save it as PDF and try again.")
    names = {i.filename.lower() for i in infos}
    if OOXML_MAIN[mime] not in names:
        raise MediaRejected("The document content does not match its type.")
    if any(n.endswith("vbaproject.bin") or "/activex/" in n for n in names):
        raise MediaRejected("Documents with macros or ActiveX controls are not accepted. Save it again without them, or as PDF.")


# Directory entry names in an OLE (old Office) file are UTF-16; a VBA project stores one of these.
_OLE_MACRO_MARKERS = ("_VBA_PROJECT".encode("utf-16-le"), "VBA_PROJECT".encode("utf-16-le"))


def _document(raw: bytes, mime: str) -> Processed:
    """Staff documents are stored as uploaded (after these checks) and only ever downloaded."""
    if len(raw) > MAX_DOCUMENT:
        raise MediaRejected("Documents can be at most 10 MB.", 413)
    if mime in PHOTO_TYPES:
        # A scanned bill or a photo of a quote: re-encoded like any photo, kept as a document.
        p = _photo(raw, mime)
        return Processed("document", mime, p.data, p.width, p.height)
    if mime == "application/pdf":
        if not raw.startswith(b"%PDF-"):
            raise MediaRejected("The document content does not match its type.")
        # Active content has no place in a quote or report.
        if b"/JavaScript" in raw or b"/Launch" in raw or b"/EmbeddedFile" in raw:
            raise MediaRejected("PDFs with scripts, launch actions or embedded files are not accepted. "
                                "Print it to a new PDF and try again.")
    elif mime in OOXML_MAIN:
        _ooxml(raw, mime)
    elif mime in OLE_TYPES:
        if any(m in raw for m in _OLE_MACRO_MARKERS):
            raise MediaRejected("Documents with macros are not accepted. Save it again without macros, or as PDF.")
    elif mime == "text/plain":
        try:
            raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise MediaRejected("Text files must be saved as UTF-8.") from exc
    return Processed("document", mime, raw)


async def process(raw: bytes, tmp_dir: Path, *, purpose: str = "evidence") -> Processed:
    """purpose "evidence": the reporter's photos and videos. "document": staff files of any listed type."""
    mime = sniff(raw[:4096])
    if mime in _CONTAINERS:
        # Office files are zip or OLE containers; the type is only clear from the whole file.
        mime = sniff(raw)
    if purpose == "document":
        if mime not in DOCUMENT_TYPES:
            raise MediaRejected(f"This file type is not accepted. Add {DOCUMENT_LABEL}.")
        return await asyncio.to_thread(_document, raw, mime)
    if mime in PHOTO_TYPES:
        if len(raw) > MAX_PHOTO:
            raise MediaRejected("Photos can be at most 5 MB.", 413)
        return await asyncio.to_thread(_photo, raw, mime)
    if mime in VIDEO_TYPES or mime == "video/quicktime":
        if len(raw) > MAX_VIDEO:
            raise MediaRejected("Videos can be at most 20 MB.", 413)
        tmp = tmp_dir / f"upload-{secrets.token_hex(8)}"
        tmp.write_bytes(raw)
        try:
            return await _video(tmp, mime)
        finally:
            tmp.unlink(missing_ok=True)
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
