"""Sign-in, forced password change, second factor, sign-out and identity.

POST   /session           employee ID + password                      -> StepOut
POST   /session/totp      TOTP code or recovery code (verify or enrol) -> StepOut
POST   /session/password  change password (forced or voluntary)       -> StepOut
DELETE /session           sign out (revokes the server-side session)
GET    /me                identity and capabilities (full access only)

Each StepOut says what the client must do next; protected endpoints accept the
session only once next == "done" (see services/accounts.next_step).
"""

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.errors import ApiError
from app.models.session import UserSession
from app.models.user import User, normalise_employee_id
from app.schemas.session import ChangePasswordIn, MeOut, MeWithCsrf, SignInIn, StepOut, TotpEnrolment, TotpIn
from app.security import totp
from app.security.deps import Principal, current_principal, pending_principal
from app.security.passwords import hash_password, needs_rehash, verify_password
from app.security.roles import capabilities_for
from app.security.sessions import clear_cookies, client_ip, create_session, now, rotate, set_cookies
from app.services import audit, throttle
from app.services.accounts import next_step, temp_password_expired, validate_new_password

router = APIRouter(tags=["session"])

BAD_CREDENTIALS = "Employee ID or password is incorrect. Access is managed by the college roster."


def me_out(user: User) -> MeOut:
    return MeOut(id=str(user.id), employee_id=user.employee_id, name=user.name,
                 role=user.role, capabilities=capabilities_for(user.role))


def step_out(user: User, sess: UserSession, recovery_codes: list[str] | None = None) -> StepOut:
    step = next_step(user, sess)
    enrolment = None
    if step == "enrol_totp":
        if not sess.pending_totp_secret:
            sess.pending_totp_secret = totp.new_secret()
        enrolment = TotpEnrolment(secret=sess.pending_totp_secret,
                                  uri=totp.provisioning_uri(sess.pending_totp_secret, user.employee_id))
    return StepOut(user=me_out(user), next=step, csrf_token=sess.csrf_token,
                   enrolment=enrolment, recovery_codes=recovery_codes)


def _signed_in(db: AsyncSession, user: User) -> None:
    user.last_login_at = now()
    audit.record(db, actor_id=user.id, actor_label=user.name, action="signin", entity_type="user", entity_id=user.id)


@router.post("/session", response_model=StepOut)
async def sign_in(body: SignInIn, request: Request, response: Response,
                  db: AsyncSession = Depends(get_session)) -> StepOut:
    emp = normalise_employee_id(body.employee_id)
    ip = client_ip(request)
    await throttle.check(db, emp, ip)

    user = await db.scalar(select(User).where(User.employee_id == emp))
    ok = verify_password(user.password_hash if user else None, body.password)
    if not ok or user is None or not user.active:
        await throttle.record_failure(db, emp, ip)
        audit.record(db, actor_id=user.id if user else None, actor_label=emp, action="signin.failed",
                     entity_type="user", entity_id=user.id if user else emp,
                     reason="suspended" if (user and ok and not user.active) else "bad_credentials")
        await db.commit()
        raise ApiError(401, "invalid_credentials", BAD_CREDENTIALS)
    if temp_password_expired(user):
        audit.record(db, actor_id=user.id, actor_label=user.name, action="signin.failed",
                     entity_type="user", entity_id=user.id, reason="temporary_password_expired")
        await db.commit()
        raise ApiError(401, "temp_password_expired",
                       "Your temporary password has expired. Ask Team OSSC to issue a new one.")

    await throttle.clear(db, emp)
    if not user.must_change_password and needs_rehash(user.password_hash):
        user.password_hash = hash_password(body.password)

    sess, token = await create_session(db, user, request, mfa_ok=False)
    out = step_out(user, sess)
    if out.next == "done":
        sess.mfa_ok = True  # non-admin roles have no second factor
        _signed_in(db, user)
    await db.commit()
    set_cookies(response, token, sess.csrf_token)
    return out


@router.post("/session/totp", response_model=StepOut)
async def verify_totp(body: TotpIn, request: Request, response: Response,
                      p: Principal = Depends(pending_principal),
                      db: AsyncSession = Depends(get_session)) -> StepOut:
    user = await db.get(User, p.user.id, with_for_update=True)
    sess = await db.merge(p.session)
    step = next_step(user, sess)
    if step not in ("totp", "enrol_totp"):
        raise ApiError(409, "mfa_not_pending", "No second-factor step is pending for this session.")

    key = f"totp:{user.employee_id}"
    await throttle.check(db, key, client_ip(request))

    recovery_codes = None
    if step == "enrol_totp":
        matched = totp.match_step(sess.pending_totp_secret or "", body.code)
        if matched is None:
            await _totp_failed(db, key, request, user)
        user.totp_secret = sess.pending_totp_secret
        user.totp_enabled = True
        user.totp_last_step = matched
        recovery_codes, user.recovery_code_hashes = totp.new_recovery_codes()
        sess.pending_totp_secret = None
        audit.record(db, actor_id=user.id, actor_label=user.name, action="totp.enrolled", entity_type="user", entity_id=user.id)
    else:
        matched = totp.match_step(user.totp_secret or "", body.code)
        if matched is not None and user.totp_last_step is not None and matched <= user.totp_last_step:
            matched = None  # replayed code
        if matched is not None:
            user.totp_last_step = matched
        else:
            remaining = totp.consume_recovery_code(user.recovery_code_hashes, body.code)
            if remaining is None:
                await _totp_failed(db, key, request, user)
            user.recovery_code_hashes = remaining
            audit.record(db, actor_id=user.id, actor_label=user.name, action="totp.recovery_code_used",
                         entity_type="user", entity_id=user.id)

    sess.mfa_ok = True
    token = rotate(sess)
    await throttle.clear(db, key)
    out = step_out(user, sess, recovery_codes)
    if out.next == "done":
        _signed_in(db, user)
    await db.commit()
    set_cookies(response, token, sess.csrf_token)
    return out


async def _totp_failed(db: AsyncSession, key: str, request: Request, user: User):
    # rollback() expires loaded objects; read what we need first (no async lazy loads).
    user_id, user_name = user.id, user.name
    await db.rollback()
    await throttle.record_failure(db, key, client_ip(request))
    audit.record(db, actor_id=user_id, actor_label=user_name, action="totp.failed", entity_type="user", entity_id=user_id)
    await db.commit()
    raise ApiError(401, "invalid_code", "That code is not valid. Check the time on your phone and try again.")


@router.post("/session/password", response_model=StepOut)
async def change_password(body: ChangePasswordIn, request: Request, response: Response,
                          p: Principal = Depends(pending_principal),
                          db: AsyncSession = Depends(get_session)) -> StepOut:
    user = await db.get(User, p.user.id, with_for_update=True)
    sess = await db.merge(p.session)
    step = next_step(user, sess)
    if step == "totp":
        raise ApiError(401, "mfa_required", "Enter the code from your authenticator app first.")
    if step == "enrol_totp" and not user.must_change_password:
        raise ApiError(401, "mfa_required", "Set up your authenticator app first.")

    key = f"pw:{user.employee_id}"
    await throttle.check(db, key, client_ip(request))
    if not verify_password(user.password_hash, body.current_password):
        await db.rollback()
        await throttle.record_failure(db, key, client_ip(request))
        await db.commit()
        raise ApiError(400, "invalid_credentials", "Your current password is incorrect.",
                       {"currentPassword": "Incorrect"})
    validate_new_password(body.new_password, user)

    forced = user.must_change_password
    user.password_hash = hash_password(body.new_password)
    user.password_changed_at = now()
    user.must_change_password = False
    user.temp_password_expires_at = None
    # Sign out every other device; this session continues with fresh tokens.
    await db.execute(
        update(UserSession)
        .where(UserSession.user_id == user.id, UserSession.revoked_at.is_(None), UserSession.id != sess.id)
        .values(revoked_at=now())
    )
    token = rotate(sess)
    await throttle.clear(db, key)
    audit.record(db, actor_id=user.id, actor_label=user.name, entity_type="user", entity_id=user.id,
                 action="user.password_set" if forced else "user.password_changed")
    out = step_out(user, sess)
    if out.next == "done" and forced:
        _signed_in(db, user)
    await db.commit()
    set_cookies(response, token, sess.csrf_token)
    return out


@router.delete("/session", status_code=204)
async def sign_out(response: Response, p: Principal = Depends(pending_principal),
                   db: AsyncSession = Depends(get_session)) -> Response:
    sess = await db.merge(p.session)
    sess.revoked_at = now()
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="signout", entity_type="user", entity_id=p.user.id)
    await db.commit()
    response.status_code = 204
    clear_cookies(response)
    return response


@router.get("/me", response_model=MeWithCsrf)
async def me(p: Principal = Depends(current_principal)) -> MeWithCsrf:
    return MeWithCsrf(**me_out(p.user).model_dump(), csrf_token=p.session.csrf_token)
