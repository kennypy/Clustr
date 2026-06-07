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

# Tool modules
from clustr.tools.read import containers as _read_containers
from clustr.tools.read import nodes as _read_nodes
from clustr.tools.read import storage as _read_storage
from clustr.tools.read import updates as _read_updates
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

# Addresses that are not reachable off-box, so an unauthenticated server bound to
# one cannot be controlled by anyone but the local host.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"})


def _check_safe_bind(
    host: str, *, oauth_enabled: bool, allow_unauthenticated: bool
) -> None:
    """
    Refuse to start an unauthenticated server on a non-loopback address.

    The only working auth mode today is "none" (OAuth is a stub), so binding off
    loopback without authentication would put unauthenticated control of the
    Proxmox cluster on the network. Loopback, enabled OAuth, or an explicit,
    acknowledged override (``MCP_ALLOW_UNAUTHENTICATED=true`` — something else
    enforces access control) are all allowed; anything else hard-fails.
    """
    if host in _LOOPBACK_HOSTS or oauth_enabled or allow_unauthenticated:
        return
    raise SystemExit(
        f"Refusing to start: MCP_HOST={host} is not a loopback address and OAuth "
        f"is disabled, so the /mcp endpoint would have NO authentication and be "
        f"reachable off-box. Anyone who could reach this port could control your "
        f"Proxmox cluster.\n"
        f"Choose one:\n"
        f"  - Bind loopback (unset MCP_HOST or set MCP_HOST=127.0.0.1) and put a "
        f"reverse proxy / tunnel that authenticates in front; or\n"
        f"  - Enable authentication (OAUTH_ENABLED=true with a configured "
        f"provider); or\n"
        f"  - If access control is genuinely enforced elsewhere (authenticating "
        f"proxy, container/network isolation), set MCP_ALLOW_UNAUTHENTICATED=true "
        f"to acknowledge and override."
    )


# Every module that contributes tools, read first then write.
_TOOL_MODULES = (
    _read_nodes,
    _read_vms,
    _read_containers,
    _read_storage,
    _read_updates,
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

    The SDK matches Host/Origin values exactly unless an entry ends in ``:*``
    (any port). Real clients send ``Host: 127.0.0.1:8080`` — with the port —
    so every portless entry needs its ``:*`` twin or the default local setup
    is rejected with 421.
    """
    hosts = ["localhost", "localhost:*", "127.0.0.1", "127.0.0.1:*"]
    origins = [
        "http://localhost",
        "http://localhost:*",
        "http://127.0.0.1",
        "http://127.0.0.1:*",
    ]

    public_url = os.environ.get("MCP_PUBLIC_URL", "").strip()
    if public_url:
        parsed = urlparse(public_url)
        if parsed.netloc:
            hosts.append(parsed.netloc)
            origins.append(f"{parsed.scheme}://{parsed.netloc}")
            if ":" not in parsed.netloc:
                hosts.append(f"{parsed.netloc}:*")

    for extra in os.environ.get("MCP_ALLOWED_HOSTS", "").split(","):
        extra = extra.strip()
        if extra:
            hosts.append(extra)
            origins.extend([f"https://{extra}", f"http://{extra}"])
            if ":" not in extra:
                hosts.append(f"{extra}:*")
                origins.extend([f"https://{extra}:*", f"http://{extra}:*"])

    return TransportSecuritySettings(allowed_hosts=hosts, allowed_origins=origins)


def _resource_from_request(request: Request, trust_proxy: bool) -> str:
    """
    Best-effort canonical URL of this server from the incoming request.

    When ``trust_proxy`` is true, honors the X-Forwarded-Proto /
    X-Forwarded-Host headers set by a reverse proxy (e.g. Cloudflare) so the
    advertised resource is the public HTTPS URL, not the internal bind address.
    Off by default: without a proxy in front, any client could set those
    headers and inject an arbitrary host into the advertised URL.
    """
    headers = request.headers
    proto = request.url.scheme
    host = headers.get("host") or request.url.netloc
    if trust_proxy:
        proto = headers.get("x-forwarded-proto") or proto
        host = headers.get("x-forwarded-host") or host
    return f"{proto}://{host}"


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
    async def oauth_resource_metadata(request: Request) -> JSONResponse:
        """
        Anthropic directory requirement: OAuth 2.0 Protected Resource Metadata
        (RFC 9728) — tells clients which authorization server(s) issue tokens
        for this resource.

        ``resource`` is required by RFC 9728 and is the canonical URL of this
        server. Prefer the configured MCP_PUBLIC_URL; otherwise derive it from
        the incoming request (behind Cloudflare the forwarded host/proto give
        the real public URL).
        """
        settings = get_settings()
        resource = settings.server.public_url.rstrip("/") or _resource_from_request(
            request, settings.server.trust_proxy
        )
        return JSONResponse(
            {
                "resource": resource,
                "authorization_servers": (
                    [settings.oauth.issuer]
                    if settings.oauth.enabled and settings.oauth.issuer
                    else []
                ),
                "bearer_methods_supported": ["header"],
                "scopes_supported": ["clustr:read", "clustr:write"],
            }
        )

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
    # Wrap it with our ASGI middleware. OAuthMiddleware passes lifespan/non-HTTP
    # scopes straight through, so startup still runs.
    asgi_app = OAuthMiddleware(mcp.streamable_http_app())

    # Hard-fail an unauthenticated, off-box bind before opening the port — a
    # warning is not enough when the exposure is "anyone on the network can
    # delete your VMs".
    _check_safe_bind(
        settings.server.host,
        oauth_enabled=settings.oauth.enabled,
        allow_unauthenticated=settings.server.allow_unauthenticated,
    )

    logger.info(
        "Clustr starting on %s:%s (OAuth: %s)",
        settings.server.host,
        settings.server.port,
        "enabled" if settings.oauth.enabled else "disabled",
    )

    # Loud reminders for the configurations that are permitted but still risky.
    if (
        settings.server.allow_unauthenticated
        and not settings.oauth.enabled
        and settings.server.host not in _LOOPBACK_HOSTS
    ):
        logger.warning(
            "Bound to %s with OAuth disabled and MCP_ALLOW_UNAUTHENTICATED set — "
            "the /mcp endpoint has NO app-level authentication. This is only safe "
            "if a proxy/tunnel or network isolation in front enforces access "
            "control.",
            settings.server.host,
        )
    if not settings.proxmox.verify_ssl:
        logger.warning(
            "PROXMOX_VERIFY_SSL is false — the Proxmox API token is sent over an "
            "unverified TLS connection (MITM risk). Set PROXMOX_VERIFY_SSL=true "
            "with a valid certificate for production use."
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
        os.environ["MCP_PORT"] = str(args.port)
        # Reset settings cache so new port is picked up
        get_settings.cache_clear()

    if args.stdio:
        _run_stdio()
    else:
        _run_http()


if __name__ == "__main__":
    main()
