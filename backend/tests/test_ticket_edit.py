import io

from PIL import Image
from sqlalchemy import func, select

from app.db import sessionmaker
from app.models import AuditEvent
from tests.factories import API, make_user, new_client, sign_in, ticket_body


async def _faculty(client, email="faculty@dbit.edu"):
    await make_user(email, "faculty", f"Faculty {email}")
    return await sign_in(client, email)


async def _manager(client, email="manager@dbit.edu"):
    await make_user(email, "facility_manager", f"Manager {email}")
    return await sign_in(client, email)


def _edit_body(**over):
    body = ticket_body()
    body.pop("clientRequestId")
    body["expectedVersion"] = 1
    body.update(over)
    return body


def _jpeg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (32, 24), (20, 120, 220)).save(buf, format="JPEG")
    return buf.getvalue()


async def test_reporter_edits_their_ticket_and_history_is_kept(client):
    fac = await _faculty(client)
    created = (await fac.post(f"{API}/tickets", json=ticket_body())).json()

    body = _edit_body(
        categoryCode="it_services", subtype="Computer / Laptop", title="Laptop will not start",
        description="The lab laptop shows no power light.", impact="safety",
        location={"building": "BLOCK_B", "floor": "1", "room": "Lab 2"},
    )
    r = await fac.patch(f"{API}/tickets/{created['id']}", json=body)
    assert r.status_code == 200, r.text
    t = r.json()
    assert t["token"] == created["token"]
    assert t["version"] == 2
    assert t["categoryCode"] == "it_services" and t["subtype"] == "Computer / Laptop"
    assert t["title"] == "Laptop will not start" and t["priority"] == "P1"
    assert t["location"]["building"] == "BLOCK_B" and t["location"]["room"] == "Lab 2"
    assert any(e["action"] == "Ticket details updated by the reporter"  for e in t["events"])

    async with sessionmaker()() as db:
        assert await db.scalar(select(func.count()).select_from(AuditEvent).where(
            AuditEvent.action == "ticket.updated_by_reporter")) == 1

    same = await fac.patch(f"{API}/tickets/{created['id']}", json={**body, "expectedVersion": 2})
    assert same.status_code == 200 and same.json()["version"] == 2

    stale = await fac.patch(f"{API}/tickets/{created['id']}", json={**body, "title": "Another title"})
    assert stale.status_code == 409 and stale.json()["code"] == "stale_version"


async def test_only_the_reporter_can_edit_and_attachments_survive(client):
    fac = await _faculty(client)
    created = (await fac.post(f"{API}/tickets", json=ticket_body())).json()
    up = await fac.post(f"{API}/tickets/{created['id']}/attachments",
                        files={"file": ("photo.jpg", _jpeg(), "image/jpeg")})
    assert up.status_code == 202, up.text
    attachment_id = up.json()["id"]

    async with new_client() as other:
        stranger = await _faculty(other, "faculty2@dbit.edu")
        assert (await stranger.patch(f"{API}/tickets/{created['id']}", json=_edit_body())).status_code == 404

    async with new_client() as mc:
        manager = await _manager(mc)
        assert (await manager.patch(f"{API}/tickets/{created['id']}", json=_edit_body())).status_code == 403

    r = await fac.patch(f"{API}/tickets/{created['id']}", json=_edit_body(title="Corrected chair report"))
    assert r.status_code == 200
    assert [a["id"] for a in r.json()["attachments"]] == [attachment_id]


async def test_edit_is_allowed_after_triage_but_closed_after_assignment(client):
    fac = await _faculty(client)
    created = (await fac.post(f"{API}/tickets", json=ticket_body())).json()
    async with new_client() as mc:
        manager = await _manager(mc)
        triaged = await manager.post(f"{API}/tickets/{created['id']}/transitions",
                                     json={"action": "triage", "priority": "P3", "expectedVersion": 1})
        assert triaged.status_code == 200, triaged.text
        assert triaged.json()["status"] == "Triaged"

        r = await fac.patch(f"{API}/tickets/{created['id']}",
                            json={**_edit_body(title="Chair still broken"), "expectedVersion": 2})
        assert r.status_code == 200 and r.json()["version"] == 3

        assigned = await manager.post(f"{API}/tickets/{created['id']}/transitions",
                                      json={"action": "assign", "expectedVersion": 3})
        assert assigned.status_code == 200, assigned.text

    blocked = await fac.patch(f"{API}/tickets/{created['id']}", json=_edit_body(title="Too late now"))
    assert blocked.status_code == 409 and blocked.json()["code"] == "ticket_not_editable"
    assert "work has started" in blocked.json()["message"]
