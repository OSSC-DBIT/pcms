"""DBIT changes of 2026-10-30.

  - A ticket marked Critical goes to the principal first. The principal approves,
    rejects or escalates it to institute management, who make the final decision.
  - Messages on a ticket are for staff only: the facility manager, management,
    the principal and Team OSSC.
  - Every staff role can report a problem and add photos and documents; each
    attachment shows who added it.
  - The principal, management and Team OSSC see expenditure in INR for a date
    range and can download it as CSV or Excel.
"""

import csv
import io
import zipfile
from datetime import date, timedelta

from tests.factories import API, ist_today, make_user, new_client, sign_in, ticket_body

PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
# Staff files are sent with purpose=document; photos and videos are the reporter's.
DOC = {"purpose": "document"}


def docx(macro: bool = False) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-'
                   'officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0"?><Relationships '
                                  'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')
        z.writestr("word/document.xml", '<?xml version="1.0"?><w:document '
                                        'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                                        '<w:body/></w:document>')
        if macro:
            z.writestr("word/vbaProject.bin", b"\0" * 64)
    return buf.getvalue()


async def _get(s, tid):
    return (await s.get(f"{API}/tickets/{tid}")).json()


async def _tr(s, tid, **body):
    v = (await _get(s, tid))["version"]
    return await s.post(f"{API}/tickets/{tid}/transitions", json={"expectedVersion": v, **body})


async def _people(client):
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    await make_user("manager@dbit.edu", "facility_manager", "Manager")
    await make_user("management@dbit.edu", "management", "Management")
    await make_user("principal@dbit.edu", "principal", "Principal")
    fac = await sign_in(client, "faculty@dbit.edu")
    clients = [new_client() for _ in range(3)]
    mgr = await sign_in(clients[0], "manager@dbit.edu")
    mgmt = await sign_in(clients[1], "management@dbit.edu")
    prin = await sign_in(clients[2], "principal@dbit.edu")
    return fac, mgr, mgmt, prin, clients


async def _critical(fac, mgr, paise=150000, title="Water tank liner split"):
    tid = (await fac.post(f"{API}/tickets", json=ticket_body(impact="red", title=title))).json()["id"]
    await _tr(mgr, tid, action="triage")
    await _tr(mgr, tid, action="assign", workerName="Ramesh K")
    v = (await _get(mgr, tid))["version"]
    r = await mgr.post(f"{API}/tickets/{tid}/proposals", json={
        "lines": [{"label": "New liner", "paise": paise}] if paise else [],
        "requestedDate": (date.today() + timedelta(days=2)).isoformat(),
        "remedy": "Replace the liner", "expectedVersion": v})
    assert r.status_code == 200, r.text
    return tid, r.json()["proposal"]


def _decision(kind, version, **extra):
    return {"kind": kind, "proposalVersion": version, **extra}


async def _close(clients):
    for c in clients:
        await c.aclose()


async def test_principal_can_view_report_and_upload_but_not_handle_tickets(client):
    fac, mgr, mgmt, prin, clients = await _people(client)
    try:
        me = (await prin.get(f"{API}/me")).json()
        assert sorted(me["capabilities"]) == ["cost.principal", "queue.view", "ticket.attach",
                                              "ticket.create", "ticket.track", "ticket.verify"]
        tid = (await fac.post(f"{API}/tickets", json=ticket_body())).json()["id"]
        assert (await prin.get(f"{API}/tickets", params={"scope": "queue"})).json()["total"] == 1
        assert (await prin.get(f"{API}/reports")).status_code == 200
        assert (await _tr(prin, tid, action="triage")).status_code == 403
        assert (await _tr(prin, tid, action="reject", reason="no")).status_code == 403
        up = await prin.post(f"{API}/tickets/{tid}/attachments", files={"file": ("q.pdf", PDF, "application/pdf")}, data=DOC)
        assert up.status_code == 202 and up.json()["uploadedBy"] == "Principal"
    finally:
        await _close(clients)


async def test_critical_goes_to_the_principal_first(client):
    fac, mgr, mgmt, prin, clients = await _people(client)
    try:
        tid, p = await _critical(fac, mgr)
        assert p["stage"] == "principal" and p["state"] == "pending"
        # Institute management waits for the principal.
        r = await mgmt.post(f"{API}/proposals/{p['id']}/decisions", json=_decision("approved", 1, ceilingPaise=150000))
        assert r.status_code == 403
        # Only approve, reject or escalate at the principal stage.
        r = await prin.post(f"{API}/proposals/{p['id']}/decisions", json=_decision("clarify", 1, reason="?"))
        assert r.status_code == 400
        r = await prin.post(f"{API}/proposals/{p['id']}/decisions", json=_decision("approved", 1, ceilingPaise=160000))
        assert r.status_code == 200, r.text
        t = r.json()
        assert t["status"] == "InProgress" and t["proposal"]["state"] == "approved"
        assert t["proposal"]["decidedBy"] == "Principal"
        assert (await _get(fac, tid))["proposal"] is None  # faculty never see costs
    finally:
        await _close(clients)


async def test_principal_escalates_to_management_who_decide(client):
    fac, mgr, mgmt, prin, clients = await _people(client)
    try:
        tid, p = await _critical(fac, mgr)
        assert (await prin.post(f"{API}/proposals/{p['id']}/decisions",
                                json=_decision("escalated", 1))).status_code == 400  # reason required
        r = await prin.post(f"{API}/proposals/{p['id']}/decisions",
                            json=_decision("escalated", 1, reason="Above the principal's spending limit"))
        assert r.status_code == 200, r.text
        t = r.json()
        assert t["status"] == "AwaitingApproval"
        p2 = t["proposal"]
        assert p2["version"] == 2 and p2["stage"] == "management" and p2["state"] == "pending"
        assert p2["totalPaise"] == 150000

        # Now the principal cannot decide it, and management cannot escalate further.
        assert (await prin.post(f"{API}/proposals/{p2['id']}/decisions",
                                json=_decision("approved", 2, ceilingPaise=150000))).status_code == 403
        assert (await mgmt.post(f"{API}/proposals/{p2['id']}/decisions",
                                json=_decision("escalated", 2, reason="x"))).status_code == 400
        r = await mgmt.post(f"{API}/proposals/{p2['id']}/decisions", json=_decision("approved", 2, ceilingPaise=150000))
        assert r.status_code == 200, r.text
        t = r.json()
        assert t["status"] == "InProgress" and t["proposal"]["decidedBy"] == "Management"
        # The escalated version is closed.
        assert (await prin.post(f"{API}/proposals/{p['id']}/decisions",
                                json=_decision("approved", 1, ceilingPaise=150000))).status_code == 409
    finally:
        await _close(clients)


async def test_principal_rejects_or_management_asks_a_question(client):
    fac, mgr, mgmt, prin, clients = await _people(client)
    try:
        tid, p = await _critical(fac, mgr, paise=0)
        r = await prin.post(f"{API}/proposals/{p['id']}/decisions", json=_decision("rejected", 1, reason="Not now"))
        assert r.status_code == 200 and r.json()["status"] == "OnHold"

        tid2, p = await _critical(fac, mgr, title="Lift door jammed")
        p2 = (await prin.post(f"{API}/proposals/{p['id']}/decisions",
                              json=_decision("escalated", 1, reason="Needs the board"))).json()["proposal"]
        r = await mgmt.post(f"{API}/proposals/{p2['id']}/decisions",
                            json=_decision("clarify", 2, reason="Send two vendor quotes"))
        assert r.status_code == 200 and r.json()["status"] == "OnHold"
        assert "Send two vendor quotes" in r.json()["holdReason"]
    finally:
        await _close(clients)


async def test_messages_are_shared_by_staff_only(client):
    fac, mgr, mgmt, prin, clients = await _people(client)
    try:
        tid = (await fac.post(f"{API}/tickets", json=ticket_body())).json()["id"]
        for s, body in ((mgr, "Vendor quote pending"), (mgmt, "Budget head 4B"), (prin, "Approve if under 2 lakh")):
            r = await s.post(f"{API}/tickets/{tid}/comments", json={"body": body})
            assert r.status_code == 200, r.text
        assert (await fac.post(f"{API}/tickets/{tid}/comments", json={"body": "Hello"})).status_code == 403
        assert [c["actor"] for c in (await _get(prin, tid))["comments"]] == ["Manager", "Management", "Principal"]
        assert (await _get(fac, tid))["comments"] == []
    finally:
        await _close(clients)


async def test_documents_show_who_added_them_and_stay_internal(client):
    fac, mgr, mgmt, prin, clients = await _people(client)
    try:
        tid = (await fac.post(f"{API}/tickets", json=ticket_body())).json()["id"]
        r = await fac.post(f"{API}/tickets/{tid}/attachments", files={"file": ("q.pdf", PDF, "application/pdf")})
        assert r.status_code == 400 and r.json()["code"] == "media_rejected"  # faculty add photos, not documents
        r = await fac.post(f"{API}/tickets/{tid}/attachments", files={"file": ("q.pdf", PDF, "application/pdf")}, data=DOC)
        assert r.status_code == 403

        r = await mgr.post(f"{API}/tickets/{tid}/attachments", files={"file": ("quote.pdf", PDF, "application/pdf")},
                           data=DOC)
        assert r.status_code == 202, r.text
        pdf = r.json()
        assert pdf["kind"] == "document" and pdf["uploadedBy"] == "Manager"
        assert (await mgmt.post(f"{API}/tickets/{tid}/attachments",
                                files={"file": ("approval.docx", docx(), "x/y")}, data=DOC)).status_code == 202

        got = await prin.get(pdf["url"])
        assert got.status_code == 200 and got.content == PDF
        assert got.headers["content-disposition"].startswith("attachment")
        staff = (await _get(prin, tid))["attachments"]
        assert [(a["name"], a["uploadedBy"]) for a in staff] == [("quote.pdf", "Manager"), ("approval.docx", "Management")]
        assert all(a["uploadedAt"] for a in staff)

        ft = await _get(fac, tid)
        assert ft["attachments"] == []
        assert not any(e["action"] == "Document added" for e in ft["events"])
        assert (await fac.get(pdf["url"])).status_code == 404
    finally:
        await _close(clients)


async def test_staff_view_the_reporters_photos_but_do_not_add_to_them(client):
    """DBIT, 2026-11-01: photos and videos are the reporter's evidence. Staff add files as documents."""
    from tests.test_media import jpeg_with_gps

    fac, mgr, mgmt, prin, clients = await _people(client)
    try:
        tid = (await fac.post(f"{API}/tickets", json=ticket_body())).json()["id"]
        assert (await fac.post(f"{API}/tickets/{tid}/attachments",
                               files={"file": ("mine.jpg", jpeg_with_gps(), "image/jpeg")})).status_code == 202
        for s in (mgr, mgmt, prin):
            r = await s.post(f"{API}/tickets/{tid}/attachments", files={"file": ("after.jpg", jpeg_with_gps(), "image/jpeg")})
            assert r.status_code == 403, r.text
        staff_view = (await _get(mgr, tid))["attachments"]
        assert [(a["kind"], a["uploadedBy"]) for a in staff_view] == [("photo", "Reporter")]
        assert (await mgr.get(staff_view[0]["url"])).status_code == 200

        # A photo of a bill added by staff is a document: re-encoded, internal, download only.
        r = await mgr.post(f"{API}/tickets/{tid}/attachments", files={"file": ("bill.jpg", jpeg_with_gps(), "image/jpeg")},
                           data=DOC)
        assert r.status_code == 202 and r.json()["kind"] == "document", r.text
        got = await mgr.get(r.json()["url"])
        assert got.headers["content-disposition"].startswith("attachment") and b"PhoneMaker" not in got.content
        assert [a["uploadedBy"] for a in (await _get(fac, tid))["attachments"]] == ["Reporter"]
    finally:
        await _close(clients)


async def test_staff_who_reported_a_problem_add_their_own_photos(client):
    from tests.test_media import jpeg_with_gps

    fac, mgr, mgmt, prin, clients = await _people(client)
    try:
        tid = (await mgr.post(f"{API}/tickets", json=ticket_body())).json()["id"]
        r = await mgr.post(f"{API}/tickets/{tid}/attachments", files={"file": ("mine.jpg", jpeg_with_gps(), "image/jpeg")})
        assert r.status_code == 202 and r.json()["kind"] == "photo"
    finally:
        await _close(clients)


def ooxml(main: str, extra: dict[str, bytes] | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/'
                                          'package/2006/content-types"/>')
        z.writestr("_rels/.rels", '<?xml version="1.0"?><Relationships '
                                  'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')
        z.writestr(main, '<?xml version="1.0"?><x/>')
        for name, data in (extra or {}).items():
            z.writestr(name, data)
    return buf.getvalue()


async def test_staff_documents_accept_office_text_and_images(client):
    from tests.test_media import jpeg_with_gps

    fac, mgr, mgmt, prin, clients = await _people(client)
    try:
        tid = (await fac.post(f"{API}/tickets", json=ticket_body())).json()["id"]
        files = [
            ("quote.pdf", PDF, "pdf"),
            ("letter.docx", docx(), "docx"),
            ("estimate.xlsx", ooxml("xl/workbook.xml"), "xlsx"),
            ("plan.pptx", ooxml("ppt/presentation.xml"), "pptx"),
            ("notes.txt", "Vendor: Ravi\nಕನ್ನಡ टिप्पणी\n".encode(), "txt"),
            ("bill.jpg", jpeg_with_gps(), "jpg"),
        ]
        for name, raw, ext in files:
            r = await mgr.post(f"{API}/tickets/{tid}/attachments", files={"file": (name, raw, "application/octet-stream")},
                               data=DOC)
            assert r.status_code == 202 and r.json()["kind"] == "document", f"{name}: {r.text}"
            got = await mgr.get(r.json()["url"])
            assert got.status_code == 200 and got.headers["content-disposition"].endswith(f".{ext}\""), name
            assert got.headers["x-content-type-options"] == "nosniff"
        assert (await _get(fac, tid))["attachments"] == []
    finally:
        await _close(clients)


async def test_unsafe_or_unknown_staff_files_are_rejected(client):
    fac, mgr, mgmt, prin, clients = await _people(client)
    try:
        tid = (await fac.post(f"{API}/tickets", json=ticket_body())).json()["id"]
        cases = [
            ("macro.xlsx", ooxml("xl/workbook.xml", {"xl/vbaProject.bin": b"\0" * 64})),
            ("activex.pptx", ooxml("ppt/presentation.xml", {"ppt/activeX/activeX1.xml": b"<x/>"})),
            ("fake.xlsx", ooxml("docProps/app.xml")),
            ("embedded.pdf", PDF.replace(b"1 0 obj<<>>", b"1 0 obj<</Type/EmbeddedFile>>")),
            ("tool.exe", b"MZ\x90\x00" + b"\x00" * 200),
            ("page.html", b"<!DOCTYPE html><html><script>alert(1)</script></html>"),
            ("logo.svg", b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
            ("bundle.zip", _zip()),
            ("run.sh", b"#!/bin/sh\nrm -rf /\n"),
        ]
        for name, raw in cases:
            r = await mgr.post(f"{API}/tickets/{tid}/attachments", files={"file": (name, raw, "application/pdf")}, data=DOC)
            assert r.status_code == 400 and r.json()["code"] == "media_rejected", f"{name} gave {r.status_code}"
    finally:
        await _close(clients)


def _zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("readme.txt", "hello")
    return buf.getvalue()


def test_old_office_files_with_macros_are_refused():
    from app.services import media

    ole = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 504
    assert media._document(ole, "application/vnd.ms-excel").kind == "document"
    try:
        media._document(ole + "_VBA_PROJECT".encode("utf-16-le"), "application/vnd.ms-excel")
    except media.MediaRejected as exc:
        assert "macros" in exc.message
    else:
        raise AssertionError("an OLE file with a VBA project was accepted")


async def test_unsafe_documents_are_rejected(client):
    fac, mgr, mgmt, prin, clients = await _people(client)
    try:
        tid = (await fac.post(f"{API}/tickets", json=ticket_body())).json()["id"]
        cases = [
            ("script.pdf", PDF.replace(b"1 0 obj<<>>", b"1 0 obj<</S/JavaScript/JS(app.alert(1))>>")),
            ("macro.docx", docx(macro=True)),
            ("archive.docx", b"PK\x03\x04" + b"\x00" * 100),
        ]
        for name, raw in cases:
            r = await mgr.post(f"{API}/tickets/{tid}/attachments", files={"file": (name, raw, "application/pdf")}, data=DOC)
            assert r.status_code == 400, f"{name} gave {r.status_code}"
    finally:
        await _close(clients)


async def test_expenditure_report_and_exports_for_a_date_range(client):
    fac, mgr, mgmt, prin, clients = await _people(client)
    try:
        t1, p1 = await _critical(fac, mgr, paise=150000)
        await prin.post(f"{API}/proposals/{p1['id']}/decisions", json=_decision("approved", 1, ceilingPaise=160000))
        t2, p2 = await _critical(fac, mgr, paise=50000, title="Lift door jammed")
        await prin.post(f"{API}/proposals/{p2['id']}/decisions", json=_decision("escalated", 1, reason="Board"))
        today = ist_today()
        params = {"from": (today - timedelta(days=1)).isoformat(), "to": today.isoformat()}

        # The facility manager does not see spending; the approvers and admin do.
        assert (await mgr.get(f"{API}/reports/expenditure", params=params)).status_code == 403
        assert (await mgr.get(f"{API}/reports", params=params)).json()["approvedPaise"] is None
        for s in (prin, mgmt):
            r = await s.get(f"{API}/reports/expenditure", params=params)
            assert r.status_code == 200, r.text
            e = r.json()
            assert e["requests"] == 2  # the escalated request is counted once
            assert e["requestedPaise"] == 200000 and e["approvedPaise"] == 160000 and e["pendingPaise"] == 50000
            assert e["approvedCount"] == 1 and e["pendingCount"] == 1
            assert {i["status"] for i in e["items"]} == {"approved", "pending_management"}
            assert next(i for i in e["items"] if i["status"] == "pending_management")["escalated"] is True
        assert (await prin.get(f"{API}/reports", params=params)).json()["approvedPaise"] == 160000

        # A range before the requests existed is empty.
        old = {"from": (today - timedelta(days=60)).isoformat(), "to": (today - timedelta(days=30)).isoformat()}
        assert (await prin.get(f"{API}/reports/expenditure", params=old)).json()["requests"] == 0
        bad = await prin.get(f"{API}/reports/expenditure", params={"from": today.isoformat(),
                                                                   "to": (today - timedelta(days=1)).isoformat()})
        assert bad.status_code == 400

        r = await mgmt.get(f"{API}/reports/expenditure.csv", params=params)
        assert r.status_code == 200 and "PCMS_Expenditure_" in r.headers["content-disposition"]
        rows = list(csv.DictReader(io.StringIO(r.text.lstrip("﻿"))))
        assert {row["estimate_inr"] for row in rows} == {"1500.00", "500.00"}
        assert {row["approved_limit_inr"] for row in rows} == {"1600.00", ""}
        x = await prin.get(f"{API}/reports/expenditure.xlsx", params=params)
        assert x.status_code == 200 and x.content[:2] == b"PK"
        assert (await mgr.get(f"{API}/reports/expenditure.csv", params=params)).status_code == 403
    finally:
        await _close(clients)


async def test_queue_filters_by_reporter_role_and_dates(client):
    fac, mgr, mgmt, prin, clients = await _people(client)
    try:
        await fac.post(f"{API}/tickets", json=ticket_body(title="Reported by faculty"))
        await prin.post(f"{API}/tickets", json=ticket_body(title="Reported by the principal"))

        async def titles(**params):
            r = await mgr.get(f"{API}/tickets", params={"scope": "queue", **params})
            assert r.status_code == 200, r.text
            return sorted(t["title"] for t in r.json()["items"])

        assert await titles(reporter="Principal") == ["Reported by the principal"]
        assert await titles(reporter="faculty@dbit") == ["Reported by faculty"]
        assert await titles(reporterRole="faculty") == ["Reported by faculty"]
        today = ist_today().isoformat()
        assert len(await titles(**{"from": today, "to": today})) == 2
        assert await titles(**{"to": (ist_today() - timedelta(days=1)).isoformat()}) == []
        assert (await mgr.get(f"{API}/tickets", params={"scope": "queue", "reporterRole": "guest"})).status_code == 400
    finally:
        await _close(clients)


async def test_amenities_and_terrace_are_places(client):
    await make_user("faculty@dbit.edu", "faculty")
    fac = await sign_in(client, "faculty@dbit.edu")
    body = (await fac.get(f"{API}/catalogs")).json()
    codes = {b["code"] for b in body["buildings"]}
    assert {"CAFETERIA", "CANTEEN", "PARKING"} <= codes
    block_a = next(b for b in body["buildings"] if b["code"] == "BLOCK_A")
    assert block_a["floors"][-1] == "Terrace"
    r = await fac.post(f"{API}/tickets", json=ticket_body(location={
        "building": "BLOCK_A", "department": "Computer Science and Engineering (CSE)", "floor": "Terrace",
        "room": "Water tank"}))
    assert r.status_code == 201, r.text
    r = await fac.post(f"{API}/tickets", json=ticket_body(location={"building": "CANTEEN", "floor": "Ground",
                                                                     "room": "Counter 2"}))
    assert r.status_code == 201, r.text


async def test_facility_manager_documents_are_for_the_approvers_only(client):
    """DBIT, 2026-11-01: a document the facility manager adds is seen by that manager, the principal
    and institute management, not by other facility managers or the reporter."""
    fac, mgr, mgmt, prin, clients = await _people(client)
    await make_user("manager2@dbit.edu", "facility_manager", "Second Manager")
    try:
        tid = (await fac.post(f"{API}/tickets", json=ticket_body())).json()["id"]
        up = await mgr.post(f"{API}/tickets/{tid}/attachments", files={"file": ("quote.pdf", PDF, "application/pdf")}, data=DOC)
        assert up.status_code == 202, up.text
        url = up.json()["url"]
        by_principal = (await prin.post(f"{API}/tickets/{tid}/attachments",
                                        files={"file": ("approval.pdf", PDF, "application/pdf")}, data=DOC)).json()

        def docs(t):
            return sorted(a["name"] for a in t["attachments"] if a["kind"] == "document")

        assert docs(await _get(mgr, tid)) == ["approval.pdf", "quote.pdf"]
        assert docs(await _get(prin, tid)) == ["approval.pdf", "quote.pdf"]
        assert docs(await _get(mgmt, tid)) == ["approval.pdf", "quote.pdf"]
        assert (await prin.get(url)).status_code == 200 and (await mgmt.get(url)).status_code == 200

        async with new_client() as c2:
            mgr2 = await sign_in(c2, "manager2@dbit.edu")
            t2 = await _get(mgr2, tid)
            assert docs(t2) == ["approval.pdf"]  # the principal's document is for all staff
            assert not any(e["action"] == "Document added" and e["detail"] == "quote.pdf" for e in t2["events"])
            assert (await mgr2.get(url)).status_code == 404
            assert (await mgr2.get(by_principal["url"])).status_code == 200

        assert docs(await _get(fac, tid)) == [] and (await fac.get(url)).status_code == 404
    finally:
        await _close(clients)