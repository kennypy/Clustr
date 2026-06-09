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


def test_forwarded_headers_ignored_by_default(client, monkeypatch):
    """
    Without MCP_TRUST_PROXY=true, X-Forwarded-* headers must not influence the
    advertised resource URL — otherwise any client could spoof it.
    """
    from clustr.config.settings import get_settings

    monkeypatch.delenv("MCP_PUBLIC_URL", raising=False)
    monkeypatch.delenv("MCP_TRUST_PROXY", raising=False)
    get_settings.cache_clear()
    try:
        resp = client.get(
            "/.well-known/oauth-protected-resource",
            headers={
                "X-Forwarded-Host": "evil.example.com",
                "X-Forwarded-Proto": "https",
            },
        )
        assert resp.status_code == 200
        assert resp.json()["resource"] == "http://localhost"
    finally:
        get_settings.cache_clear()


def test_forwarded_headers_honored_when_proxy_trusted(client, monkeypatch):
    """With MCP_TRUST_PROXY=true the proxy-supplied host/proto are used."""
    from clustr.config.settings import get_settings

    monkeypatch.delenv("MCP_PUBLIC_URL", raising=False)
    monkeypatch.setenv("MCP_TRUST_PROXY", "true")
    get_settings.cache_clear()
    try:
        resp = client.get(
            "/.well-known/oauth-protected-resource",
            headers={
                "X-Forwarded-Host": "clustr.example.com",
                "X-Forwarded-Proto": "https",
            },
        )
        assert resp.status_code == 200
        assert resp.json()["resource"] == "https://clustr.example.com"
    finally:
        get_settings.cache_clear()


def test_host_header_with_port_accepted(client):
    """
    Regression: real clients send the port in the Host header
    (``Host: 127.0.0.1:8080``). The transport-security allow-list must match
    that, not only the portless form — exact-only matching used to reject the
    documented local setup with 421.
    """
    for host in ("127.0.0.1:8080", "localhost:9090"):
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
                "Host": host,
            },
        )
        assert resp.status_code == 200, f"Host {host!r} rejected: {resp.status_code}"
