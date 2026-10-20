"""Operational commands: python -m app.cli <command> [options].

  seed                            idempotent catalog seed (categories, buildings)
  create-admin --employee-id ID --name NAME [--email E]
                                  bootstrap a Team OSSC account; prints a temporary
                                  password that must be changed at first sign-in
  reset-password --employee-id ID [--reset-mfa]
                                  break-glass reset when no OSSC admin can sign in
  vapid-keys                      generate a VAPID key pair for web push
  check-config                    exit 1 if production settings are unsafe
  create-test-accounts            dev/staging only: one account per role for manual testing
  export-openapi [--out PATH]     write the API contract (Swagger UI is disabled)

Everything else (people, roles, CSV import) is done in the admin portal.
"""

import argparse
import asyncio
import sys


async def _seed(_: argparse.Namespace) -> int:
    from app.seed import seed_all

    await seed_all()
    print("catalog seed complete")
    return 0


async def _create_admin(a: argparse.Namespace) -> int:
    from sqlalchemy import select

    from app.db import sessionmaker
    from app.errors import ApiError
    from app.models.user import User, normalise_employee_id
    from app.services import audit
    from app.services.accounts import issue_temporary_password
    from app.services.users import clean_name, validate_identity

    emp = normalise_employee_id(a.employee_id)
    name = clean_name(a.name)
    errs = validate_identity(emp, name, "ossc", a.email)
    if errs:
        for k, v in errs.items():
            print(f"{k}: {v}", file=sys.stderr)
        return 2
    async with sessionmaker()() as db:
        if await db.scalar(select(User).where(User.employee_id == emp)):
            print(f"account {emp} already exists; use reset-password", file=sys.stderr)
            return 1
        user = User(employee_id=emp, name=name, role="ossc", email=a.email, active=True,
                    totp_enabled=False, recovery_code_hashes=[])
        pw = issue_temporary_password(user)
        db.add(user)
        await db.flush()
        audit.record(db, actor_id=None, actor_label="cli", action="user.created", entity_type="user",
                     entity_id=user.id, after={"employeeId": emp, "role": "ossc"}, reason="bootstrap")
        try:
            await db.commit()
        except ApiError as exc:  # pragma: no cover
            print(exc.message, file=sys.stderr)
            return 1
    print(f"created {emp} (ossc)")
    print(f"temporary password: {pw}")
    print("Give it to the person directly. They must change it and set up an authenticator app at first sign-in.")
    return 0


async def _reset_password(a: argparse.Namespace) -> int:
    from sqlalchemy import select

    from app.db import sessionmaker
    from app.models.user import User, normalise_employee_id
    from app.security.sessions import revoke_all_for_user
    from app.services import audit
    from app.services.accounts import issue_temporary_password

    emp = normalise_employee_id(a.employee_id)
    async with sessionmaker()() as db:
        user = await db.scalar(select(User).where(User.employee_id == emp).with_for_update())
        if user is None:
            print(f"no account {emp}", file=sys.stderr)
            return 1
        pw = issue_temporary_password(user)
        if a.reset_mfa:
            user.totp_enabled = False
            user.totp_secret = None
            user.totp_last_step = None
            user.recovery_code_hashes = []
        user.version += 1
        await revoke_all_for_user(db, user.id)
        audit.record(db, actor_id=None, actor_label="cli", action="user.password_reset", entity_type="user",
                     entity_id=user.id, reason="cli break-glass" + (" including second factor" if a.reset_mfa else ""))
        await db.commit()
    print(f"temporary password for {emp}: {pw}")
    return 0


async def _vapid(_: argparse.Namespace) -> int:
    from app.services.webpush import generate_vapid_keys

    pub, priv = generate_vapid_keys()
    print(f"PCMS_VAPID_PUBLIC_KEY={pub}")
    print(f"PCMS_VAPID_PRIVATE_KEY={priv}")
    return 0


async def _check(_: argparse.Namespace) -> int:
    from app.config import get_settings

    problems = get_settings().check_production()
    for p in problems:
        print(f"config error: {p}", file=sys.stderr)
    if not problems:
        print("configuration ok")
    return 1 if problems else 0


async def _test_accounts(_: argparse.Namespace) -> int:
    """Manual-testing accounts. Refuses to run in production."""
    from sqlalchemy import select

    from app.config import get_settings
    from app.db import sessionmaker
    from app.models import User
    from app.services import audit
    from app.services.accounts import issue_temporary_password

    if get_settings().env == "prod":
        print("refusing: test accounts are never created in production", file=sys.stderr)
        return 2
    people = [
        ("TEST-FAC01", "Test Faculty", "faculty", "Faculty portal: raise and track tickets"),
        ("TEST-FM01", "Test Facility Manager", "facility_manager", "Admin portal: triage, assign, close"),
        ("TEST-INST01", "Test Institute Management", "management", "Institute portal: approve spending, reports"),
        ("TEST-OSSC01", "Test OSSC Admin", "ossc", "Super admin: users, CSV import, catalogs, audit"),
    ]
    out = []
    async with sessionmaker()() as db:
        for emp, name, role, what in people:
            u = await db.scalar(select(User).where(User.employee_id == emp))
            if u is None:
                u = User(employee_id=emp, name=name, role=role, active=True, totp_enabled=False, recovery_code_hashes=[])
                db.add(u)
            else:
                u.active, u.totp_enabled, u.totp_secret, u.totp_last_step, u.recovery_code_hashes = True, False, None, None, []
            pw = issue_temporary_password(u)
            await db.flush()
            audit.record(db, actor_id=None, actor_label="cli", action="user.test_account", entity_type="user", entity_id=u.id)
            out.append((emp, role, pw, what))
        await db.commit()
    print("Test accounts (temporary passwords, valid 7 days, must be changed at first sign-in):")
    for emp, role, pw, what in out:
        print(f"  {emp:<12} {role:<17} {pw}   {what}")
    print("Admin-portal accounts also need an authenticator app (Google/Microsoft Authenticator) at first sign-in.")
    return 0


async def _export_openapi(a: argparse.Namespace) -> int:
    import json
    from pathlib import Path

    from app.main import create_app

    spec = create_app().openapi()
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {a.out} ({len(spec['paths'])} paths)")
    return 0


async def _push_test_all(_: argparse.Namespace) -> int:
    """Send one test notification to every saved browser subscription; remove dead ones."""
    from sqlalchemy import delete, select

    from app.db import sessionmaker
    from app.models import PushSubscription, User
    from app.services import webpush

    if not webpush.is_configured():
        print("web push is not configured (PCMS_VAPID_PUBLIC_KEY / PCMS_VAPID_PRIVATE_KEY)", file=sys.stderr)
        return 1
    async with sessionmaker()() as db:
        rows = (await db.execute(select(PushSubscription, User.employee_id).join(User, User.id == PushSubscription.user_id))).all()
    sent = failed = 0
    gone = []
    for sub, emp in rows:
        r = await webpush.send(sub.endpoint, sub.p256dh, sub.auth,
                               {"title": "PCMS", "body": "Test notification: this device will get ticket updates.", "url": "/", "tag": "pcms-test"}, ttl=600)
        status = "ok" if r.ok else ("gone, removed" if r.gone else f"failed ({r.status or r.error})")
        print(f"  {emp:<14} {status}")
        sent += r.ok
        failed += not r.ok
        if r.gone:
            gone.append(sub.id)
    if gone:
        async with sessionmaker()() as db:
            await db.execute(delete(PushSubscription).where(PushSubscription.id.in_(gone)))
            await db.commit()
    print(f"{len(rows)} subscription(s): {sent} sent, {failed} failed")
    return 0


async def _smoke_accounts(a: argparse.Namespace) -> int:
    """Known-password accounts for the automated browser test (CI and dev only)."""
    from sqlalchemy import select

    from app.config import get_settings
    from app.db import sessionmaker
    from app.models import User
    from app.security.passwords import hash_password

    if get_settings().env == "prod":
        print("refusing: smoke accounts are never created in production", file=sys.stderr)
        return 2
    async with sessionmaker()() as db:
        for emp, name, role in [("SMOKE-FAC", "Smoke Faculty", "faculty"), ("SMOKE-FM", "Smoke Manager", "facility_manager")]:
            u = await db.scalar(select(User).where(User.employee_id == emp))
            if u is None:
                u = User(employee_id=emp, name=name, role=role, active=True, totp_enabled=False, recovery_code_hashes=[])
                db.add(u)
            u.password_hash = hash_password(a.password)
            u.must_change_password = False
            u.temp_password_expires_at = None
        await db.commit()
    print("smoke accounts ready: SMOKE-FAC, SMOKE-FM")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("create-smoke-accounts")
    p.add_argument("--password", required=True)
    p.set_defaults(fn=_smoke_accounts)
    sub.add_parser("push-test-all").set_defaults(fn=_push_test_all)
    sub.add_parser("seed").set_defaults(fn=_seed)
    sub.add_parser("create-test-accounts").set_defaults(fn=_test_accounts)
    p = sub.add_parser("export-openapi")
    p.add_argument("--out", default="openapi/openapi.json")
    p.set_defaults(fn=_export_openapi)
    p = sub.add_parser("create-admin")
    p.add_argument("--employee-id", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--email")
    p.set_defaults(fn=_create_admin)
    p = sub.add_parser("reset-password")
    p.add_argument("--employee-id", required=True)
    p.add_argument("--reset-mfa", action="store_true")
    p.set_defaults(fn=_reset_password)
    sub.add_parser("vapid-keys").set_defaults(fn=_vapid)
    sub.add_parser("check-config").set_defaults(fn=_check)
    args = parser.parse_args(argv[1:])
    return asyncio.run(args.fn(args))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
