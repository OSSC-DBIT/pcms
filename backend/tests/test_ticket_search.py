"""Server-side search, filter, sort and paging for the ticket list.

The Queue screen depends on every one of these being applied by the server. Filtering
a fixed 100-row page in the browser silently hides older tickets, which is why the
client now sends filters here and shows the real total.
"""

from tests.factories import API, make_user, new_client, sign_in, ticket_body


async def _triage(s, tid, priority="P2"):
    """Triage with whatever version the ticket currently has."""
    v = (await s.get(f"{API}/tickets/{tid}")).json()["version"]
    return await s.post(f"{API}/tickets/{tid}/transitions",
                        json={"action": "triage", "priority": priority, "expectedVersion": v})


async def _faculty(client, emp="DB2101"):
    await make_user(emp, "faculty")
    return await sign_in(client, emp)


async def _manager(client, emp="DB0001"):
    await make_user(emp, "facility_manager")
    return await sign_in(client, emp)


async def test_paging_reports_the_real_total(client):
    """The old client threw page.total away and hardcoded 100, so rows went missing."""
    fac = await _faculty(client)
    for i in range(7):
        assert (await fac.post(f"{API}/tickets", json=ticket_body(title=f"Broken chair number {i}"))).status_code == 201

    first = (await fac.get(f"{API}/tickets", params={"scope": "mine", "page": 1, "pageSize": 3})).json()
    assert first["total"] == 7 and first["page"] == 1 and first["pageSize"] == 3
    assert len(first["items"]) == 3

    last = (await fac.get(f"{API}/tickets", params={"scope": "mine", "page": 3, "pageSize": 3})).json()
    assert len(last["items"]) == 1

    # Every ticket is reachable exactly once across the pages.
    seen = set()
    for page in (1, 2, 3):
        body = (await fac.get(f"{API}/tickets", params={"scope": "mine", "page": page, "pageSize": 3})).json()
        seen |= {t["id"] for t in body["items"]}
    assert len(seen) == 7


async def test_paging_is_stable_across_pages(client):
    """Tickets sharing a created_at must not shuffle between page 1 and page 2."""
    fac = await _faculty(client)
    for i in range(10):
        await fac.post(f"{API}/tickets", json=ticket_body(title=f"Item {i}"))

    p1 = (await fac.get(f"{API}/tickets", params={"scope": "mine", "sort": "newest", "page": 1, "pageSize": 5})).json()
    p2 = (await fac.get(f"{API}/tickets", params={"scope": "mine", "sort": "newest", "page": 2, "pageSize": 5})).json()
    assert not ({t["id"] for t in p1["items"]} & {t["id"] for t in p2["items"]})


async def test_search_matches_title_token_and_room(client):
    fac = await _faculty(client)
    await fac.post(f"{API}/tickets", json=ticket_body(title="Broken chair in lecture room"))
    await fac.post(f"{API}/tickets", json=ticket_body(title="Leaking tap",
                                                       location={"building": "CSE", "floor": "1", "room": "101"}))
    await fac.post(f"{API}/tickets", json=ticket_body(title="Flickering light",
                                                       location={"building": "ECE", "floor": "3", "room": "305"}))

    r = (await fac.get(f"{API}/tickets", params={"scope": "mine", "search": "leaking"})).json()
    assert r["total"] == 1 and r["items"][0]["title"] == "Leaking tap"
    assert (await fac.get(f"{API}/tickets", params={"scope": "mine", "search": "101"})).json()["total"] == 1

    everything = (await fac.get(f"{API}/tickets", params={"scope": "mine"})).json()["items"]
    by_token = (await fac.get(f"{API}/tickets", params={"scope": "mine", "search": everything[0]["token"]})).json()
    assert by_token["total"] == 1


async def test_search_wildcards_are_escaped_not_matched(client):
    """A literal % or _ must not turn into match-anything."""
    fac = await _faculty(client)
    await fac.post(f"{API}/tickets", json=ticket_body(title="Broken chair in lecture room"))
    await fac.post(f"{API}/tickets", json=ticket_body(title="Flickering light"))
    assert (await fac.get(f"{API}/tickets", params={"scope": "mine", "search": "%"})).json()["total"] == 0
    assert (await fac.get(f"{API}/tickets", params={"scope": "mine", "search": "_"})).json()["total"] == 0


async def test_building_and_category_filters(client):
    fac = await _faculty(client)
    a = (await fac.post(f"{API}/tickets", json=ticket_body(
        title="Leaking tap", location={"building": "CSE", "floor": "1", "room": "101"}))).json()
    await fac.post(f"{API}/tickets", json=ticket_body(
        title="Flickering light", categoryCode="electrical", subtype=None,
        location={"building": "ECE", "floor": "3", "room": "305"}))

    mc = new_client()
    try:
        mgr = await _manager(mc)
        by_building = (await mgr.get(f"{API}/tickets", params={"scope": "queue", "building": "CSE"})).json()
        assert by_building["total"] == 1 and by_building["items"][0]["id"] == a["id"]

        by_category = (await mgr.get(f"{API}/tickets", params={"scope": "queue", "category": "electrical"})).json()
        assert by_category["total"] == 1

        # Both filters together narrow, never widen.
        both = (await mgr.get(f"{API}/tickets", params={"scope": "queue", "building": "CSE",
                                                        "category": "electrical"})).json()
        assert both["total"] == 0
    finally:
        await mc.aclose()


async def test_priority_and_flag_filters(client):
    fac = await _faculty(client)
    t = (await fac.post(f"{API}/tickets", json=ticket_body())).json()

    mc = new_client()
    try:
        mgr = await _manager(mc)
        # Only a facility manager may triage, so the manager sets the priority.
        assert (await _triage(mgr, t["id"], priority="P1")).status_code == 200
        assert (await mgr.get(f"{API}/tickets", params={"scope": "queue", "priority": "P1"})).json()["total"] == 1
        assert (await mgr.get(f"{API}/tickets", params={"scope": "queue", "priority": "P4"})).json()["total"] == 0
        assert (await mgr.get(f"{API}/tickets", params={"scope": "queue", "flag": "C"})).json()["total"] == 0
        # The reporter can filter their own tickets by the same priority.
        assert (await fac.get(f"{API}/tickets", params={"scope": "mine", "priority": "P1"})).json()["total"] == 1
    finally:
        await mc.aclose()


async def test_bad_filter_values_are_rejected(client):
    """An out-of-range value must fail loudly rather than being silently ignored."""
    mgr = await _manager(client)
    for bad in ({"priority": "P9"}, {"flag": "Z"}, {"sort": "sideways"}, {"category": "does-not-exist"}):
        r = await mgr.get(f"{API}/tickets", params={"scope": "queue", **bad})
        assert r.status_code == 400, f"{bad} gave {r.status_code}"
        assert r.json()["code"] == "validation"


async def test_sort_orders(client):
    fac = await _faculty(client)
    first = (await fac.post(f"{API}/tickets", json=ticket_body(title="Older and more urgent"))).json()
    second = (await fac.post(f"{API}/tickets", json=ticket_body(title="Newer but routine", impact="routine"))).json()

    mc = new_client()
    try:
        mgr = await _manager(mc)
        await _triage(mgr, first["id"], priority="P1")
        await _triage(mgr, second["id"], priority="P4")

        async def order(sort):
            r = (await mgr.get(f"{API}/tickets", params={"scope": "queue", "sort": sort})).json()
            return [t["id"] for t in r["items"]]

        assert (await order("newest"))[0] == second["id"]
        assert (await order("oldest"))[0] == first["id"]
        assert (await order("priority"))[0] == first["id"]  # P1 outranks P4
    finally:
        await mc.aclose()


async def test_worker_filter_matches_the_free_text_name(client):
    fac = await _faculty(client)
    t = (await fac.post(f"{API}/tickets", json=ticket_body())).json()

    mc = new_client()
    try:
        mgr = await _manager(mc)
        await _triage(mgr, t["id"])
        v = (await mgr.get(f"{API}/tickets/{t['id']}")).json()["version"]
        r = await mgr.post(f"{API}/tickets/{t['id']}/transitions",
                           json={"action": "assign", "workerName": "Ramesh K", "expectedVersion": v})
        assert r.status_code == 200, r.text
        assert (await mgr.get(f"{API}/tickets", params={"scope": "queue", "worker": "ram"})).json()["total"] == 1

        v = (await mgr.get(f"{API}/tickets/{t['id']}")).json()["version"]
        r = await mgr.post(f"{API}/tickets/{t['id']}/transitions",
                           json={"action": "set_worker", "workerName": "Suresh", "expectedVersion": v})
        assert r.status_code == 200, r.text
        # The old name no longer matches.
        assert (await mgr.get(f"{API}/tickets", params={"scope": "queue", "worker": "ram"})).json()["total"] == 0
        assert (await mgr.get(f"{API}/tickets", params={"scope": "queue", "worker": "suresh"})).json()["total"] == 1

        # Faculty cannot use the queue scope, with or without the worker filter.
        assert (await fac.get(f"{API}/tickets", params={"scope": "queue", "worker": "ram"})).status_code == 403
    finally:
        await mc.aclose()


async def test_filters_never_cross_the_visibility_boundary(client):
    """A faculty member cannot reach another reporter's ticket through a filter."""
    await make_user("DB2101", "faculty", "Reporter One")
    await make_user("DB2102", "faculty", "Reporter Two")
    fac = await sign_in(client, "DB2101")
    await fac.post(f"{API}/tickets", json=ticket_body(title="Broken chair"))

    other = new_client()
    try:
        two = await sign_in(other, "DB2102")
        # The queue scope is refused outright, filter or no filter.
        assert (await fac.get(f"{API}/tickets", params={"scope": "queue"})).status_code == 403
        assert (await fac.get(f"{API}/tickets", params={"scope": "queue", "search": "Broken"})).status_code == 403
        # Searching the mine scope only ever returns their own ticket.
        assert (await fac.get(f"{API}/tickets", params={"scope": "mine", "search": "Broken"})).json()["total"] == 1
        assert (await two.get(f"{API}/tickets", params={"scope": "mine", "search": "Broken"})).json()["total"] == 0
    finally:
        await other.aclose()
