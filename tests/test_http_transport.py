"""
Smoke test for the Streamable HTTP transport.

This guards the previously-broken /mcp endpoint: it confirms the transport is
actually wired and completes an MCP ``initialize`` handshake end-to-end through
the real Starlette app (with its session-manager lifespan running).

Note: the session manager's lifespan may only run once per app instance, so a
single TestClient context is shared across the assertions below.
"""
import os

import pytest
from starlette.testclient import TestClient


@pytest.fixture(scope="module")
def client():
    # Importing the server builds the FastMCP instance and registers tools.
    # Provide dummy Proxmox creds so settings construction never blocks import.
    os.environ.setdefault("PROXMOX_HOST", "127.0.0.1")
    os.environ.setdefault("PROXMOX_USER", "root@pam")
    os.environ.setdefault("PROXMOX_TOKEN_NAME", "test")
    os.environ.setdefault("PROXMOX_TOKEN_VALUE", "test")
    from clustr.server import mcp

    app = mcp.streamable_http_app()
    # base_url host "localhost" is in the transport-security allow-list.
    with TestClient(app, base_url="http://localhost") as c:
        yield c


def test_streamable_http_initialize(client):
    resp = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "smoke-test", "version": "1.0"},
            },
        },
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    assert resp.status_code == 200, resp.text
    # Works for both SSE and JSON response modes — the payload is in the body.
    assert "protocolVersion" in resp.text
    assert "clustr" in resp.text


def test_health_endpoint(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "service": "clustr"}
