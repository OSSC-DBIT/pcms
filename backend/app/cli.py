"""Operational commands: python -m app.cli <command> [options].

  seed                            idempotent catalog seed (categories, buildings)
  create-admin --email E --name NAME
                                  bootstrap a Team OSSC account; prints a temporary
                                  password that must be changed at first sign-in
  create-admin-from-env           the same for every admin in the environment file:
                                  PCMS_ADMIN_1_EMAIL, PCMS_ADMIN_1_NAME, PCMS_ADMIN_1_PASSWORD,
                                  then PCMS_ADMIN_2_..., and so on (PCMS_ADMIN_EMAIL also works).
                                  An empty password is generated. Existing accounts are skipped
  reset-password --email E [--reset-mfa]
                                  break-glass reset when no OSSC admin can sign in
  vapid-keys                      generate a VAPID key pair for web push
  credential-key                  generate a PCMS_CREDENTIAL_KEY value
  check-config                    exit 1 if production settings are unsafe
  create-test-accounts            dev/staging only: one account per role for manual testing
  export-openapi [--out PATH]     write the API contract (Swagger UI is disabled)

Everything else (people, roles, Excel or CSV import) is done in the admin portal.
"""

import argparse
import asyncio
import sys


async def _seed(_: argparse.Namespace) -> int:
    from app.seed import seed_all

    await seed_all()
    print("catalog seed complete")
    return 0


async def _bootstrap_admin(raw_email: str, raw_name: str, password: str | None, *, exists_ok: bool,
                           source: str = "") -> int:
    """Create a Team OSSC account holding a temporary password. Never changes an existing account.

    source names the environment variables the values came from, for messages only.
    """
    import uuid

    from sqlalchemy import select

    from app.db import sessionmaker
    from app.errors import ApiError
    from app.models.user import User, normalise_email
    from app.security.passwords import hash_password
    from app.services import audit
    from app.services.accounts import generate_temporary_password, set_temporary_password, validate_initial_password
    from app.services.users import clean_name, validate_identity

    email = normalise_email(raw_email)
    name = clean_name(raw_name)
    errs = validate_identity(email, name, "ossc")
    if password:
        try:
            validate_initial_password(password, email)
        except ApiError as exc:
            errs["password"] = (exc.field_errors or {}).get("newPassword", exc.message)
    if errs:
        for k, v in errs.items():
            print(f"{source + ': ' if source else ''}{k}: {v}", file=sys.stderr)
        return 2
    async with sessionmaker()() as db:
        if await db.scalar(select(User).where(User.email == email)):
            if exists_ok:
                print(f"account {email} already exists; nothing was changed")
                return 0
            print(f"account {email} already exists; use reset-password", file=sys.stderr)
            return 1
        user = User(id=uuid.uuid4(), email=email, name=name, role="ossc", active=True,
                    totp_enabled=False, recovery_code_hashes=[])
        pw = password or generate_temporary_password()
        set_temporary_password(user, pw, hash_password(pw))
        db.add(user)
        await db.flush()
        audit.record(db, actor_id=None, actor_label="cli", action="user.created", entity_type="user",
                     entity_id=user.id, after={"email": email, "role": "ossc"}, reason="bootstrap")
        try:
            await db.commit()
        except ApiError as exc:  # pragma: no cover
            print(exc.message, file=sys.stderr)
            return 1
    print(f"created {email} (ossc)")
    if password:
        print(f"temporary password: the {source or 'given'}_PASSWORD value")
    else:
        print(f"temporary password: {pw}")
    print("They must change it and set up an authenticator app at first sign-in.")
    return 0


async def _create_admin(a: argparse.Namespace) -> int:
    return await _bootstrap_admin(a.email, a.name, None, exists_ok=False)


def _env_admins() -> tuple[list[tuple[str, str, str, str]], list[str]]:
    """Every admin set in the environment as (source, email, name, password), plus problems.

    Read: PCMS_ADMIN_EMAIL/_NAME/_PASSWORD, then PCMS_ADMIN_1_EMAIL, PCMS_ADMIN_2_EMAIL and so on.
    A slot with all three values empty is skipped, so blank placeholders are fine.
    """
    import os
    import re

    env = {k: v.strip() for k, v in os.environ.items()}
    numbers = sorted({int(m.group(1)) for k in env
                      if (m := re.fullmatch(r"PCMS_ADMIN_(\d+)_(?:EMAIL|NAME|PASSWORD)", k))})
    admins, problems = [], []
    for prefix in ["PCMS_ADMIN"] + [f"PCMS_ADMIN_{n}" for n in numbers]:
        email, name, password = (env.get(f"{prefix}_{part}", "") for part in ("EMAIL", "NAME", "PASSWORD"))
        if not (email or name or password):
            continue
        if not (email and name):
            problems.append(f"{prefix}_EMAIL and {prefix}_NAME are both required")
            continue
        admins.append((prefix, email, name, password))
    return admins, problems


async def _create_admin_from_env(_: argparse.Namespace | None) -> int:
    """Create every Team OSSC admin listed in the environment file. Safe to re-run."""
    admins, problems = _env_admins()
    for problem in problems:
        print(problem, file=sys.stderr)
    if not admins and not problems:
        print("no admins set: add PCMS_ADMIN_1_EMAIL and PCMS_ADMIN_1_NAME (PASSWORD is optional) "
              "to the environment file", file=sys.stderr)
        return 2
    result = 2 if problems else 0
    for source, email, name, password in admins:
        result = max(result, await _bootstrap_admin(email, name, password or None, exists_ok=True, source=source))
    return result


async def _reset_password(a: argparse.Namespace) -> int:
    from sqlalchemy import select

    from app.db import sessionmaker
    from app.models.user import User, normalise_email
    from app.security.sessions import revoke_all_for_user
    from app.services import audit
    from app.services.accounts import issue_temporary_password

    email = normalise_email(a.email)
    async with sessionmaker()() as db:
        user = await db.scalar(select(User).where(User.email == email).with_for_update())
        if user is None:
            print(f"no account {email}", file=sys.stderr)
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
    print(f"temporary password for {email}: {pw}")
    return 0


async def _vapid(_: argparse.Namespace) -> int:
    from app.services.webpush import generate_vapid_keys

    pub, priv = generate_vapid_keys()
    print(f"PCMS_VAPID_PUBLIC_KEY={pub}")
    print(f"PCMS_VAPID_PRIVATE_KEY={priv}")
    return 0


async def _credential_key(_: argparse.Namespace) -> int:
    import secrets

    print(f"PCMS_CREDENTIAL_KEY={secrets.token_urlsafe(48)}")
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
    import uuid

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
        ("test-faculty@dbit.edu", "Test Faculty", "faculty", "Faculty portal: raise and track tickets"),
        ("test-manager@dbit.edu", "Test Facility Manager", "facility_manager", "Admin portal: triage, assign, close"),
        ("test-management@dbit.edu", "Test Institute Management", "management",
         "Institute portal: approve spending, reports"),
        ("test-principal@dbit.edu", "Test Principal", "principal",
         "Principal: view tickets, approve, reject or escalate spending"),
        ("test-admin@dbit.edu", "Test OSSC Admin", "ossc", "Super admin: users, import, catalogs, audit"),
    ]
    out = []
    async with sessionmaker()() as db:
        for email, name, role, what in people:
            u = await db.scalar(select(User).where(User.email == email))
            if u is None:
                u = User(id=uuid.uuid4(), email=email, name=name, role=role, active=True,
                         totp_enabled=False, recovery_code_hashes=[])
                db.add(u)
            else:
                u.active, u.totp_enabled, u.totp_secret, u.totp_last_step, u.recovery_code_hashes = True, False, None, None, []
            pw = issue_temporary_password(u)
            await db.flush()
            audit.record(db, actor_id=None, actor_label="cli", action="user.test_account", entity_type="user", entity_id=u.id)
            out.append((email, role, pw, what))
        await db.commit()
    print("Test accounts (temporary passwords, valid 7 days, must be changed at first sign-in):")
    for email, role, pw, what in out:
        print(f"  {email:<28} {role:<17} {pw}   {what}")
    print("OSSC accounts also need an authenticator app (Google/Microsoft Authenticator) at first sign-in.")
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
        rows = (await db.execute(select(PushSubscription, User.email).join(User, User.id == PushSubscription.user_id))).all()
    sent = failed = 0
    gone = []
    for sub, email in rows:
        r = await webpush.send(sub.endpoint, sub.p256dh, sub.auth,
                               {"title": "PCMS", "body": "Test notification: this device will get ticket updates.", "url": "/", "tag": "pcms-test"}, ttl=600)
        status = "ok" if r.ok else ("gone, removed" if r.gone else f"failed ({r.status or r.error})")
        print(f"  {email:<28} {status}")
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
    import uuid

    from sqlalchemy import select

    from app.config import get_settings
    from app.db import sessionmaker
    from app.models import User
    from app.security.passwords import hash_password
    from app.security.sessions import now

    if get_settings().env == "prod":
        print("refusing: smoke accounts are never created in production", file=sys.stderr)
        return 2
    async with sessionmaker()() as db:
        for email, name, role in [("smoke-faculty@dbit.edu", "Smoke Faculty", "faculty"),
                                  ("smoke-manager@dbit.edu", "Smoke Manager", "facility_manager"),
                                  ("smoke-management@dbit.edu", "Smoke Management", "management"),
                                  ("smoke-principal@dbit.edu", "Smoke Principal", "principal")]:
            u = await db.scalar(select(User).where(User.email == email))
            if u is None:
                u = User(id=uuid.uuid4(), email=email, name=name, role=role, active=True,
                         totp_enabled=False, recovery_code_hashes=[])
                db.add(u)
            # Reset every smoke account, including ones a manual test suspended
            # or gave an authenticator, so the browser suite starts clean.
            u.name = name
            u.role = role
            u.active = True
            u.password_hash = hash_password(a.password)
            u.must_change_password = False
            u.temp_password_expires_at = None
            u.temp_password_enc = None
            u.password_changed_at = now()
            u.totp_enabled = False
            u.totp_secret = None
            u.totp_last_step = None
            u.recovery_code_hashes = []
        await db.commit()
    print("smoke accounts ready: smoke-faculty@dbit.edu, smoke-manager@dbit.edu, smoke-management@dbit.edu, "
          "smoke-principal@dbit.edu")
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
    p.add_argument("--email", required=True)
    p.add_argument("--name", required=True)
    p.set_defaults(fn=_create_admin)
    sub.add_parser("create-admin-from-env").set_defaults(fn=_create_admin_from_env)
    p = sub.add_parser("reset-password")
    p.add_argument("--email", required=True)
    p.add_argument("--reset-mfa", action="store_true")
    p.set_defaults(fn=_reset_password)
    sub.add_parser("vapid-keys").set_defaults(fn=_vapid)
    sub.add_parser("credential-key").set_defaults(fn=_credential_key)
    sub.add_parser("check-config").set_defaults(fn=_check)
    args = parser.parse_args(argv[1:])
    return asyncio.run(args.fn(args))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
