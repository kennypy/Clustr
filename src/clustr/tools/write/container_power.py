"""
Write tools for LXC container power management.

Same pattern as vm_power.py — separate tools per action, no catch-all.

Annotations:
  - start:    destructiveHint = False
  - shutdown: destructiveHint = False  (graceful)
  - stop:     destructiveHint = True   (force kill)
  - reboot:   destructiveHint = False  (graceful)
"""

from __future__ import annotations

import logging
from typing import Annotated, cast

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from clustr.proxmox.client import ProxmoxError, get_client, proxmox_post
from clustr.tools import needs_confirm, safe

logger = logging.getLogger(__name__)

_SAFE_WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False)
_DESTRUCTIVE = ToolAnnotations(readOnlyHint=False, destructiveHint=True)

_Node = Annotated[str, Field(description="Node name (e.g. 'pve')")]
_CtId = Annotated[int, Field(ge=100, description="Container ID")]
_Confirm = Annotated[
    bool,
    Field(
        description="Must be true to execute this destructive operation. When "
        "false (default), returns a confirmation prompt without acting."
    ),
]


# ---------------------------------------------------------------------------
# Tool implementation
# ---------------------------------------------------------------------------


def _container_power_action(node: str, ctid: int, action: str) -> str:
    actions = {"start", "shutdown", "stop", "reboot"}
    if action not in actions:
        raise ProxmoxError(f"Unknown container power action: {action}")
    return cast(
        str,
        proxmox_post(
            lambda: getattr(get_client().nodes(node).lxc(ctid).status, action).post()
        ),
    )


def _run(node: str, ctid: int, action: str) -> str:
    task_id = _container_power_action(node, ctid, action)
    return (
        f"✅ Container {ctid} on {node}: **{action}** initiated.\n"
        f"Task ID: `{task_id}`\n\n"
        f"Use `get_container_status` to check the current state."
    )


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------


def register(mcp: FastMCP) -> None:
    """Register all container power tools onto the given FastMCP instance."""

    @mcp.tool(
        name="start_container",
        title="Start Container",
        description="Start a stopped LXC container. No effect if already running.",
        annotations=_SAFE_WRITE,
    )
    async def start_container(node: _Node, ctid: _CtId) -> str:
        return await safe("start_container", lambda: _run(node, ctid, "start"))

    @mcp.tool(
        name="shutdown_container",
        title="Shutdown Container (Graceful)",
        description=(
            "Gracefully shut down an LXC container by sending a shutdown signal "
            "to init. Use stop_container if the container is unresponsive."
        ),
        annotations=_SAFE_WRITE,
    )
    async def shutdown_container(node: _Node, ctid: _CtId) -> str:
        return await safe("shutdown_container", lambda: _run(node, ctid, "shutdown"))

    @mcp.tool(
        name="stop_container",
        title="Stop Container (Force)",
        description=(
            "Force-stop an LXC container immediately. "
            "Data loss may occur. Prefer shutdown_container for graceful stop."
        ),
        annotations=_DESTRUCTIVE,
    )
    async def stop_container(
        node: _Node, ctid: _CtId, confirm: _Confirm = False
    ) -> str:
        def _do() -> str:
            if not confirm:
                return needs_confirm("force-stop", f"container {ctid} on {node}")
            return _run(node, ctid, "stop")

        return await safe("stop_container", _do)

    @mcp.tool(
        name="reboot_container",
        title="Reboot Container (Graceful)",
        description="Gracefully reboot a running LXC container.",
        annotations=_SAFE_WRITE,
    )
    async def reboot_container(node: _Node, ctid: _CtId) -> str:
        return await safe("reboot_container", lambda: _run(node, ctid, "reboot"))
