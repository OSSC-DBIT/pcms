"""DBIT changes of 2026-11-04.

  - The facility manager records the exact cost (optional) when a ticket is marked fixed.
    It is a spending figure: faculty never see it, and the reports show it only to
    the principal, institute management and Team OSSC.
  - Block B gets the Library. The Administrator Block gets the Placement Department,
    Dean's Room, R&D Department, Board Room and Server Room.
  - The Mechanical type is shown as "Mechanical / Electrical".
"""

import csv
import io
from datetime import date, timedelta

from tests.factories import API, ist_today, make_user, new_client, sign_in, ticket_body


async def _get(s, tid):
    return (await s.get(f"{API}/tickets/{tid}")).json()


async def _tr(s, tid, **body):
    v = (await _get(s, tid))["version"]
    return await s.post(f"{API}/tickets/{tid}/transitions", json={"expectedVersion": v, **body})


async def _people(client):
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    await make_user("manager@dbit.edu", "facility_manager", "Manager")
    await make_user("principal@dbit.edu", "principal", "Principal")
    fac = await sign_in(client, "faculty@dbit.edu")
    clients = [new_client() for _ in range(2)]
    mgr = await sign_in(clients[0], "manager@dbit.edu")
    prin = await sign_in(clients[1], "principal@dbit.edu")
    return fac, mgr, prin, clients


async def _assigned(fac, mgr, **over):
    tid = (await fac.post(f"{API}/tickets", json=ticket_body(**over))).json()["id"]
    assert (await _tr(mgr, tid, action="triage", flag="I")).status_code == 200
    assert (await _tr(mgr, tid, action="assign", workerName="Ramesh K")).status_code == 200
    return tid


async def _close(clients):
    for c in clients:
        await c.aclose()


async def test_actual_cost_is_recorded_when_marked_fixed_and_hidden_from_faculty(client):
    fac, mgr, prin, clients = await _people(client)
    try:
        tid = await _assigned(fac, mgr)
        # Only when marking it fixed.
        r = await _tr(mgr, tid, action="set_worker", workerName="Ravi", actualCostPaise=1000)
        assert r.status_code == 400 and "actualCostPaise" in r.json()["field_errors"], r.text
        assert (await _tr(mgr, tid, action="resolve", note="Done", actualCostPaise=-1)).status_code in (400, 422)

        r = await _tr(mgr, tid, action="resolve", note="Replaced the hinge", actualCostPaise=185050)
        assert r.status_code == 200, r.text
        assert r.json()["actualCostPaise"] == 185050
        assert (await _get(prin, tid))["actualCostPaise"] == 185050
        assert (await _get(fac, tid))["actualCostPaise"] is None

        # The cost is optional.
        tid2 = await _assigned(fac, mgr, title="Loose tap")
        r = await _tr(mgr, tid2, action="resolve", note="Tightened")
        assert r.status_code == 200 and r.json()["actualCostPaise"] is None
    finally:
        await _close(clients)


async def test_actual_cost_in_reports_is_for_the_approvers_only(client):
    fac, mgr, prin, clients = await _people(client)
    try:
        tid = await _assigned(fac, mgr)
        assert (await _tr(mgr, tid, action="resolve", note="Done", actualCostPaise=50000)).status_code == 200
        tid2 = await _assigned(fac, mgr, title="Second chair")
        assert (await _tr(mgr, tid2, action="resolve", note="Done", actualCostPaise=25000)).status_code == 200

        today = ist_today()
        params = {"from": (today - timedelta(days=1)).isoformat(), "to": today.isoformat()}

        e = (await prin.get(f"{API}/reports/expenditure", params=params)).json()
        assert e["actualPaise"] == 75000 and e["actualCount"] == 2

        def cse(report):
            return next(d for d in report["byDepartment"] if d["building"] == "BLOCK_A"
                        and d["department"] == "Computer Science and Engineering (CSE)")

        row = cse((await prin.get(f"{API}/reports", params=params)).json())
        assert row["total"] == 2 and row["fixed"] == 2 and row["actualPaise"] == 75000
        assert cse((await mgr.get(f"{API}/reports", params=params)).json())["actualPaise"] is None

        rows = list(csv.DictReader(io.StringIO(
            (await prin.get(f"{API}/reports/expenditure.csv", params=params)).text.lstrip("\ufeff"))))
        assert rows == []  # no expenditure requests; the CSV lists requests only
        assert (await mgr.get(f"{API}/reports/expenditure", params=params)).status_code == 403
    finally:
        await _close(clients)


async def test_actual_cost_beside_the_approved_limit(client):
    fac, mgr, prin, clients = await _people(client)
    try:
        tid = (await fac.post(f"{API}/tickets", json=ticket_body(title="Water tank liner split"))).json()["id"]
        await _tr(mgr, tid, action="triage")
        await _tr(mgr, tid, action="assign")
        v = (await _get(mgr, tid))["version"]
        p = (await mgr.post(f"{API}/tickets/{tid}/proposals", json={
            "lines": [{"label": "New liner", "paise": 150000}],
            "requestedDate": (date.today() + timedelta(days=2)).isoformat(),
            "remedy": "Replace the liner", "expectedVersion": v})).json()["proposal"]
        r = await prin.post(f"{API}/proposals/{p['id']}/decisions",
                            json={"kind": "approved", "proposalVersion": 1, "ceilingPaise": 160000})
        assert r.status_code == 200, r.text
        assert (await _tr(mgr, tid, action="resolve", note="Liner replaced", actualCostPaise=142000)).status_code == 200

        today = ist_today()
        params = {"from": (today - timedelta(days=1)).isoformat(), "to": today.isoformat()}
        item = (await prin.get(f"{API}/reports/expenditure", params=params)).json()["items"][0]
        assert item["approvedPaise"] == 160000 and item["actualPaise"] == 142000
        rows = list(csv.DictReader(io.StringIO(
            (await prin.get(f"{API}/reports/expenditure.csv", params=params)).text.lstrip("\ufeff"))))
        assert rows[0]["approved_limit_inr"] == "1600.00" and rows[0]["actual_cost_inr"] == "1420.00"
    finally:
        await _close(clients)


async def test_spending_by_department(client):
    """DBIT, 2026-11-04: the approvers see spending per department, requested, approved and actual."""
    fac, mgr, prin, clients = await _people(client)
    try:
        cse = {"building": "BLOCK_A", "department": "Computer Science and Engineering (CSE)", "floor": "2", "room": "203"}
        lib = {"building": "BLOCK_B", "department": "Library", "floor": "1", "room": "Reading hall"}
        t1 = await _assigned(fac, mgr, title="CSE lab chair", location=cse)
        assert (await _tr(mgr, t1, action="resolve", actualCostPaise=30000)).status_code == 200
        t2 = await _assigned(fac, mgr, title="CSE lab fan", location=cse)
        assert (await _tr(mgr, t2, action="resolve", actualCostPaise=20000)).status_code == 200
        t3 = await _assigned(fac, mgr, title="Library shelf", location=lib)
        assert (await _tr(mgr, t3, action="resolve", actualCostPaise=90000)).status_code == 200
        t4 = await _assigned(fac, mgr, title="Library roof leak", location=lib)
        v = (await _get(mgr, t4))["version"]
        assert (await mgr.post(f"{API}/tickets/{t4}/proposals", json={
            "lines": [{"label": "Waterproofing", "paise": 500000}], "requestedDate": date.today().isoformat(),
            "remedy": "Waterproof the roof", "expectedVersion": v})).status_code == 200

        today = ist_today()
        params = {"from": (today - timedelta(days=1)).isoformat(), "to": today.isoformat()}
        e = (await prin.get(f"{API}/reports/expenditure", params=params)).json()
        by = {r["department"]: r for r in e["byDepartment"]}
        assert by["Library"]["actualPaise"] == 90000 and by["Library"]["repairs"] == 1
        assert by["Library"]["requests"] == 1 and by["Library"]["requestedPaise"] == 500000
        assert by["Library"]["pendingPaise"] == 500000 and by["Library"]["approvedPaise"] == 0
        cse_row = by["Computer Science and Engineering (CSE)"]
        assert cse_row["actualPaise"] == 50000 and cse_row["repairs"] == 2 and cse_row["requests"] == 0
        assert [r["department"] for r in e["byDepartment"]][0] == "Library"  # largest actual cost first
        assert sum(r["actualPaise"] for r in e["byDepartment"]) == e["actualPaise"]

        # The department filter narrows the breakdown too.
        only = (await prin.get(f"{API}/reports/expenditure", params={**params, "department": "Library"})).json()
        assert [r["department"] for r in only["byDepartment"]] == ["Library"]

        # In the downloads, and never for the facility manager.
        from openpyxl import load_workbook
        wb = load_workbook(io.BytesIO((await prin.get(f"{API}/reports/expenditure.xlsx", params=params)).content))
        sheet = [row for row in wb["By Department"].iter_rows(values_only=True)]
        assert sheet[0][:2] == ("building", "department") and ("BLOCK_B", "Library") in [r[:2] for r in sheet[1:]]
        assert "Spending by Department" in load_workbook(io.BytesIO(
            (await prin.get(f"{API}/reports/export.xlsx", params=params)).content)).sheetnames
        assert "Spending by Department" not in load_workbook(io.BytesIO(
            (await mgr.get(f"{API}/reports/export.xlsx", params=params)).content)).sheetnames
        assert (await mgr.get(f"{API}/reports/expenditure", params=params)).status_code == 403
        assert (await prin.get(f"{API}/reports/export.pdf", params=params)).status_code == 200
    finally:
        await _close(clients)


async def test_new_places_and_mechanical_electrical_name(client):
    await make_user("faculty@dbit.edu", "faculty")
    fac = await sign_in(client, "faculty@dbit.edu")
    body = (await fac.get(f"{API}/catalogs")).json()
    by_code = {b["code"]: b for b in body["buildings"]}

    block_b = by_code["BLOCK_B"]
    assert "Library" in block_b["departments"]
    assert len(block_b["departments"]) == len(block_b["departmentsKn"])

    admin = by_code["ADMIN_BLOCK"]["departments"]
    new = ["Placement Department", "Dean's Room", "R&D Department", "Board Room", "Server Room"]
    assert admin[-len(new) - 1:] == [*new, "Other Area"]

    mech = next(c for c in body["categories"] if c["code"] == "mechanical")
    assert mech["nameEn"] == "Mechanical / Electrical" and mech["letter"] == "M"

    r = await fac.post(f"{API}/tickets", json=ticket_body(location={
        "building": "ADMIN_BLOCK", "department": "Server Room", "floor": by_code["ADMIN_BLOCK"]["floors"][0],
        "room": "Rack 2"}))
    assert r.status_code == 201, r.text
