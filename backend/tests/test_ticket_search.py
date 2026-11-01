"""Server-side search, filter, sort and paging for the ticket list.

The Queue screen depends on every one of these being applied by the server. Filtering
a fixed 100-row page in the browser silently hides older tickets, which is why the
client now sends filters here and shows the real total.
"""

from tests.factories import API, make_user, new_client, sign_in, ticket_body


async def _triage(s, tid):
    """Triage with whatever version the ticket currently has."""
    v = (await s.get(f"{API}/tickets/{tid}")).json()["version"]
    return await s.post(f"{API}/tickets/{tid}/transitions",
                        json={"action": "triage", "expectedVersion": v})


async def _faculty(client, emp="faculty@dbit.edu"):
    await make_user(emp, "faculty")
    return await sign_in(client, emp)


async def _manager(client, emp="manager@dbit.edu"):
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
                                                       location={"building": "BLOCK_A", "department": "Computer Science and Engineering (CSE)",
                             "floor": "1", "room": "101"}))
    await fac.post(f"{API}/tickets", json=ticket_body(title="Flickering light",
                                                       location={"building": "BLOCK_B", "department": "Artificial Intelligence and Machine Learning (AI/ML)",
                             "floor": "3", "room": "305"}))
    await fac.post(f"{API}/tickets", json=ticket_body(
        title="Loose cable", location={"building": "CUSTOM", "customLocation": "Workshop annex",
                                       "department": "Workshop", "floor": "Ground", "room": "Store"}))

    r = (await fac.get(f"{API}/tickets", params={"scope": "mine", "search": "leaking"})).json()
    assert r["total"] == 1 and r["items"][0]["title"] == "Leaking tap"
    assert (await fac.get(f"{API}/tickets", params={"scope": "mine", "search": "101"})).json()["total"] == 1
    assert (await fac.get(f"{API}/tickets", params={"scope": "mine", "search": "annex"})).json()["total"] == 1

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
        title="Leaking tap", location={"building": "BLOCK_A", "department": "Computer Science and Engineering (CSE)",
                             "floor": "1", "room": "101"}))).json()
    await fac.post(f"{API}/tickets", json=ticket_body(
        title="Flickering light", categoryCode="mechanical", subtype="Fan / Light / Electrical",
        location={"building": "BLOCK_B", "department": "Artificial Intelligence and Machine Learning (AI/ML)",
                             "floor": "3", "room": "305"}))

    mc = new_client()
    try:
        mgr = await _manager(mc)
        by_building = (await mgr.get(f"{API}/tickets", params={"scope": "queue", "building": "BLOCK_A"})).json()
        assert by_building["total"] == 1 and by_building["items"][0]["id"] == a["id"]

        by_category = (await mgr.get(f"{API}/tickets", params={"scope": "queue", "category": "mechanical"})).json()
        assert by_category["total"] == 1

        # Both filters together narrow, never widen.
        both = (await mgr.get(f"{API}/tickets", params={"scope": "queue", "building": "BLOCK_A",
                                                        "category": "mechanical"})).json()
        assert both["total"] == 0
    finally:
        await mc.aclose()


async def test_severity_and_flag_filters(client):
    fac = await _faculty(client)
    t = (await fac.post(f"{API}/tickets", json=ticket_body(impact="red"))).json()

    mc = new_client()
    try:
        mgr = await _manager(mc)
        # Accepting no longer takes a priority: the reporter's colour is what staff filter by.
        assert (await _triage(mgr, t["id"])).status_code == 200
        assert (await mgr.get(f"{API}/tickets", params={"scope": "queue", "severity": "red"})).json()["total"] == 1
        assert (await mgr.get(f"{API}/tickets", params={"scope": "queue", "severity": "green"})).json()["total"] == 0
        assert (await mgr.get(f"{API}/tickets", params={"scope": "queue", "flag": "C"})).json()["total"] == 0
        # The reporter can filter their own tickets by the same severity.
        assert (await fac.get(f"{API}/tickets", params={"scope": "mine", "severity": "red"})).json()["total"] == 1
        # Priority is gone from the API: not returned, and not accepted as a filter.
        assert "priority" not in (await mgr.get(f"{API}/tickets/{t['id']}")).json()
    finally:
        await mc.aclose()


async def test_old_impact_values_and_manual_priority_are_rejected(client):
    fac = await _faculty(client)
    assert (await fac.post(f"{API}/tickets", json=ticket_body(impact="safety"))).status_code == 400
    t = (await fac.post(f"{API}/tickets", json=ticket_body())).json()
    mc = new_client()
    try:
        mgr = await _manager(mc)
        r = await mgr.post(f"{API}/tickets/{t['id']}/transitions",
                           json={"action": "set_priority", "priority": "P1", "expectedVersion": 1})
        assert r.status_code == 400
    finally:
        await mc.aclose()


async def test_bad_filter_values_are_rejected(client):
    """An out-of-range value must fail loudly rather than being silently ignored."""
    mgr = await _manager(client)
    for bad in ({"severity": "purple"}, {"flag": "Z"}, {"sort": "sideways"}, {"sort": "priority"},
                {"category": "does-not-exist"}):
        r = await mgr.get(f"{API}/tickets", params={"scope": "queue", **bad})
        assert r.status_code == 400, f"{bad} gave {r.status_code}"
        assert r.json()["code"] == "validation"


async def test_sort_orders(client):
    fac = await _faculty(client)
    first = (await fac.post(f"{API}/tickets", json=ticket_body(title="Older and more urgent", impact="red"))).json()
    middle = (await fac.post(f"{API}/tickets", json=ticket_body(title="Needs a look soon", impact="orange"))).json()
    second = (await fac.post(f"{API}/tickets", json=ticket_body(title="Newer but routine", impact="green"))).json()

    mc = new_client()
    try:
        mgr = await _manager(mc)

        async def order(sort):
            r = (await mgr.get(f"{API}/tickets", params={"scope": "queue", "sort": sort})).json()
            return [t["id"] for t in r["items"]]

        assert (await order("newest"))[0] == second["id"]
        assert (await order("oldest"))[0] == first["id"]
        # Red, then orange, then green, whatever the creation order.
        assert await order("severity") == [first["id"], middle["id"], second["id"]]
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
    await make_user("faculty@dbit.edu", "faculty", "Reporter One")
    await make_user("faculty2@dbit.edu", "faculty", "Reporter Two")
    fac = await sign_in(client, "faculty@dbit.edu")
    await fac.post(f"{API}/tickets", json=ticket_body(title="Broken chair"))

    other = new_client()
    try:
        two = await sign_in(other, "faculty2@dbit.edu")
        # The queue scope is refused outright, filter or no filter.
        assert (await fac.get(f"{API}/tickets", params={"scope": "queue"})).status_code == 403
        assert (await fac.get(f"{API}/tickets", params={"scope": "queue", "search": "Broken"})).status_code == 403
        # Searching the mine scope only ever returns their own ticket.
        assert (await fac.get(f"{API}/tickets", params={"scope": "mine", "search": "Broken"})).json()["total"] == 1
        assert (await two.get(f"{API}/tickets", params={"scope": "mine", "search": "Broken"})).json()["total"] == 0
    finally:
        await other.aclose()
