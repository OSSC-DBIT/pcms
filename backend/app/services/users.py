"""User administration for Team OSSC: create, edit, suspend, reset, CSV import.

Temporary passwords are returned to the caller exactly once and never stored
or logged in plain text. Audit events record who did what, never the secret.
"""

import asyncio
import csv
import io
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.errors import ApiError, conflict, validation
from app.models.user import User, normalise_employee_id
from app.security.passwords import hash_password
from app.security.roles import ROLES
from app.security.sessions import revoke_all_for_user
from app.services import audit
from app.services.accounts import generate_temporary_password, temporary_password_fields

EMPLOYEE_ID_RE = re.compile(r"^[A-Z0-9][A-Z0-9_-]{1,31}$")
EMAIL_RE = re.compile(r"^[^@\s<>\"']{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")

# CSV import cannot create super-admin accounts; those are created one by one.
IMPORT_ROLES = ("faculty", "facility_manager", "management")
IMPORT_COLUMNS = ("employee_id", "name", "role", "email")

# Argon2 hashing is CPU bound and releases the GIL; hash imports in parallel.
_hash_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="pwhash")


def clean_name(raw: str) -> str:
    return " ".join(_CONTROL_RE.sub(" ", raw or "").split())


def validate_identity(employee_id: str, name: str, role: str, email: str | None, allowed_roles=ROLES) -> dict[str, str]:
    errors = {}
    if not EMPLOYEE_ID_RE.match(employee_id):
        errors["employeeId"] = "Use 2 to 32 letters, digits, hyphen or underscore."
    if not (2 <= len(name) <= 120):
        errors["name"] = "Give a name of 2 to 120 characters."
    if role not in allowed_roles:
        errors["role"] = f"Role must be one of: {', '.join(allowed_roles)}."
    if email and not EMAIL_RE.match(email):
        errors["email"] = "Not a valid email address."
    return errors


async def active_ossc_count(db: AsyncSession) -> int:
    return await db.scalar(select(func.count()).select_from(User).where(User.role == "ossc", User.active)) or 0


async def create_user(db: AsyncSession, actor: User, *, employee_id: str, name: str, role: str,
                      email: str | None) -> tuple[User, str]:
    emp = normalise_employee_id(employee_id)
    name = clean_name(name)
    email = (email or "").strip() or None
    errs = validate_identity(emp, name, role, email)
    if errs:
        raise validation("Some fields need attention.", errs)
    if await db.scalar(select(User.id).where(User.employee_id == emp)):
        raise conflict("employee_exists", f"An account for {emp} already exists.")
    pw = generate_temporary_password()
    hashed = await asyncio.get_running_loop().run_in_executor(_hash_pool, hash_password, pw)
    user = User(employee_id=emp, name=name, role=role, email=email, active=True,
                totp_enabled=False, recovery_code_hashes=[], **temporary_password_fields(hashed))
    db.add(user)
    await db.flush()
    audit.record(db, actor_id=actor.id, actor_label=actor.name, action="user.created", entity_type="user",
                 entity_id=user.id, after={"employeeId": emp, "name": name, "role": role, "email": email})
    return user, pw


async def reset_password(db: AsyncSession, actor: User, user: User, *, reset_mfa: bool) -> str:
    pw = generate_temporary_password()
    hashed = await asyncio.get_running_loop().run_in_executor(_hash_pool, hash_password, pw)
    for k, v in temporary_password_fields(hashed).items():
        setattr(user, k, v)
    if reset_mfa:
        user.totp_enabled = False
        user.totp_secret = None
        user.totp_last_step = None
        user.recovery_code_hashes = []
    user.version += 1
    await revoke_all_for_user(db, user.id)
    audit.record(db, actor_id=actor.id, actor_label=actor.name, action="user.password_reset", entity_type="user",
                 entity_id=user.id, reason="including second factor" if reset_mfa else None)
    return pw


async def update_user(db: AsyncSession, actor: User, user: User, *, expected_version: int, name: str | None,
                      email: str | None, role: str | None, active: bool | None, reason: str | None) -> User:
    if user.version != expected_version:
        raise conflict("stale_version", "This account was changed by someone else. Refresh and try again.")
    before = {"name": user.name, "email": user.email, "role": user.role, "active": user.active}
    errors: dict[str, str] = {}
    if name is not None:
        name = clean_name(name)
        if not (2 <= len(name) <= 120):
            errors["name"] = "Give a name of 2 to 120 characters."
    if email is not None:
        email = email.strip() or None
        if email and not EMAIL_RE.match(email):
            errors["email"] = "Not a valid email address."
    if role is not None and role not in ROLES:
        errors["role"] = "Unknown role."
    if errors:
        raise validation("Some fields need attention.", errors)

    role_changed = role is not None and role != user.role
    suspending = active is False and user.active
    if user.id == actor.id and (role_changed or suspending):
        raise ApiError(403, "self_change", "You cannot change your own role or suspend yourself.")
    if user.role == "ossc" and user.active and (suspending or role_changed) and await active_ossc_count(db) <= 1:
        raise conflict("last_admin", "At least one active Team OSSC account must remain.")
    if (role_changed or suspending) and not reason:
        raise validation("Give a reason for this change.", {"reason": "Required for role changes and suspension"})

    if name is not None:
        user.name = name
    if email is not None:
        user.email = email
    if role_changed:
        user.role = role
        # New role may need a second factor and has different access: start over.
        await revoke_all_for_user(db, user.id)
    if active is not None:
        user.active = active
        if suspending:
            await revoke_all_for_user(db, user.id)
    user.version += 1
    after = {"name": user.name, "email": user.email, "role": user.role, "active": user.active}
    action = "user.role_changed" if role_changed else "user.suspended" if suspending else \
        "user.reactivated" if (active and not before["active"]) else "user.updated"
    audit.record(db, actor_id=actor.id, actor_label=actor.name, action=action, entity_type="user",
                 entity_id=user.id, before=before, after=after, reason=reason)
    return user


@dataclass
class ImportRow:
    line: int
    employee_id: str
    name: str
    role: str
    email: str | None


@dataclass
class ImportResult:
    created: list[tuple[ImportRow, str]] = field(default_factory=list)  # (row, temporary password)
    existing: list[ImportRow] = field(default_factory=list)


def parse_import(data: bytes) -> list[ImportRow]:
    s = get_settings()
    if len(data) > s.import_max_bytes:
        raise ApiError(413, "too_large", f"The file is larger than {s.import_max_bytes // 1000} KB.")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise validation("Save the file as CSV UTF-8 and try again.", {"file": "Not UTF-8 text"})
    if "\x00" in text:
        raise validation("This is not a CSV text file.", {"file": "Binary content"})

    reader = csv.reader(io.StringIO(text))
    try:
        header = next(reader)
    except StopIteration:
        raise validation("The file is empty.", {"file": "Empty"})
    cols = [h.strip().lower().replace(" ", "_") for h in header]
    missing = [c for c in ("employee_id", "name") if c not in cols]
    if missing:
        raise validation("The header row must include employee_id and name.", {"file": f"Missing: {', '.join(missing)}"})
    unknown = [c for c in cols if c and c not in IMPORT_COLUMNS]
    if unknown:
        raise validation("The header row has unknown columns.", {"file": f"Unknown: {', '.join(unknown)}"})
    idx = {c: cols.index(c) for c in IMPORT_COLUMNS if c in cols}

    rows: list[ImportRow] = []
    errors: dict[str, str] = {}
    seen: dict[str, int] = {}
    try:
        for record in reader:
            line = reader.line_num
            if not any(cell.strip() for cell in record):
                continue
            if len(rows) >= s.import_max_rows:
                raise validation(f"Import at most {s.import_max_rows} people per file.", {"file": "Too many rows"})

            def get(c: str) -> str:
                i = idx.get(c)
                return record[i].strip() if i is not None and i < len(record) else ""

            emp = normalise_employee_id(get("employee_id"))
            row = ImportRow(line=line, employee_id=emp, name=clean_name(get("name")),
                            role=(get("role") or "faculty").lower(), email=get("email") or None)
            errs = validate_identity(row.employee_id, row.name, row.role, row.email, IMPORT_ROLES)
            if emp in seen:
                errs["employeeId"] = f"Duplicate of line {seen[emp]}."
            seen.setdefault(emp, line)
            if errs:
                errors[f"line {line}"] = "; ".join(f"{k}: {v}" for k, v in errs.items())
            rows.append(row)
    except csv.Error as exc:
        raise validation("The CSV could not be read.", {"file": str(exc)[:200]})

    if errors:
        shown = dict(list(errors.items())[:50])
        if len(errors) > 50:
            shown["more"] = f"{len(errors) - 50} more lines have problems."
        raise validation(f"{len(errors)} line(s) need fixing. Nothing was imported.", shown)
    if not rows:
        raise validation("The file has no people in it.", {"file": "No data rows"})
    return rows


async def import_users(db: AsyncSession, actor: User, rows: list[ImportRow]) -> ImportResult:
    """All-or-nothing: either every new account is created or none is."""
    existing_ids = set((await db.scalars(
        select(User.employee_id).where(User.employee_id.in_([r.employee_id for r in rows]))
    )).all())
    result = ImportResult()
    new_rows = [r for r in rows if r.employee_id not in existing_ids]
    result.existing = [r for r in rows if r.employee_id in existing_ids]

    passwords = [generate_temporary_password() for _ in new_rows]
    loop = asyncio.get_running_loop()
    hashes = await asyncio.gather(*(loop.run_in_executor(_hash_pool, hash_password, pw) for pw in passwords))

    for row, pw, hashed in zip(new_rows, passwords, hashes, strict=True):
        db.add(User(employee_id=row.employee_id, name=row.name, role=row.role, email=row.email, active=True,
                    totp_enabled=False, recovery_code_hashes=[], **temporary_password_fields(hashed)))
        result.created.append((row, pw))
    await db.flush()
    audit.record(db, actor_id=actor.id, actor_label=actor.name, action="user.imported", entity_type="user",
                 entity_id="import", after={"created": len(result.created), "existing": len(result.existing),
                                            "employeeIds": [r.employee_id for r, _ in result.created][:1000]})
    return result
