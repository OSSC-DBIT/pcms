"""Team OSSC user administration (capability admin.users).

GET    /admin/users                       list and search accounts
POST   /admin/users                       create one account -> temporary password
PATCH  /admin/users/{id}                  edit email/name/role/active (audited, versioned)
POST   /admin/users/{id}/reset-password   new temporary password, optional second-factor reset
GET    /admin/users/import/template       empty XLSX with the expected header
POST   /admin/users/import                XLSX/CSV upload -> XLSX credentials
POST   /admin/users/credentials/export    re-authenticated XLSX credential download

Responses that contain temporary passwords are marked no-store.
"""

import uuid
from datetime import datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, File, Query, Request, Response, UploadFile
from pydantic import Field
from sqlalchemy import func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.errors import ApiError, conflict, not_found
from app.models.user import User
from app.schemas import CamelModel
from app.security.credentials import decrypt_password
from app.security.deps import Principal, require
from app.security.passwords import verify_password
from app.security.sessions import client_ip, now
from app.services import audit, throttle
from app.services import users as svc
from app.services.accounts import temp_password_expired
from app.services.xlsx import build_credentials_workbook, build_import_template, ist_stamp

router = APIRouter(prefix="/admin/users", tags=["admin"])
admin_users = require("admin.users")

NO_STORE = {"Cache-Control": "no-store, max-age=0", "Pragma": "no-cache"}
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

RoleName = Literal["faculty", "ossc", "facility_manager", "management"]


class AdminUserOut(CamelModel):
    id: uuid.UUID
    email: str
    name: str
    role: str
    active: bool
    must_change_password: bool
    temp_password_expires_at: datetime | None
    password_changed_at: datetime | None
    totp_enabled: bool
    last_login_at: datetime | None
    created_at: datetime
    version: int


class UserPage(CamelModel):
    items: list[AdminUserOut]
    total: int
    page: int
    page_size: int


class CreateUserIn(CamelModel):
    email: str = Field(min_length=3, max_length=254)
    name: str = Field(min_length=1, max_length=200)
    role: RoleName
    password: str = Field(min_length=1, max_length=128)


class Credential(CamelModel):
    user: AdminUserOut
    temporary_password: str
    expires_at: datetime | None


class UpdateUserIn(CamelModel):
    expected_version: int
    email: str | None = Field(default=None, max_length=254)
    name: str | None = Field(default=None, max_length=200)
    role: RoleName | None = None
    active: bool | None = None
    reason: str | None = Field(default=None, max_length=500)


class ResetIn(CamelModel):
    password: str | None = Field(default=None, max_length=128)
    reset_mfa: bool = False


class ImportPreview(CamelModel):
    to_create: int
    already_exist: list[str]


class ExportIn(CamelModel):
    password: str = Field(min_length=1, max_length=256)
    q: str | None = Field(default=None, max_length=80)
    role: RoleName | None = None
    active: bool | None = None
    pending: bool | None = None


async def _get(db: AsyncSession, user_id: uuid.UUID, lock: bool = False) -> User:
    user = await db.get(User, user_id, with_for_update=lock)
    if user is None:
        raise not_found("Account not found.")
    return user


def _apply_filters(stmt, *, q: str | None, role: RoleName | None, active: bool | None,
                   pending: bool | None):
    if q:
        like = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        stmt = stmt.where(or_(User.email.ilike(like, escape="\\"), User.name.ilike(like, escape="\\")))
    if role:
        stmt = stmt.where(User.role == role)
    if active is not None:
        stmt = stmt.where(User.active == active)
    if pending is not None:
        stmt = stmt.where(User.must_change_password == pending)
    return stmt


@router.get("", response_model=UserPage)
async def list_users(q: str | None = Query(default=None, max_length=80), role: RoleName | None = None,
                     active: bool | None = None, pending: bool | None = None,
                     page: int = Query(1, ge=1),
                     page_size: int = Query(25, ge=1, le=200, alias="pageSize"),
                     _: Principal = Depends(admin_users),
                     db: AsyncSession = Depends(get_session)) -> UserPage:
    stmt = _apply_filters(select(User), q=q, role=role, active=active, pending=pending)
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (await db.scalars(stmt.order_by(User.email).offset((page - 1) * page_size).limit(page_size))).all()
    return UserPage(items=[AdminUserOut.model_validate(u) for u in rows], total=total or 0, page=page,
                    page_size=page_size)


@router.post("", response_model=Credential, status_code=201)
async def create_user(body: CreateUserIn, response: Response, p: Principal = Depends(admin_users),
                      db: AsyncSession = Depends(get_session)) -> Credential:
    user, pw = await svc.create_user(db, p.user, email=body.email, name=body.name,
                                     role=body.role, password=body.password)
    try:
        await db.commit()
    except IntegrityError:
        raise conflict("email_exists", "An account with this email already exists.")
    response.headers.update(NO_STORE)
    return Credential(user=AdminUserOut.model_validate(user), temporary_password=pw,
                      expires_at=user.temp_password_expires_at)


@router.patch("/{user_id}", response_model=AdminUserOut)
async def update_user(user_id: uuid.UUID, body: UpdateUserIn, p: Principal = Depends(admin_users),
                      db: AsyncSession = Depends(get_session)) -> AdminUserOut:
    if user_id != p.user.id:
        # Serialise admin changes so the last-administrator check cannot race.
        await db.execute(text("SELECT pg_advisory_xact_lock(hashtext('pcms.admin_users'))"))
    user = await _get(db, user_id, lock=True)
    await svc.update_user(db, p.user, user, expected_version=body.expected_version, email=body.email,
                          name=body.name, role=body.role, active=body.active, reason=body.reason)
    try:
        await db.commit()
    except IntegrityError:
        raise conflict("email_exists", "An account with this email already exists.")
    return AdminUserOut.model_validate(user)


@router.post("/{user_id}/reset-password", response_model=Credential)
async def reset_password(user_id: uuid.UUID, body: ResetIn, response: Response,
                         p: Principal = Depends(admin_users), db: AsyncSession = Depends(get_session)) -> Credential:
    if user_id == p.user.id:
        raise ApiError(403, "self_change", "Change your own password from Settings.")
    user = await _get(db, user_id, lock=True)
    pw = await svc.reset_password(db, p.user, user, password=body.password, reset_mfa=body.reset_mfa)
    await db.commit()
    response.headers.update(NO_STORE)
    return Credential(user=AdminUserOut.model_validate(user), temporary_password=pw,
                      expires_at=user.temp_password_expires_at)


@router.get("/import/template")
async def import_template(_: Principal = Depends(admin_users)) -> Response:
    return Response(build_import_template(), media_type=XLSX, headers={
        "Content-Disposition": 'attachment; filename="pcms-import-template.xlsx"',
        **NO_STORE,
    })


@router.post("/import", responses={200: {"content": {XLSX: {}}, "description": "Credentials XLSX"}})
async def import_users(file: UploadFile = File(...), dry_run: bool = Query(False, alias="dryRun"),
                       p: Principal = Depends(admin_users), db: AsyncSession = Depends(get_session)):
    limit = get_settings().import_max_bytes
    data = await file.read(limit + 1)
    rows = svc.parse_import(data, file.filename)

    # One import at a time, so two uploads of the same file cannot race.
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext('pcms.user_import'))"))
    if dry_run:
        existing = set((await db.scalars(
            select(User.email).where(User.email.in_([r.email for r in rows]))
        )).all())
        return ImportPreview(to_create=sum(1 for r in rows if r.email not in existing),
                             already_exist=sorted(existing))

    result = await svc.import_users(db, p.user, rows)
    try:
        await db.commit()
    except IntegrityError:
        raise conflict("email_exists", "Some accounts were created by someone else meanwhile. Upload again.")

    stamp = now().astimezone(ZoneInfo(get_settings().timezone)).strftime("%Y%m%d-%H%M")
    out_rows = []
    for row, pw in result.created:
        out_rows.append({
            "email": row.email, "name": row.name, "role": row.role, "status": "Not activated",
            "password": pw, "password_changed_at": "", "last_login_at": "",
            "temp_password_expires_at": _expiry(get_settings().temp_password_days),
            "notes": "Share only with this person",
        })
    for row in result.existing:
        out_rows.append({
            "email": row.email, "name": row.name, "role": row.role, "status": "Already exists",
            "password": "", "password_changed_at": "", "last_login_at": "", "temp_password_expires_at": "",
            "notes": "Existing account unchanged; use Reset if they need a new password",
        })
    body = build_credentials_workbook(out_rows, generated_by=f"{p.user.name} <{p.user.email}>",
                                      generated_at=now())
    return Response(body, media_type=XLSX, headers={
        **NO_STORE,
        "Content-Disposition": f'attachment; filename="pcms-credentials-{stamp}.xlsx"',
        "X-PCMS-Created": str(len(result.created)),
        "X-PCMS-Existing": str(len(result.existing)),
    })


@router.post("/credentials/export")
async def export_credentials(body: ExportIn, request: Request, p: Principal = Depends(admin_users),
                             db: AsyncSession = Depends(get_session)) -> Response:
    key = f"export:{p.user.email}"
    await throttle.check(db, key, client_ip(request))
    if not verify_password(p.user.password_hash, body.password):
        await throttle.record_failure(db, key, client_ip(request))
        await db.commit()
        raise ApiError(400, "invalid_credentials", "Your password is incorrect.",
                       {"password": "Incorrect"})
    await throttle.clear(db, key)

    stmt = _apply_filters(select(User), q=body.q, role=body.role, active=body.active, pending=body.pending)
    users = (await db.scalars(stmt.order_by(User.email))).all()
    out_rows = []
    for u in users:
        password, status, notes = _password_status(u)
        if password and u.role == "ossc":
            notes = (notes + " OSSC account: authenticator code also required.").strip()
        out_rows.append({
            "email": u.email, "name": u.name, "role": u.role, "status": status, "password": password,
            "password_changed_at": ist_stamp(u.password_changed_at),
            "last_login_at": ist_stamp(u.last_login_at),
            "temp_password_expires_at": ist_stamp(u.temp_password_expires_at),
            "notes": notes,
        })

    stamp = now().astimezone(ZoneInfo(get_settings().timezone)).strftime("%Y%m%d-%H%M")
    workbook = build_credentials_workbook(out_rows, generated_by=f"{p.user.name} <{p.user.email}>",
                                          generated_at=now())
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="user.credentials_exported",
                 entity_type="export", entity_id="user_credentials",
                 after={"rows": len(out_rows), "q": body.q, "role": body.role, "active": body.active,
                        "pending": body.pending})
    await db.commit()
    return Response(workbook, media_type=XLSX, headers={
        **NO_STORE,
        "Content-Disposition": f'attachment; filename="pcms-credentials-{stamp}.xlsx"',
    })


def _password_status(user: User) -> tuple[str, str, str]:
    if not user.active:
        return "", "Suspended", "Account suspended; reactivate before sharing credentials"
    if user.must_change_password:
        if user.temp_password_enc:
            if temp_password_expired(user):
                return "", "Temporary password expired", "Temporary password expired; reset required"
            return (decrypt_password(user.temp_password_enc, aad=str(user.id)), "Not activated",
                    "Share only with this person")
        return "", "Temporary password expired", "No temporary password on file; reset required"
    if user.password_changed_at:
        return "", "Active", "Changed by employee; reset to issue a new password"
    return "", "Active", ""


def _expiry(days: int) -> str:
    return (now() + timedelta(days=days)).astimezone(ZoneInfo(get_settings().timezone)).strftime(
        "%Y-%m-%d %H:%M IST")
