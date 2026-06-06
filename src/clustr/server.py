"""
Clustr MCP Server — entry point.

Built on FastMCP (the high-level MCP server API). FastMCP owns the
Streamable HTTP transport and its session lifecycle, so there is no
hand-rolled transport code here.

Transports:
  Primary:   Streamable HTTP on /mcp  (required for Anthropic directory)
  Secondary: stdio  (for local use with Claude Desktop / CLI)

Middleware stack (outermost → innermost), applied to the HTTP app:
  OAuthMiddleware       → pass-through when OAUTH_ENABLED=false
  HostVerifyMiddleware  → pass-through skeleton
  FastMCP Streamable HTTP app (with session-manager lifespan)

Tool registration:
  Each tool module exposes a ``register(mcp)`` function. Adding a new tool
  means creating it in tools/read/ or tools/write/ and calling its module's
  ``register`` in ``_register_all`` below.
"""

from __future__ import annotations

import argparse
import logging
import os
from urllib.parse import urlparse

import uvicorn
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.requests import Request
from starlette.responses import JSONResponse

# Middleware
from clustr.auth.oauth import OAuthMiddleware
from clustr.config.settings import get_settings
from clustr.middleware.host_verify import HostVerifyMiddleware

# Tool modules
from clustr.tools.read import containers as _read_containers
from clustr.tools.read import nodes as _read_nodes
from clustr.tools.read import storage as _read_storage
from clustr.tools.read import vms as _read_vms
from clustr.tools.write import container_create as _write_container_create
from clustr.tools.write import container_delete as _write_container_delete
from clustr.tools.write import container_power as _write_container_power
from clustr.tools.write import container_snapshots as _write_container_snapshots
from clustr.tools.write import vm_create as _write_vm_create
from clustr.tools.write import vm_delete as _write_vm_delete
from clustr.tools.write import vm_power as _write_vm_power
from clustr.tools.write import vm_snapshots as _write_vm_snapshots

logger = logging.getLogger(__name__)

_OAUTH_META = "/.well-known/oauth-protected-resource"

# Every module that contributes tools, read first then write.
_TOOL_MODULES = (
    _read_nodes,
    _read_vms,
    _read_containers,
    _read_storage,
    _write_vm_power,
    _write_container_power,
    _write_vm_snapshots,
    _write_container_snapshots,
    _write_vm_delete,
    _write_container_delete,
    _write_vm_create,
    _write_container_create,
)


def _register_all(mcp: FastMCP) -> None:
    """Register every tool module's tools onto the FastMCP instance."""
    for module in _TOOL_MODULES:
        module.register(mcp)


def _transport_security() -> TransportSecuritySettings:
    """
    Build DNS-rebinding protection settings for the Streamable HTTP transport.

    Read from the environment directly (not via get_settings) so importing this
    module never requires Proxmox credentials. Loopback is always allowed for
    local use and health checks; the public host is allow-listed from
    MCP_PUBLIC_URL, with extra hosts via MCP_ALLOWED_HOSTS (comma-separated).
    """
    hosts = ["localhost", "127.0.0.1"]
    origins = ["http://localhost", "http://127.0.0.1"]

    public_url = os.environ.get("MCP_PUBLIC_URL", "").strip()
    if public_url:
        parsed = urlparse(public_url)
        if parsed.netloc:
            hosts.append(parsed.netloc)
            origins.append(f"{parsed.scheme}://{parsed.netloc}")

    for extra in os.environ.get("MCP_ALLOWED_HOSTS", "").split(","):
        extra = extra.strip()
        if extra:
            hosts.append(extra)

    return TransportSecuritySettings(allowed_hosts=hosts, allowed_origins=origins)


def _build_mcp() -> FastMCP:
    """Construct the FastMCP server, register tools, and add custom routes."""
    mcp = FastMCP(
        "clustr",
        instructions="Manage a Proxmox VE cluster: nodes, VMs, and LXC containers.",
        # Stateless: every HTTP request is self-contained — no session id to
        # track, which is what a horizontally-scaled connector wants.
        stateless_http=True,
        streamable_http_path="/mcp",
        transport_security=_transport_security(),
    )
    _register_all(mcp)

    @mcp.custom_route("/health", methods=["GET"])  # type: ignore[untyped-decorator]
    async def health(_request: Request) -> JSONResponse:
        return JSONResponse({"status": "ok", "service": "clustr"})

    @mcp.custom_route(_OAUTH_META, methods=["GET"])  # type: ignore[untyped-decorator]
    async def oauth_resource_metadata(_request: Request) -> JSONResponse:
        """
        Anthropic directory requirement: OAuth 2.0 Protected Resource Metadata.
        RFC 9728 — describes how to obtain access tokens for this resource.

        The ``resource`` field is the canonical public URL of this server. We
        publish it only when MCP_PUBLIC_URL is configured — never a localhost
        placeholder, which would fail validation.
        """
        settings = get_settings()
        metadata: dict[str, object] = {
            "authorization_servers": (
                [settings.oauth.issuer]
                if settings.oauth.enabled and settings.oauth.issuer
                else []
            ),
            "bearer_methods_supported": ["header"],
            "scopes_supported": ["clustr:read", "clustr:write"],
        }
        if settings.server.public_url:
            metadata["resource"] = settings.server.public_url.rstrip("/")
        return JSONResponse(metadata)

    return mcp


# Module-level instance — imported by tests and the HTTP/stdio runners.
mcp = _build_mcp()


# ---------------------------------------------------------------------------
# Runners
# ---------------------------------------------------------------------------


def _run_http() -> None:
    """Start the Streamable HTTP server (primary transport)."""
    settings = get_settings()

    logging.basicConfig(
        level=getattr(logging, settings.server.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    # FastMCP builds the Starlette app (with the session-manager lifespan).
    # Wrap it with our ASGI middleware — outermost first. Both middlewares
    # pass lifespan/non-HTTP scopes straight through, so startup still runs.
    asgi_app = OAuthMiddleware(HostVerifyMiddleware(mcp.streamable_http_app()))

    logger.info(
        "Clustr starting on %s:%s (OAuth: %s)",
        settings.server.host,
        settings.server.port,
        "enabled" if settings.oauth.enabled else "disabled",
    )

    uvicorn.run(
        asgi_app,
        host=settings.server.host,
        port=settings.server.port,
        log_level=settings.server.log_level.lower(),
    )


def _run_stdio() -> None:
    """Run MCP over stdio (secondary transport, for local use)."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    logger.info("Clustr starting in stdio mode")
    mcp.run(transport="stdio")


def main() -> None:
    """CLI entry point — parses transport flag and starts the server."""
    parser = argparse.ArgumentParser(
        description="Clustr — Proxmox MCP Server",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  clustr                  # Start HTTP server (default)\n"
            "  clustr --stdio          # Start stdio transport\n"
            "  clustr --port 9090      # HTTP on custom port\n"
        ),
    )
    parser.add_argument(
        "--stdio",
        action="store_true",
        help="Use stdio transport instead of HTTP (for Claude Desktop / local use)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="Override HTTP port (default: MCP_PORT env var or 8080)",
    )
    args = parser.parse_args()

    if args.port:
        import os

        os.environ["MCP_PORT"] = str(args.port)
        # Reset settings cache so new port is picked up
        get_settings.cache_clear()

    if args.stdio:
        _run_stdio()
    else:
        _run_http()


if __name__ == "__main__":
    main()
