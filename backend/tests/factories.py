"""Test-only helpers. Accounts are created per test; nothing here ships as data."""

import time
from datetime import timedelta

import pyotp

from app.db import sessionmaker
from app.models.user import User
from app.security.passwords import hash_password
from app.security.sessions import now

PASSWORD = "Correct-horse-42"
API = "/api/v1"


async def make_user(employee_id: str, role: str, name: str | None = None, password: str | None = PASSWORD,
                    active: bool = True, temporary: bool = False) -> User:
    async with sessionmaker()() as s:
        u = User(employee_id=employee_id, name=name or f"User {employee_id}", role=role,
                 password_hash=hash_password(password) if password else None, active=active,
                 totp_enabled=False, recovery_code_hashes=[],
                 must_change_password=temporary,
                 temp_password_expires_at=now() + timedelta(days=7) if temporary else None)
        s.add(u)
        await s.commit()
        await s.refresh(u)
        return u


class Session:
    """Wraps an httpx client with the CSRF header for one signed-in user."""

    def __init__(self, client, csrf: str, totp_secret: str | None = None):
        self.client = client
        self.csrf = csrf
        self.totp_secret = totp_secret

    def _h(self, headers=None):
        return {"X-CSRF-Token": self.csrf, **(headers or {})}

    async def get(self, url, **kw):
        return await self.client.get(url, **kw)

    async def post(self, url, **kw):
        return await self.client.post(url, headers=self._h(kw.pop("headers", None)), **kw)

    async def patch(self, url, **kw):
        return await self.client.patch(url, headers=self._h(kw.pop("headers", None)), **kw)

    async def delete(self, url, **kw):
        return await self.client.request("DELETE", url, headers=self._h(kw.pop("headers", None)), **kw)


def totp_code(secret: str, offset: int = 0) -> str:
    return pyotp.TOTP(secret).at(time.time() + offset)


def new_client():
    import httpx

    from app.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def ticket_body(**over) -> dict:
    import uuid as _uuid

    body = {
        "clientRequestId": str(_uuid.uuid4()), "categoryCode": "carpentry", "subtype": "Chair",
        "location": {"building": "CSE", "floor": "2", "room": "203"},
        "title": "Broken chair in lecture room", "description": "Two chairs have broken backs.",
        "impact": "class_interrupted",
    }
    body.update(over)
    return body


async def make_worker(name="Ramesh K", phone="+919876500001", trades=("carpentry",), mode="whatsapp", active=True):
    from app.db import sessionmaker as sm
    from app.models import Category, Worker, WorkerSkill
    from sqlalchemy import select as sel

    async with sm()() as s:
        w = Worker(name=name, phone_e164=phone, area="Campus", language="kn", mode=mode, kind="employee", active=active, version=1)
        s.add(w)
        await s.flush()
        for code in trades:
            cid = await s.scalar(sel(Category.id).where(Category.code == code))
            s.add(WorkerSkill(worker_id=w.id, category_id=cid))
        await s.commit()
        await s.refresh(w)
        return w


async def sign_in(client, employee_id: str, password: str = PASSWORD, totp_secret: str | None = None,
                  new_password: str | None = None) -> Session:
    """Walk every sign-in step until full access."""
    r = await client.post(f"{API}/session", json={"employeeId": employee_id, "password": password})
    assert r.status_code == 200, r.text
    body = r.json()
    secret = totp_secret
    current = password
    for _ in range(4):
        step, csrf = body["next"], body["csrfToken"]
        if step == "done":
            return Session(client, csrf, secret)
        if step == "change_password":
            new = new_password or "Brand-new-pass-91"
            r = await client.post(f"{API}/session/password", json={"currentPassword": current, "newPassword": new},
                                  headers={"X-CSRF-Token": csrf})
            current = new
        else:
            if step == "enrol_totp":
                secret = body["enrolment"]["secret"]
            r = await client.post(f"{API}/session/totp", json={"code": totp_code(secret)}, headers={"X-CSRF-Token": csrf})
        assert r.status_code == 200, r.text
        body = r.json()
    raise AssertionError("sign-in did not finish")
