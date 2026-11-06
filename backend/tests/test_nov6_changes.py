"""DBIT changes of 2026-11-06.

  - Blocks A and B have a 3rd floor again (rooms A-301 to A-335, B-301 to B-335).
  - The first timeline entry on a new ticket reads "Trouble ticket raised".
"""

from tests.factories import API, make_user, sign_in, ticket_body


async def test_blocks_a_and_b_have_a_third_floor(client):
    await make_user("faculty@dbit.edu", "faculty")
    fac = await sign_in(client, "faculty@dbit.edu")
    buildings = (await fac.get(f"{API}/catalogs")).json()["buildings"]
    block_b = next(b for b in buildings if b["code"] == "BLOCK_B")
    assert block_b["floors"] == ["Ground", "1", "2", "3", "Terrace"]
    # Floor 3 is accepted on Block A ...
    r = await fac.post(f"{API}/tickets", json=ticket_body(location={
        "building": "BLOCK_A", "department": "Computer Science and Engineering (CSE)",
        "floor": "3", "room": "A-301"}))
    assert r.status_code == 201, r.text
    assert r.json()["location"]["floor"] == "3"


async def test_first_timeline_entry_reads_trouble_ticket_raised(client):
    await make_user("faculty@dbit.edu", "faculty")
    fac = await sign_in(client, "faculty@dbit.edu")
    r = await fac.post(f"{API}/tickets", json=ticket_body())
    assert r.status_code == 201, r.text
    t = (await fac.get(f"{API}/tickets/{r.json()['id']}")).json()
    assert t["events"][0]["action"] == "Trouble ticket raised"
