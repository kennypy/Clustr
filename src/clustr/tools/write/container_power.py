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
from typing import Any

from mcp.types import TextContent, Tool

from clustr.proxmox.client import ProxmoxError, get_client

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

TOOL_START_CONTAINER = Tool(
    name="start_container",
    title="Start Container",
    description="Start a stopped LXC container. No effect if already running.",
    inputSchema={
        "type": "object",
        "properties": {
            "node": {"type": "string", "description": "Node name (e.g. 'pve')"},
            "ctid": {"type": "integer", "description": "Container ID", "minimum": 100},
        },
        "required": ["node", "ctid"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": False,
    },
)

TOOL_SHUTDOWN_CONTAINER = Tool(
    name="shutdown_container",
    title="Shutdown Container (Graceful)",
    description=(
        "Gracefully shut down an LXC container by sending a shutdown signal "
        "to init. Use stop_container if the container is unresponsive."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {"type": "string", "description": "Node name"},
            "ctid": {"type": "integer", "description": "Container ID", "minimum": 100},
        },
        "required": ["node", "ctid"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": False,
    },
)

TOOL_STOP_CONTAINER = Tool(
    name="stop_container",
    title="Stop Container (Force)",
    description=(
        "Force-stop an LXC container immediately. "
        "Data loss may occur. Prefer shutdown_container for graceful stop."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {"type": "string", "description": "Node name"},
            "ctid": {"type": "integer", "description": "Container ID", "minimum": 100},
        },
        "required": ["node", "ctid"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": True,
    },
)

TOOL_REBOOT_CONTAINER = Tool(
    name="reboot_container",
    title="Reboot Container (Graceful)",
    description="Gracefully reboot a running LXC container.",
    inputSchema={
        "type": "object",
        "properties": {
            "node": {"type": "string", "description": "Node name"},
            "ctid": {"type": "integer", "description": "Container ID", "minimum": 100},
        },
        "required": ["node", "ctid"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": False,
    },
)


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def _container_power_action(node: str, ctid: int, action: str) -> str:
    client = get_client()
    ct_api = client.nodes(node).lxc(ctid)
    action_map = {
        "start": ct_api.status.start.post,
        "shutdown": ct_api.status.shutdown.post,
        "stop": ct_api.status.stop.post,
        "reboot": ct_api.status.reboot.post,
    }
    fn = action_map.get(action)
    if fn is None:
        raise ProxmoxError(f"Unknown container power action: {action}")
    return fn()


# ---------------------------------------------------------------------------
# Handler dispatcher
# ---------------------------------------------------------------------------

async def handle(tool_name: str, arguments: dict[str, Any]) -> list[TextContent]:
    node = arguments.get("node", "").strip()
    ctid_raw = arguments.get("ctid")

    if not node:
        return [TextContent(type="text", text="Error: 'node' parameter is required.")]
    if ctid_raw is None:
        return [TextContent(type="text", text="Error: 'ctid' parameter is required.")]
    try:
        ctid = int(ctid_raw)
    except (TypeError, ValueError):
        return [TextContent(type="text", text="Error: 'ctid' must be an integer.")]
    if ctid < 100:
        return [TextContent(type="text", text="Error: 'ctid' must be >= 100.")]

    action_map = {
        "start_container": "start",
        "shutdown_container": "shutdown",
        "stop_container": "stop",
        "reboot_container": "reboot",
    }

    action = action_map.get(tool_name)
    if action is None:
        return [TextContent(type="text", text=f"Unknown tool: {tool_name}")]

    try:
        task_id = _container_power_action(node, ctid, action)
        return [
            TextContent(
                type="text",
                text=(
                    f"✅ Container {ctid} on {node}: **{action}** initiated.\n"
                    f"Task ID: `{task_id}`\n\n"
                    f"Use `get_container_status` to check the current state."
                ),
            )
        ]
    except ProxmoxError as exc:
        logger.error("Proxmox error in %s: %s", tool_name, exc)
        return [TextContent(type="text", text=f"Proxmox error: {exc}")]
