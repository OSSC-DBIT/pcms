"""User administration for Team OSSC: create, edit, suspend, reset, import.

Team OSSC supplies the temporary password. It is shown and downloadable until
the person chooses their own password, then only the Argon2 hash remains.
Audit events record who did what, never the secret.
"""

import asyncio
import csv
import io
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.errors import ApiError, conflict, validation
from app.models.user import User, normalise_email
from app.security.passwords import hash_password
from app.security.roles import ROLES
from app.security.sessions import revoke_all_for_user
from app.services import audit
from app.services.accounts import (
    generate_temporary_password,
    set_temporary_password,
    validate_initial_password,
)
from app.services.xlsx import read_people_workbook

EMAIL_RE = re.compile(r"^[^@\s<>\"']{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")

# CSV/Excel import cannot create super-admin accounts; those are created one by one.
IMPORT_ROLES = ("faculty", "facility_manager", "management")
IMPORT_COLUMNS = ("email", "name", "role", "password")

# Argon2 hashing is CPU bound and releases the GIL; hash imports in parallel.
_hash_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="pwhash")


def clean_name(raw: str) -> str:
    return " ".join(_CONTROL_RE.sub(" ", raw or "").split())


def validate_identity(email: str, name: str, role: str, allowed_roles=ROLES) -> dict[str, str]:
    errors = {}
    if len(email) > 254 or not EMAIL_RE.match(email):
        errors["email"] = "Give a valid college email address."
    if not (2 <= len(name) <= 120):
        errors["name"] = "Give a name of 2 to 120 characters."
    if role not in allowed_roles:
        errors["role"] = f"Role must be one of: {', '.join(allowed_roles)}."
    return errors


def _password_error(password: str, email: str) -> str | None:
    try:
        validate_initial_password(password, email)
    except ApiError as exc:
        return (exc.field_errors or {}).get("newPassword", exc.message)
    return None


async def active_ossc_count(db: AsyncSession) -> int:
    return await db.scalar(select(func.count()).select_from(User).where(User.role == "ossc", User.active)) or 0


async def create_user(db: AsyncSession, actor: User, *, email: str, name: str, role: str,
                      password: str) -> tuple[User, str]:
    email = normalise_email(email)
    name = clean_name(name)
    errs = validate_identity(email, name, role)
    if errs:
        raise validation("Some fields need attention.", errs)
    pw_error = _password_error(password, email)
    if pw_error:
        raise validation("Choose a stronger password.", {"password": pw_error})
    if await db.scalar(select(User.id).where(User.email == email)):
        raise conflict("email_exists", f"An account for {email} already exists.")

    hashed = await asyncio.get_running_loop().run_in_executor(_hash_pool, hash_password, password)
    user = User(id=uuid.uuid4(), email=email, name=name, role=role, active=True,
                totp_enabled=False, recovery_code_hashes=[])
    set_temporary_password(user, password, hashed)
    db.add(user)
    await db.flush()
    audit.record(db, actor_id=actor.id, actor_label=actor.name, action="user.created", entity_type="user",
                 entity_id=user.id, after={"email": email, "name": name, "role": role})
    return user, password


async def reset_password(db: AsyncSession, actor: User, user: User, *, password: str | None,
                         reset_mfa: bool) -> str:
    password = password or generate_temporary_password()
    pw_error = _password_error(password, user.email)
    if pw_error:
        raise validation("Choose a stronger password.", {"password": pw_error})
    hashed = await asyncio.get_running_loop().run_in_executor(_hash_pool, hash_password, password)
    set_temporary_password(user, password, hashed)
    if reset_mfa:
        user.totp_enabled = False
        user.totp_secret = None
        user.totp_last_step = None
        user.recovery_code_hashes = []
    user.version += 1
    await revoke_all_for_user(db, user.id)
    audit.record(db, actor_id=actor.id, actor_label=actor.name, action="user.password_reset", entity_type="user",
                 entity_id=user.id, reason="including second factor" if reset_mfa else None)
    return password


async def update_user(db: AsyncSession, actor: User, user: User, *, expected_version: int, email: str | None,
                      name: str | None, role: str | None, active: bool | None, reason: str | None) -> User:
    if user.version != expected_version:
        raise conflict("stale_version", "This account was changed by someone else. Refresh and try again.")
    before = {"email": user.email, "name": user.name, "role": user.role, "active": user.active}
    errors: dict[str, str] = {}
    if email is not None:
        email = normalise_email(email)
        if len(email) > 254 or not EMAIL_RE.match(email):
            errors["email"] = "Give a valid college email address."
    if name is not None:
        name = clean_name(name)
        if not (2 <= len(name) <= 120):
            errors["name"] = "Give a name of 2 to 120 characters."
    if role is not None and role not in ROLES:
        errors["role"] = "Unknown role."
    if errors:
        raise validation("Some fields need attention.", errors)

    email_changed = email is not None and email != user.email
    if email_changed and await db.scalar(select(User.id).where(User.email == email, User.id != user.id)):
        raise conflict("email_exists", f"An account for {email} already exists.")

    role_changed = role is not None and role != user.role
    suspending = active is False and user.active
    if user.id == actor.id and (role_changed or suspending):
        raise ApiError(403, "self_change", "You cannot change your own role or suspend yourself.")
    if user.role == "ossc" and user.active and (suspending or role_changed) and await active_ossc_count(db) <= 1:
        raise conflict("last_admin", "At least one active Team OSSC account must remain.")
    if (role_changed or suspending) and not reason:
        raise validation("Give a reason for this change.", {"reason": "Required for role changes and suspension"})

    if email_changed:
        user.email = email
        # The login identity changed; end existing sessions.
        await revoke_all_for_user(db, user.id)
    if name is not None:
        user.name = name
    if role_changed:
        user.role = role
        # New role may need a second factor and has different access: start over.
        await revoke_all_for_user(db, user.id)
    if active is not None:
        user.active = active
        if suspending:
            await revoke_all_for_user(db, user.id)
    user.version += 1
    after = {"email": user.email, "name": user.name, "role": user.role, "active": user.active}
    action = "user.role_changed" if role_changed else "user.suspended" if suspending else \
        "user.reactivated" if (active and not before["active"]) else "user.updated"
    audit.record(db, actor_id=actor.id, actor_label=actor.name, action=action, entity_type="user",
                 entity_id=user.id, before=before, after=after, reason=reason)
    return user


@dataclass
class ImportRow:
    line: int
    email: str
    name: str
    role: str
    password: str


@dataclass
class ImportResult:
    created: list[tuple[ImportRow, str]] = field(default_factory=list)  # (row, temporary password)
    existing: list[ImportRow] = field(default_factory=list)


def parse_import(data: bytes, filename: str | None = None) -> list[ImportRow]:
    s = get_settings()
    if len(data) > s.import_max_bytes:
        raise ApiError(413, "too_large", f"The file is larger than {s.import_max_bytes // 1000} KB.")
    if not data:
        raise validation("The file is empty.", {"file": "Empty"})

    if filename and filename.lower().endswith(".xlsm"):
        raise validation("Macro-enabled workbooks are not accepted. Save as .xlsx.", {"file": "Expected .xlsx"})
    is_xlsx = data[:4] == b"PK\x03\x04"
    if is_xlsx:
        raw_rows = read_people_workbook(data)
    elif filename and filename.lower().endswith((".xlsx", ".xlsm", ".xls")):
        raise validation("This is not a valid Excel file.", {"file": "Expected .xlsx"})
    else:
        raw_rows = _read_csv(data)

    header = [h.strip().lower().replace(" ", "_") for h in raw_rows[0][1]] if raw_rows else []
    missing = [c for c in ("email", "name", "password") if c not in header]
    if missing:
        raise validation("The header row must include email, name and password.",
                         {"file": f"Missing: {', '.join(missing)}"})
    unknown = [c for c in header if c and c not in IMPORT_COLUMNS]
    if unknown:
        raise validation("The header row has unknown columns.", {"file": f"Unknown: {', '.join(unknown)}"})
    idx = {c: header.index(c) for c in IMPORT_COLUMNS if c in header}

    rows: list[ImportRow] = []
    errors: dict[str, str] = {}
    seen: dict[str, int] = {}
    for line, values in raw_rows[1:]:
        if not any(str(cell).strip() for cell in values):
            continue
        if len(rows) >= s.import_max_rows:
            raise validation(f"Import at most {s.import_max_rows} people per file.", {"file": "Too many rows"})

        def get(c: str) -> str:
            i = idx.get(c)
            return str(values[i]).strip() if i is not None and i < len(values) else ""

        email = normalise_email(get("email"))
        row = ImportRow(line=line, email=email, name=clean_name(get("name")),
                        role=(get("role") or "faculty").lower(), password=get("password"))
        errs = validate_identity(row.email, row.name, row.role, IMPORT_ROLES)
        pw_error = _password_error(row.password, row.email)
        if pw_error:
            errs["password"] = pw_error
        if email in seen:
            errs["email"] = f"Duplicate of line {seen[email]}."
        seen.setdefault(email, line)
        if errs:
            errors[f"line {line}"] = "; ".join(f"{k}: {v}" for k, v in errs.items())
        rows.append(row)

    if errors:
        shown = dict(list(errors.items())[:50])
        if len(errors) > 50:
            shown["more"] = f"{len(errors) - 50} more lines have problems."
        raise validation(f"{len(errors)} line(s) need fixing. Nothing was imported.", shown)
    if not rows:
        raise validation("The file has no people in it.", {"file": "No data rows"})
    return rows


def _read_csv(data: bytes) -> list[tuple[int, list[str]]]:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise validation("Save the file as CSV UTF-8 or upload an .xlsx file.", {"file": "Not UTF-8 text"})
    if "\x00" in text:
        raise validation("This is not a CSV text file.", {"file": "Binary content"})
    reader = csv.reader(io.StringIO(text))
    out: list[tuple[int, list[str]]] = []
    try:
        for record in reader:
            out.append((reader.line_num, record))
    except csv.Error as exc:
        raise validation("The CSV could not be read.", {"file": str(exc)[:200]})
    if not out:
        raise validation("The file is empty.", {"file": "Empty"})
    return out


async def import_users(db: AsyncSession, actor: User, rows: list[ImportRow]) -> ImportResult:
    """All-or-nothing: either every new account is created or none is."""
    existing_ids = set((await db.scalars(
        select(User.email).where(User.email.in_([r.email for r in rows]))
    )).all())
    result = ImportResult()
    new_rows = [r for r in rows if r.email not in existing_ids]
    result.existing = [r for r in rows if r.email in existing_ids]

    loop = asyncio.get_running_loop()
    hashes = await asyncio.gather(*(loop.run_in_executor(_hash_pool, hash_password, r.password) for r in new_rows))

    for row, hashed in zip(new_rows, hashes, strict=True):
        user = User(id=uuid.uuid4(), email=row.email, name=row.name, role=row.role, active=True,
                    totp_enabled=False, recovery_code_hashes=[])
        set_temporary_password(user, row.password, hashed)
        db.add(user)
        result.created.append((row, row.password))
    await db.flush()
    audit.record(db, actor_id=actor.id, actor_label=actor.name, action="user.imported", entity_type="user",
                 entity_id="import", after={"created": len(result.created), "existing": len(result.existing),
                                            "emails": [r.email for r, _ in result.created][:1000]})
    return result
