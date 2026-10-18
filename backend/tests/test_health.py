async def test_ready_checks_database(client):
    r = await client.get("/api/v1/health/ready")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "database": "up"}
    assert r.headers["x-request-id"]


async def test_unknown_route_uses_error_envelope(client):
    r = await client.get("/api/v1/nope", headers={"X-Request-ID": "abc123"})
    assert r.status_code == 404
    body = r.json()
    assert set(body) == {"code", "message", "field_errors", "request_id"}
    assert body["code"] == "not_found"
    assert body["request_id"] == "abc123"


async def test_bad_request_id_is_replaced(client):
    r = await client.get("/api/v1/health/live", headers={"X-Request-ID": "<script>"})
    assert r.headers["x-request-id"] != "<script>"


async def test_swagger_ui_is_disabled(client):
    for path in ("/api/v1/docs", "/docs", "/redoc", "/docs/oauth2-redirect"):
        assert (await client.get(path)).status_code == 404, path
