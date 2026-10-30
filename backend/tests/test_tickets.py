import asyncio
import re
import uuid
from types import SimpleNamespace

from sqlalchemy import func, select

from app.db import sessionmaker
from app.models import Outbox, Ticket
from app.services import tickets as ticket_service
from app.services.tickets import format_token, ist_year
from tests.factories import API, make_user, new_client, sign_in, ticket_body


def test_other_subtype_detection_is_not_substring_based():
    cat = SimpleNamespace(code="it_services")
    assert ticket_service._is_other_issue(cat, "Motherboard") is False
    assert ticket_service._is_other_issue(cat, "Other IT Issue") is True


async def _faculty(client, emp="faculty@dbit.edu"):
    await make_user(emp, "faculty", f"Faculty {emp}")
    return await sign_in(client, emp)


async def test_create_returns_token_and_replays(client):
    s = await _faculty(client)
    body = ticket_body()
    r = await s.post(f"{API}/tickets", json=body)
    assert r.status_code == 201, r.text
    created = r.json()
    yy = ist_year() % 100
    assert created["token"] == f"V{yy:02d}-0001"
    assert created["status"] == "Submitted" and created["version"] == 1 and created["attachmentUploadAllowed"]

    again = await s.post(f"{API}/tickets", json=body)
    assert again.status_code == 200 and again.json()["id"] == created["id"]

    changed = await s.post(f"{API}/tickets", json={**body, "title": "Something else entirely"})
    assert changed.status_code == 409 and changed.json()["code"] == "idempotency_conflict"

    t = (await s.get(f"{API}/tickets/{created['id']}")).json()
    assert t["priority"] == "P2" and t["reporterName"] == "Faculty faculty@dbit.edu"
    assert t["events"][0]["action"] == "Your report was received"


async def test_validation_errors(client):
    s = await _faculty(client)
    r = await s.post(f"{API}/tickets", json=ticket_body(title="no", categoryCode="nope"))
    assert r.status_code == 400
    assert {"title", "categoryCode"} <= set(r.json()["field_errors"])
    r = await s.post(f"{API}/tickets", json=ticket_body(location={
        "building": "BLOCK_A", "department": "Computer Science and Engineering (CSE)",
        "floor": "99", "room": "1"}))
    assert r.status_code == 400 and "location" in r.json()["field_errors"]
    r = await s.post(f"{API}/tickets", json=ticket_body(location={"outdoors": True}))
    assert r.status_code == 400
    r = await s.post(f"{API}/tickets", json=ticket_body(
        location={"building": "BLOCK_A", "department": "Computer Science and Engineering (CSE)",
                  "outdoors": True, "landmark": "Main gate"}))
    assert r.status_code == 201


async def test_staff_cannot_create_without_capability(client):
    await make_user("management@dbit.edu", "management")
    s = await sign_in(client, "management@dbit.edu")
    assert (await s.post(f"{API}/tickets", json=ticket_body())).status_code == 403


async def test_100_parallel_creates_yield_unique_sequential_tokens(client):
    await make_user("faculty@dbit.edu", "faculty")
    clients = [new_client() for _ in range(4)]
    sessions = [await sign_in(c, "faculty@dbit.edu") for c in clients]
    gate = asyncio.Semaphore(25)

    async def one(i):
        async with gate:
            return await sessions[i % 4].post(f"{API}/tickets", json=ticket_body())

    results = await asyncio.gather(*(one(i) for i in range(100)))
    for c in clients:
        await c.aclose()
    assert all(r.status_code == 201 for r in results), {r.status_code for r in results}
    tokens = [r.json()["token"] for r in results]
    assert len(set(tokens)) == 100
    serials = sorted(int(re.search(r"-(\d{4,})$", t).group(1)) for t in tokens)
    assert serials == list(range(1, 101))


async def test_concurrent_identical_retries_create_one_ticket(client):
    s = await _faculty(client)
    body = ticket_body()
    results = await asyncio.gather(*(s.post(f"{API}/tickets", json=body) for _ in range(8)))
    assert sorted(r.status_code for r in results).count(201) == 1
    assert {r.json()["id"] for r in results} == {results[0].json()["id"]}
    async with sessionmaker()() as db:
        assert await db.scalar(select(func.count()).select_from(Ticket)) == 1


async def test_faculty_cannot_see_other_reporters_tickets(client):
    s1 = await _faculty(client, "faculty@dbit.edu")
    created = (await s1.post(f"{API}/tickets", json=ticket_body())).json()
    async with new_client() as other:
        s2 = await _faculty(other, "faculty2@dbit.edu")
        assert (await s2.get(f"{API}/tickets/{created['id']}")).status_code == 404
        assert (await s2.get(f"{API}/tickets/{uuid.uuid4()}")).status_code == 404
        assert (await s2.get(f"{API}/tickets?scope=mine")).json()["total"] == 0
        assert (await s2.get(f"{API}/tickets?scope=queue")).status_code == 403
        # Duplicate hints show token and title only.
        d = (await s2.get(f"{API}/tickets/duplicates", params={"category": "civil", "building": "BLOCK_A", "room": "203"})).json()
        assert d == [{"token": created["token"], "title": "Broken chair in lecture room", "status": "Submitted"}]


async def test_create_queues_receipt_and_manager_alerts(client):
    u = await make_user("faculty@dbit.edu", "faculty")
    async with sessionmaker()() as db:
        (await db.get(type(u), u.id)).email = "faculty@example.edu"
        await db.commit()
    await make_user("manager@dbit.edu", "facility_manager")
    s = await sign_in(client, "faculty@example.edu")
    await s.post(f"{API}/tickets", json=ticket_body())
    async with sessionmaker()() as db:
        rows = (await db.scalars(select(Outbox))).all()
    templates = {(o.template, o.channel) for o in rows}
    assert ("receipt", "email") in templates


def test_token_starts_with_type_letter_and_grows_past_9999():
    assert format_token("C", 2026, 123) == "C26-0123"
    assert format_token("W", 2027, 10000) == "W27-10000"


async def test_other_needs_a_description(client):
    s = await _faculty(client)
    r = await s.post(f"{API}/tickets", json=ticket_body(subtype="Other Civil Issue"))
    assert r.status_code == 400 and "otherDetail" in r.json()["field_errors"]
    r = await s.post(f"{API}/tickets", json=ticket_body(subtype="Other Civil Issue", otherDetail="Bench"))
    assert r.status_code == 201
    t = (await s.get(f"{API}/tickets/{r.json()['id']}")).json()
    assert t["subtype"] == "Other Civil Issue: Bench"
    r = await s.post(f"{API}/tickets", json=ticket_body(categoryCode="other", subtype=None, otherDetail="Water cooler"))
    assert r.status_code == 400 and "categoryCode" in r.json()["field_errors"]


async def test_custom_location_and_area_validation(client):
    s = await _faculty(client)
    custom = ticket_body(location={"building": "CUSTOM", "customLocation": "Workshop near the back gate",
                                   "department": "Mechanical Workshop", "floor": "Ground", "room": "Tool room"})
    r = await s.post(f"{API}/tickets", json=custom)
    assert r.status_code == 201, r.text
    t = (await s.get(f"{API}/tickets/{r.json()['id']}")).json()
    assert t["location"] == {"building": "", "customLocation": "Workshop near the back gate",
                             "department": "Mechanical Workshop", "floor": "Ground",
                             "room": "Tool room", "outdoors": False, "landmark": None}

    missing = ticket_body(location={"building": "CUSTOM", "floor": "Ground", "room": "Tool room"})
    r = await s.post(f"{API}/tickets", json=missing)
    assert r.status_code == 400 and "location" in r.json()["field_errors"]

    no_department = ticket_body(location={"building": "CUSTOM", "customLocation": "Workshop annex",
                                          "floor": "Ground", "room": "Tool room"})
    r = await s.post(f"{API}/tickets", json=no_department)
    assert r.status_code == 400 and "location" in r.json()["field_errors"]

    wrong = ticket_body(location={"building": "BLOCK_A", "customLocation": "Somewhere else",
                                  "department": "Computer Science and Engineering (CSE)",
                                  "floor": "2", "room": "203"})
    r = await s.post(f"{API}/tickets", json=wrong)
    assert r.status_code == 400 and "location" in r.json()["field_errors"]

    area = ticket_body(location={"building": "ADMIN_BLOCK", "department": "Principal's Office",
                                 "floor": "1", "room": "Cabin"})
    r = await s.post(f"{API}/tickets", json=area)
    assert r.status_code == 201, r.text
    t = (await s.get(f"{API}/tickets/{r.json()['id']}")).json()
    assert t["location"]["department"] == "Principal's Office"


async def test_department_must_belong_to_the_chosen_building(client):
    s = await _faculty(client)
    r = await s.post(f"{API}/tickets", json=ticket_body(location={
        "building": "BLOCK_A", "floor": "2", "room": "203"}))
    assert r.status_code == 400 and "location" in r.json()["field_errors"]

    r = await s.post(f"{API}/tickets", json=ticket_body(location={
        "building": "BLOCK_A", "department": "Artificial Intelligence and Machine Learning (AI/ML)",
        "floor": "2", "room": "203"}))
    assert r.status_code == 400 and "location" in r.json()["field_errors"]

    r = await s.post(f"{API}/tickets", json=ticket_body(location={
        "building": "BLOCK_A", "department": "Information Science and Engineering (ISE)",
        "floor": "2", "room": "203"}))
    assert r.status_code == 201, r.text
    t = (await s.get(f"{API}/tickets/{r.json()['id']}")).json()
    assert t["location"]["department"] == "Information Science and Engineering (ISE)"


async def test_sports_department_has_no_subdivision(client):
    s = await _faculty(client)
    r = await s.post(f"{API}/tickets", json=ticket_body(location={
        "building": "SPORTS", "department": "Physics", "floor": "Ground", "room": "Main ground"}))
    assert r.status_code == 201, r.text
    t = (await s.get(f"{API}/tickets/{r.json()['id']}")).json()
    assert t["location"]["building"] == "SPORTS"
    assert t["location"]["department"] == ""
    assert t["location"]["floor"] == "Ground"
    assert t["location"]["room"] == "Main ground"



async def test_cli_test_accounts_refuse_production(monkeypatch):
    import argparse

    from app.cli import _test_accounts
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "env", "prod")
    assert await _test_accounts(argparse.Namespace()) == 2
