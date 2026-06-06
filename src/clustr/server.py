"""
Clustr MCP Server — entry point.

Transports:
  Primary:   Streamable HTTP on /mcp  (required for Anthropic directory)
  Secondary: stdio  (for local use with Claude Desktop / CLI)

Middleware stack (outermost → innermost):
  HostVerifyMiddleware  → pass-through skeleton
  OAuthMiddleware       → pass-through when OAUTH_ENABLED=false
  FastAPI app

Tool registration:
  All read and write tools are registered here. Adding a new tool requires:
    1. Create the tool + handler in tools/read/ or tools/write/
    2. Import the Tool object here
    3. Register in _ALL_TOOLS
    4. Add the tool_name → module mapping in _TOOL_HANDLERS
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from typing import Any

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from mcp.server import Server
from mcp.server.streamable_http import StreamableHTTPServerTransport
from mcp.types import TextContent, Tool

# Config
from clustr.config.settings import get_settings

# Middleware
from clustr.auth.oauth import OAuthMiddleware
from clustr.middleware.host_verify import HostVerifyMiddleware

# Read tools — Tool objects
from clustr.tools.read.nodes import (
    TOOL_GET_CLUSTER_STATUS,
    TOOL_GET_NODE,
    TOOL_GET_NODE_SERVICES,
    TOOL_LIST_NODES,
)
from clustr.tools.read.vms import (
    TOOL_GET_VM,
    TOOL_GET_VM_STATUS,
    TOOL_LIST_VM_SNAPSHOTS,
    TOOL_LIST_VMS,
)
from clustr.tools.read.containers import (
    TOOL_GET_CONTAINER,
    TOOL_GET_CONTAINER_STATUS,
    TOOL_LIST_CONTAINER_SNAPSHOTS,
    TOOL_LIST_CONTAINERS,
)
from clustr.tools.read.storage import (
    TOOL_GET_STORAGE,
    TOOL_LIST_STORAGE,
)

# Write tools — Tool objects
from clustr.tools.write.vm_power import (
    TOOL_REBOOT_VM,
    TOOL_RESET_VM,
    TOOL_SHUTDOWN_VM,
    TOOL_START_VM,
    TOOL_STOP_VM,
)
from clustr.tools.write.container_power import (
    TOOL_REBOOT_CONTAINER,
    TOOL_SHUTDOWN_CONTAINER,
    TOOL_START_CONTAINER,
    TOOL_STOP_CONTAINER,
)
from clustr.tools.write.vm_snapshots import (
    TOOL_CREATE_VM_SNAPSHOT,
    TOOL_DELETE_VM_SNAPSHOT,
    TOOL_ROLLBACK_VM_SNAPSHOT,
)
from clustr.tools.write.container_snapshots import (
    TOOL_CREATE_CONTAINER_SNAPSHOT,
    TOOL_DELETE_CONTAINER_SNAPSHOT,
    TOOL_ROLLBACK_CONTAINER_SNAPSHOT,
)
from clustr.tools.write.vm_delete import (
    TOOL_VM_DELETE_CONFIRM,
    TOOL_VM_DELETE_REQUEST,
)
from clustr.tools.write.container_delete import (
    TOOL_CONTAINER_DELETE_CONFIRM,
    TOOL_CONTAINER_DELETE_REQUEST,
)
from clustr.tools.write.vm_create import TOOL_CREATE_VM
from clustr.tools.write.container_create import TOOL_CREATE_CONTAINER

# Handler modules
import clustr.tools.read.nodes as _nodes_handler
import clustr.tools.read.vms as _vms_handler
import clustr.tools.read.containers as _containers_handler
import clustr.tools.read.storage as _storage_handler
import clustr.tools.write.vm_power as _vm_power_handler
import clustr.tools.write.container_power as _ct_power_handler
import clustr.tools.write.vm_snapshots as _vm_snap_handler
import clustr.tools.write.container_snapshots as _ct_snap_handler
import clustr.tools.write.vm_delete as _vm_delete_handler
import clustr.tools.write.container_delete as _ct_delete_handler
import clustr.tools.write.vm_create as _vm_create_handler
import clustr.tools.write.container_create as _ct_create_handler

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Complete tool registry
# ---------------------------------------------------------------------------

_ALL_TOOLS: list[Tool] = [
    # Read — Nodes
    TOOL_LIST_NODES,
    TOOL_GET_NODE,
    TOOL_GET_NODE_SERVICES,
    TOOL_GET_CLUSTER_STATUS,
    # Read — VMs
    TOOL_LIST_VMS,
    TOOL_GET_VM,
    TOOL_GET_VM_STATUS,
    TOOL_LIST_VM_SNAPSHOTS,
    # Read — Containers
    TOOL_LIST_CONTAINERS,
    TOOL_GET_CONTAINER,
    TOOL_GET_CONTAINER_STATUS,
    TOOL_LIST_CONTAINER_SNAPSHOTS,
    # Read — Storage
    TOOL_LIST_STORAGE,
    TOOL_GET_STORAGE,
    # Write — VM power
    TOOL_START_VM,
    TOOL_SHUTDOWN_VM,
    TOOL_STOP_VM,
    TOOL_REBOOT_VM,
    TOOL_RESET_VM,
    # Write — Container power
    TOOL_START_CONTAINER,
    TOOL_SHUTDOWN_CONTAINER,
    TOOL_STOP_CONTAINER,
    TOOL_REBOOT_CONTAINER,
    # Write — VM snapshots
    TOOL_CREATE_VM_SNAPSHOT,
    TOOL_DELETE_VM_SNAPSHOT,
    TOOL_ROLLBACK_VM_SNAPSHOT,
    # Write — Container snapshots
    TOOL_CREATE_CONTAINER_SNAPSHOT,
    TOOL_DELETE_CONTAINER_SNAPSHOT,
    TOOL_ROLLBACK_CONTAINER_SNAPSHOT,
    # Write — VM delete (two-step)
    TOOL_VM_DELETE_REQUEST,
    TOOL_VM_DELETE_CONFIRM,
    # Write — Container delete (two-step)
    TOOL_CONTAINER_DELETE_REQUEST,
    TOOL_CONTAINER_DELETE_CONFIRM,
    # Write — Create
    TOOL_CREATE_VM,
    TOOL_CREATE_CONTAINER,
]

# tool_name → handler module mapping
_TOOL_HANDLERS: dict[str, Any] = {
    # Nodes
    "list_nodes": _nodes_handler,
    "get_node": _nodes_handler,
    "get_node_services": _nodes_handler,
    "get_cluster_status": _nodes_handler,
    # VMs
    "list_vms": _vms_handler,
    "get_vm": _vms_handler,
    "get_vm_status": _vms_handler,
    "list_vm_snapshots": _vms_handler,
    # Containers
    "list_containers": _containers_handler,
    "get_container": _containers_handler,
    "get_container_status": _containers_handler,
    "list_container_snapshots": _containers_handler,
    # Storage
    "list_storage": _storage_handler,
    "get_storage": _storage_handler,
    # VM power
    "start_vm": _vm_power_handler,
    "shutdown_vm": _vm_power_handler,
    "stop_vm": _vm_power_handler,
    "reboot_vm": _vm_power_handler,
    "reset_vm": _vm_power_handler,
    # Container power
    "start_container": _ct_power_handler,
    "shutdown_container": _ct_power_handler,
    "stop_container": _ct_power_handler,
    "reboot_container": _ct_power_handler,
    # VM snapshots
    "create_vm_snapshot": _vm_snap_handler,
    "delete_vm_snapshot": _vm_snap_handler,
    "rollback_vm_snapshot": _vm_snap_handler,
    # Container snapshots
    "create_container_snapshot": _ct_snap_handler,
    "delete_container_snapshot": _ct_snap_handler,
    "rollback_container_snapshot": _ct_snap_handler,
    # VM delete
    "vm_delete_request": _vm_delete_handler,
    "vm_delete_confirm": _vm_delete_handler,
    # Container delete
    "container_delete_request": _ct_delete_handler,
    "container_delete_confirm": _ct_delete_handler,
    # Create
    "create_vm": _vm_create_handler,
    "create_container": _ct_create_handler,
}


# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------

def _build_mcp_server() -> Server:
    """Construct and return the configured MCP server instance."""
    mcp = Server("clustr")

    @mcp.list_tools()
    async def list_tools() -> list[Tool]:
        return _ALL_TOOLS

    @mcp.call_tool()
    async def call_tool(
        tool_name: str, arguments: dict[str, Any]
    ) -> list[TextContent]:
        handler_module = _TOOL_HANDLERS.get(tool_name)
        if handler_module is None:
            return [
                TextContent(
                    type="text",
                    text=f"Error: Unknown tool '{tool_name}'. "
                         f"Call list_tools to see available tools.",
                )
            ]
        try:
            return await handler_module.handle(tool_name, arguments or {})
        except Exception as exc:
            logger.exception("Unhandled error in tool '%s'", tool_name)
            return [
                TextContent(
                    type="text",
                    text=f"Internal error in '{tool_name}': {exc}",
                )
            ]

    return mcp


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

def _build_app(mcp: Server) -> FastAPI:
    """Build the FastAPI application with MCP endpoint and health check."""
    app = FastAPI(
        title="Clustr",
        description="Proxmox MCP Server",
        version="0.1.0",
        docs_url="/docs",
        redoc_url=None,
    )

    @app.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse({"status": "ok", "service": "clustr"})

    @app.get("/.well-known/oauth-protected-resource")
    async def oauth_resource_metadata() -> JSONResponse:
        """
        Anthropic directory requirement: OAuth 2.0 Protected Resource Metadata.
        RFC 9728 — describes how to obtain access tokens for this resource.
        """
        settings = get_settings()
        base_url = f"http://localhost:{settings.server.port}"
        return JSONResponse(
            {
                "resource": base_url,
                "authorization_servers": (
                    [settings.oauth.issuer] if settings.oauth.enabled and settings.oauth.issuer
                    else []
                ),
                "bearer_methods_supported": ["header"],
                "scopes_supported": ["clustr:read", "clustr:write"],
            }
        )

    # Streamable HTTP MCP transport
    @app.post("/mcp")
    @app.get("/mcp")
    async def mcp_endpoint(request: Request) -> Any:
        transport = StreamableHTTPServerTransport(mcp_session_id=None)
        async with transport.connect() as (read_stream, write_stream):
            await mcp.run(
                read_stream,
                write_stream,
                mcp.create_initialization_options(),
            )
        return transport.response

    return app


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

def _run_http() -> None:
    """Start the Streamable HTTP server (primary transport)."""
    settings = get_settings()

    logging.basicConfig(
        level=getattr(logging, settings.server.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    mcp = _build_mcp_server()
    app = _build_app(mcp)

    # Wire middleware — outermost first (applied last-in, first-out by Starlette)
    from starlette.middleware import Middleware
    from starlette.applications import Starlette

    # Wrap with ASGI middleware classes
    # FastAPI doesn't natively support class-based ASGI middleware via .add_middleware
    # when the middleware isn't Starlette-native, so we wrap the ASGI app directly.
    asgi_app = OAuthMiddleware(HostVerifyMiddleware(app))

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


async def _run_stdio() -> None:
    """Run MCP over stdio (secondary transport, for local use)."""
    from mcp.server.stdio import stdio_server

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr,
    )

    mcp = _build_mcp_server()
    logger.info("Clustr starting in stdio mode")

    async with stdio_server() as (read_stream, write_stream):
        await mcp.run(
            read_stream,
            write_stream,
            mcp.create_initialization_options(),
        )


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
        asyncio.run(_run_stdio())
    else:
        _run_http()


if __name__ == "__main__":
    main()
