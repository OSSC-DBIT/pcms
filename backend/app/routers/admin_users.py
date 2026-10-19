"""Team OSSC user administration (capability admin.users).

GET    /admin/users                       list and search accounts
POST   /admin/users                       create one account -> temporary password (shown once)
PATCH  /admin/users/{id}                  edit name/email/role/active (audited, versioned)
POST   /admin/users/{id}/reset-password   new temporary password, optional second-factor reset
POST   /admin/users/import                CSV upload -> CSV download with temporary passwords
GET    /admin/users/import/template       empty CSV with the expected header

Responses that contain temporary passwords are marked no-store.
"""

import uuid
from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile
from pydantic import Field
from sqlalchemy import func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.errors import ApiError, conflict, not_found
from app.models.user import User
from app.schemas import CamelModel
from app.security.deps import Principal, require
from app.security.sessions import now
from app.services import users as svc
from app.services.csvsafe import to_csv

router = APIRouter(prefix="/admin/users", tags=["admin"])
admin_users = require("admin.users")

NO_STORE = {"Cache-Control": "no-store, max-age=0", "Pragma": "no-cache"}

RoleName = Literal["faculty", "ossc", "facility_manager", "management"]


class AdminUserOut(CamelModel):
    id: uuid.UUID
    employee_id: str
    name: str
    email: str | None
    role: str
    active: bool
    must_change_password: bool
    temp_password_expires_at: datetime | None
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
    employee_id: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=200)
    role: RoleName
    email: str | None = Field(default=None, max_length=254)


class Credential(CamelModel):
    user: AdminUserOut
    temporary_password: str
    expires_at: datetime


class UpdateUserIn(CamelModel):
    expected_version: int
    name: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=254)
    role: RoleName | None = None
    active: bool | None = None
    reason: str | None = Field(default=None, max_length=500)


class ResetIn(CamelModel):
    reset_mfa: bool = False


class ImportPreview(CamelModel):
    to_create: int
    already_exist: list[str]


async def _get(db: AsyncSession, user_id: uuid.UUID, lock: bool = False) -> User:
    user = await db.get(User, user_id, with_for_update=lock)
    if user is None:
        raise not_found("Account not found.")
    return user


@router.get("", response_model=UserPage)
async def list_users(q: str | None = Query(default=None, max_length=80), role: RoleName | None = None,
                     active: bool | None = None, page: int = Query(1, ge=1),
                     page_size: int = Query(25, ge=1, le=200, alias="pageSize"),
                     _: Principal = Depends(admin_users),
                     db: AsyncSession = Depends(get_session)) -> UserPage:
    stmt = select(User)
    if q:
        like = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        stmt = stmt.where(or_(User.employee_id.ilike(like, escape="\\"), User.name.ilike(like, escape="\\")))
    if role:
        stmt = stmt.where(User.role == role)
    if active is not None:
        stmt = stmt.where(User.active == active)
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (await db.scalars(stmt.order_by(User.employee_id).offset((page - 1) * page_size).limit(page_size))).all()
    return UserPage(items=[AdminUserOut.model_validate(u) for u in rows], total=total or 0, page=page, page_size=page_size)


@router.post("", response_model=Credential, status_code=201)
async def create_user(body: CreateUserIn, response: Response, p: Principal = Depends(admin_users),
                      db: AsyncSession = Depends(get_session)) -> Credential:
    user, pw = await svc.create_user(db, p.user, employee_id=body.employee_id, name=body.name,
                                     role=body.role, email=body.email)
    try:
        await db.commit()
    except IntegrityError:
        raise conflict("employee_exists", "An account with this employee ID already exists.")
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
    await svc.update_user(db, p.user, user, expected_version=body.expected_version, name=body.name,
                          email=body.email, role=body.role, active=body.active, reason=body.reason)
    await db.commit()
    return AdminUserOut.model_validate(user)


@router.post("/{user_id}/reset-password", response_model=Credential)
async def reset_password(user_id: uuid.UUID, body: ResetIn, response: Response,
                         p: Principal = Depends(admin_users), db: AsyncSession = Depends(get_session)) -> Credential:
    if user_id == p.user.id:
        raise ApiError(403, "self_change", "Change your own password from Settings.")
    user = await _get(db, user_id, lock=True)
    pw = await svc.reset_password(db, p.user, user, reset_mfa=body.reset_mfa)
    await db.commit()
    response.headers.update(NO_STORE)
    return Credential(user=AdminUserOut.model_validate(user), temporary_password=pw,
                      expires_at=user.temp_password_expires_at)


@router.get("/import/template")
async def import_template(_: Principal = Depends(admin_users)) -> Response:
    body = to_csv(["employee_id", "name", "role", "email"], [])
    return Response(body, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="pcms-import-template.csv"'})


@router.post("/import", responses={200: {"content": {"text/csv": {}}, "description": "Credentials CSV"}})
async def import_users(file: UploadFile = File(...), dry_run: bool = Query(False, alias="dryRun"),
                       p: Principal = Depends(admin_users), db: AsyncSession = Depends(get_session)):
    limit = get_settings().import_max_bytes
    data = await file.read(limit + 1)
    rows = svc.parse_import(data)

    # One import at a time, so two uploads of the same file cannot race.
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext('pcms.user_import'))"))
    if dry_run:
        existing = set((await db.scalars(
            select(User.employee_id).where(User.employee_id.in_([r.employee_id for r in rows]))
        )).all())
        return ImportPreview(to_create=sum(1 for r in rows if r.employee_id not in existing),
                             already_exist=sorted(existing))

    result = await svc.import_users(db, p.user, rows)
    try:
        await db.commit()
    except IntegrityError:
        raise conflict("employee_exists", "Some accounts were created by someone else meanwhile. Upload again.")

    tz = ZoneInfo(get_settings().timezone)
    out_rows = []
    for row, pw in result.created:
        out_rows.append([row.employee_id, row.name, row.role, row.email or "", "created", pw,
                         _expiry(tz, get_settings().temp_password_days)])
    for row in result.existing:
        out_rows.append([row.employee_id, row.name, row.role, row.email or "", "already_exists", "", ""])
    body = to_csv(["employee_id", "name", "role", "email", "status", "temporary_password", "expires_at"], out_rows)
    stamp = now().astimezone(tz).strftime("%Y%m%d-%H%M")
    return Response(body, media_type="text/csv; charset=utf-8", headers={
        **NO_STORE,
        "Content-Disposition": f'attachment; filename="pcms-credentials-{stamp}.csv"',
        "X-PCMS-Created": str(len(result.created)),
        "X-PCMS-Existing": str(len(result.existing)),
    })


def _expiry(tz: ZoneInfo, days: int) -> str:
    from datetime import timedelta

    return (now() + timedelta(days=days)).astimezone(tz).strftime("%Y-%m-%d %H:%M IST")
